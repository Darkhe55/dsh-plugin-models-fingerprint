import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

async function loadQueue() {
  const source = await fs.readFile(new URL('../client/turn-window-requests.js', import.meta.url), 'utf8')
  return new Function(source + '\nreturn TurnWindowQueue')()
}

const response = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
})

test('turn-window batches deduplicate and keep the latest window', async () => {
  const TurnWindowQueue = await loadQueue()
  const calls = []
  const results = []
  const queue = new TurnWindowQueue({
    fetchWindow: async (values, context) => {
      calls.push({ values, context })
      return response({ sessionId: 's', revision: 2, generation: 'g', turns: values.map((turn) => ({ turn, status: 'observed', data: { id: 's:turn:' + turn, turn } })) })
    },
    onResult: (payload) => results.push(payload),
  })
  queue.request([3, 2, 3, 1], { sessionId: 's', revision: 2, generation: 'g' })
  queue.request([3, 2, 1], { sessionId: 's', revision: 2, generation: 'g' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls[0].values, [1, 2, 3])
  assert.equal(calls.length, 1)
  assert.equal(results.length, 1)
  queue.invalidate()
  queue.request([4], { sessionId: 's', revision: 3, generation: 'g' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.length, 2)
})

test('turn-window discards stale generation and falls back on 404', async () => {
  const TurnWindowQueue = await loadQueue()
  const results = []
  const fallbacks = []
  let mode = 'stale'
  const queue = new TurnWindowQueue({
    fetchWindow: async () => mode === 'stale'
      ? response({ sessionId: 's', revision: 9, generation: 'old', turns: [] })
      : { ok: false, status: 404 },
    onResult: (payload) => results.push(payload),
    onFallback: (values) => fallbacks.push(values),
  })
  queue.request([1], { sessionId: 's', revision: 5, generation: 'new' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(results.length, 0)
  mode = 'missing'
  queue.request([2], { sessionId: 's', revision: 5, generation: 'new' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(fallbacks, [[2]])
})
