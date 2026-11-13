import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCalibration, buildOfficialProfile, modelKey, normalizeOfficialModels, scoreSimilarity } from '../lib/similarity.mjs'

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

test('similarity score is calibrated only when same/different pairs separate', () => {
  const officialRows = Array.from({ length: 20 }, (_, index) => row(index))
  const otherRows = Array.from({ length: 20 }, (_, index) => row(100 + index, 'third-party', 'other-model', {
    behavior: {
      tokensPerChar: 0.9,
      charsPerChunk: 18,
      reasoningRatio: 0.8,
      jsonSpacing: 2,
      cjkRatio: 0.01,
      asciiRatio: 0.95,
      punctuationRatio: 0.2,
      markdownPerK: 20,
      escapedUnicode: 0.1,
      newlineRatio: 0.2,
    },
  }))
  const baseline = buildOfficialProfile(officialRows, { provider: 'official', model: 'official-model', minSamples: 20 })
  const calibration = buildCalibration([...officialRows, ...otherRows], { provider: 'official', model: 'official-model' })
  assert.equal(calibration.calibrated, true)
  assert.ok(calibration.auc >= 0.7)
  assert.ok(calibration.aucLower <= calibration.auc && calibration.auc <= calibration.aucUpper)
  const same = scoreSimilarity(officialRows.slice(0, 10), baseline, calibration)
  const different = scoreSimilarity(otherRows.slice(0, 10), baseline, calibration)
  assert.equal(same.calibrated, true)
  assert.ok(same.similarity >= 0.99)
  assert.ok(same.similarity > different.similarity)
  assert.equal(different.verdict, 'likely-different-behavior')
  const uncalibrated = scoreSimilarity(officialRows.slice(0, 10), baseline, null)
  assert.equal(uncalibrated.similarity, null)
  assert.equal(uncalibrated.calibrated, false)
})

test('degradation proxy separates stable and shifted recent behavior', async () => {
  const { analyzeDegradation } = await import('../lib/similarity.mjs')
  const officialRows = Array.from({ length: 20 }, (_, index) => row(index))
  const baseline = buildOfficialProfile(officialRows, { provider: 'official', model: 'official-model', minSamples: 20 })
  const stable = analyzeDegradation(Array.from({ length: 20 }, (_, index) => row(200 + index, 'third', 'candidate')), baseline)
  assert.ok(['stable', 'watch'].includes(stable.level))
  const shifted = analyzeDegradation(Array.from({ length: 20 }, (_, index) => row(300 + index, 'third', 'candidate', {
    behavior: {
      tokensPerChar: 1.5,
      charsPerChunk: 30,
      reasoningRatio: 1,
      jsonSpacing: 3,
      cjkRatio: 0,
      asciiRatio: 1,
      punctuationRatio: 0.4,
      markdownPerK: 40,
      escapedUnicode: 0.5,
      newlineRatio: 0.5,
    },
  })), baseline)
  assert.equal(shifted.level, 'degrading')
})

test('calibration stays disabled for insufficient or overlapping samples', () => {
  const few = Array.from({ length: 6 }, (_, index) => row(index))
  const tooFew = buildCalibration(few, { provider: 'official', model: 'official-model' })
  assert.equal(tooFew.calibrated, false)
  const sameOther = Array.from({ length: 20 }, (_, index) => row(100 + index, 'third', 'clone'))
  const overlap = buildCalibration([...few, ...sameOther], { provider: 'official', model: 'official-model' })
  assert.equal(overlap.calibrated, false)
})
