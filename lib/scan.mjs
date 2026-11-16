/**
 * Historical session discovery and incremental fingerprint scanning.
 *
 * Session logs are concatenated Zstandard frames, one durable batch per frame.
 * Scanning is resumable: the persisted cursor holds the last complete frame
 * offset plus the request context needed to interpret later assistant messages.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { applySessionEvent, createCursor, scanZstdFrames, sha12, stableStringify } from './core.mjs'
import { normalizeTurnIndex, recordTurnIndex, turnIndexFromObservations } from './turn-index.mjs'
import { buildDriftReport } from './drift.mjs'

const SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/i
const MAX_LINE_BYTES = 12 * 1024 * 1024
const MAX_PENDING_CHANGES = 20000
const DATA_VERSION = 2
const decompress = promisify(zstdDecompress)

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

export function sessionFileVersion(file) {
  const match = SESSION_FILE.exec(path.basename(String(file || '')))
  if (!match) return -1
  return match[1] ? Number(match[1]) : 0
}

function sessionFileRank(file) {
  const name = path.basename(String(file || ''))
  const match = SESSION_FILE.exec(name)
  return {
    version: match && match[1] ? Number(match[1]) : 0,
    compressed: Boolean(match && match[2]),
  }
}

/**
 * Group logs by their session directory. DSH can leave several generations of
 * the same log in one directory; they are snapshots of the same session, not
 * independent sessions. Only the highest version is canonical. Lower versions
 * remain available as corruption fallbacks.
 */
export function canonicalSessionFiles(files) {
  const groups = new Map()
  for (const file of files || []) {
    const directory = path.dirname(normalizePath(file.path || file))
    if (!groups.has(directory)) groups.set(directory, [])
    groups.get(directory).push(file)
  }
  const selected = []
  for (const [directory, candidates] of groups) {
    const ordered = [...candidates].sort((left, right) => {
      const a = sessionFileRank(left.path)
      const b = sessionFileRank(right.path)
      if (a.version !== b.version) return b.version - a.version
      if (a.compressed !== b.compressed) return a.compressed ? -1 : 1
      return (right.mtimeMs || 0) - (left.mtimeMs || 0)
    })
    const primary = ordered[0]
    selected.push({
      ...primary,
      directory,
      version: sessionFileRank(primary.path).version,
      candidates: ordered,
    })
  }
  selected.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return selected
}

/**
 * Discover one canonical log per session directory, newest first.
 * @returns {Promise<Array<{path:string,size:number,mtimeMs:number,version:number,candidates:Array<object>}>>}
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
  return canonicalSessionFiles(files)
}

/**
 * Stable identity for one model step. Session/sequence ids differ between
 * historical log generations, but the turn, step, timestamp, model, protocol
 * fingerprint and protocol shape are the semantic event.
 */
export function semanticKeyOf(observation) {
  if (!observation || !observation.sessionId) return ''
  const payload = {
    sessionId: String(observation.sessionId),
    turn: Number(observation.turn),
    step: Number(observation.step),
    time: Number(observation.time),
    model: String(observation.model || ''),
    fingerprint: String(observation.fingerprint || ''),
    protocol: observation.protocol || null,
  }
  return 'sk_' + sha12(stableStringify(payload))
}

