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

test('official similarity scoring stays bounded for a thousand observations', async () => {
  const { buildOfficialProfile, scoreSimilarity } = await import('../lib/similarity.mjs')
  const make = (index, provider, model) => ({
    id: 's:' + index,
    provider,
    model,
    time: index,
    fingerprint: 'fp_a',
    behavior: {
      tokensPerChar: 0.2 + (index % 3) * 0.001,
      charsPerChunk: 4,
      reasoningRatio: 0.1,
      jsonSpacing: 0.5,
      cjkRatio: 0.1,
      asciiRatio: 0.8,
      punctuationRatio: 0.05,
      markdownPerK: 2,
      escapedUnicode: 0,
      newlineRatio: 0.02,
    },
  })
  const rows = Array.from({ length: 1000 }, (_, index) => make(index, 'official', 'm'))
  const started = Date.now()
  const baseline = buildOfficialProfile(rows, { provider: 'official', model: 'm', minSamples: 20 })
  const score = scoreSimilarity(rows.slice(-50), baseline, null)
  const elapsed = Date.now() - started
  assert.equal(baseline.ready, true)
  assert.ok(score.score >= 0 && score.score <= 1)
  assert.ok(elapsed < 2000, 'similarity budget exceeded: ' + elapsed + 'ms')
})

test('one hundred thousand turn index still pages within budget', () => {
  const index = {}
  const started = Date.now()
  for (let turn = 1; turn <= 100000; turn += 1) {
    recordTurnIndex(index, { sessionId: 'bulk', turn, seq: turn, time: turn, fingerprint: 'fp_bulk' })
  }
  const page = listSessionTurns(index, 'bulk', { limit: 200 })
  const elapsed = Date.now() - started
  assert.equal(page.turns.length, 200)
  assert.equal(page.turns[0].turn, 100000)
  assert.equal(page.hasMore, true)
  assert.ok(elapsed < 5000, '100k index budget exceeded: ' + elapsed + 'ms')
})
