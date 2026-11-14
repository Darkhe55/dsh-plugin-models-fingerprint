import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

test('turn geometry excludes user bubbles when an assistant node is present', async () => {
  const source = await fs.readFile(new URL('../client/geometry.js', import.meta.url), 'utf8')
  const TurnGeometry = new Function(source + '\nreturn TurnGeometry')()
  const rect = (top, height) => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100 })
  const user = {
    className: 'user',
    getAttribute: (name) => name === 'data-chat-flow-kind' ? 'user' : null,
    matches: () => false,
    querySelectorAll: () => [],
    querySelector: () => null,
    getClientRects: () => [1],
    getBoundingClientRect: () => rect(100, 40),
    contains: () => false,
  }
  const assistant = {
    className: 'msg',
    getAttribute: (name) => name === 'data-chat-flow-kind' ? 'assistant' : null,
    matches: () => false,
    querySelectorAll: () => [],
    querySelector: () => null,
    getClientRects: () => [1],
    getBoundingClientRect: () => rect(150, 30),
    contains: () => false,
  }
  const wrapper = {
    className: 'turn',
    getAttribute: () => null,
    matches: () => false,
    querySelectorAll: () => [assistant],
    querySelector: (selector) => selector.includes('user') ? user : null,
    getClientRects: () => [1],
    getBoundingClientRect: () => rect(100, 90),
    contains: (node) => node === user || node === assistant,
  }
  const nodes = TurnGeometry.responseNodes([wrapper, user])
  assert.deepEqual(nodes, [assistant])
  const measured = TurnGeometry.measure([wrapper, user], 0, 500)
  assert.equal(measured.top, 150)
  assert.equal(measured.bottom, 180)
})

test('measureNormalized does not rescan subtrees', async () => {
  const source = await fs.readFile(new URL('../client/geometry.js', import.meta.url), 'utf8')
  const TurnGeometry = new Function(source + '\nreturn TurnGeometry')()
  const node = {
    kind: 'assistant',
    getAttribute: (name) => name === 'data-chat-flow-kind' ? 'assistant' : null,
    querySelectorAll: () => { throw new Error('must not rescan normalized nodes') },
    querySelector: () => { throw new Error('must not rescan normalized nodes') },
    getClientRects: () => [1],
    getBoundingClientRect: () => ({ top: 50, bottom: 80, height: 30, left: 0, right: 100, width: 100 }),
  }
  const measured = TurnGeometry.measureNormalized([node], 0, 100)
  assert.equal(measured.top, 50)
  assert.equal(measured.bottom, 80)
  assert.equal(measured.segments.length, 1)
})

test('right anchor is independent of compact card width', async () => {
  const source = await fs.readFile(new URL('../client/geometry.js', import.meta.url), 'utf8')
  const TurnGeometry = new Function(source + '\nreturn TurnGeometry')()
  const flow = { left: 600, right: 1400 }
  const wide = TurnGeometry.anchorRight(flow, 240, 442, 176)
  const narrow = TurnGeometry.anchorRight(flow, 240, 442, 176)
  assert.equal(wide, narrow)
  assert.equal(wide, 618)
  assert.ok(Math.abs((wide - 8) - (narrow - 8)) <= 1, 'range line world X stays fixed')
})
