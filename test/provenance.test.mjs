import test from 'node:test'
import assert from 'node:assert/strict'
import { createProvenanceChannel, detectWatermark, normalizeDetectorReply, provenanceConfig } from '../lib/provenance.mjs'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('the watermark channel is inert until an endpoint is configured', async () => {
  assert.equal(provenanceConfig({}).enabled, false)
  assert.equal(provenanceConfig({ DSH_MF_WATERMARK_ENDPOINT: '  ' }).enabled, false)
  const enabled = provenanceConfig({ DSH_MF_WATERMARK_ENDPOINT: 'http://127.0.0.1:1/detect' })
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.timeoutMs, 5000)
  assert.equal(enabled.minChars, 200)

  const calls = []
  const attached = []
  const channel = createProvenanceChannel({
    env: {},
    fetchImpl: async () => { calls.push(1); throw new Error('must not run') },
  })
  channel.observe({
    observation: { id: 's:1', provider: 'p', model: 'm', turn: 1 },
    text: 'x'.repeat(500),
    attach: (record) => attached.push(record),
  })
  await tick()
  assert.equal(calls.length, 0, 'a disabled channel never calls the detector')
  assert.equal(attached.length, 0)
  assert.equal(channel.status().enabled, false)
})

test('only an explicit positive with a label becomes a provenance record', async () => {
  assert.equal(normalizeDetectorReply(null), null)
  assert.equal(normalizeDetectorReply({ detected: false, vendor: 'google' }), null)
  assert.equal(normalizeDetectorReply({ detected: true }), null, 'a positive without scheme or vendor is not evidence')
  const record = normalizeDetectorReply({ detected: true, vendor: 'Google', scheme: 'synthid-text', confidence: 0.92, score: 4.1, threshold: 3 }, { now: 1234 })
  assert.deepEqual(record, {
    v: 1,
    state: 'detected',
    scheme: 'synthid-text',
    vendor: 'Google',
    detector: null,
    confidence: 0.92,
    score: 4.1,
    threshold: 3,
    checkedAt: 1234,
  })
  assert.equal('text' in record, false, 'the record never carries the turn text')
  const percent = normalizeDetectorReply({ watermarked: true, vendor: 'X', confidence: 92 })
  assert.equal(percent.confidence, 0.92)
  assert.equal(percent.scheme, null)
})

test('the detector fails soft on errors, timeouts and non-2xx replies', async () => {
  const config = { enabled: true, endpoint: 'http://detector', token: null, timeoutMs: 1000, minChars: 10 }
  const text = 'y'.repeat(100)

  const disabled = await detectWatermark({ text, config: { ...config, enabled: false } })
  assert.deepEqual(disabled, { record: null, reason: 'disabled' })

  const short = await detectWatermark({ text: 'tiny', config })
  assert.deepEqual(short, { record: null, reason: 'short-text' })

  const throwing = await detectWatermark({ text, config, fetchImpl: async () => { throw new Error('offline') } })
  assert.deepEqual(throwing, { record: null, reason: 'detector-error' })

  const http = await detectWatermark({ text, config, fetchImpl: async () => ({ ok: false, status: 500 }) })
  assert.deepEqual(http, { record: null, reason: 'http-error' })

  const positive = await detectWatermark({
    text,
    config,
    context: { provider: 'p', model: 'm' },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://detector')
      const body = JSON.parse(init.body)
      assert.equal(body.text.length, 100)
      assert.equal(body.model, 'm')
      return { ok: true, json: async () => ({ detected: true, vendor: 'v', scheme: 's', confidence: 0.8 }) }
    },
  })
  assert.equal(positive.reason, null)
  assert.equal(positive.record.state, 'detected')
  assert.equal(positive.record.vendor, 'v')
})

test('the queue dedupes one observation and keeps only positives', async () => {
  const requests = []
  const attached = []
  const channel = createProvenanceChannel({
    env: { DSH_MF_WATERMARK_ENDPOINT: 'http://detector' },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return { ok: true, json: async () => ({ detected: true, vendor: 'vendor-a', scheme: 'scheme-a' }) }
    },
  })
  const observation = { id: 's:9', provider: 'p', model: 'm', turn: 9 }
  channel.observe({ observation, text: 'z'.repeat(400), attach: (record) => attached.push(record) })
  channel.observe({ observation, text: 'z'.repeat(400), attach: (record) => attached.push(record) })
  await tick()
  await tick()
  assert.equal(requests.length, 1)
  assert.equal(attached.length, 1)
  assert.equal(attached[0].state, 'detected')
  const status = channel.status()
  assert.equal(status.enabled, true)
  assert.equal(status.detected, 1)
  channel.dispose()
})
