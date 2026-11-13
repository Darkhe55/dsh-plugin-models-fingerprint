import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const parts = ['transport.js', 'animator.js', 'geometry.js', 'window-store.js', 'state.js', 'overlay.js', 'rail.js', 'composer.js', 'apply.js']
const header = [
  'window.__ModuleLoader__.load({',
  "  id: 'dsh-plugin-model-fingerprint',",
  '  factory(require) {',
  "    const React = require('react')",
  '    const h = React.createElement',
].join('\n')
const footer = ['  },', '})', ''].join('\n')
let body = header + '\n'
for (const part of parts) {
  body += await fs.readFile(path.join(root, 'client', part), 'utf8')
  if (!body.endsWith('\n')) body += '\n'
}
body += footer
await fs.writeFile(path.join(root, 'client.js'), body)
console.log('client.js built from client/*.js')
