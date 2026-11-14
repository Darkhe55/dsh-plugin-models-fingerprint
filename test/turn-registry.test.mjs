import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

async function loadRegistry() {
  const source = await fs.readFile(new URL('../client/turn-registry.js', import.meta.url), 'utf8')
  return new Function(source + '\nreturn OfficialTurnRegistry')()
}

test('official turn registry tracks mount and unmount by turn number', async () => {
  const OfficialTurnRegistry = await loadRegistry()
  const registry = new OfficialTurnRegistry()
  let notifications = 0
  const unsubscribe = registry.subscribe(() => { notifications += 1 })
  const first = { seq: 10 }
  const removeA = registry.add(87, first)
  assert.equal(registry.get(87).seq, 10)
  assert.deepEqual(registry.turns(), [87])
  const removeB = registry.add(87, { seq: 11 })
  assert.equal(registry.get(87).seq, 11)
  removeA()
  assert.equal(registry.get(87).seq, 11, 'stale unmount cannot remove its replacement')
  removeB()
  assert.equal(registry.get(87), null)
  assert.equal(notifications, 3)
  unsubscribe()
  registry.dispose()
})
