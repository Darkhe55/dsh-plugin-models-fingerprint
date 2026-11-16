/**
 * Local persistence for the fingerprint monitor.
 *
 * Large observation history is never rewritten for a single append. An
 * existing state.json.zst is an immutable base checkpoint; normal mutations
 * are checksummed append-only journal records selected by an atomic manifest.
 * Runtime persistence never serializes or compresses the complete history.
 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { STATE_VERSION } from './core.mjs'
import { mergeOfficialSeeds, normalizeOfficialModels } from './official.mjs'
import {
  appendJournal,
  createManifest,
  journalPaths,
  readJournal,
  readManifest,
  truncateJournal,
  updateManifest,
} from './journal.mjs'

const SAVE_DELAY_MS = 15000
const MIN_SAVE_INTERVAL_MS = 30000
const STATE_FILE = 'state.json.zst'
const LEGACY_FILE = 'state.json'
const MAX_BATCH_RECORDS = 500
const SHUTDOWN_FLUSH_MS = 5000
const decompress = promisify(zstdDecompress)

export const DATA_VERSION = 2

function completesWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs))
    timer.unref?.()
    Promise.resolve(promise).then(() => finish(true), () => finish(false))
  })
}

function emptyState() {
  return {
    version: STATE_VERSION,
    dataVersion: DATA_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    labels: {},
    files: {},
    observations: {},
    turnIndex: {},
    officialModels: [],
    officialEvidenceVersion: 0,
    officialBaselines: {},
    similarityCalibration: {},
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
    this.retryTimer = null
    this.saving = null
    this.dirty = false
    this.dirtyAgain = false
    this.closed = false
    this.closing = false
    this.status = 'clean'
    this.reason = null
    this.lastSaveAt = 0
    this.retryCount = 0
    this.pendingScanner = null
    this.metadataDirty = new Map()
    this.manifest = null
    this.journalValidBytes = 0
    this.revision = 0
    this.persistedRevision = 0
    this.needsMigration = false
    this.migrationBackup = null
    this.resetBeforeNextWrite = false
    this.diagnostics = {
      saveReason: null,
      dirtyRevision: 0,
      persistedRevision: 0,
      pendingCount: 0,
      batchSize: 0,
      queueLength: 0,
      saveDurationMs: 0,
      serializeDurationMs: 0,
      compressDurationMs: 0,
      rawBytes: 0,
      storedBytes: 0,
      rss: 0,
      heapUsed: 0,
      external: 0,
      workerExitCode: 0,
      retryCount: 0,
      migrationStage: 'idle',
      journalRecords: 0,
    }
  }

  memorySnapshot() {
    const usage = process.memoryUsage()
    return { rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external }
  }

  truthyMetaKeys() {
    return new Set([
      'labels', 'files', 'officialModels', 'officialEvidenceVersion',
      'officialBaselines', 'similarityCalibration', 'probes',
      'version', 'dataVersion',
    ])
  }

  markMeta(...keys) {
    const revision = ++this.revision
    for (const key of keys) this.metadataDirty.set(key, revision)
    this.dirty = true
    this.diagnostics.dirtyRevision = this.revision
  }

  async load() {
    this.manifest = await readManifest(this.root)
    let parsed
    let loadedFrom = null
    const candidates = []
    if (this.manifest && this.manifest.base && this.manifest.base.path) {
      candidates.push(path.resolve(this.root, this.manifest.base.path))
    }
    candidates.push(this.file, this.legacyFile)
    for (const candidate of [...new Set(candidates)]) {
      try {
        const bytes = await fs.readFile(candidate)
        if (this.manifest && this.manifest.base && this.manifest.base.sha256) {
          const actual = createHash('sha256').update(bytes).digest('hex')
          if (actual !== this.manifest.base.sha256) {
            this.diagnostics.baseDigestMismatch = true
            this.logger?.warn?.(`model-fingerprint: base checkpoint hash mismatch for ${path.basename(candidate)}; journal remains read-only until the next successful compaction`)
          }
        }
        const text = candidate.endsWith('.zst')
          ? (await decompress(bytes)).toString('utf8')
          : bytes.toString('utf8')
        parsed = JSON.parse(text)
        loadedFrom = candidate
        break
      } catch (error) {
        if (error && error.code !== 'ENOENT') {
          this.logger?.warn?.(`model-fingerprint: could not load ${path.basename(candidate)} (${error.message})`)
        }
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      this.state = emptyState()
    } else {
      const dataVersion = Number(parsed.dataVersion || parsed.version || 0)
      this.needsMigration = dataVersion < DATA_VERSION
      this.state = {
        version: STATE_VERSION,
        dataVersion,
        createdAt: Number(parsed.createdAt) || Date.now(),
        updatedAt: Number(parsed.updatedAt) || Date.now(),
        labels: parsed.labels && typeof parsed.labels === 'object' ? parsed.labels : {},
        files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
        observations: parsed.observations && typeof parsed.observations === 'object' ? parsed.observations : {},
        turnIndex: parsed.turnIndex && typeof parsed.turnIndex === 'object' ? parsed.turnIndex : {},
        officialModels: Array.isArray(parsed.officialModels) ? parsed.officialModels : [],
        officialEvidenceVersion: Number(parsed.officialEvidenceVersion) || 0,
        officialBaselines: parsed.officialBaselines && typeof parsed.officialBaselines === 'object' ? parsed.officialBaselines : {},
        similarityCalibration: parsed.similarityCalibration && typeof parsed.similarityCalibration === 'object' ? parsed.similarityCalibration : {},
        probes: parsed.probes && typeof parsed.probes === 'object' ? parsed.probes : {},
      }
      if (loadedFrom === this.legacyFile) this.dirty = true
      if (this.state.officialModels.length) {
        const merged = mergeOfficialSeeds(this.state.officialModels, this.state.officialEvidenceVersion)
        if (merged.changed || merged.version !== this.state.officialEvidenceVersion) {
          this.state.officialModels = merged.models
          this.state.officialEvidenceVersion = merged.version
          this.markMeta('officialModels', 'officialEvidenceVersion')
        }
      }
    }
    if (this.manifest) {
      try {
        const replay = await readJournal(this.root, this.manifest, {
          collect: false,
          onRecord: (record) => this.applyJournalRecord(record),
        })
        this.journalValidBytes = replay.validBytes
        if (replay.size > replay.validBytes) {
          await truncateJournal(this.root, this.manifest, replay.validBytes)
          this.logger?.warn?.(`model-fingerprint: discarded ${replay.size - replay.validBytes} trailing journal byte(s)`)
        }
        this.diagnostics.journalRecords = replay.recordCount || 0
        this.persistedRevision = replay.recordCount || 0
      } catch (error) {
        this.logger?.warn?.(`model-fingerprint: journal replay failed (${error.message}); base remains authoritative`)
      }
    }
    this.loaded = true
    return this.state
  }

  applyJournalRecord(record) {
    if (!record) return
    if (record.type === 'reset') {
      this.state.files = {}
      this.state.observations = {}
      this.state.turnIndex = {}
      return
    }
    if (record.type === 'obs' && record.value && record.value.id) {
      this.state.observations[record.value.id] = record.value
      return
    }
    if (record.type === 'obs-delete' && record.id) {
      delete this.state.observations[record.id]
      return
    }
    if (record.type === 'meta' && record.key && this.truthyMetaKeys().has(record.key)) {
      this.state[record.key] = record.value
    }
  }

  releaseLargeState() {
    this.state.files = {}
    this.state.observations = {}
    this.state.turnIndex = {}
  }

  /**
   * Keep one pre-migration copy for rollback. Migration itself rebuilds from
   * canonical logs; it never tries to delete duplicate ids out of the old
   * mixed-version state in place.
   */
  async backupMigration() {
    if (!this.needsMigration) return null
    await fs.mkdir(this.root, { recursive: true })
    const target = this.file + '.pre-semantic-v' + DATA_VERSION + '-' + Date.now()
    for (const source of [this.file, this.legacyFile]) {
      try {
        await fs.copyFile(source, target)
        this.migrationBackup = target
        return target
      } catch (error) {
        if (error && error.code === 'ENOENT') continue
        throw error
      }
    }
    return null
  }

  markMigrated() {
    this.state.dataVersion = DATA_VERSION
    this.state.version = STATE_VERSION
    this.needsMigration = false
    this.resetBeforeNextWrite = true
    this.markMeta('dataVersion', 'version')
    this.scheduleSave(this.pendingScanner, 'migration')
  }

  labels() {
    return this.state.labels || {}
  }

  probes() {
    return Object.values(this.state.probes || {})
  }

  officialModels() {
    return Array.isArray(this.state.officialModels) ? this.state.officialModels : []
  }

  setOfficialModels(models) {
    const next = normalizeOfficialModels(models)
    const nextKeys = new Set(next.map((model) => model.key))
    for (const previous of Array.isArray(this.state.officialModels) ? this.state.officialModels : []) {
      if (previous && previous.key && !nextKeys.has(previous.key)) this.deleteOfficialArtifacts(previous.key)
    }
    this.state.officialModels = next
    if (!this.state.officialEvidenceVersion) this.state.officialEvidenceVersion = 1
    this.markMeta('officialModels', 'officialEvidenceVersion')
    this.scheduleSave(this.pendingScanner, 'official-model-change')
    return this.state.officialModels
  }

  markOfficialArtifactsStale(key, reasons = [], error = null, only = 'both') {
    let changed = false
    const collections = only === 'baseline'
      ? [this.state.officialBaselines]
      : only === 'calibration'
        ? [this.state.similarityCalibration]
        : [this.state.officialBaselines, this.state.similarityCalibration]
    for (const collection of collections) {
      const artifact = collection && collection[key]
      if (!artifact) continue
      artifact.stale = true
      artifact.staleReasons = Array.isArray(reasons) ? reasons.slice() : []
      artifact.staleError = error ? String(error) : null
      changed = true
    }
    if (changed) {
      this.markMeta('officialBaselines', 'similarityCalibration')
      this.scheduleSave(this.pendingScanner, 'artifact-stale')
    }
    return changed
  }

  deleteOfficialArtifacts(key) {
    let removed = false
    if (key && this.state.officialBaselines && this.state.officialBaselines[key]) {
      delete this.state.officialBaselines[key]
      removed = true
    }
    if (key && this.state.similarityCalibration && this.state.similarityCalibration[key]) {
      delete this.state.similarityCalibration[key]
      removed = true
    }
    if (removed) {
      this.markMeta('officialBaselines', 'similarityCalibration')
      this.scheduleSave(this.pendingScanner, 'artifact-delete')
    }
    return removed
  }

  officialBaseline(key) {
    return this.state.officialBaselines && this.state.officialBaselines[key] ? this.state.officialBaselines[key] : null
  }

  saveOfficialBaseline(baseline) {
    if (!baseline || !baseline.key) return null
    if (!this.state.officialBaselines) this.state.officialBaselines = {}
    this.state.officialBaselines[baseline.key] = baseline
    this.markMeta('officialBaselines')
    this.scheduleSave(this.pendingScanner, 'baseline-save')
    return baseline
  }

  calibrationFor(key) {
    return this.state.similarityCalibration && this.state.similarityCalibration[key] ? this.state.similarityCalibration[key] : null
  }

  saveCalibration(key, calibration) {
    if (!key || !calibration) return null
    if (!this.state.similarityCalibration) this.state.similarityCalibration = {}
    this.state.similarityCalibration[key] = calibration
    this.markMeta('similarityCalibration')
    this.scheduleSave(this.pendingScanner, 'calibration-save')
    return calibration
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
    this.markMeta('probes')
    this.scheduleSave(this.pendingScanner, 'probe-save')
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
    this.markMeta('labels')
    this.scheduleSave(this.pendingScanner, 'label-change')
    return this.state.labels[id] || null
  }

  scheduleSave(scanner, reason = 'change') {
    if (this.closed || this.closing) return
    if (scanner) this.pendingScanner = scanner
    this.dirty = true
    this.reason = reason
    if (this.saving) {
      this.dirtyAgain = true
      this.status = 'dirtyWhileWriting'
      return
    }
    this.status = 'scheduled'
    if (this.saveTimer) clearTimeout(this.saveTimer)
    const elapsed = Date.now() - this.lastSaveAt
    const delay = Math.max(SAVE_DELAY_MS, MIN_SAVE_INTERVAL_MS - elapsed, 0)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save(this.pendingScanner, reason).catch(() => {})
    }, delay)
    this.saveTimer.unref?.()
  }

  collectChanges(scanner) {
    const started = Date.now()
    const active = scanner || this.pendingScanner
    if (active && typeof active.checkoutChanges !== 'function') {
      throw new Error('scanner does not support incremental persistence')
    }
    const delta = active ? active.checkoutChanges() : { token: 0, observations: [], deleted: [], files: null }
    const metadata = []
    for (const [key, revision] of this.metadataDirty) {
      const value = typeof structuredClone === 'function'
        ? structuredClone(this.state[key])
        : JSON.parse(JSON.stringify(this.state[key]))
      metadata.push({ key, revision, value })
    }
    const changes = {
      scanner: active,
      token: Number(delta && delta.token) || 0,
      observations: Array.isArray(delta && delta.observations) ? delta.observations : [],
      deleted: Array.isArray(delta && delta.deleted) ? delta.deleted : [],
      files: delta && delta.files ? delta.files : null,
      metadata,
      reset: this.resetBeforeNextWrite,
    }
    this.diagnostics.pendingCount = changes.observations.length + changes.deleted.length
    this.diagnostics.serializeDurationMs = Date.now() - started
    if (this.diagnostics.serializeDurationMs > 100) {
      this.diagnostics.lastWarning = 'change collection exceeded 100 ms'
      this.logger?.warn?.(`model-fingerprint: change collection took ${this.diagnostics.serializeDurationMs} ms`)
    }
    return changes
  }

  async ensureManifest() {
    if (this.manifest) return this.manifest
    let base = null
    try {
      const stat = await fs.stat(this.file)
      const bytes = await fs.readFile(this.file)
      base = { path: STATE_FILE, size: stat.size, sha256: createHash('sha256').update(bytes).digest('hex') }
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
    }
    this.manifest = await createManifest(this.root, { base })
    this.journalValidBytes = 0
    this.diagnostics.migrationStage = base ? 'journal-attached' : 'journal-created'
    return this.manifest
  }

  checkpointRecords(changes) {
    const records = []
    if (changes.reset) records.push({ type: 'reset' })
    for (const observation of changes.observations) {
      if (observation && observation.id) records.push({ type: 'obs', value: observation })
    }
    for (const id of changes.deleted) if (id) records.push({ type: 'obs-delete', id })
    if (changes.files) records.push({ type: 'meta', key: 'files', value: changes.files })
    for (const item of changes.metadata) {
      if (this.truthyMetaKeys().has(item.key)) records.push({ type: 'meta', key: item.key, value: item.value })
    }
    return records
  }

  async persistJournal(changes) {
    const records = this.checkpointRecords(changes)
    if (!records.length) return 0
    const manifest = await this.ensureManifest()
    const journalFile = manifest.journal
      ? path.join(path.dirname(journalPaths(this.root).manifest), manifest.journal)
      : journalPaths(this.root).journal
    const current = await fs.stat(journalFile).catch(() => null)
    if (current) {
      if (this.journalValidBytes === 0) this.journalValidBytes = current.size
      // A failed or interrupted append can leave a torn final line. Never
      // concatenate the next batch behind it; truncate to the last verified
      // byte boundary first. The scanner records are still pending, so the
      // same batch is retried from the in-memory queue.
      if (current.size > this.journalValidBytes) {
        await truncateJournal(this.root, manifest, this.journalValidBytes)
        this.logger?.warn?.(`model-fingerprint: truncated ${current.size - this.journalValidBytes} torn journal byte(s) before append`)
      }
    }
    let written = 0
    for (let index = 0; index < records.length; index += MAX_BATCH_RECORDS) {
      const batch = records.slice(index, index + MAX_BATCH_RECORDS)
      const result = await appendJournal(this.root, batch, manifest)
      written += result.records
      this.journalValidBytes += result.bytes
      this.diagnostics.batchSize = batch.length
      this.diagnostics.queueLength = records.length - index - batch.length
    }
    this.manifest = await updateManifest(this.root, this.manifest, {
      counts: {
        observations: changes.scanner && Number.isFinite(changes.scanner.size) ? changes.scanner.size : null,
        labels: Object.keys(this.state.labels || {}).length,
      },
      journalBytes: this.journalValidBytes,
    })
    this.diagnostics.journalRecords += written
    this.diagnostics.journalBytes = this.journalValidBytes
    return written
  }

  async runSave(scanner, reason = this.reason || 'save') {
    const started = Date.now()
    this.diagnostics.saveReason = reason
    this.diagnostics.dirtyRevision = this.revision
    this.status = 'writing'
    this.dirty = false
    const changes = this.collectChanges(scanner)
    const wrote = await this.persistJournal(changes)
    if (wrote > 0) {
      if (changes.scanner && typeof changes.scanner.ackChanges === 'function') changes.scanner.ackChanges(changes.token)
      for (const item of changes.metadata) {
        if ((this.metadataDirty.get(item.key) || 0) <= item.revision) this.metadataDirty.delete(item.key)
      }
      if (changes.reset) this.resetBeforeNextWrite = false
    }
    this.lastSaveAt = Date.now()
    this.diagnostics.saveDurationMs = this.lastSaveAt - started
    Object.assign(this.diagnostics, this.memorySnapshot())
    if (this.diagnostics.saveDurationMs > 500) {
      this.diagnostics.lastWarning = 'save exceeded 500 ms'
      this.logger?.warn?.(`model-fingerprint: save took ${this.diagnostics.saveDurationMs} ms; status=${this.status}`)
    }
    this.persistedRevision = Math.max(this.persistedRevision, this.revision)
    this.retryCount = 0
    this.diagnostics.retryCount = 0
    const scannerDirty = changes.scanner && typeof changes.scanner.hasPendingChanges === 'function' && changes.scanner.hasPendingChanges()
    this.dirty = this.dirty || scannerDirty || this.metadataDirty.size > 0 || this.resetBeforeNextWrite
    this.status = this.dirtyAgain || this.dirty ? 'dirty' : 'clean'
    return wrote
  }

  save(scanner, reason = this.reason || 'save') {
    if (this.closed) return Promise.reject(new Error('store is closed'))
    if (scanner) this.pendingScanner = scanner
    this.dirty = true
    this.reason = reason
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.saving) {
      this.dirtyAgain = true
      this.status = 'dirtyWhileWriting'
      return this.saving
    }
    this.saving = (async () => {
      let passes = 0
      do {
        this.dirtyAgain = false
        await this.runSave(scanner, reason)
        passes += 1
      } while ((this.dirtyAgain || this.dirty) && passes < 2)
    })().catch((error) => {
      this.handleFailure(error)
      throw error
    }).finally(() => {
      this.saving = null
      if ((this.dirty || this.dirtyAgain) && !this.closed && !this.closing) {
        this.status = 'dirty'
        this.scheduleSave(scanner, 'merged-after-write')
      }
    })
    return this.saving
  }

  handleFailure(error) {
    this.dirty = true
    this.status = 'failed'
    this.retryCount += 1
    this.diagnostics.retryCount = this.retryCount
    this.diagnostics.error = error && error.message ? error.message : String(error)
    this.logger?.warn?.(`model-fingerprint: persistence failed (${this.diagnostics.error})`)
    if (this.closed || this.closing || this.retryTimer) return
    const delay = Math.min(60000, 1000 * 2 ** Math.min(6, this.retryCount))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.save(this.pendingScanner, 'retry').catch(() => {})
    }, delay)
    this.retryTimer.unref?.()
  }

  async flush(scanner, { timeoutMs = SHUTDOWN_FLUSH_MS } = {}) {
    if (this.closed) return
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const deadline = Date.now() + Math.max(1, timeoutMs)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.saving) {
        const finished = await completesWithin(this.saving, deadline - Date.now())
        if (!finished && this.saving) {
          this.status = 'failed'
          this.logger?.warn?.('model-fingerprint: flush deadline exceeded while a write was active')
          return false
        }
      }
      if (Date.now() >= deadline) break
      const scannerPending = scanner && typeof scanner.hasPendingChanges === 'function' && scanner.hasPendingChanges()
      if (!this.dirty && !this.metadataDirty.size && !scannerPending && !this.resetBeforeNextWrite) return true
      this.dirty = true
      const finished = await completesWithin(this.save(scanner, 'flush'), deadline - Date.now())
      if (!finished) {
        this.logger?.warn?.('model-fingerprint: flush deadline exceeded; pending journal changes remain recoverable in memory')
        break
      }
    }
    if (Date.now() >= deadline) {
      this.status = 'failed'
      this.logger?.warn?.('model-fingerprint: flush deadline exceeded; dirty state retained in memory')
      return false
    }
    return !this.dirty && !this.dirtyAgain && !this.metadataDirty.size && !this.resetBeforeNextWrite
  }

  async close(scanner, options = {}) {
    if (this.closed) return true
    this.closing = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.saveTimer = null
    this.retryTimer = null
    const flushed = await this.flush(scanner, options).catch(() => false)
    this.closed = true
    this.closing = false
    this.status = 'closed'
    return flushed
  }

  stats() {
    return {
      ...this.diagnostics,
      status: this.status,
      dirty: this.dirty,
      dirtyAgain: this.dirtyAgain,
      inFlight: Boolean(this.saving),
      revision: this.revision,
      persistedRevision: this.persistedRevision,
      journalRecords: this.diagnostics.journalRecords,
      manifest: this.manifest ? this.manifest.generation : null,
    }
  }
}
