import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

async function loadRailState() {
  const source = await fs.readFile(new URL('../client/rail-state.js', import.meta.url), 'utf8')
  return new Function(source + '\nreturn { railVisibility, deriveRailTargets, validateRailTargets, layoutMiddleCards, chooseRailMapping, railJumpDetected, RailSnapshotTracker }')()
}

const turn = (turn, id = 's:turn:' + turn) => ({ id, turn, verdictLabel: 'test' })
const row = (domTurn, top, bottom) => ({ domTurn, top, bottom, segments: [{ top: Math.max(0, top), bottom: Math.min(500, bottom) }] })
const snapshot = (rows) => ({ rows })
const viewport = { clipTop: 0, clipBottom: 500 }

test('rail is hidden without a chat flow or visible conversation rows', async () => {
  const { railVisibility } = await loadRailState()
  assert.equal(railVisibility({ on: true, flow: null, rows: [row(1, 0, 100)] }), false)
  assert.equal(railVisibility({ on: true, flow: {}, rows: [] }), false)
  assert.equal(railVisibility({ on: false, flow: {}, rows: [row(1, 0, 100)] }), false)
  assert.equal(railVisibility({ on: true, flow: {}, rows: [row(1, 0, 100)] }), true)
})

test('a recycled DOM node cannot keep its old turn identity', async () => {
  const { deriveRailTargets } = await loadRailState()
  const turns = [turn(783), turn(784), turn(785), turn(786)]
  const before = deriveRailTargets(snapshot([
    row(783, -100, -40),
    row(784, 40, 140),
    row(785, -80, -10),
    row(786, 220, 320),
  ]), turns, { offset: 0 }, viewport, new Map([['s:turn:785', 'top']]))
  assert.equal(before.top.turn.turn, 785)
  assert.deepEqual(before.middle.map((entry) => entry.turn.turn), [784, 786])
  const after = deriveRailTargets(snapshot([
    row(783, -80, -10),
    row(784, 40, 140),
    row(786, 220, 320),
  ]), turns, { offset: 0 }, viewport, new Map([['s:turn:783', 'top'], ['s:turn:785', 'top']]))
  assert.equal(after.top.turn.turn, 783)
  assert.equal(after.middle.some((entry) => entry.turn.turn === 785), false)
  assert.equal(new Set([after.top, ...after.middle].filter(Boolean).map((entry) => entry.turn.id)).size, 3)
})

test('the reported 786/785/784/783 scroll sequence has one card per turn and recovers in reverse', async () => {
  const { deriveRailTargets, validateRailTargets } = await loadRailState()
  const turns = [turn(783), turn(784), turn(785), turn(786)]
  const upward = deriveRailTargets(snapshot([
    row(783, -100, -40),
    row(784, -20, 80),
    row(785, -80, -10),
    row(786, 120, 220),
  ]), turns, { offset: 0 }, viewport, new Map([['s:turn:785', 'top'], ['s:turn:784', 'middle'], ['s:turn:786', 'middle']]))
  validateRailTargets(upward)
  assert.equal(upward.top.turn.turn, 785)
  assert.ok(upward.middle.some((entry) => entry.turn.turn === 784))
  assert.equal(upward.ids.size, 3)
  const reverse = deriveRailTargets(snapshot([
    row(784, 40, 140),
    row(785, 180, 280),
    row(786, 320, 420),
  ]), turns, { offset: 0 }, viewport, new Map([['s:turn:784', 'middle'], ['s:turn:785', 'top'], ['s:turn:786', 'middle']]))
  validateRailTargets(reverse)
  assert.equal(reverse.top, null, '785 leaves the top slot when it becomes visible')
  assert.deepEqual(reverse.middle.map((entry) => entry.turn.turn), [784, 785, 786])
  assert.equal(reverse.ids.size, 3)
})

test('top hysteresis uses position, never a pinned turn', async () => {
  const { deriveRailTargets } = await loadRailState()
  const turns = [turn(1), turn(2)]
  const held = deriveRailTargets(snapshot([row(1, -50, 10), row(2, 100, 200)]), turns, { offset: 0 }, viewport, new Map([['s:turn:1', 'top']]))
  assert.equal(held.top.turn.turn, 1, 'still top while within the leave threshold')
  const released = deriveRailTargets(snapshot([row(1, -50, 40), row(2, 100, 200)]), turns, { offset: 0 }, viewport, new Map([['s:turn:1', 'top']]))
  assert.equal(released.top, null)
  assert.equal(released.middle[0].turn.turn, 1)
})

test('middle layout never stacks cards and reports overflow as collapsed', async () => {
  const { layoutMiddleCards } = await loadRailState()
  const items = Array.from({ length: 8 }, (_, index) => ({
    id: 't' + index,
    anchorTop: index * 60,
    anchorBottom: index * 60 + 40,
    center: index * 60 + 20,
  }))
  const result = layoutMiddleCards(items, { top: 0, bottom: 128, cardHeight: 40, gap: 4 })
  assert.equal(result.items.length, 3)
  assert.equal(result.collapsed, 5)
  assert.equal(result.collapsedIds.length, 5)
  const tops = result.items.map((item) => item.top)
  assert.equal(new Set(tops).size, tops.length)
  for (let index = 1; index < tops.length; index += 1) assert.ok(tops[index] - tops[index - 1] >= 44)
  assert.ok(tops.every((top) => top >= 0 && top + 40 <= 128))
  const tooSmall = layoutMiddleCards(items, { top: 0, bottom: 30, cardHeight: 40, gap: 4 })
  assert.equal(tooSmall.items.length, 0)
  assert.equal(tooSmall.collapsed, 8)
})

test('ambiguous offsets keep the previous offset instead of the first candidate', async () => {
  const { chooseRailMapping } = await loadRailState()
  const twoRows = chooseRailMapping([10, 11, 12], [110, 111], { offset: 0, confidence: 0.7 })
  assert.equal(twoRows.offset, 0)
  assert.ok(twoRows.confidence <= 0.7)
  const threeRows = chooseRailMapping([10, 11, 12], [110, 111, 112], { offset: 0, confidence: 0 })
  assert.equal(threeRows.offset, 0, 'pairwise arithmetic is not evidence for an offset')
  assert.equal(threeRows.confidence, 0)
  const confirmed = chooseRailMapping([110, 111, 112], [210, 211, 212], { offset: 100, confidence: 1 })
  assert.equal(confirmed.offset, 100, 'an already confirmed offset remains usable when direct evidence is absent')
})

test('jump detection and stable-snapshot timeout are bounded but not permanent', async () => {
  const { railJumpDetected, RailSnapshotTracker } = await loadRailState()
  assert.equal(railJumpDetected(snapshot([row(1, 0, 10)]), snapshot([row(9, 0, 10)]), { scrollDelta: 300 }), 'scroll')
  assert.equal(railJumpDetected(snapshot([row(1, 0, 10)]), snapshot([row(2, 0, 10)]), {}), 'no-common-turn')
  const tracker = new RailSnapshotTracker({ maxWaitMs: 600 })
  const first = tracker.observe('a', 0)
  assert.equal(first.stable, false)
  const second = tracker.observe('a', 16)
  assert.equal(second.stable, true)
  tracker.reset()
  tracker.observe('b', 0)
  const later = tracker.observe('b', 600)
  assert.equal(later.timedOut, true)
  assert.equal(later.stable, true)
})
