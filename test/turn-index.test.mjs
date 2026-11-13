import test from 'node:test'
import assert from 'node:assert/strict'
import { recordTurnIndex, listSessionTurns, normalizeTurnIndex, turnIndexFromObservations } from '../lib/turn-index.mjs'

test('turn index aggregates observations and keeps old turns addressable', () => {
  const index = {}
  recordTurnIndex(index, { sessionId: 's1', turn: 1, seq: 1, time: 100, fingerprint: 'fp_a', model: 'm1' })
  recordTurnIndex(index, { sessionId: 's1', turn: 1, seq: 2, time: 120, fingerprint: 'fp_b', model: 'm2' })
  recordTurnIndex(index, { sessionId: 's1', turn: 2, seq: 3, time: 200, fingerprint: 'fp_c', model: 'm3' })
  const row = index.s1['1']
  assert.equal(row.steps, 2)
  assert.equal(row.startTime, 100)
  assert.equal(row.endTime, 120)
  assert.equal(row.primaryFingerprint, 'fp_b')
  assert.equal(row.primaryModel, 'm2')
  const page = listSessionTurns(index, 's1', { limit: 1 })
  assert.equal(page.turns[0].turn, 2)
  assert.equal(page.hasMore, true)
  assert.equal(page.nextBefore, 2)
  const older = listSessionTurns(index, 's1', { before: 2, limit: 10 })
  assert.equal(older.turns.length, 1)
  assert.equal(older.turns[0].turn, 1)
})

test('turn index normalizes persisted rows and rebuilds from observations', () => {
  const normalized = normalizeTurnIndex({ s1: { '3': { turn: 3, steps: 2, time: 9 } } })
  assert.equal(normalized.s1['3'].status, 'observed')
  const rebuilt = turnIndexFromObservations([
    { sessionId: 's2', turn: 4, seq: 1, time: 10, fingerprint: 'fp_x', model: 'mx' },
  ])
  assert.equal(rebuilt.s2['4'].steps, 1)
})
