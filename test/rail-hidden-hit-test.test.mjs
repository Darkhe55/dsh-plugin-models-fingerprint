import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

const read = async (relative) => (await fs.readFile(new URL('../' + relative, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')

test('the rail component delegates hidden hit-testing to the pure helpers', async () => {
  const source = await read('client/rail.js')
  assert.match(source, /const hidden = railHidden\(\{ canvasOpen, rightbarOpen \}\)/)
  assert.match(source, /\.\.\.railLayerChrome\(\{ hidden \}\)/)
  assert.match(source, /pointerEvents: railCardPointerEvents\(\{ hidden, visible: position\.visible \}\)/)
  assert.match(source, /pointerEvents: railCardPointerEvents\(\{ hidden, visible: placeholderPosition\.current\.visible \}\)/)
  assert.match(source, /pointerEvents: railCardPointerEvents\(\{ hidden, visible: true \}\)/)
  assert.match(source, /setStyle\(node, 'pointerEvents', hiddenRef\.current \? 'none' : 'auto'\)/)
})

test('applyTargets cannot re-enable cards on a frame scheduled while hidden', async () => {
  const source = await read('client/rail.js')
  assert.match(source, /hiddenRef\.current = hidden/)
  assert.doesNotMatch(source, /setStyle\(node, 'pointerEvents', 'auto'\)/)
})

test('the fade-only hiding that swallowed clicks stays gone', async () => {
  const source = await read('client/rail.js')
  assert.doesNotMatch(source, /opacity: canvasOpen \|\| rightbarOpen \? 0 : 1/)
  assert.doesNotMatch(source, /pointerEvents: position\.visible \? 'auto' : 'none'/)
  assert.doesNotMatch(source, /pointerEvents: placeholderPosition\.current\.visible \? 'auto' : 'none'/)
  assert.doesNotMatch(source, /pointerEvents: 'auto'/)
})

test('the shipped bundle carries the hidden hit-testing gate', async () => {
  const built = await read('client.js')
  assert.match(built, /function railHidden\(/)
  assert.match(built, /railLayerChrome\(\{ hidden \}\)/)
  assert.match(built, /railCardPointerEvents\(\{ hidden, visible: position\.visible \}\)/)
  assert.match(built, /setStyle\(node, 'pointerEvents', hiddenRef\.current \? 'none' : 'auto'\)/)
  assert.doesNotMatch(built, /opacity: canvasOpen \|\| rightbarOpen \? 0 : 1/)
})
