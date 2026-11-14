import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

test('built client.js is exactly the concatenated client modules', async () => {
  const root = new URL('../', import.meta.url)
  const parts = ['transport.js', 'animator.js', 'geometry.js', 'window-store.js', 'rail-state.js', 'scroll-scheduler.js', 'rebind-scheduler.js', 'turn-requests.js', 'turn-window-requests.js', 'turn-registry.js', 'visible-turn-adapter.js', 'state.js', 'overlay.js', 'rail.js', 'composer.js', 'apply.js']
  const header = [
    'window.__ModuleLoader__.load({',
    "  id: 'dsh-plugin-model-fingerprint',",
    '  factory(require) {',
    "    const React = require('react')",
    '    const h = React.createElement',
  ].join('\n')
  const footer = ['  },', '})', ''].join('\n')
  let expected = header + '\n'
  for (const part of parts) {
    expected += await fs.readFile(new URL('client/' + part, root), 'utf8')
    if (!expected.endsWith('\n')) expected += '\n'
  }
  expected += footer
  const actual = (await fs.readFile(new URL('client.js', root), 'utf8')).replace(/\r\n/g, '\n')
  assert.equal(actual, expected.replace(/\r\n/g, '\n'))
})
