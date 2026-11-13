import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FingerprintStore } from '../lib/store.mjs'

test('compressed state round-trips labels and observations', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-store-'))
  const store = new FingerprintStore({ home })
  await store.load()
  const observation = { id: 's:1', sessionId: 's', seq: 1, time: 1, fingerprint: 'fp_aaaaaaaaaaaa' }
  const fakeScanner = { serialize: () => ({ files: { 'a.jsonl': { size: 1 } }, observations: { 's:1': observation } }) }
  await store.save(fakeScanner)
  await store.flush(fakeScanner)
  await store.setLabel('fp_aaaaaaaaaaaa', 'actual-model', 'note')
  await store.flush(fakeScanner)
  store.addProbes([{ id: 'probe:1', routeKey: 'p/m', time: 2, probe: true }])
  store.setOfficialModels([{ provider: 'official', model: 'm' }])
  store.saveOfficialBaseline({ key: 'official/m', samples: 20, ready: true })
  store.saveCalibration('official/m', { calibrated: true, cutoff: 1 })
  await store.flush(fakeScanner)

  const files = await fs.readdir(path.join(home, 'model-fingerprint'))
  assert.ok(files.includes('state.json.zst'))
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
})
