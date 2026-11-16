import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReport, buildTurns } from '../lib/summary.mjs'

function observation({ id, sessionId = 's1', time, provider = 'p', model = 'm', fingerprint = 'fp_aaaaaaaaaaaa', route } = {}) {
  return {
    id: id || sessionId + ':' + time,
    sessionId,
    seq: time,
    time,
    provider,
    model,
    routeKey: route || provider + '/' + model,
    fingerprint,
    protocol: { api: 'openai-completions', adapter: 'pi-ai@2', wireProvider: provider, responseId: 'hex:32', replay: 'blocks' },
    protocolDetail: { api: 'openai-completions', adapter: 'pi-ai@2', wireProvider: provider, responseIdShape: 'hex:32', toolIdShapes: [], usageKeys: ['inputTokens', 'outputTokens', 'totalTokens'], stopReason: 'stop', blockTypes: 'T', hasReplay: true },
    behavior: {
      tokensPerChar: 0.3, charsPerChunk: 4, cjkRatio: 0.1, newlineRatio: 0.01, markdownPerK: 5, jsonSpacing: 0.5,
      reasoningRatio: 0, ttftMs: 500, streamMs: 1000, textChars: 100, reasoningChars: 0, argChars: 0, chunkCount: 25,
      deltaMedianMs: 20, deltaP90Ms: 30, charsPerSecond: 100, tokensPerSecond: 30,
    },
    timing: { stepStart: time - 500, firstToken: time - 480, lastToken: time - 10 },
    tokens: { input: 10, output: 5, total: 15, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    toolCalls: 0,
    textBlocks: 1,
    reasoningBlocks: 0,
  }
}

function scannerFor(rows) {
  const map = new Map(rows.map((row) => [row.id, row]))
  return {
    observations: map,
    sessionMeta: new Map(rows.map((row) => [row.sessionId, { id: row.sessionId, cwd: 'C:/work' }])),
    status: () => ({ discovered: 1, cachedFiles: 1, observations: map.size, queue: 0, scanning: false, lastScanAt: 1, lastError: null }),
  }
}

test('report separates claimed names from fingerprints and flags a route shift', () => {
  const rows = [
    observation({ time: 100, id: 's1:1' }),
    observation({ time: 200, id: 's1:2' }),
    observation({ time: 300, id: 's1:3' }),
    observation({ time: 400, id: 's1:4', fingerprint: 'fp_bbbbbbbbbbbb' }),
    observation({ time: 500, id: 's2:5', sessionId: 's2', provider: 'p2', model: 'm2', fingerprint: 'fp_aaaaaaaaaaaa' }),
    observation({ time: 600, id: 's1:6', fingerprint: 'fp_bbbbbbbbbbbb' }),
  ]
  const report = buildReport(scannerFor(rows), {}, { limit: 50 })
  assert.equal(report.stats.observations, 6)
  assert.equal(report.stats.fingerprints, 2)
  assert.equal(report.stats.routes, 2)
  assert.equal(report.latest.assessment.verdict, 'changed')
  assert.equal(report.latest.assessment.confidence > 0.2, true)
  assert.equal(report.drift.unit, 'underlying-session')
  assert.equal(report.drift.status, 'insufficient-sessions')
  assert.ok(report.alerts.some((alert) => alert.kind === 'fingerprint-shift'))
  assert.ok(report.alerts.some((alert) => alert.kind === 'alias-collision'))
  const fp = report.fingerprints.find((item) => item.id === 'fp_aaaaaaaaaaaa')
  assert.deepEqual(fp.names.map((item) => item.name), ['m', 'm2'])
  assert.equal(fp.status, 'alias', 'the same fingerprint appears under two claimed names/routes')
})

test('a legacy observation without routeKey does not crash the report', () => {
  const row = observation({ time: 100, id: 's1:1' })
  delete row.routeKey
  delete row.protocol
  const report = buildReport(scannerFor([row]), {}, { limit: 50 })
  assert.equal(report.stats.observations, 1)
  assert.equal(report.routes[0].routeKey, 'p/m')
  assert.equal(report.fingerprints[0].protocol.api, undefined)
})

test('a stable route with enough samples is assessed as consistent', () => {
  const rows = Array.from({ length: 6 }, (_, index) => observation({ time: 100 + index, id: 's1:' + index }))
  const report = buildReport(scannerFor(rows), {}, { limit: 50 })
  assert.equal(report.latest.assessment.verdict, 'consistent')
  assert.equal(report.latest.assessment.confidence >= 0.6, true)
  assert.equal(report.routes[0].status, 'stable')
})

test('human labels are surfaced and can produce a mismatch signal', () => {
  const rows = [
    observation({ time: 100, id: 's1:1' }),
    observation({ time: 200, id: 's1:2' }),
    observation({ time: 300, id: 's1:3' }),
  ]
  const report = buildReport(scannerFor(rows), { fp_aaaaaaaaaaaa: { label: 'actual-model', note: 'billing' } }, { limit: 50 })
  assert.equal(report.fingerprints[0].label, 'actual-model')
  assert.equal(report.stats.labeled, 1)
  assert.ok(report.alerts.some((alert) => alert.kind === 'label-mismatch'))
})

test('buildTurns makes one detection per turn and compares the previous turn', () => {
  const rows = [
    observation({ time: 100, id: 's1:1', fingerprint: 'fp_aaaaaaaaaaaa' }),
    observation({ time: 200, id: 's1:2', fingerprint: 'fp_aaaaaaaaaaaa' }),
    observation({ time: 300, id: 's1:3', fingerprint: 'fp_bbbbbbbbbbbb' }),
  ]
  rows[0].turn = 1
  rows[1].turn = 2
  rows[2].turn = 3
  const turns = buildTurns(rows, 's1')
  assert.equal(turns.length, 3)
  assert.equal(turns[0].turn, 3, 'newest turn first')
  assert.equal(turns[0].verdict, 'changed')
  assert.equal(turns[1].verdict, 'same')
  assert.equal(turns[2].verdict, 'first')
  assert.equal(turns[0].steps, 1)
  assert.equal(turns[0].stepList[0].fingerprint, 'fp_bbbbbbbbbbbb')
})

test('a sustained cross-session behavior shift produces a session-level cue', () => {
  const rows = []
  for (let session = 0; session < 12; session += 1) {
    const row = observation({ time: 100 + session, id: 's' + session + ':1', sessionId: 's' + session })
    row.behavior.tokensPerChar = session < 6 ? 0.3 : 0.8
    rows.push(row)
  }
  const report = buildReport(scannerFor(rows), {}, { limit: 50 })
  assert.ok(report.alerts.some((alert) => alert.kind === 'session-behavior-change'))
  assert.equal(report.drift.unit, 'underlying-session')
})
