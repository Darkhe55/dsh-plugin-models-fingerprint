import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

const read = async (relative) => (await fs.readFile(new URL('../' + relative, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')

test('the rail only renders watermark provenance for a positive record', async () => {
  const rail = await read('client/rail.js')
  assert.match(rail, /const provenanceText = \(provenance\) => \{/)
  assert.match(rail, /if \(!provenance \|\| provenance\.state !== 'detected'\) return ''/)
  assert.match(rail, /turn\.provenance \? ' · 水印' : ''/)
  assert.match(rail, /provenanceText\(turn\.provenance\) \? ' · 水印：'/)
})

test('the dashboard only emits a watermark chip for a positive record', async () => {
  const html = await read('public/dashboard.html')
  assert.match(html, /function provenanceChip\(provenance\)/)
  assert.match(html, /if \(!provenance \|\| provenance\.state !== 'detected'\) return '';/)
  assert.match(html, /const watermark = provenanceChip\(turn\.provenance\)/)
  assert.match(html, /\$\{watermark\}/)
})

test('the shipped client bundle carries the gated provenance rendering', async () => {
  const built = await read('client.js')
  assert.match(built, /const provenanceText = \(provenance\) => \{/)
  assert.match(built, /turn\.provenance \? ' · 水印' : ''/)
})
