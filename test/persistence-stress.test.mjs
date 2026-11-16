import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FingerprintStore } from '../lib/store.mjs'
import { SessionScanner } from '../lib/scan.mjs'

test('sixty-five thousand observations persist incrementally without a full snapshot', { timeout: 30000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-persistence-stress-'))
  const scanner = new SessionScanner({ roots: [] })
  const padding = 'x'.repeat(256)
  for (let index = 0; index < 65000; index += 1) {
    const sessionId = 'session-' + Math.floor(index / 100)
    scanner.addObservation({
      id: sessionId + ':' + index,
      sessionId,
      seq: index,
      time: index + 1,
      turn: index % 100,
      step: 1,
      provider: 'synthetic',
      model: 'load-test',
      fingerprint: 'fp_aaaaaaaaaaaa',
      protocol: { api: 'test', adapter: 'test', padding },
    })
  }
  scanner.serialize = () => { throw new Error('full serialization is forbidden in runtime persistence') }
  const before = process.memoryUsage().rss
  const store = new FingerprintStore({ home })
  await store.load()
  await store.save(scanner, 'stress-test')
  assert.equal(scanner.hasPendingChanges(), false)
  const afterSave = process.memoryUsage().rss
  assert.ok(afterSave - before < 384 * 1024 * 1024, 'incremental save must not create a full-state-sized memory spike')
  t.diagnostic(`save=${store.stats().saveDurationMs}ms rssDelta=${Math.round((afterSave - before) / 1024 / 1024)}MiB`)

  const reloaded = new FingerprintStore({ home })
  await reloaded.load()
  assert.equal(Object.keys(reloaded.state.observations).length, 65000)
  scanner.stop()
})
