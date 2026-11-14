import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

async function loadQueue() {
  const source = await fs.readFile(new URL('../client/turn-requests.js', import.meta.url), 'utf8')
  return new Function(source + '\nreturn TurnRequestQueue')()
}

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
