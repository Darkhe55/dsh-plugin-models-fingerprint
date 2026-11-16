/**
 * Isolated persistence benchmark. Run in a child process, never inside DSH:
 *
 *   node --max-old-space-size=2048 scripts/persistence-bench.mjs 1000,65000
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { FingerprintStore } from '../lib/store.mjs'
import { SessionScanner } from '../lib/scan.mjs'
import { journalPaths } from '../lib/journal.mjs'

const counts = String(process.argv[2] || '1000,65000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0)

async function run(count) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-persist-bench-'))
  const scanner = new SessionScanner({ roots: [] })
  const padding = 'x'.repeat(128)
  const addStarted = performance.now()
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
      model: 'load-test',
      fingerprint: 'fp_aaaaaaaaaaaa',
      routeKey: 'synthetic/load-test',
      behavior: { tokensPerChar: 0.25, charsPerChunk: 20, reasoningRatio: 0.1 },
      protocol: { api: 'test', adapter: 'test', padding },
    })
  }
  const addMs = performance.now() - addStarted
  scanner.serialize = () => { throw new Error('runtime persistence must not call serialize') }
  const store = new FingerprintStore({ home })
  await store.load()
  const monitor = monitorEventLoopDelay({ resolution: 10 })
  monitor.enable()
  const saveStarted = performance.now()
  await store.save(scanner, 'benchmark')
  const saveMs = performance.now() - saveStarted
  monitor.disable()
  const maxBlockMs = monitor.max / 1e6
  const memory = process.memoryUsage()
  const journal = journalPaths(path.join(home, 'model-fingerprint')).journal
  const journalBytes = (await fs.stat(journal).catch(() => ({ size: 0 }))).size
  const reloaded = new FingerprintStore({ home })
  const reloadStarted = performance.now()
  await reloaded.load()
  const reloadMs = performance.now() - reloadStarted
  const reloadedCount = Object.keys(reloaded.state.observations).length
  scanner.stop()
  await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  return {
    count,
    addMs: Math.round(addMs),
    saveMs: Math.round(saveMs),
    reloadMs: Math.round(reloadMs),
    maxBlockMs: Math.round(maxBlockMs),
    journalBytes,
    rssMiB: Math.round(memory.rss / 1024 / 1024),
    heapUsedMiB: Math.round(memory.heapUsed / 1024 / 1024),
    reloadedCount,
    storeStatus: store.stats().status,
    batches: store.stats().batchSize,
  }
}

const results = []
for (const count of counts) {
  results.push(await run(count))
}
console.log(JSON.stringify(results, null, 2))
