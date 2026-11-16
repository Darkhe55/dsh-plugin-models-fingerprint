import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionScanner } from '../lib/scan.mjs'
import { buildReport } from '../lib/summary.mjs'

function row(index, sessionId = 's1', fingerprint = 'fp_aaaaaaaaaaaa') {
  return {
    id: sessionId + ':' + index,
    sessionId,
    seq: index,
    time: 1000 + index,
    provider: 'p',
    model: 'm',
    routeKey: 'p/m',
    fingerprint,
    protocol: { api: 'x', adapter: 'y' },
    behavior: { tokensPerChar: 0.3, charsPerChunk: 20 },
  }
}

test('report summaries are reused until the affected group changes', () => {
  const scanner = new SessionScanner({ roots: [] })
  for (let index = 0; index < 8; index += 1) scanner.addObservation(row(index))
  const first = buildReport(scanner, {}, { limit: 20 })
  assert.equal(first.stats.observations, 8)
  assert.ok(scanner.reportIndex.stats().cachedSummaries >= 3)
  const fingerprint = scanner.reportIndex.summarize('fingerprint', 'fp_aaaaaaaaaaaa', () => { throw new Error('must be cached') })
  const second = buildReport(scanner, {}, { limit: 20 })
  assert.equal(second.fingerprints[0].observations, 8)
  assert.equal(scanner.reportIndex.summarize('fingerprint', 'fp_aaaaaaaaaaaa', () => fingerprint), fingerprint)

  scanner.addObservation(row(9, 's1', 'fp_bbbbbbbbbbbb'))
  const third = buildReport(scanner, {}, { limit: 20 })
  assert.equal(third.stats.observations, 9)
  assert.equal(third.fingerprints.length, 2)

  const labeled = buildReport(scanner, { fp_aaaaaaaaaaaa: { label: 'actual', note: null } }, { limit: 20 })
  assert.equal(labeled.fingerprints.find((item) => item.id === 'fp_aaaaaaaaaaaa').label, 'actual')
  scanner.stop()
})
