/**
 * Offline checkpoint/compaction utility.
 *
 * Run only with DSH stopped. It reads the current manifest + journal in an
 * isolated Node process, writes a new zstd checkpoint, verifies it, and only
 * then atomically switches the manifest. The old checkpoint and journal are
 * never modified.
 *
 *   node scripts/compact-state.mjs --home "$env:USERPROFILE\.dsh"
 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import { zstdCompress } from 'node:zlib'
import { FingerprintStore, DATA_VERSION } from '../lib/store.mjs'
import { STATE_VERSION } from '../lib/core.mjs'
import { createManifest, journalPaths, readManifest } from '../lib/journal.mjs'

const compress = promisify(zstdCompress)

async function syncBestEffort(handle) {
  try {
    await handle.sync()
  } catch (error) {
    const unsupportedOnWindows = process.platform === 'win32' && error && ['EPERM', 'EINVAL', 'ENOTSUP'].includes(error.code)
    if (!unsupportedOnWindows) throw error
  }
}
const homeIndex = process.argv.indexOf('--home')
const home = homeIndex >= 0 ? process.argv[homeIndex + 1] : path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
if (!home) throw new Error('usage: node scripts/compact-state.mjs --home <DSH_HOME>')
const root = path.join(home, 'model-fingerprint')

function digestState(state) {
  const hash = createHash('sha256')
  for (const id of Object.keys(state.observations || {}).sort()) hash.update(id + '\n')
  hash.update(JSON.stringify({
    labels: Object.keys(state.labels || {}).sort(),
    official: (state.officialModels || []).map((model) => model.key).sort(),
    baselines: Object.keys(state.officialBaselines || {}).sort(),
    calibration: Object.keys(state.similarityCalibration || {}).sort(),
    files: Object.keys(state.files || {}).sort(),
    probes: Object.keys(state.probes || {}).sort(),
  }))
  return hash.digest('hex')
}

async function main() {
  const beforeManifest = await readManifest(root)
  const store = new FingerprintStore({ home })
  await store.load()
  const before = {
    observations: Object.keys(store.state.observations || {}).length,
    sessions: new Set(Object.values(store.state.observations || {}).map((row) => row.sessionId)).size,
    digest: digestState(store.state),
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = 'state.compact-' + stamp + '.json.zst'
  const target = path.join(root, filename)
  const payload = {
    version: STATE_VERSION,
    dataVersion: DATA_VERSION,
    semanticDedupe: true,
    createdAt: store.state.createdAt,
    updatedAt: Date.now(),
    labels: store.state.labels || {},
    files: store.state.files || {},
    observations: store.state.observations || {},
    turnIndex: store.state.turnIndex || {},
    officialModels: store.state.officialModels || [],
    officialEvidenceVersion: store.state.officialEvidenceVersion || 0,
    officialBaselines: store.state.officialBaselines || {},
    similarityCalibration: store.state.similarityCalibration || {},
    probes: store.state.probes || {},
  }
  const json = JSON.stringify(payload)
  const compressed = await compress(Buffer.from(json))
  const tmp = target + '.tmp-' + process.pid
  await fs.writeFile(tmp, compressed, { mode: 0o600 })
  const handle = await fs.open(tmp, 'r')
  try { await syncBestEffort(handle) } finally { await handle.close() }
  await fs.rename(tmp, target)

  const check = new FingerprintStore({ home: home })
  const originalManifest = path.join(path.dirname(journalPaths(root).manifest), 'manifest.pre-compact-' + stamp + '.json')
  await fs.mkdir(path.dirname(originalManifest), { recursive: true })
  if (beforeManifest) await fs.writeFile(originalManifest, JSON.stringify(beforeManifest), { mode: 0o600 })
  let switched = false
  try {
    const manifest = await createManifest(root, {
      base: { path: filename, size: compressed.length, sha256: createHash('sha256').update(compressed).digest('hex') },
      journalFile: 'journal-' + stamp + '.jsonl',
    })
    switched = true
    await check.load()
    const after = {
      observations: Object.keys(check.state.observations || {}).length,
      sessions: new Set(Object.values(check.state.observations || {}).map((row) => row.sessionId)).size,
      digest: digestState(check.state),
    }
    if (before.observations !== after.observations || before.sessions !== after.sessions || before.digest !== after.digest) {
      throw new Error('post-compaction verification mismatch')
    }
    console.log(JSON.stringify({
      ok: true,
      filename,
      rawBytes: Buffer.byteLength(json),
      storedBytes: compressed.length,
      manifest: manifest.generation,
      before,
      after,
    }, null, 2))
  } catch (error) {
    if (switched && beforeManifest) {
      await fs.copyFile(originalManifest, journalPaths(root).manifest).catch(() => {})
      console.error('compaction failed; restored the previous manifest')
    }
    throw error
  } finally {
    check.releaseLargeState()
  }
}

await main()
