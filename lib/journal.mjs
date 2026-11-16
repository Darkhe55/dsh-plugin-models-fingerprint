/**
 * Versioned append-only journal for the fingerprint store.
 *
 * The large legacy state.json.zst remains the immutable base checkpoint. New
 * observations and small metadata changes are appended as checksummed JSONL
 * records. A manifest is the single atomic switch that points at the base and
 * the active journal. No observation payload is ever rewritten in place.
 */
import { promises as fs } from 'node:fs'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { crc32 } from 'node:zlib'

export const JOURNAL_VERSION = 3
export const JOURNAL_DIR = 'journal-v3'
export const MANIFEST_FILE = 'manifest.json'
export const JOURNAL_FILE = 'journal-000001.jsonl'

async function syncHandle(handle) {
  try {
    await handle.sync()
  } catch (error) {
    const unsupportedOnWindows = process.platform === 'win32' && error && ['EPERM', 'EINVAL', 'ENOTSUP'].includes(error.code)
    if (!unsupportedOnWindows) throw error
  }
}

export function journalPaths(root) {
  const dir = path.join(root, JOURNAL_DIR)
  return {
    dir,
    manifest: path.join(dir, MANIFEST_FILE),
    journal: path.join(dir, JOURNAL_FILE),
    checkpoint: path.join(root, 'state.json.zst'),
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  const handle = await fs.open(tmp, 'r')
  try {
    await syncHandle(handle)
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, file)
}

export async function readManifest(root) {
  const paths = journalPaths(root)
  try {
    const raw = await fs.readFile(paths.manifest, 'utf8')
    const value = JSON.parse(raw)
    if (!value || value.formatVersion !== JOURNAL_VERSION) return null
    if (!value.journal || typeof value.journal !== 'string') return null
    return value
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    return null
  }
}

export async function createManifest(root, { base, journalFile = JOURNAL_FILE }) {
  const paths = journalPaths(root)
  const manifest = {
    formatVersion: JOURNAL_VERSION,
    active: 'journal',
    base: base || null,
    journal: journalFile,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    generation: 'j' + Date.now().toString(36) + '-' + process.pid.toString(36),
  }
  await fs.mkdir(paths.dir, { recursive: true })
  await writeJsonAtomic(paths.manifest, manifest)
  const journalPath = path.join(paths.dir, manifest.journal)
  try {
    await fs.access(journalPath)
  } catch {
    await fs.writeFile(journalPath, '', { mode: 0o600 })
  }
  return manifest
}

export async function updateManifest(root, manifest, patch = {}) {
  const next = { ...manifest, ...patch, updatedAt: Date.now() }
  await writeJsonAtomic(journalPaths(root).manifest, next)
  return next
}

function encodedLine(record) {
  const body = { v: 1, type: record.type, ...record }
  delete body.crc
  const json = JSON.stringify(body)
  return JSON.stringify({ ...body, crc: crc32(Buffer.from(json)).toString(16) }) + '\n'
}

/**
 * Append a batch. The caller is the only writer; a crash may leave one torn
 * final line, which readJournal ignores and truncates before the next append.
 */
export async function appendJournal(root, records, manifest = null) {
  if (!Array.isArray(records) || !records.length) return { bytes: 0, records: 0 }
  const file = manifest && manifest.journal
    ? path.join(path.dirname(journalPaths(root).manifest), manifest.journal)
    : journalPaths(root).journal
  await fs.mkdir(path.dirname(file), { recursive: true })
  const payload = Buffer.from(records.map(encodedLine).join(''), 'utf8')
  const handle = await fs.open(file, 'a')
  try {
    await handle.write(payload)
    await syncHandle(handle)
  } finally {
    await handle.close()
  }
  return { bytes: payload.length, records: records.length }
}

export async function readJournal(root, manifest, { collect = true, onRecord } = {}) {
  const file = path.join(path.dirname(journalPaths(root).manifest), manifest && manifest.journal ? manifest.journal : JOURNAL_FILE)
  let stat
  try {
    stat = await fs.stat(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { records: [], validBytes: 0, badLines: 0, size: 0, file }
    throw error
  }
  const records = []
  let validBytes = 0
  let badLines = 0
  let recordCount = 0
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line) {
      validBytes += 1
      continue
    }
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (validBytes + lineBytes >= stat.size) {
      // A record without its terminating newline may be a torn append. Never
      // apply it, otherwise the next append would concatenate two JSON values.
      badLines += 1
      break
    }
    let value
    try {
      value = JSON.parse(line)
    } catch {
      badLines += 1
      break
    }
    if (!value || value.v !== 1) {
      badLines += 1
      break
    }
    const expected = value.crc
    const body = { ...value }
    delete body.crc
    let actual = null
    try {
      actual = crc32(Buffer.from(JSON.stringify(body))).toString(16)
    } catch {
      actual = null
    }
    if (expected !== actual) {
      badLines += 1
      break
    }
    if (collect) records.push(body)
    if (typeof onRecord === 'function') await onRecord(body)
    recordCount += 1
    validBytes += lineBytes + 1
  }
  lines.close()
  input.destroy()
  return { records, recordCount, validBytes, badLines, size: stat.size, file }
}

export async function truncateJournal(root, manifest, validBytes) {
  const file = path.join(path.dirname(journalPaths(root).manifest), manifest && manifest.journal ? manifest.journal : JOURNAL_FILE)
  const stat = await fs.stat(file).catch(() => null)
  if (!stat || stat.size <= validBytes) return false
  await fs.truncate(file, validBytes)
  return true
}
