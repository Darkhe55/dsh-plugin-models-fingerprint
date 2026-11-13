import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOfficialProfile, modelKey, normalizeOfficialModels } from '../lib/similarity.mjs'

function row(index, provider = 'official', model = 'official-model', overrides = {}) {
  return {
    id: 's:' + index,
    sessionId: 's',
    provider,
    model,
    time: 1000 + index,
    fingerprint: 'fp_aaaaaaaaaaaa',
    behavior: {
      tokensPerChar: 0.2,
      charsPerChunk: 4,
      reasoningRatio: 0.1,
      jsonSpacing: 0.5,
      cjkRatio: 0.1,
      asciiRatio: 0.8,
      punctuationRatio: 0.05,
      markdownPerK: 2,
      escapedUnicode: 0,
      newlineRatio: 0.02,
    },
    ...overrides,
  }
}

test('official model normalization is explicit and deduplicated', () => {
  const models = normalizeOfficialModels([
    { provider: 'official', model: 'model-a' },
    { provider: 'official', model: 'model-a', label: 'dup' },
    { provider: '', model: 'bad' },
  ])
  assert.equal(models.length, 1)
  assert.equal(models[0].key, modelKey('official', 'model-a'))
  assert.equal(models[0].label, 'official/model-a')
})

test('official profile requires enough samples and keeps evidence bounds', () => {
  const rows = Array.from({ length: 20 }, (_, index) => row(index))
  const baseline = buildOfficialProfile(rows, { provider: 'official', model: 'official-model', minSamples: 20 })
  assert.equal(baseline.ready, true)
  assert.equal(baseline.samples, 20)
  assert.equal(baseline.firstTime, 1000)
  assert.equal(baseline.lastTime, 1019)
  assert.equal(baseline.fingerprints[0].id, 'fp_aaaaaaaaaaaa')
  assert.ok(baseline.profile.usable > 0)
  const insufficient = buildOfficialProfile(rows.slice(0, 3), { provider: 'official', model: 'official-model', minSamples: 20 })
  assert.equal(insufficient.ready, false)
})
