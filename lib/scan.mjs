/**
 * Historical session discovery and incremental fingerprint scanning.
 *
 * Session logs are concatenated Zstandard frames, one durable batch per frame.
 * Scanning is resumable: the persisted cursor holds the last complete frame
 * offset plus the request context needed to interpret later assistant messages.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { applySessionEvent, createCursor, scanZstdFrames } from './core.mjs'
import { normalizeTurnIndex, recordTurnIndex, turnIndexFromObservations } from './turn-index.mjs'

const SESSION_FILE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/i
const MAX_LINE_BYTES = 12 * 1024 * 1024

const now = () => Date.now()

function normalizePath(value) {
  return path.resolve(String(value))
}

export function defaultSessionRoots(home) {
  const roots = []
  if (process.env.DSH_SESSIONS_DIR) roots.push(path.resolve(process.env.DSH_SESSIONS_DIR))
  if (home) {
    const base = path.resolve(home)
    roots.push(path.join(base, 'sessions'))
    const profiles = path.join(base, 'profiles')
    try {
      // Synchronous discovery is intentionally avoided here; callers add
      // profile roots through discoverProfileRoots when they need them.
      void profiles
    } catch {
      /* ignore */
    }
  }
  return [...new Set(roots)]
}

export async function discoverProfileRoots(home) {
  const base = path.resolve(home)
  const profiles = path.join(base, 'profiles')
  const roots = []
  try {
    const entries = await fs.readdir(profiles, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(profiles, entry.name, 'sessions')
      try {
        const stat = await fs.stat(candidate)
        if (stat.isDirectory()) roots.push(candidate)
      } catch {
        /* no sessions directory */
      }
    }
  } catch {
    /* no profiles directory */
  }
  return roots
}

async function walk(root, out) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await walk(absolute, out)
    } else if (entry.isFile() && SESSION_FILE.test(entry.name)) {
      out.push(absolute)
    }
  }
}

/**
 * Discover session logs under one or more roots, newest first.
 * @returns {Promise<Array<{path:string,size:number,mtimeMs:number}>>}
 */
export async function discoverSessionFiles(roots) {
  const paths = []
  for (const root of roots) await walk(root, paths)
  const unique = [...new Set(paths.map(normalizePath))]
  const files = []
  for (const file of unique) {
    try {
      const stat = await fs.stat(file)
      if (stat.isFile()) files.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch {
      /* raced with deletion */
    }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return files
}

function parseLines(text, onLine) {
  const parts = text.split('\n')
  const tail = parts.pop() ?? ''
  for (const line of parts) {
    if (!line.trim()) continue
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) continue
    try {
      onLine(JSON.parse(line))
    } catch {
      /* one malformed/torn line must not abort the session */
    }
  }
  return tail
}

/**
 * Scan one session file from its cached frame offset.
 * @param {string} file
 * @param {object|undefined} cached
 * @param {(observation:object)=>void} emit
 * @returns {Promise<object>} new cache entry
 */
export async function scanSessionFile(file, cached, emit) {
  const stat = await fs.stat(file)
  const previous = cached && cached.offset > 0 && cached.offset <= stat.size ? cached : undefined
  const start = previous ? previous.offset : 0
  const handle = await fs.open(file, 'r')
  let buffer
  try {
    const length = stat.size - start
    if (length > 256 * 1024 * 1024) throw new Error(`session file is too large to scan in one pass (${length} bytes)`)
    buffer = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, start + read)
      if (!result.bytesRead) break
      read += result.bytesRead
    }
    if (read !== length) buffer = buffer.subarray(0, read)
  } finally {
    await handle.close()
  }

  const cursor = previous && previous.cursor
    ? { ...previous.cursor, stepStarts: { ...(previous.cursor.stepStarts || {}) } }
    : createCursor()
  let pending = previous && typeof previous.pending === 'string' ? previous.pending : ''
  let frames = 0
  let parsedEvents = 0
  let newOffset = start
  let tornStart
  const errors = []
  const noteError = (message) => {
    if (errors.length < 50) errors.push(message)
  }
  const consume = (event) => {
    parsedEvents += 1
    try {
      applySessionEvent(cursor, event, emit)
    } catch (error) {
      noteError(`event: ${error && error.message ? error.message : String(error)}`)
    }
  }

  const isPlain = !file.toLowerCase().endsWith('.zstd')
  if (isPlain) {
    const text = buffer.toString('utf8')
    const joined = pending + text
    pending = parseLines(joined, consume)
    newOffset = stat.size
  } else {
    try {
      const scanned = scanZstdFrames(buffer)
      frames = scanned.frames.length
      tornStart = scanned.tornStart
      for (const frame of scanned.frames) {
        let plain
        try {
          plain = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
        } catch (error) {
          noteError(`frame at ${start + frame.start}: ${error && error.message ? error.message : String(error)}`)
          continue
        }
        pending = parseLines(pending + plain, consume)
        newOffset = start + frame.end
      }
      if (tornStart !== undefined) newOffset = start + tornStart
    } catch (error) {
      noteError(error && error.message ? error.message : String(error))
      newOffset = start
    }
  }

  return {
    path: file,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    offset: newOffset,
    pending,
    cursor,
    frames,
    parsedEvents,
    errors,
    scannedAt: now(),
  }
}

