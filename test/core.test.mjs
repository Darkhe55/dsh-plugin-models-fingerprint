import test from 'node:test'
import assert from 'node:assert/strict'
import { applySessionEvent, classifyId, createCursor, observationFromEvent, scanZstdFrames, stableStringify } from '../lib/core.mjs'

function messageEvent({ seq = 5, time = 2000, provider = 'provider-a', model = 'claimed-a', api = 'openai-completions', responseId = 'abc123', text = 'hello world', withTool = false } = {}) {
  const content = [{ type: 'text', text }]
  if (withTool) content.push({ type: 'tool-call', id: 'call_abc123', name: 'read', arguments: '{"file_path":"a.txt"}' })
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content,
        source: {
          kind: 'model',
          provider,
          model,
          replayState: {
            response: { kind: 'pi-ai', version: 2, api, provider, model, responseId, stopReason: withTool ? 'toolUse' : 'stop' },
            blocks: content.map((block) => ({ type: block.type })),
          },
        },
        id: 'message-1',
      },
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadTokens: 0 },
      stream: [
        { type: 'chunk', time: 2100, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: 2100, index: 0, dt: [0, 20, 0], texts: ['hello', ' ', 'world'] },
        { type: 'chunk', time: 2160, chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } },
        { type: 'chunk', time: 2161, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadTokens: 0 } } },
        { type: 'chunk', time: 2162, chunk: { type: 'finish', reason: { kind: withTool ? 'tool-calls' : 'stop' } } },
      ],
    },
  }
}

function cursorFor(provider = 'provider-a', model = 'claimed-a') {
  const cursor = createCursor({ id: 'session-test' })
  applySessionEvent(cursor, { type: 'request/context', seq: 2, time: 500, data: { provider, model, contextWindow: 100000 } })
  applySessionEvent(cursor, { type: 'step/start', seq: 3, time: 1000, data: { turn: 1, step: 1 } })
  return cursor
}

test('classifyId stores shape, not the raw id', () => {
  assert.equal(classifyId('call_0123456789abcdef01234567'), 'call:hex:29')
  assert.equal(classifyId('chatcmpl-xyzXYZ123456'), 'chatcmpl:alnum:21')
  assert.equal(classifyId(''), 'none')
})

test('same protocol under different claimed names yields the same fingerprint', () => {
  const one = observationFromEvent({ sessionId: 's', cursor: cursorFor('provider-a', 'name-a'), event: messageEvent({ provider: 'provider-a', model: 'name-a' }) })
  const two = observationFromEvent({ sessionId: 's', cursor: cursorFor('provider-a', 'name-b'), event: messageEvent({ provider: 'provider-a', model: 'name-b', responseId: 'def456' }) })
  assert.ok(one && two)
  assert.equal(one.fingerprint, two.fingerprint)
  assert.notEqual(one.routeKey, two.routeKey)
  assert.equal(one.protocol.responseId, 'hex:6')
})

test('different wire api yields a different fingerprint', () => {
  const one = observationFromEvent({ sessionId: 's', cursor: cursorFor(), event: messageEvent({ api: 'openai-completions' }) })
  const two = observationFromEvent({ sessionId: 's', cursor: cursorFor(), event: messageEvent({ api: 'anthropic-messages' }) })
  assert.notEqual(one.fingerprint, two.fingerprint)
})

test('protocol hash excludes task-dependent tool shape', () => {
  const plain = observationFromEvent({ sessionId: 's', cursor: cursorFor(), event: messageEvent({ withTool: false }) })
  const tool = observationFromEvent({ sessionId: 's', cursor: cursorFor(), event: messageEvent({ withTool: true, seq: 6 }) })
  assert.equal(plain.fingerprint, tool.fingerprint)
  assert.notDeepEqual(plain.protocolDetail.toolIdShapes, tool.protocolDetail.toolIdShapes)
})

test('behavior metrics include tokenizer ratio and stream timing', () => {
  const observation = observationFromEvent({ sessionId: 's', cursor: cursorFor(), event: messageEvent() })
  assert.equal(observation.behavior.tokensPerChar, 0.2727)
  assert.equal(observation.behavior.textChars, 11)
  assert.equal(observation.timing.stepStart, 1000)
  assert.equal(observation.behavior.ttftMs, 1100)
})

test('stableStringify sorts keys recursively', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
})

test('scanZstdFrames finds a concatenated frame boundary', async () => {
  const { zstdCompressSync } = await import('node:zlib')
  const a = zstdCompressSync(Buffer.from('{"a":1}\n'))
  const b = zstdCompressSync(Buffer.from('{"b":2}\n'))
  const { frames } = scanZstdFrames(Buffer.concat([a, b]))
  assert.equal(frames.length, 2)
  assert.equal(frames[0].start, 0)
  assert.equal(frames[1].start, a.length)
})
