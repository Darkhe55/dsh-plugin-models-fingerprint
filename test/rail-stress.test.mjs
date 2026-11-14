import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

async function load(name, returns) {
  const source = await fs.readFile(new URL('../client/' + name, import.meta.url), 'utf8')
  return new Function(source + '\nreturn {' + returns + '}')()
}

test('one thousand recycled turn snapshots never duplicate a card', async () => {
  const { deriveRailTargets, validateRailTargets, layoutMiddleCards } = await load('rail-state.js', 'deriveRailTargets, validateRailTargets, layoutMiddleCards')
  const turns = Array.from({ length: 8 }, (_, index) => ({ id: 't' + index, turn: index + 1 }))
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    const base = 500 - (iteration % 100)
    const rows = turns.map((turn, index) => ({
      domTurn: base + index,
      turnTop: index * 70,
      turnBottom: index * 70 + 50,
      anchorTop: index * 70 + 10,
      anchorBottom: index * 70 + 40,
    }))
    const local = turns.map((turn, index) => ({ ...turn, turn: base + index }))
    const targets = deriveRailTargets({ rows }, local, { offset: 0 }, { clipTop: 0, clipBottom: 500 }, new Map())
    validateRailTargets(targets)
    const layout = layoutMiddleCards(targets.middle.map((entry) => ({
      id: entry.turn.id,
      anchorTop: entry.anchorTop,
      anchorBottom: entry.anchorBottom,
      center: (entry.anchorTop + entry.anchorBottom) / 2,
    })), { top: 0, bottom: 500, cardHeight: 58, gap: 4 })
    const tops = layout.items.map((item) => item.top)
    assert.equal(new Set(tops).size, tops.length)
    assert.equal(layout.collapsed + layout.items.length, targets.middle.length)
  }
})

test('five hundred prepend windows stay finite and unique', async () => {
  const { deriveRailTargets, validateRailTargets } = await load('rail-state.js', 'deriveRailTargets, validateRailTargets')
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const start = 800 - iteration
    const turns = Array.from({ length: 12 }, (_, index) => ({ id: 't' + (start + index), turn: start + index }))
    const rows = turns.map((turn, index) => ({
      domTurn: turn.turn,
      turnTop: index * 80 - 100,
      turnBottom: index * 80 - 40,
      anchorTop: index * 80 - 80,
      anchorBottom: index * 80 - 50,
    }))
    const targets = deriveRailTargets({ rows }, turns, { offset: 0 }, { clipTop: 0, clipBottom: 600 }, new Map())
    validateRailTargets(targets)
    assert.ok(targets.ids.size > 0)
    for (const id of targets.ids) assert.match(id, /^t/)
  }
})

test('out-of-order delayed turn windows discard the stale response', async () => {
  const { TurnWindowQueue } = await load('turn-window-requests.js', 'TurnWindowQueue')
  const results = []
  const queue = new TurnWindowQueue({
    fetchWindow: (values) => new Promise((resolve) => {
      const delay = values.includes(1) ? 80 : 5
      setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ sessionId: 's', revision: 1, generation: 'g', turns: [] }) }), delay)
    }),
    onResult: (payload) => results.push(payload),
  })
  queue.request([1], { sessionId: 's', revision: 1, generation: 'g' })
  queue.invalidate()
  queue.request([2], { sessionId: 's', revision: 1, generation: 'g' })
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(results.length, 1, 'the invalidated 80ms response must not publish after the 5ms window')
})
