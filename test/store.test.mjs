import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FingerprintStore } from '../lib/store.mjs'
import { SessionScanner } from '../lib/scan.mjs'
import { journalPaths } from '../lib/journal.mjs'

test('compressed state round-trips labels and observations', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-store-'))
  const store = new FingerprintStore({ home })
  await store.load()
  const observation = { id: 's:1', sessionId: 's', seq: 1, time: 1, fingerprint: 'fp_aaaaaaaaaaaa' }
  const scanner = new SessionScanner({ roots: [] })
  scanner.serialize = () => { throw new Error('runtime persistence must not call serialize') }
  scanner.addObservation(observation)
  scanner.files.set('a.jsonl', { size: 1 })
  scanner.markFilesChanged()
  await store.save(scanner)
  await store.flush(scanner)
  await store.setLabel('fp_aaaaaaaaaaaa', 'actual-model', 'note')
  await store.flush(scanner)
  store.addProbes([{ id: 'probe:1', routeKey: 'p/m', time: 2, probe: true }])
  store.setOfficialModels([{ provider: 'official', model: 'm' }])
  store.saveOfficialBaseline({ key: 'official/m', samples: 20, ready: true })
  store.saveCalibration('official/m', { calibrated: true, cutoff: 1 })
  await store.flush(scanner)

  const files = await fs.readdir(path.join(home, 'model-fingerprint'))
  assert.ok(files.includes('journal-v3'))
  assert.ok(!files.includes('state.json'))

  const reloaded = new FingerprintStore({ home })
  await reloaded.load()
  assert.equal(reloaded.labels().fp_aaaaaaaaaaaa.label, 'actual-model')
  assert.equal(reloaded.state.observations['s:1'].sessionId, 's')
  assert.equal(reloaded.state.files['a.jsonl'].size, 1)
  assert.equal(reloaded.probes()[0].id, 'probe:1')
  assert.equal(reloaded.officialModels()[0].provider, 'official')
  assert.equal(reloaded.officialBaseline('official/m').samples, 20)
  assert.equal(reloaded.calibrationFor('official/m').calibrated, true)
  reloaded.setOfficialModels([])
  assert.equal(reloaded.officialBaseline('official/m'), null, 'deleting an official source clears its baseline')
  assert.equal(reloaded.calibrationFor('official/m'), null, 'deleting an official source clears its calibration')
})

test('a failed append does not acknowledge scanner changes', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-store-fail-'))
  await fs.writeFile(path.join(home, 'model-fingerprint'), 'blocks directory creation')
  const store = new FingerprintStore({ home, logger: { warn() {} } })
  await store.load()
  const scanner = new SessionScanner({ roots: [] })
  scanner.addObservation({ id: 's:1', sessionId: 's', seq: 1, time: 1, fingerprint: 'fp_aaaaaaaaaaaa' })
  await assert.rejects(store.save(scanner))
  assert.equal(scanner.hasPendingChanges(), true)
})

test('changes during an active write are acknowledged only after a merged pass', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-store-merge-'))
  const store = new FingerprintStore({ home })
  await store.load()
  const scanner = new SessionScanner({ roots: [] })
  scanner.addObservation({ id: 's:1', sessionId: 's', seq: 1, time: 1, fingerprint: 'fp_aaaaaaaaaaaa' })
  const first = store.save(scanner, 'first')
  scanner.addObservation({ id: 's:2', sessionId: 's', seq: 2, time: 2, fingerprint: 'fp_aaaaaaaaaaaa' })
  await first
  await store.flush(scanner)
  assert.equal(store.stats().inFlight, false)
  assert.equal(scanner.hasPendingChanges(), false)
  const reloaded = new FingerprintStore({ home })
  await reloaded.load()
  assert.deepEqual(Object.keys(reloaded.state.observations).sort(), ['s:1', 's:2'])
})

test('journal growth recommends offline compaction without doing a full write', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-store-compact-'))
  const store = new FingerprintStore({ home })
  store.compactionBytes = 1
  await store.load()
  const scanner = new SessionScanner({ roots: [] })
  scanner.addObservation({ id: 's:1', sessionId: 's', seq: 1, time: 1, fingerprint: 'fp_aaaaaaaaaaaa' })
  await store.save(scanner, 'compaction-signal')
  assert.equal(store.stats().compaction.recommended, true)
  assert.equal(store.stats().compaction.reasons.includes('journal-bytes'), true)
  assert.equal(scanner.hasPendingChanges(), false)
})

test('a torn journal tail is ignored and truncated before the next append', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-store-torn-'))
  const store = new FingerprintStore({ home })
  await store.load()
  const scanner = new SessionScanner({ roots: [] })
  scanner.addObservation({ id: 's:1', sessionId: 's', seq: 1, time: 1, fingerprint: 'fp_aaaaaaaaaaaa' })
  await store.save(scanner, 'initial')
  const journal = journalPaths(path.join(home, 'model-fingerprint')).journal
  await fs.appendFile(journal, '{"v":1,"type":"obs"')

  const reloaded = new FingerprintStore({ home })
  await reloaded.load()
  assert.equal(Object.keys(reloaded.state.observations).length, 1)
  const afterLoad = await fs.stat(journal)
  assert.equal(Number.isInteger(afterLoad.size), true)
  const beforeAppend = (await fs.readFile(journal)).toString('utf8')
  assert.equal(beforeAppend.endsWith('\n'), true, 'load must remove the torn tail')

  const next = new SessionScanner({ roots: [] })
  next.addObservation({ id: 's:2', sessionId: 's', seq: 2, time: 2, fingerprint: 'fp_aaaaaaaaaaaa' })
  await reloaded.save(next, 'after-torn-tail')
  const final = new FingerprintStore({ home })
  await final.load()
  assert.deepEqual(Object.keys(final.state.observations).sort(), ['s:1', 's:2'])
  assert.equal(reloaded.stats().status, 'clean')
})
