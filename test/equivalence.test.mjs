import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEquivalence } from '../lib/equivalence.mjs'

function row(route, time, tpc, json = 0.5) {
  const [provider, ...rest] = route.split('/')
  return {
    time,
    provider,
    model: rest.join('/'),
    routeKey: route,
    fingerprint: 'fp_aaaaaaaaaaaa',
    protocol: { api: 'openai-completions', adapter: 'pi-ai@2' },
    behavior: {
      tokensPerChar: tpc,
      jsonSpacing: json,
      reasoningRatio: 0.1,
      charsPerChunk: 4,
      cjkRatio: 0.2,
      asciiRatio: 0.7,
      punctuationRatio: 0.05,
      markdownPerK: 5,
      escapedUnicode: 0.01,
      newlineRatio: 0.02,
    },
  }
}

test('equivalent behavior profiles cluster together and different ones separate', () => {
  const rows = []
  for (let i = 0; i < 8; i += 1) rows.push(row('provider-a/model-x', 100 + i, 0.3 + (i % 2) * 0.01))
  for (let i = 0; i < 8; i += 1) rows.push(row('provider-b/model-x', 200 + i, 0.3 + (i % 2) * 0.01))
  for (let i = 0; i < 8; i += 1) rows.push(row('provider-c/model-y', 300 + i, 0.8 + (i % 2) * 0.01))
  const report = buildEquivalence(rows, {}, { limit: 50 })
  assert.equal(report.stats.routes, 3)
  const ab = report.pairs.find((pair) => pair.a === 'provider-a/model-x' && pair.b === 'provider-b/model-x')
  const ac = report.pairs.find((pair) => pair.a === 'provider-a/model-x' && pair.b === 'provider-c/model-y')
  assert.ok(ab)
  assert.ok(ac)
  assert.equal(ab.verdict, 'same-behavior')
  assert.equal(ac.verdict, 'different-behavior')
  assert.ok(ab.distance < ac.distance)
  assert.equal(report.claims[0].model, 'model-x')
  assert.equal(report.claims[0].routes.length, 2)
})

test('a single route has no cross-route pairs', () => {
  const rows = Array.from({ length: 6 }, (_, index) => row('provider-a/solo', 100 + index, 0.4))
  const report = buildEquivalence(rows, {}, { limit: 20 })
  assert.equal(report.stats.routes, 1)
  assert.equal(report.stats.pairs, 0)
})

function probeRow(route, promptId, input) {
  const [provider, ...rest] = route.split('/')
  return {
    time: 500 + input,
    provider,
    model: rest.join('/'),
    routeKey: route,
    fingerprint: 'fp_aaaaaaaaaaaa',
    probe: true,
    probeMeta: { promptId },
    tokens: { input, output: 2, total: input + 2 },
    protocol: { api: 'openai-completions', adapter: 'pi-ai@2' },
    behavior: {
      tokensPerChar: 0.3, jsonSpacing: 0.5, reasoningRatio: 0.1, charsPerChunk: 4,
      cjkRatio: 0.2, asciiRatio: 0.7, punctuationRatio: 0.05, markdownPerK: 5,
      escapedUnicode: 0.01, newlineRatio: 0.02,
    },
  }
}

test('probe tokenizer deltas can override a weak behavioral distance', () => {
  const rows = []
  for (const prompt of ['baseline', 'en', 'zh', 'code', 'emoji', 'tool']) {
    const base = prompt === 'baseline' ? 10 : 20
    rows.push(probeRow('provider-a/model-x', prompt, base))
    rows.push(probeRow('provider-b/model-x', prompt, base))
    rows.push(probeRow('provider-c/model-y', prompt, prompt === 'baseline' ? 10 : 30))
  }
  const report = buildEquivalence([], {}, { limit: 20, probes: rows })
  const ab = report.pairs.find((pair) => pair.a === 'provider-a/model-x' && pair.b === 'provider-b/model-x')
  const ac = report.pairs.find((pair) => pair.a === 'provider-a/model-x' && pair.b === 'provider-c/model-y')
  assert.ok(ab && ac)
  assert.equal(ab.tokenizerDistance, 0)
  assert.equal(ab.verdict, 'same-behavior')
  assert.ok(ac.tokenizerDistance > 0.35)
  assert.equal(ac.verdict, 'different-behavior')
})
