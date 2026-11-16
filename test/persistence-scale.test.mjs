import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { FingerprintStore } from '../lib/store.mjs'
import { SessionScanner } from '../lib/scan.mjs'

const requested = Number(process.env.MF_PERSISTENCE_COUNT || 1000)
const count = Math.max(1, Math.min(250000, Number.isFinite(requested) ? Math.floor(requested) : 1000))

test(`incremental persistence at ${count} observations`, { timeout: count >= 100000 ? 120000 : 30000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-persistence-scale-'))
  const scanner = new SessionScanner({ roots: [] })
  const padding = 'x'.repeat(64)
  for (let index = 0; index < count; index += 1) {
    const sessionId = 'session-' + Math.floor(index / 100)
    scanner.addObservation({
      id: sessionId + ':' + index,
      sessionId,
      seq: index,
      time: index + 1,
      turn: index % 100,
      step: 1,
      provider: 'synthetic',
      model: 'scale-test',
      fingerprint: 'fp_aaaaaaaaaaaa',
      routeKey: 'synthetic/scale-test',
      behavior: { tokensPerChar: 0.25, charsPerChunk: 20, reasoningRatio: 0.1 },
      protocol: { api: 'test', adapter: 'test', padding },
    })
  }
  scanner.serialize = () => { throw new Error('full serialization is forbidden') }
  const store = new FingerprintStore({ home })
  await store.load()
  const monitor = monitorEventLoopDelay({ resolution: 10 })
  monitor.enable()
  const started = performance.now()
  await store.save(scanner, 'scale-test')
  const elapsed = performance.now() - started
  monitor.disable()
  assert.equal(scanner.hasPendingChanges(), false)
  assert.equal(store.stats().status, 'clean')
  assert.equal(store.stats().inFlight, false)
  if (process.env.MF_PERSISTENCE_ASSERT_BLOCK === '1') {
    assert.ok(monitor.max / 1e6 < 100, 'one save must not block the event loop for 100 ms')
  }
  const reloaded = new FingerprintStore({ home })
  await reloaded.load()
  assert.equal(Object.keys(reloaded.state.observations).length, count)
  scanner.stop()
  await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  console.log(`persistence-scale count=${count} saveMs=${Math.round(elapsed)} maxBlockMs=${Math.round(monitor.max / 1e6)}`)
})
