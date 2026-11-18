import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const languages = ['zh', 'en', 'fr', 'ru', 'es', 'ar']

test('market metadata exposes the localized title and description in six UN languages', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.ok(pkg.files.includes('locale/*.json'))
  for (const language of languages) {
    const locale = JSON.parse(await fs.readFile(path.join(root, 'locale', language + '.json'), 'utf8'))
    assert.equal(typeof locale.meta.title, 'string')
    assert.ok(locale.meta.title.trim().length > 0)
    assert.equal(typeof locale.meta.description, 'string')
    assert.match(locale.meta.description.trim(), /[.。]$/, language + ' description must end with a sentence period')
    assert.equal(typeof locale.meta.detail, 'string')
    const detail = await fs.readFile(path.join(root, locale.meta.detail), 'utf8')
    assert.match(detail.trim(), /^!\[[^\]]+\]\(preview\.svg\)$/, language + ' detail must be one image line')
  }
  const zh = JSON.parse(await fs.readFile(path.join(root, 'locale', 'zh.json'), 'utf8'))
  assert.equal(zh.meta.title, '模型指纹识别器')
  assert.ok(await fs.stat(path.join(root, 'docs', 'preview.svg')))
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8')
  for (const heading of ['## What it does', '## Install', '## Quick start', '## Boundaries', '## Data and privacy', '## Development', '## License']) {
    assert.ok(readme.includes(heading), 'README missing ' + heading)
  }
})
