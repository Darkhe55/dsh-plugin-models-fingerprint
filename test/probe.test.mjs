import test from 'node:test'
import assert from 'node:assert/strict'
import { PROBE_SUITE, runProbeSuite } from '../lib/probe.mjs'

const mockLlm = {
  async *stream(options) {
    const inputTokens = 10 + options.messages[0].content[0].text.length
    yield { type: 'usage', usage: { inputTokens, outputTokens: 2, totalTokens: inputTokens + 2 } }
    yield { type: 'text-delta', index: 0, text: 'OK' }
    yield {
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: {
        response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: options.provider, model: options.model, responseId: 'abc123', stopReason: 'stop' },
        blocks: [{ type: 'text' }],
      },
    }
  },
}

test('probe suite records tokenizer deltas and behavior without running automatically', async () => {
  const progress = []
  const result = await runProbeSuite({
    llm: mockLlm,
    provider: 'provider-a',
    model: 'model-a',
    repeats: 1,
    onProgress: (item) => progress.push(item.completed),
  })
  assert.equal(result.calls, PROBE_SUITE.length)
  assert.equal(result.completed, PROBE_SUITE.length)
  assert.equal(result.results.length, PROBE_SUITE.length)
  assert.equal(result.tokenizerVector.length, PROBE_SUITE.length - 1)
  assert.ok(result.tokenizerVector.every((item) => item.delta !== null))
  assert.equal(result.behavior.tokensPerChar, 2 / 2)
  assert.equal(progress.length, PROBE_SUITE.length)
  assert.equal(result.results[0].probe, true)
  assert.ok(result.results[0].probeMeta.promptId)
})

test('probe repeats multiply calls but stay bounded', async () => {
  const result = await runProbeSuite({ llm: mockLlm, provider: 'p', model: 'm', repeats: 9 })
  assert.equal(result.repeats, 3)
  assert.equal(result.calls, PROBE_SUITE.length * 3)
  assert.equal(result.results.length, PROBE_SUITE.length * 3)
})
