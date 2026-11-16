import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDriftReport, buildSessionUnits } from '../lib/drift.mjs'

function observation(index, sessionId, value, overrides = {}) {
  return {
    id: sessionId + ':' + index,
    sessionId,
    time: 1000 + index,
    fingerprint: 'fp_' + (overrides.fingerprint || 'aaaaaaaaaaaa'),
    routeKey: overrides.routeKey || 'p/m',
    behavior: {
      tokensPerChar: value,
      jsonSpacing: 0.5,
      reasoningRatio: 0.2,
      charsPerChunk: 20,
      escapedUnicode: 0,
      asciiRatio: 0.8,
      cjkRatio: 0.1,
      punctuationRatio: 0.05,
      markdownPerK: 2,
      newlineRatio: 0.03,
    },
  }
}

test('drift uses sessions as units and detects a clear behavior shift', () => {
  const rows = []
  for (let session = 0; session < 12; session += 1) {
    const value = session < 6 ? 0.2 : 0.8
    for (let repeat = 0; repeat < 5; repeat += 1) {
      rows.push(observation(session * 10 + repeat, 's' + session, value))
    }
  }
  const units = buildSessionUnits(rows)
  assert.equal(units.length, 12)
  const report = buildDriftReport(rows)
  assert.equal(report.unit, 'underlying-session')
  assert.equal(report.sessions, 12)
  assert.equal(report.status, 'drift')
  assert.ok(report.changePoints.some((item) => item.field === 'tokensPerChar'))
})

test('drift does not treat many observations in one session as independent samples', () => {
  const rows = Array.from({ length: 50 }, (_, index) => observation(index, 'one', 0.2))
  const report = buildDriftReport(rows)
  assert.equal(report.sessions, 1)
  assert.equal(report.status, 'insufficient-sessions')
  assert.deepEqual(report.changePoints, [])
})

test('route transitions are reported without claiming model identity', () => {
  const rows = []
  for (let session = 0; session < 8; session += 1) {
    rows.push(observation(session, 's' + session, 0.2, {
      fingerprint: session < 4 ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb',
      routeKey: session < 4 ? 'p/m-old' : 'p/m-new',
    }))
  }
  const report = buildDriftReport(rows)
  assert.equal(report.status, 'drift')
  assert.ok(report.routeTransitions.length >= 1)
  assert.equal(report.routeTransitions[0].identityEligible, false)
  assert.equal(report.routeTransitions[0].type, 'fingerprint')
})
