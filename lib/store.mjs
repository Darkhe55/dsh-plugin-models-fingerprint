/**
 * Local persistence for the fingerprint monitor.
 *
 * Only metric summaries and protocol shapes are stored — never prompts or
 * assistant text. The file lives in DSH home so history survives project
 * changes, and writes are atomic, compressed, and serialized.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { STATE_VERSION } from './core.mjs'

const SAVE_DELAY_MS = 3000
const STATE_FILE = 'state.json.zst'
const LEGACY_FILE = 'state.json'

function emptyState() {
  return {
    version: STATE_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    labels: {},
    files: {},
    observations: {},
    turnIndex: {},
    probes: {},
  }
}

export class FingerprintStore {
  constructor({ home, logger }) {
    this.home = home
    this.logger = logger
    this.root = path.join(home, 'model-fingerprint')
    this.file = path.join(this.root, STATE_FILE)
    this.legacyFile = path.join(this.root, LEGACY_FILE)
    this.state = emptyState()
    this.loaded = false
    this.saveTimer = null
    this.saving = null
    this.dirty = false
    this.pendingScanner = null
  }

  async load() {
    let parsed
    let loadedFrom = null
    for (const candidate of [this.file, this.legacyFile]) {
      try {
        const bytes = await fs.readFile(candidate)
        const text = candidate.endsWith('.zst') ? zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8')
        parsed = JSON.parse(text)
        loadedFrom = candidate
        break
      } catch (error) {
        if (error && error.code !== 'ENOENT') {
          this.logger?.warn?.(`model-fingerprint: could not load ${path.basename(candidate)} (${error.message})`)
          try {
            await fs.mkdir(this.root, { recursive: true })
            await fs.rename(candidate, candidate + '.corrupt-' + Date.now()).catch(() => {})
          } catch {
            /* best effort */
          }
        }
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      this.state = emptyState()
    } else {
      this.state = {
        version: STATE_VERSION,
        createdAt: Number(parsed.createdAt) || Date.now(),
        updatedAt: Number(parsed.updatedAt) || Date.now(),
        labels: parsed.labels && typeof parsed.labels === 'object' ? parsed.labels : {},
        files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
        observations: parsed.observations && typeof parsed.observations === 'object' ? parsed.observations : {},
        turnIndex: parsed.turnIndex && typeof parsed.turnIndex === 'object' ? parsed.turnIndex : {},
        probes: parsed.probes && typeof parsed.probes === 'object' ? parsed.probes : {},
      }
      if (loadedFrom === this.legacyFile) this.dirty = true
    }
    this.loaded = true
    return this.state
  }

  labels() {
    return this.state.labels || {}
  }

  probes() {
    return Object.values(this.state.probes || {})
  }

  addProbes(observations) {
    for (const observation of Array.isArray(observations) ? observations : []) {
      if (!observation || !observation.id) continue
      this.state.probes[observation.id] = observation
    }
    const ids = Object.keys(this.state.probes)
    if (ids.length > 500) {
      const ordered = ids
        .map((id) => this.state.probes[id])
        .sort((left, right) => (left.time || 0) - (right.time || 0))
      for (const observation of ordered.slice(0, ids.length - 500)) delete this.state.probes[observation.id]
    }
    this.scheduleSave()
  }

  setLabel(fingerprintId, label, note) {
    const id = String(fingerprintId || '').trim()
    if (!/^fp_[0-9a-f]{12}$/i.test(id)) throw new Error('invalid fingerprint id')
    const cleanLabel = String(label || '').trim().slice(0, 80)
    const cleanNote = String(note || '').trim().slice(0, 400)
    if (!cleanLabel) {
      delete this.state.labels[id]
    } else {
      this.state.labels[id] = { label: cleanLabel, note: cleanNote || null, updatedAt: Date.now() }
    }
    this.scheduleSave()
    return this.state.labels[id] || null
  }

  scheduleSave(scanner) {
    if (scanner) this.pendingScanner = scanner
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save(this.pendingScanner).catch((error) => this.logger?.warn?.(`model-fingerprint: save failed (${error.message})`))
    }, SAVE_DELAY_MS)
    this.saveTimer.unref?.()
  }

  snapshotPayload() {
    return {
      version: STATE_VERSION,
      createdAt: this.state.createdAt,
      updatedAt: Date.now(),
      labels: this.state.labels,
      files: this.state.files,
      observations: this.state.observations,
      turnIndex: this.state.turnIndex || {},
      probes: this.state.probes || {},
    }
  }

  /**
   * Serialize writes. A scanner snapshot is copied synchronously before the
   * first await, so live appends during a write trigger a second pass instead
   * of racing the same temp path.
   */
  save(scanner) {
    if (scanner) {
      const data = scanner.serialize()
      this.state.files = data.files
      this.state.observations = data.observations
      this.state.turnIndex = data.turnIndex || {}
      this.pendingScanner = scanner
    }
    this.dirty = true
    if (this.saving) return this.saving
    this.saving = (async () => {
      while (this.dirty) {
        this.dirty = false
        await this.writePayload(this.snapshotPayload())
      }
    })().catch((error) => {
      this.dirty = true
      throw error
    }).finally(() => {
      this.saving = null
    })
    return this.saving
  }

  async writePayload(payload) {
    await fs.mkdir(this.root, { recursive: true })
    const bytes = zstdCompressSync(Buffer.from(JSON.stringify(payload)))
    const tmp = this.file + '.tmp-' + process.pid
    await fs.writeFile(tmp, bytes, { mode: 0o600 })
    try {
      await fs.rename(tmp, this.file)
    } catch {
      await fs.rm(this.file, { force: true })
      await fs.rename(tmp, this.file)
    }
    // A prior uncompressed state is no longer the source of truth.
    await fs.rm(this.legacyFile, { force: true }).catch(() => {})
  }

  async flush(scanner) {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (scanner) {
      const data = scanner.serialize()
      this.state.files = data.files
      this.state.observations = data.observations
      this.state.turnIndex = data.turnIndex || {}
    }
    this.dirty = true
    await this.save(this.pendingScanner || scanner)
  }
}