function observationKey(observation) {
  return observation.id
}

/**
 * Background scanner with a bounded, resumable queue. It is deliberately
 * single-file-at-a-time: a 60 MB compressed session can expand into a large
 * frame sequence, and competing with the live agent is worse than being late.
 */
export class SessionScanner {
  constructor({ roots, state, onChange, logger, perSessionLimit = 0, totalLimit = 0 }) {
    this.roots = [...new Set(roots.map(normalizePath))]
    this.state = state || { files: {}, observations: {} }
    this.state.files = this.state.files && typeof this.state.files === 'object' ? this.state.files : {}
    this.state.observations = this.state.observations && typeof this.state.observations === 'object' ? this.state.observations : {}
    this.state.turnIndex = normalizeTurnIndex(this.state.turnIndex)
    this.onChange = typeof onChange === 'function' ? onChange : () => {}
    this.logger = logger
    this.perSessionLimit = perSessionLimit
    this.totalLimit = totalLimit
    this.observations = new Map(Object.entries(this.state.observations))
    this.turnIndex = normalizeTurnIndex(this.state.turnIndex)
    if (!Object.keys(this.turnIndex).length && this.observations.size) {
      this.turnIndex = turnIndexFromObservations(this.observations.values())
    } else {
      const derived = turnIndexFromObservations(this.observations.values())
      for (const [sessionId, turns] of Object.entries(derived)) {
        if (!this.turnIndex[sessionId]) this.turnIndex[sessionId] = {}
        for (const [turn, row] of Object.entries(turns)) {
          if (!this.turnIndex[sessionId][turn]) this.turnIndex[sessionId][turn] = row
        }
      }
    }
    this.files = new Map(Object.entries(this.state.files))
    this.sessionCounts = new Map()
    this.sessionObservations = new Map()
    for (const observation of this.observations.values()) {
      this.sessionCounts.set(observation.sessionId, (this.sessionCounts.get(observation.sessionId) || 0) + 1)
      if (!this.sessionObservations.has(observation.sessionId)) this.sessionObservations.set(observation.sessionId, new Map())
      this.sessionObservations.get(observation.sessionId).set(observation.id, observation)
    }
    this.addedSinceTrim = 0
    this.queue = []
    this.queued = new Set()
    this.scanning = false
    this.scanningPath = null
    this.timer = null
    this.discovered = 0
    this.removedFiles = new Set()
    this.lastScanAt = 0
    this.lastError = null
    this.started = false
    this.stopped = false
    this.liveCursors = new Map()
    this.sessionMeta = new Map()
    this.sessionFiles = new Map()
    for (const cache of this.files.values()) {
      if (cache && cache.cursor && cache.cursor.header && cache.cursor.header.id) {
        this.sessionMeta.set(String(cache.cursor.header.id), cache.cursor.header)
      }
    }
    this.stats = { scannedFiles: 0, scannedBytes: 0, parseErrors: 0, scanErrors: 0 }
    this.backfillStats = null
    this.backfillPromise = null
    this.onBackfill = null
    this.version = 0
  }

  get size() {
    return this.observations.size
  }

  start() {
    if (this.started) return
    this.started = true
    this.stopped = false
    this.discovery = this.discover().catch((error) => this.recordError(error))
    this.ready = this.discovery
      .then(() => this.waitIdle())
      .then(() => this.backfillMissing())
      .catch((error) => this.recordError(error))
    this.timer = setInterval(() => {
      this.discover().catch((error) => this.recordError(error))
    }, 5000)
    this.timer.unref?.()
  }

