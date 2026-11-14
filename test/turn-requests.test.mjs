import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

async function loadQueue() {
  const source = await fs.readFile(new URL('../client/turn-requests.js', import.meta.url), 'utf8')
  return new Function(source + '\nreturn TurnRequestQueue')()
}

test('turn request generation, session and revision are checked before merge', async () => {
  const TurnRequestQueue = await loadQueue()
  const resolvers = []
  const received = []
  const queue = new TurnRequestQueue({
    fetchTurn: (turn) => new Promise((resolve) => resolvers.push({ turn, resolve })),
    onTurn: (turn) => received.push(turn.turn),
  })
  queue.request(['5'], [], 0, { sessionId: 's1', revision: 10, generation: '2' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  resolvers[0].resolve({ sessionId: 's1', revision: 9, generation: '2', turn: { turn: 5 } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(received, [], 'older revision is discarded')
  queue.invalidate()
  queue.request(['6'], [], 0, { sessionId: 's1', revision: 11, generation: '3' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  resolvers[1].resolve({ sessionId: 'other', revision: 11, generation: '3', turn: { turn: 6 } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(received, [], 'other session is discarded')
  queue.request(['7'], [], 0, { sessionId: 's1', revision: 11, generation: '3' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  resolvers[2].resolve({ sessionId: 's1', revision: 11, generation: '3', turn: { turn: 7 } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(received, [7])
})

test('turn request queue deduplicates in-flight visible turns and limits the batch', async () => {
  const TurnRequestQueue = await loadQueue()
  const calls = []
  const received = []
  const queue = new TurnRequestQueue({
    limit: 2,
    fetchTurn: (turn) => new Promise((resolve) => { calls.push(turn); setTimeout(() => resolve({ turn: { turn } }), 5) }),
    onTurn: (turn) => received.push(turn.turn),
  })
  const first = queue.request(['17', '18', '19'], [], 0)
  const second = queue.request(['17', '18', '19'], [], 0)
  assert.deepEqual(first, [17, 18])
  assert.deepEqual(second, [17, 18])
  assert.equal(queue.pending, 2)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.deepEqual(calls, [17, 18])
  assert.deepEqual(received, [17, 18])
  assert.equal(queue.pending, 0)
})
