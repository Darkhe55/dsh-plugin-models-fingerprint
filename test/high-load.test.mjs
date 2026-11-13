import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { recordTurnIndex, listSessionTurns } from '../lib/turn-index.mjs'

test('ten thousand turn index remains pageable under a small budget', () => {
  const index = {}
  const started = Date.now()
  for (let turn = 1; turn <= 10000; turn += 1) {
    recordTurnIndex(index, {
      sessionId: 's',
      turn,
      seq: turn,
      time: turn,
      fingerprint: 'fp_' + String(turn % 97).padStart(12, '0'),
      model: 'model-' + (turn % 5),
    })
  }
  const first = listSessionTurns(index, 's', { limit: 200 })
  assert.equal(first.turns.length, 200)
  assert.equal(first.turns[0].turn, 10000)
  assert.equal(first.hasMore, true)
  assert.equal(first.nextBefore, 9801)
  const deep = listSessionTurns(index, 's', { before: 5000, limit: 200 })
  assert.equal(deep.turns[0].turn, 4999)
  assert.equal(deep.turns[199].turn, 4800)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2000, 'indexing/page selection should stay bounded, got ' + elapsed + 'ms')
})

test('client window keeps a bounded focused subset of ten thousand turns', async () => {
  const source = await fs.readFile(new URL('../client/window-store.js', import.meta.url), 'utf8')
  const Store = new Function(source + '\nreturn TurnWindowStore')()
  const store = new Store(2000)
  const turns = []
  for (let turn = 1; turn <= 10000; turn += 1) turns.push({ id: 's:' + turn, turn })
  store.merge(turns)
  assert.equal(store.size, 10000)
  assert.equal(store.pruneAround(5000), true)
  assert.ok(store.size <= 2000)
  const kept = store.turns()
  assert.ok(kept.some((row) => row.turn === 5000))
  assert.ok(kept.some((row) => row.turn === 5001))
  assert.ok(kept.every((row) => Math.abs(row.turn - 5000) <= 1000))
})