function healthyScan(result) {
  if (!result) return false
  if (!result.size) return true
  return result.errors.length === 0 && (result.parsedEvents > 0 || result.offset === result.size)
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
          plain = (await decompress(buffer.subarray(frame.start, frame.end))).toString('utf8')
        } catch (error) {
          noteError(`frame at ${start + frame.start}: ${error && error.message ? error.message : String(error)}`)
          continue
        }
        pending = parseLines(pending + plain, consume)
        newOffset = start + frame.end
        await new Promise((resolve) => setImmediate(resolve))
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
    this.observations = new Map()
    this.observationIdsBySemanticKey = new Map()
    this.dedupedOnLoad = 0
    const loaded = Object.entries(this.state.observations)
      .filter(([id, observation]) => observation && observation.sessionId)
      .map(([id, observation]) => observation.id ? observation : { ...observation, id })
      .sort((left, right) => (Number(left.time) || 0) - (Number(right.time) || 0) || String(left.id).localeCompare(String(right.id)))
    for (const observation of loaded) {
      const semanticKey = semanticKeyOf(observation)
      if (this.observationIdsBySemanticKey.has(semanticKey)) {
        this.dedupedOnLoad += 1
        continue
      }
      this.observations.set(observation.id, observation)
      this.observationIdsBySemanticKey.set(semanticKey, observation.id)
    }
    this.turnIndex = turnIndexFromObservations(this.observations.values())
    this.files = new Map(Object.entries(this.state.files))
    // Maps now own the loaded records and cursors. Keeping the source
    // dictionaries here would retain a second 100+ MiB history indefinitely.
    this.state = null
    this.sessionCounts = new Map()
    this.sessionObservations = new Map()
    for (const observation of this.observations.values()) {
      this.sessionCounts.set(observation.sessionId, (this.sessionCounts.get(observation.sessionId) || 0) + 1)
      if (!this.sessionObservations.has(observation.sessionId)) this.sessionObservations.set(observation.sessionId, new Set())
      this.sessionObservations.get(observation.sessionId).add(observation.id)
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
    // Process-unique generation. A DSH/plugin restart resets revision, so the
    // client must see a new generation and clear its old window instead of
    // merging a lower-revision snapshot.
    this.generation = 'g' + Date.now().toString(36) + '-' + process.pid.toString(36)
    this.dataVersion = DATA_VERSION
    this.changeRevision = 0
    this.pendingObservations = new Map()
    this.pendingDeleted = new Map()
    this.filesRevision = 0
    this.notificationQueued = false
    this.backpressure = false
    this.driftCache = null
    this.driftCacheVersion = -1
  }

  get size() {
    return this.observations.size
  }

  notifyChange() {
    if (this.notificationQueued) return
    this.notificationQueued = true
    queueMicrotask(() => {
      this.notificationQueued = false
      if (!this.stopped) this.onChange()
    })
  }

  updateBackpressure() {
    this.backpressure = this.pendingObservations.size + this.pendingDeleted.size > MAX_PENDING_CHANGES
    return this.backpressure
  }

  recordObservationChange(observation) {
    const revision = ++this.changeRevision
    this.pendingDeleted.delete(observation.id)
    this.pendingObservations.set(observation.id, { revision, value: observation })
    this.updateBackpressure()
  }

  recordObservationDelete(id) {
    const revision = ++this.changeRevision
    this.pendingObservations.delete(id)
    this.pendingDeleted.set(id, { revision, id })
    this.updateBackpressure()
  }

  markFilesChanged() {
    this.filesRevision = ++this.changeRevision
    this.notifyChange()
  }

  checkoutChanges() {
    const token = this.changeRevision
    const observations = []
    const deleted = []
    for (const entry of this.pendingObservations.values()) {
      if (entry.revision <= token) observations.push(entry.value)
    }
    for (const entry of this.pendingDeleted.values()) {
      if (entry.revision <= token) deleted.push(entry.id)
    }
    let files = null
    if (this.filesRevision > 0 && this.filesRevision <= token) {
      files = {}
      for (const [file, cache] of this.files) files[file] = cache
    }
    return { token, observations, deleted, files }
  }

  ackChanges(token) {
    const committed = Number(token) || 0
    for (const [id, entry] of this.pendingObservations) {
      if (entry.revision <= committed) this.pendingObservations.delete(id)
    }
    for (const [id, entry] of this.pendingDeleted) {
      if (entry.revision <= committed) this.pendingDeleted.delete(id)
    }
    if (this.filesRevision > 0 && this.filesRevision <= committed) this.filesRevision = 0
    this.updateBackpressure()
  }

  hasPendingChanges() {
    return this.pendingObservations.size > 0 || this.pendingDeleted.size > 0 || this.filesRevision > 0
  }

  start() {
    if (this.started) return
    this.started = true
    this.stopped = false
    this.discovery = this.discover().catch((error) => this.recordError(error))
    this.ready = this.discovery
      .then(() => this.waitIdle())
      .catch((error) => this.recordError(error))
    this.timer = setInterval(() => {
      this.discover().catch((error) => this.recordError(error))
    }, 5000)
    this.timer.unref?.()
  }

  /**
   * Scan the canonical version first. If it is corrupt, retry lower versions
   * in order and use the first healthy one. Scans are never merged: only one
   * source version contributes observations for a session.
   */
  async scanCanonical(entry, cached, emit) {
    const candidates = entry && Array.isArray(entry.candidates) && entry.candidates.length
      ? entry.candidates
      : [{ path: entry.path, size: entry.size, mtimeMs: entry.mtimeMs }]
    let lastError = null
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      try {
        const cache = cached && cached.path === candidate.path ? cached : undefined
        const emitted = []
        const result = await scanSessionFile(candidate.path, cache, (observation) => emitted.push(observation))
        if (!healthyScan(result) && index < candidates.length - 1) {
          lastError = result.errors[0] || `unreadable session log ${candidate.path}`
          continue
        }
        for (const observation of emitted) emit(observation)
        return {
          ...result,
          canonicalPath: entry.path,
          version: sessionFileVersion(candidate.path),
          fallback: candidate.path !== entry.path,
          primarySize: entry.size,
          primaryMtimeMs: entry.mtimeMs,
        }
      } catch (error) {
        lastError = error && error.message ? error.message : String(error)
      }
    }
    throw new Error(lastError || `no readable session log for ${entry.path}`)
  }

  rebuildIndex() {
    this.turnIndex = turnIndexFromObservations(this.observations.values())
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
      const entries = [...this.sessionFiles.values()]
      let backpressured = false
      for (const entry of entries) {
        if (this.stopped) break
        if (this.backpressure) {
          backpressured = true
          break
        }
        try {
          const result = await this.scanCanonical(entry, undefined, (observation) => {
            if (this.addObservation(observation)) added += 1
          })
          this.files.set(entry.path, result)
          this.markFilesChanged()
          if (result.cursor && result.cursor.header && result.cursor.header.id) {
            this.sessionMeta.set(String(result.cursor.header.id), result.cursor.header)
          }
          scanned += 1
        } catch (error) {
          this.recordError(error)
        }
        await new Promise((resolve) => setImmediate(resolve))
      }
      this.rebuildIndex()
      const summary = {
        scanned,
        added,
        files: entries.length,
        backpressured,
        startedAt,
        finishedAt: Date.now(),
      }
      this.backfillStats = summary
      if (added > 0) {
        this.version += 1
        if (this.onBackfill) await this.onBackfill(summary)
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
      const primarySize = cached && Number.isFinite(cached.primarySize) ? cached.primarySize : cached && cached.path === entry.path ? cached.size : null
      const primaryMtimeMs = cached && Number.isFinite(cached.primaryMtimeMs) ? cached.primaryMtimeMs : cached && cached.path === entry.path ? cached.mtimeMs : null
      const source = cached && cached.path !== entry.path
        ? (entry.candidates || []).find((candidate) => candidate.path === cached.path)
        : null
      const sourceChanged = Boolean(cached && cached.path !== entry.path && (!source || source.size !== cached.size || Math.abs(source.mtimeMs - cached.mtimeMs) > 1))
      const changed = !cached || cached.path !== entry.path || primarySize !== entry.size || Math.abs(primaryMtimeMs - entry.mtimeMs) > 1 || sourceChanged
      if (changed) this.enqueue(entry.path, !cached)
    }
    // Keep discovery and cache in sync. Observations are retained as history,
    // but a deleted log must stop appearing as a current session file. If the
    // same path appears again, there is no cached offset, so it is rescanned.
    for (const file of [...this.files.keys()]) {
      if (!currentFiles.has(file)) {
        this.files.delete(file)
        this.removedFiles.add(file)
        this.markFilesChanged()
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
          const entry = this.sessionFiles.get(file)
          const result = await this.scanCanonical(entry, cached, (observation) => this.addObservation(observation))
          this.files.set(file, result)
          this.markFilesChanged()
          if (result.cursor && result.cursor.header && result.cursor.header.id) {
            this.sessionMeta.set(String(result.cursor.header.id), result.cursor.header)
          }
          this.stats.scannedFiles += 1
          this.stats.scannedBytes += Math.max(0, result.size - (cached ? cached.offset : 0))
          this.stats.parseErrors += result.errors.length
          this.lastScanAt = now()
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
    const ids = this.sessionObservations.get(sessionId)
    if (!ids) return []
    const rows = []
    for (const id of ids.keys()) {
      const observation = this.observations.get(id)
      if (observation) rows.push(observation)
    }
    return rows
  }

  unindexObservation(observation) {
    if (!observation) return
    const bucket = this.sessionObservations.get(observation.sessionId)
    if (bucket) {
      bucket.delete(observation.id)
      if (!bucket.size) this.sessionObservations.delete(observation.sessionId)
    }
    const semanticKey = semanticKeyOf(observation)
    if (this.observationIdsBySemanticKey.get(semanticKey) === observation.id) {
      this.observationIdsBySemanticKey.delete(semanticKey)
    }
  }

  /**
   * Add or replace one observation. Normal additions update the turn index
   * incrementally; replacements and removals rebuild that session's index so
   * an old contribution can never be left behind.
   */
  addObservation(observation) {
    if (this.stopped) return false
    if (!observation || !observation.id || !observation.sessionId) return false
    const semanticKey = semanticKeyOf(observation)
    const semanticId = this.observationIdsBySemanticKey.get(semanticKey)
    if (semanticId && semanticId !== observation.id) return false
    const existing = this.observations.get(observation.id)
    if (existing) {
      if (Number(existing.time) > Number(observation.time)) return false
      if (Number(existing.time) === Number(observation.time) && stableStringify(existing) === stableStringify(observation)) return false
      this.unindexObservation(existing)
      this.observations.delete(existing.id)
      if (this.sessionCounts.has(existing.sessionId)) {
        const count = (this.sessionCounts.get(existing.sessionId) || 1) - 1
        if (count > 0) this.sessionCounts.set(existing.sessionId, count)
        else this.sessionCounts.delete(existing.sessionId)
      }
    }
    this.observations.set(observation.id, observation)
    this.observationIdsBySemanticKey.set(semanticKey, observation.id)
    if (!this.sessionObservations.has(observation.sessionId)) this.sessionObservations.set(observation.sessionId, new Set())
    this.sessionObservations.get(observation.sessionId).add(observation.id)
    this.sessionCounts.set(observation.sessionId, (this.sessionCounts.get(observation.sessionId) || 0) + 1)
    if (!existing) {
      this.addedSinceTrim += 1
      recordTurnIndex(this.turnIndex, observation)
    }
    this.version += 1
    if (existing) this.rebuildSessionIndex(observation.sessionId)
    if (existing && existing.sessionId !== observation.sessionId) this.rebuildSessionIndex(existing.sessionId)
    this.recordObservationChange(observation)
    this.trimSession(observation.sessionId)
    this.trimTotal()
    this.notifyChange()
    return true
  }

  removeObservation(id) {
    const observation = this.observations.get(id)
    if (!observation) return false
    this.unindexObservation(observation)
    this.observations.delete(id)
    const count = (this.sessionCounts.get(observation.sessionId) || 1) - 1
    if (count > 0) this.sessionCounts.set(observation.sessionId, count)
    else this.sessionCounts.delete(observation.sessionId)
    this.rebuildSessionIndex(observation.sessionId)
    this.version += 1
    this.recordObservationDelete(id)
    this.notifyChange()
    return true
  }

  rebuildSessionIndex(sessionId) {
    const rows = this.observationsForSession(sessionId)
    if (rows.length) this.turnIndex[sessionId] = turnIndexFromObservations(rows)[sessionId] || {}
    else delete this.turnIndex[sessionId]
  }

  trimSession(sessionId) {
    if (!this.perSessionLimit || this.perSessionLimit <= 0) return
    if ((this.sessionCounts.get(sessionId) || 0) <= this.perSessionLimit) return
    const rows = this.observationsForSession(sessionId)
    if (rows.length <= this.perSessionLimit) return
    rows.sort((left, right) => left.time - right.time)
    for (const observation of rows.slice(0, rows.length - this.perSessionLimit)) this.removeObservation(observation.id)
  }

  trimTotal() {
    if (!this.totalLimit || this.totalLimit <= 0) return
    if (this.observations.size <= this.totalLimit || this.addedSinceTrim < 32) return
    this.addedSinceTrim = 0
    const rows = [...this.observations.values()].sort((left, right) => left.time - right.time)
    const removeCount = this.observations.size - this.totalLimit
    for (const observation of rows.slice(0, removeCount)) this.removeObservation(observation.id)
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

  driftReport() {
    if (this.driftCache && this.driftCacheVersion === this.version) return this.driftCache
    this.driftCache = buildDriftReport(this.observations.values())
    this.driftCacheVersion = this.version
    return this.driftCache
  }

  serialize() {
    const files = {}
    for (const [file, cache] of this.files) files[file] = cache
    const observations = {}
    for (const [id, observation] of this.observations) observations[id] = observation
    // turnIndex is maintained incrementally on add/replace/remove. Do not
    // rebuild or stable-serialize the complete history during a normal save.
    return { files, observations, turnIndex: this.turnIndex, dataVersion: DATA_VERSION, generation: this.generation }
  }

  status() {
    return {
      roots: this.roots,
      discovered: this.discovered,
      cachedFiles: this.files.size,
      sessionFiles: this.sessionFiles.size,
      removedFiles: this.removedFiles.size,
      observations: this.observations.size,
      deduped: this.dedupedOnLoad,
      queue: this.queue.length,
      pendingChanges: this.pendingObservations.size + this.pendingDeleted.size,
      backpressure: this.backpressure,
      scanning: Boolean(this.scanningPath),
      scanningPath: this.scanningPath,
      lastScanAt: this.lastScanAt || null,
      lastError: this.lastError,
      version: this.version,
      generation: this.generation,
      dataVersion: this.dataVersion,
      stats: this.stats,
      backfill: this.backfillStats,
      backfilling: Boolean(this.backfillPromise),
    }
  }
}