  async backfillMissing(options = {}) {
    if (this.stopped) return { scanned: 0, added: 0, skipped: 'stopped' }
    if (this.backfillPromise) {
      if (!options.force) return this.backfillPromise
      await this.backfillPromise
    }
    const run = async () => {
      const startedAt = Date.now()
      let scanned = 0
      let added = 0
      const files = [...this.sessionFiles.keys()]
      for (const file of files) {
        if (this.stopped) break
        try {
          const result = await scanSessionFile(file, undefined, (observation) => {
            if (this.addObservation(observation)) added += 1
          })
          this.files.set(file, result)
          if (result.cursor && result.cursor.header && result.cursor.header.id) {
            this.sessionMeta.set(String(result.cursor.header.id), result.cursor.header)
          }
          scanned += 1
        } catch (error) {
          this.recordError(error)
        }
        await new Promise((resolve) => setImmediate(resolve))
      }
      const summary = {
        scanned,
        added,
        files: files.length,
        startedAt,
        finishedAt: Date.now(),
      }
      this.backfillStats = summary
      if (added > 0) {
        this.version += 1
        if (this.onBackfill) await this.onBackfill(summary)
        this.onChange()
      }
      return summary
    }
    this.backfillPromise = run().finally(() => { this.backfillPromise = null })
    return this.backfillPromise
  }

  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.started = false
  }

  recordError(error) {
    this.lastError = error && error.message ? error.message : String(error)
    if (this.logger) this.logger.warn?.(`model-fingerprint scan: ${this.lastError}`)
  }

  async discover() {
    if (this.stopped) return
    const discovered = await discoverSessionFiles(this.roots)
    this.discovered = discovered.length
    const currentFiles = new Map()
    for (const entry of discovered) {
      currentFiles.set(entry.path, entry)
      const cached = this.files.get(entry.path)
      const changed = !cached || cached.size !== entry.size || Math.abs(cached.mtimeMs - entry.mtimeMs) > 1
      if (changed) this.enqueue(entry.path, !cached)
    }
    // Keep discovery and cache in sync. Observations are retained as history,
    // but a deleted log must stop appearing as a current session file. If the
    // same path appears again, there is no cached offset, so it is rescanned.
    for (const file of [...this.files.keys()]) {
      if (!currentFiles.has(file)) {
        this.files.delete(file)
        this.removedFiles.add(file)
      }
    }
    this.sessionFiles = currentFiles
    this.run().catch((error) => this.recordError(error))
  }

  enqueue(file, front = false) {
    if (this.queued.has(file) || this.scanningPath === file) return
    this.queued.add(file)
    if (front) this.queue.unshift(file)
    else this.queue.push(file)
  }

  async waitIdle(timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs
    if (this.discovery) {
      try { await this.discovery } catch { /* recorded */ }
    }
    while ((this.scanning || this.queue.length) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return !this.scanning && this.queue.length === 0
  }

  async run() {    if (this.scanning || this.stopped) return
    this.scanning = true
    try {
      while (this.queue.length && !this.stopped) {
        const file = this.queue.shift()
        this.queued.delete(file)
        if (!file || !this.sessionFiles.has(file)) continue
        this.scanningPath = file
        try {
          const cached = this.files.get(file)
          const before = this.observations.size
          const result = await scanSessionFile(file, cached, (observation) => this.addObservation(observation))
          this.files.set(file, result)
          if (result.cursor && result.cursor.header && result.cursor.header.id) {
            this.sessionMeta.set(String(result.cursor.header.id), result.cursor.header)
          }
          this.stats.scannedFiles += 1
          this.stats.scannedBytes += Math.max(0, result.size - (cached ? cached.offset : 0))
          this.stats.parseErrors += result.errors.length
          this.lastScanAt = now()
          if (this.observations.size !== before) this.onChange()
        } catch (error) {
          this.stats.scanErrors += 1
          this.recordError(error)
        } finally {
          this.scanningPath = null
        }
        // Yield to the event loop between files, and to the live session.
        await new Promise((resolve) => setImmediate(resolve))
      }
    } finally {
      this.scanning = false
    }
  }

  observationsForSession(sessionId) {
    return [...(this.sessionObservations.get(sessionId)?.values() || [])]
  }

  unindexObservation(observation) {
    if (!observation) return
    const bucket = this.sessionObservations.get(observation.sessionId)
    if (bucket) {
      bucket.delete(observation.id)
      if (!bucket.size) this.sessionObservations.delete(observation.sessionId)
    }
  }

  addObservation(observation) {
    if (this.stopped) return false
    if (!observation || !observation.id) return false
    const existing = this.observations.get(observation.id)
    if (existing && existing.time >= observation.time) return false
    this.observations.set(observation.id, observation)
    if (!this.sessionObservations.has(observation.sessionId)) this.sessionObservations.set(observation.sessionId, new Map())
    this.sessionObservations.get(observation.sessionId).set(observation.id, observation)
    recordTurnIndex(this.turnIndex, observation)
    this.version += 1
    if (!existing) {
      this.sessionCounts.set(observation.sessionId, (this.sessionCounts.get(observation.sessionId) || 0) + 1)
      this.addedSinceTrim += 1
    }
    this.trimSession(observation.sessionId)
    this.trimTotal()
    this.onChange()
    return true
  }

  trimSession(sessionId) {
    if (!this.perSessionLimit || this.perSessionLimit <= 0) return
    if ((this.sessionCounts.get(sessionId) || 0) <= this.perSessionLimit) return
    const rows = []
    for (const observation of this.observations.values()) {
      if (observation.sessionId === sessionId) rows.push(observation)
    }
    if (rows.length <= this.perSessionLimit) return
    rows.sort((left, right) => left.time - right.time)
    const remove = rows.slice(0, rows.length - this.perSessionLimit)
    for (const observation of remove) {
      this.observations.delete(observation.id)
      this.unindexObservation(observation)
      this.sessionCounts.set(sessionId, (this.sessionCounts.get(sessionId) || 1) - 1)
    }
  }

  trimTotal() {
    if (!this.totalLimit || this.totalLimit <= 0) return
    if (this.observations.size <= this.totalLimit || this.addedSinceTrim < 32) return
    this.addedSinceTrim = 0
    const rows = [...this.observations.values()].sort((left, right) => left.time - right.time)
    const removeCount = this.observations.size - this.totalLimit
    for (const observation of rows.slice(0, removeCount)) {
      this.observations.delete(observation.id)
      this.unindexObservation(observation)
      const count = (this.sessionCounts.get(observation.sessionId) || 1) - 1
      if (count > 0) this.sessionCounts.set(observation.sessionId, count)
      else this.sessionCounts.delete(observation.sessionId)
    }
  }

  /** Feed one live event; the same dedupe key makes later file scans harmless. */
  liveEvent(sessionId, event) {
    const id = String(sessionId)
    let cursor = this.liveCursors.get(id)
    if (!cursor) {
      cursor = createCursor({ id })
      this.liveCursors.set(id, cursor)
    }
    if (event && event.type === 'session') {
      this.sessionMeta.set(id, {
        id,
        version: event.version,
        createdAt: event.createdAt,
        cwd: event.cwd,
        parentSession: event.parentSession,
        delegationDepth: event.delegationDepth,
        origin: event.origin,
        agentPreset: event.agentPreset,
      })
    }
    applySessionEvent(cursor, event, (observation) => this.addObservation(observation))
  }

  liveCreated(session) {
    const id = session && session.id ? String(session.id) : ''
    if (id && !this.liveCursors.has(id)) this.liveCursors.set(id, createCursor({ id }))
  }

  liveDisposed(session) {
    const id = session && session.id ? String(session.id) : ''
    if (id) this.liveCursors.delete(id)
  }

  serialize() {
    const files = {}
    for (const [file, cache] of this.files) files[file] = cache
    const observations = {}
    for (const [id, observation] of this.observations) observations[id] = observation
    return { files, observations, turnIndex: this.turnIndex }
  }

  status() {
    return {
      roots: this.roots,
      discovered: this.discovered,
      cachedFiles: this.files.size,
      sessionFiles: this.sessionFiles.size,
      removedFiles: this.removedFiles.size,
      observations: this.observations.size,
      queue: this.queue.length,
      scanning: Boolean(this.scanningPath),
      scanningPath: this.scanningPath,
      lastScanAt: this.lastScanAt || null,
      lastError: this.lastError,
      version: this.version,
      stats: this.stats,
      backfill: this.backfillStats,
      backfilling: Boolean(this.backfillPromise),
    }
  }
}
