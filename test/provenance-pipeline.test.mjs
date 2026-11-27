import test from 'node:test'
import assert from 'node:assert/strict'
import { applySessionEvent, assistantTextFromEvent, createCursor } from '../lib/core.mjs'
import { SessionScanner } from '../lib/scan.mjs'
import { buildTurns } from '../lib/summary.mjs'

function messageEvent({ text = 'hello watermark world', turn = 1, step = 1, seq = 7, time = 1000 } = {}) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn,
      step,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'provider-a', model: 'claimed-a' },
      },
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      stream: [{ type: 'chunk', time, chunk: { type: 'text-delta', text } }],
    },
  }
}

test('the observation event travels with the emit so the channel can read the text', () => {
  const cursor = createCursor({ id: 'session-a' })
  const seen = []
  applySessionEvent(cursor, messageEvent(), (observation, payload) => seen.push({ observation, payload }))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].payload.type, 'assistant/message')
  assert.equal(assistantTextFromEvent(seen[0].payload), 'hello watermark world')
  assert.equal(assistantTextFromEvent({ type: 'request/context' }), '')
})

test('visible text ignores reasoning and tool blocks', () => {
  const event = messageEvent()
  event.data.message.content = [
    { type: 'text', text: 'first' },
    { type: 'reasoning', text: 'hidden' },
    { type: 'tool-call', name: 'read', arguments: '{}' },
    { type: 'text', text: 'second' },
  ]
  assert.equal(assistantTextFromEvent(event), 'first\nsecond')
})

test('a live turn reaches the text hook and never stores the text', () => {
  const scanner = new SessionScanner({ roots: [] })
  const captured = []
  scanner.onTurnText((observation, payload) => captured.push({ observation, text: assistantTextFromEvent(payload) }))
  scanner.liveEvent('session-a', messageEvent())
  assert.equal(captured.length, 1)
  assert.equal(captured[0].text, 'hello watermark world')
  const stored = scanner.observations.get(captured[0].observation.id)
  assert.equal(JSON.stringify(stored).includes('hello watermark world'), false, 'turn text stays out of state')
})

test('attachProvenance replaces the observation without touching fingerprint or verdict', () => {
  const scanner = new SessionScanner({ roots: [] })
  const captured = []
  scanner.onTurnText((observation) => captured.push(observation))
  scanner.liveEvent('session-a', messageEvent())
  const observation = captured[0]
  const before = buildTurns(scanner.observationsForSession('session-a'), 'session-a')[0]
  assert.equal('provenance' in before, false, 'no field when nothing was detected')

  const record = {
    v: 1,
    state: 'detected',
    vendor: 'vendor-a',
    scheme: 'scheme-a',
    detector: 'test-detector',
    confidence: 0.9,
    score: 4.2,
    threshold: 3,
    checkedAt: 2000,
  }
  assert.equal(scanner.attachProvenance(observation.id, record), true)
  const stored = scanner.observations.get(observation.id)
  assert.equal(stored.fingerprint, observation.fingerprint)
  assert.equal(stored.protocol.api, observation.protocol.api)
  assert.deepEqual(stored.provenance, record)

  const after = buildTurns(scanner.observationsForSession('session-a'), 'session-a')[0]
  assert.equal(after.provenance.vendor, 'vendor-a')
  assert.equal(after.verdict, before.verdict)
  assert.equal(after.primaryFingerprint, before.primaryFingerprint)
  assert.equal(after.primaryShort, before.primaryShort)

  assert.equal(scanner.attachProvenance(observation.id, record), false, 'identical record is a no-op')
  assert.equal(scanner.attachProvenance(observation.id, { state: 'not-detected' }), false, 'negative records are dropped')
  assert.equal(scanner.attachProvenance('missing', record), false)

  const serialized = scanner.serialize().observations[observation.id]
  assert.equal(serialized.provenance.scheme, 'scheme-a')
})

test('observations persisted without provenance still load and render', () => {
  const legacy = {
    id: 'legacy:1',
    sessionId: 'legacy',
    seq: 1,
    time: 500,
    turn: 1,
    step: 1,
    provider: 'provider-a',
    model: 'claimed-a',
    fingerprint: 'fp_legacy',
    protocol: { api: 'openai-completions', adapter: 'pi-ai' },
    behavior: { textChars: 12 },
    tokens: { input: 1, output: 2, total: 3 },
    toolCalls: 0,
  }
  const scanner = new SessionScanner({ roots: [], state: { files: {}, observations: { 'legacy:1': legacy } } })
  const turns = buildTurns(scanner.observationsForSession('legacy'), 'legacy')
  assert.equal(turns.length, 1)
  assert.equal('provenance' in turns[0], false)
  assert.equal(turns[0].primaryFingerprint, 'fp_legacy')
})
