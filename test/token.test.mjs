import test from 'node:test'
import assert from 'node:assert/strict'
import { currentToken } from '../index.js'

test('dashboard token is stable for the plugin process lifetime', () => {
  const first = currentToken()
  assert.match(first, /^[a-f0-9]{32}$/)
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 31 * 60 * 1000
    assert.equal(currentToken(), first)
    Date.now = () => realNow() + 24 * 60 * 60 * 1000
    assert.equal(currentToken(), first)
  } finally {
    Date.now = realNow
  }
})
