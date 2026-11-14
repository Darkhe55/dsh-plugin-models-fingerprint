import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { FingerprintStore } from '../lib/store.mjs'
import { normalizeOfficialModels, freshness, FEATURE_SCHEMA_VERSION, QUALITY_VERSION } from '../lib/official.mjs'
import { artifactContext, ensureOfficialArtifacts } from '../lib/lifecycle.mjs'
import { buildOfficialProfile, SIMILARITY_VERSION, sourceForOfficial } from '../lib/similarity.mjs'
import { assessModelIdentity, compareProtocol } from '../lib/identity.mjs'
import { bootstrapSessionAuc, buildHardNegativeBenchmark, clopperPearsonUpper, clusterBootstrapRate, clusterDecisionStats, evaluateFprGate, nestedSessionFpr, rollingTimeFolds, thresholdAtFpr, zeroEventConfidenceMinimum } from '../lib/benchmark.mjs'
import { buildProbePlan, validateProbeResults } from '../lib/probe-plan.mjs'
import { evaluateObservationQuality } from '../lib/quality.mjs'

function behavior() {
  return {
    tokensPerChar: 0.25,
    charsPerChunk: 12,
    reasoningRatio: 0.2,
    jsonSpacing: 0.5,
    cjkRatio: 0.1,
    asciiRatio: 0.8,
    punctuationRatio: 0.05,
    markdownPerK: 3,
    escapedUnicode: 0,
    newlineRatio: 0.03,
  }
}

function row(index, model = 'MiniMax-M3', sessionId = 's' + (index % 6), overrides = {}) {
  return {
    id: sessionId + ':' + index,
    sessionId,
    provider: 'minimax-cn',
    model,
    routeKey: 'minimax-cn/' + model,
    time: 1000 + index,
    fingerprint: 'fp_8e17c9bd6670',
    protocol: { api: 'anthropic-messages', adapter: 'pi-ai@2', wireProvider: 'minimax-cn', responseId: 'hex:32', replay: 'blocks' },
    protocolDetail: { hasReplay: true, usageKeys: ['inputTokens', 'outputTokens', 'cacheReadTokens'], toolIdShapes: ['call:hex:29'], logprobs: false },
    tokens: { input: 10, output: 5, total: 15 },
    behavior: behavior(),
    ...overrides,
  }
}

test('official evidence is explicit and survives store round-trip without provider inference', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-evidence-'))
  const root = path.join(home, 'model-fingerprint')
  await fs.mkdir(root, { recursive: true })
  const legacy = {
    version: 2,
    dataVersion: 2,
    officialModels: [{ key: 'deepseek-official/deepseek-flash', provider: 'deepseek-official', model: 'deepseek-flash', label: '官方 DeepSeek Flash', minSamples: 20 }],
    observations: {},
  }
  await fs.writeFile(path.join(root, 'state.json.zst'), zstdCompressSync(Buffer.from(JSON.stringify(legacy))))
  const store = new FingerprintStore({ home })
  await store.load()
  const keys = store.officialModels().map((model) => model.key)
  assert.ok(keys.includes('minimax-cn/MiniMax-M3'))
  assert.ok(keys.includes('minimax-cn/MiniMax-M2.7'))
  const m3 = store.officialModels().find((model) => model.key === 'minimax-cn/MiniMax-M3')
  assert.equal(m3.evidenceLevel, 'user-confirmed-official-api')
  assert.ok(m3.evidenceSource)
  await store.flush()
  const reloaded = new FingerprintStore({ home })
  await reloaded.load()
  assert.equal(reloaded.officialModels().find((model) => model.key === m3.key).evidenceLevel, 'user-confirmed-official-api')

  const inferred = normalizeOfficialModels([{ provider: 'minimax-cn', model: 'MiniMax-M9' }])[0]
  assert.equal(inferred.evidenceLevel, 'unknown', 'provider prefix must not imply official status')
})

test('stale dataVersion baseline is identified and rebuilt without being overwritten on failure', () => {
  const official = normalizeOfficialModels([{ provider: 'minimax-cn', model: 'MiniMax-M3', evidenceLevel: 'user-confirmed-official-api' }])[0]
  const rows = Array.from({ length: 12 }, (_, index) => row(index))
  const old = buildOfficialProfile(rows, official, { dataVersion: 1, featureSchemaVersion: FEATURE_SCHEMA_VERSION, qualityVersion: QUALITY_VERSION })
  const context = artifactContext({ dataVersion: 2, scannerGeneration: 'g2', observationRevision: 12, similarityVersion: SIMILARITY_VERSION })
  assert.equal(freshness(old, { digest: old.sourceDigest }, context).fresh, false)
  assert.ok(freshness(old, { digest: old.sourceDigest }, context).reasons.includes('data-version'))
  let calls = 0
  const rebuilt = ensureOfficialArtifacts({
    model: official,
    observations: rows,
    existingBaseline: old,
    existingCalibration: null,
    context,
    builders: {
      baseline: (...args) => { calls += 1; return buildOfficialProfile(...args) },
      calibration: () => { calls += 1; throw new Error('calibration failed') },
    },
  })
  assert.equal(rebuilt.baseline.rebuilt, true)
  assert.equal(rebuilt.baseline.stale, false)
  assert.equal(rebuilt.calibration.stale, true)
  assert.equal(calls, 2)

  const failure = ensureOfficialArtifacts({
    model: official,
    observations: rows,
    existingBaseline: old,
    existingCalibration: null,
    context,
    builders: { baseline: () => { throw new Error('build failed') } },
  })
  assert.equal(failure.baseline.artifact.sourceDigest, old.sourceDigest, 'last valid baseline is retained')
  assert.equal(failure.baseline.artifact.stale, true)
  assert.equal(failure.baseline.rebuilt, false)

  const stable = ensureOfficialArtifacts({
    model: official,
    observations: rows,
    existingBaseline: rebuilt.baseline.artifact,
    existingCalibration: null,
    context: artifactContext({ dataVersion: 2, scannerGeneration: 'g2', observationRevision: 12, similarityVersion: SIMILARITY_VERSION }),
    builders: { baseline: () => { throw new Error('must not rebuild') } },
  })
  assert.equal(stable.baseline.rebuilt, false)
  assert.equal(stable.baseline.stale, false)
})

test('source changes invalidate and rebuild; unchanged source is not recomputed', () => {
  const official = normalizeOfficialModels([{ provider: 'minimax-cn', model: 'MiniMax-M3' }])[0]
  const context = artifactContext({ dataVersion: 2, scannerGeneration: 'g', observationRevision: 5, similarityVersion: SIMILARITY_VERSION })
  const rows = Array.from({ length: 8 }, (_, index) => row(index))
  const first = ensureOfficialArtifacts({ model: official, observations: rows, context, builders: { calibration: () => ({ calibrated: false }) } })
  let builds = 0
  const second = ensureOfficialArtifacts({
    model: official,
    observations: rows,
    existingBaseline: first.baseline.artifact,
    existingCalibration: first.calibration.artifact,
    context,
    builders: { baseline: () => { builds += 1; return first.baseline.artifact }, calibration: () => ({ calibrated: false }) },
  })
  assert.equal(second.baseline.rebuilt, false)
  assert.equal(builds, 0)
  const changed = rows.concat(row(99, 'MiniMax-M3', 's99'))
  const third = ensureOfficialArtifacts({
    model: official,
    observations: changed,
    existingBaseline: first.baseline.artifact,
    existingCalibration: first.calibration.artifact,
    context,
    builders: { calibration: () => ({ calibrated: false }) },
  })
  assert.equal(third.baseline.rebuilt, true)
  assert.notEqual(third.baseline.artifact.sourceDigest, first.baseline.artifact.sourceDigest)
})

test('protocol agreement is not model identity; passive identity is capped', () => {
  const left = row(1, 'MiniMax-M3')
  const right = row(2, 'MiniMax-M2.7')
  const protocol = compareProtocol(left, right)
  assert.equal(protocol.sameFamily, true)
  assert.equal(protocol.sameVariant, true)
  assert.equal(protocol.sameExact, true)
  const identity = assessModelIdentity({
    protocol,
    behaviorSimilarity: 0.95,
    behaviorDistance: 1.688,
    evidenceLevel: 'user-confirmed-official-api',
    source: 'passive',
  })
  assert.equal(identity.passiveOnly, true)
  assert.ok(identity.modelIdentityConfidence <= 0.45)
  assert.equal(identity.status, 'possible-different-model-insufficient-evidence')
  assert.notEqual(identity.status, 'identity-supported')
  assert.match(identity.note, /不能单独确认模型身份/)
  const claimed = assessModelIdentity({ protocol, behaviorSimilarity: 0.95, evidenceLevel: 'claimed-only', source: 'passive' })
  assert.ok(claimed.modelIdentityConfidence <= 0.2, 'claimed-only evidence cannot use the official ceiling')
})

test('low-quality protocol-missing anomaly is flagged and excluded from baseline', () => {
  const official = normalizeOfficialModels([{ provider: 'minimax-cn', model: 'MiniMax-M2.7' }])[0]
  const good = Array.from({ length: 20 }, (_, index) => row(index, 'MiniMax-M2.7'))
  const anomaly = row(99, 'MiniMax-M2.7', 's-anomaly', {
    fingerprint: 'fp_bb2f3030e807',
    protocol: { api: '-', adapter: '-', wireProvider: '-', responseId: 'none', replay: 'none' },
    protocolDetail: { hasReplay: false, usageKeys: [], responseModel: '' },
    tokens: { input: 0, output: 0, total: 0 },
    textBlocks: 0,
    toolCalls: 0,
    behavior: { ...behavior(), tokensPerChar: null, charsPerChunk: 62.86, reasoningRatio: 1, textChars: 0, reasoningChars: 880 },
  })
  const quality = evaluateObservationQuality(anomaly)
  assert.equal(quality.completeProtocol, false)
  assert.equal(quality.usableForBaseline, false)
  assert.ok(quality.exclusionReasons.includes('protocol-fields-missing'))
  assert.ok(quality.exclusionReasons.includes('usage-missing'))
  const baseline = buildOfficialProfile(good.concat(anomaly), official, { dataVersion: 2 })
  assert.equal(baseline.samples, 20)
  assert.equal(baseline.excludedSamples, 1)
  assert.equal(baseline.fingerprints.some((item) => item.id === 'fp_bb2f3030e807'), false)
})

test('session bootstrap uses sessions and hard-negative folds do not leak rows', () => {
  const records = [
    { sessionId: 'a', sameDistance: 0.4, otherDistance: 1.2 },
    { sessionId: 'b', sameDistance: 0.5, otherDistance: 1.1 },
    { sessionId: 'c', sameDistance: 0.6, otherDistance: 1.4 },
    { sessionId: 'd', sameDistance: 0.7, otherDistance: 1.0 },
  ]
  const boot = bootstrapSessionAuc(records, { reps: 100, seed: 3 })
  assert.equal(boot.unit, 'session')
  assert.equal(boot.paired, true)
  assert.equal(boot.method, 'session-block-bootstrap')
  assert.equal(boot.clusterUnit, 'underlying-session-id')
  assert.equal(boot.uniqueUnderlyingSessions, 4)
  assert.equal(boot.pairTrials, 8)
  assert.ok(boot.auc >= 0.9)
  assert.ok(boot.lower <= boot.auc && boot.auc <= boot.upper)

  const rows = []
  for (let session = 0; session < 5; session += 1) {
    for (let index = 0; index < 6; index += 1) {
      rows.push(row(session * 10 + index, 'MiniMax-M3', 'm3-' + session, { behavior: { ...behavior(), tokensPerChar: 0.2 + index * 0.002 } }))
      rows.push(row(1000 + session * 10 + index, 'MiniMax-M2.7', 'm27-' + session, { behavior: { ...behavior(), tokensPerChar: 0.5 + index * 0.002 } }))
    }
  }
  const report = buildHardNegativeBenchmark(rows, { bootstrapReps: 50 })
  assert.equal(report.sessionHeldOut.unit, 'session')
  assert.equal(report.sessionHeldOut.leakage, false)
  assert.equal(report.sessionHeldOut.folds, 10)
  assert.ok(report.sessionHeldOut.records.every((record) => record.sessionId))
  assert.ok(report.sessionHeldOut.auc.bootstrap.unit === 'session')
})

test('fixed probe plan is offline-only and makes no MoE claim', () => {
  const plan = buildProbePlan({
    models: [{ provider: 'minimax-cn', model: 'MiniMax-M3' }, { provider: 'minimax-cn', model: 'MiniMax-M2.7' }],
    repeats: 10,
    windows: ['w1', 'w2'],
  })
  assert.equal(plan.automaticProviderCalls, false)
  assert.equal(plan.confirmRequired, true)
  assert.equal(plan.categories.length, 6)
  assert.equal(plan.prompts.length, 30)
  assert.equal(plan.totals.perModel, 600)
  assert.equal(JSON.stringify(plan).toLowerCase().includes('moe'), false)
  const imported = validateProbeResults(plan, [
    { provider: 'minimax-cn', model: 'MiniMax-M3', promptId: plan.prompts[0].id, window: 'w1', repeat: 1, behavior: {} },
    { provider: 'minimax-cn', model: 'MiniMax-M3', promptId: 'missing', behavior: {} },
  ])
  assert.equal(imported.acceptedCount, 1)
  assert.equal(imported.rejectedCount, 1)
})

test('rolling-origin training never contains a session at or after testStart', () => {
  const rowsA = Array.from({ length: 6 }, (_, index) => row(index, 'MiniMax-M3', 'a-' + index, { time: 100 + index * 10 }))
  const rowsB = Array.from({ length: 6 }, (_, index) => row(100 + index, 'MiniMax-M2.7', 'b-' + index, { time: 105 + index * 10 }))
  const result = rollingTimeFolds(rowsA, rowsB, { provider: 'minimax-cn', model: 'MiniMax-M3' }, { provider: 'minimax-cn', model: 'MiniMax-M2.7' }, { windows: 3, minTrainSessionsPerModel: 2 })
  assert.equal(result.method, 'rolling-origin-forward-chaining')
  assert.ok(result.validFolds >= 1)
  assert.equal(result.leakage, false)
  for (const fold of result.folds) {
    assert.equal(fold.leakage, false)
    assert.ok(fold.futureSessionsExcluded >= 0)
    if (fold.status === 'ok') {
      assert.ok(Date.parse(fold.trainEnd) < Date.parse(fold.testStart), 'trainEnd must precede testStart')
      assert.ok(fold.trainSessionsByModel['MiniMax-M3'] >= 2)
      assert.ok(fold.trainSessionsByModel['MiniMax-M2.7'] >= 2)
      assert.ok(fold.distances)
    } else {
      assert.equal(fold.distances, null)
      assert.equal(fold.auc, null)
    }
  }
})

test('nested FPR selects thresholds only from outer training sessions and reports resolution limits', () => {
  const rowsA = Array.from({ length: 20 }, (_, index) => row(index, 'MiniMax-M3', 'fa-' + index, { time: 1000 + index }))
  const rowsB = Array.from({ length: 20 }, (_, index) => row(1000 + index, 'MiniMax-M2.7', 'fb-' + index, { time: 1000 + index }))
  const result = nestedSessionFpr(rowsA, rowsB, { provider: 'minimax-cn', model: 'MiniMax-M3' }, { provider: 'minimax-cn', model: 'MiniMax-M2.7' }, { targets: [0.01, 0.05], reps: 100, seed: 5 })
  assert.equal(result.method, 'nested-session-level')
  assert.equal(result.thresholdSource, 'outer-training-sessions-only')
  assert.equal(result.testDataUsedForThreshold, false)
  assert.equal(result.featureSelectionUsedTest, false)
  assert.equal(result.unit, 'session')
  assert.equal(result.targets['0.01'].resolutionInsufficient, true)
  assert.equal(result.targets['0.01'].minimumObservableNonzeroFpr, 0.025)
  assert.equal(result.targets['0.05'].resolutionInsufficient, true)
  assert.equal(result.targets['0.05'].status, 'training-resolution-insufficient')
  assert.equal(result.targets['0.05'].fpr, null)
  assert.equal(result.targets['0.05'].minimumTrainNegativeTrials, 19)
  assert.equal(result.targets['0.01'].exploratoryClusterBootstrap.clusterUnit, 'underlying-session-id')
  assert.equal(result.targets['0.01'].formalUpperConfidenceBound.valid, false)
  assert.equal(result.targets['0.01'].formalGateEligible, false)
  assert.equal(result.targets['0.01'].thresholdSource, 'outer-training-sessions-only')
  assert.equal(result.targets['0.01'].testDataUsedForThreshold, false)
  assert.equal(result.targets['0.01'].meetsTarget, false)
})

test('behavior-only legacy rows can enter behavior baseline but never protocol identity', () => {
  const legacy = row(1, 'legacy-model', 'legacy-session', {
    provider: 'deepseek-official',
    routeKey: 'deepseek-official/legacy-model',
    model: 'legacy-model',
    protocol: { api: '-', adapter: '-', wireProvider: '-', responseId: 'none', replay: 'none' },
    protocolDetail: { hasReplay: false, usageKeys: [] },
  })
  const quality = evaluateObservationQuality(legacy)
  assert.equal(quality.usableForBaseline, true)
  assert.equal(quality.baselineClass, 'behavior-only-legacy')
  assert.equal(quality.usableForIdentity, false)
  assert.ok(quality.identityExclusionReasons.includes('protocol-identity-ineligible'))
  const official = normalizeOfficialModels([{ provider: 'deepseek-official', model: 'legacy-model', evidenceLevel: 'unknown' }])[0]
  const baseline = buildOfficialProfile([legacy], official, { dataVersion: 2 })
  assert.equal(baseline.samples, 1)
  assert.equal(baseline.ready, false)
})

test('source digest ignores generation and input order but changes with behavior, quality and negative inputs', () => {
  const official = normalizeOfficialModels([{ provider: 'minimax-cn', model: 'MiniMax-M3', evidenceLevel: 'user-confirmed-official-api' }])[0]
  const rows = Array.from({ length: 6 }, (_, index) => row(index))
  const context = artifactContext({ dataVersion: 2, scannerGeneration: 'g1', observationRevision: 1, similarityVersion: SIMILARITY_VERSION })
  const first = ensureOfficialArtifacts({ model: official, observations: rows, context })
  const otherGeneration = ensureOfficialArtifacts({
    model: official,
    observations: rows.slice().reverse(),
    existingBaseline: first.baseline.artifact,
    existingCalibration: first.calibration.artifact,
    context: artifactContext({ dataVersion: 2, scannerGeneration: 'restart-unique', observationRevision: 999, similarityVersion: SIMILARITY_VERSION }),
    builders: { baseline: () => { throw new Error('generation/order must not rebuild') }, calibration: () => { throw new Error('generation/order must not rebuild') } },
  })
  assert.equal(otherGeneration.baseline.rebuilt, false)
  assert.equal(otherGeneration.calibration.rebuilt, false)

  const changedRows = rows.map((item, index) => index === 0 ? { ...item, behavior: { ...item.behavior, tokensPerChar: 0.9 } } : item)
  const changed = sourceForOfficial(changedRows, official, { dataVersion: 2 })
  const original = sourceForOfficial(rows, official, { dataVersion: 2 })
  assert.notEqual(changed.digest, original.digest)
  const rebuiltForBehavior = ensureOfficialArtifacts({
    model: official,
    observations: changedRows,
    existingBaseline: first.baseline.artifact,
    existingCalibration: first.calibration.artifact,
    context,
  })
  assert.equal(rebuiltForBehavior.baseline.rebuilt, true)

  const excluded = rows.map((item, index) => index === 0 ? { ...item, behavior: { ...item.behavior, tokensPerChar: null } } : item)
  const excludedSource = sourceForOfficial(excluded, official, { dataVersion: 2 })
  assert.notEqual(excludedSource.digest, original.digest)

  const negative = row(99, 'MiniMax-M2.7', 'negative-session', { provider: 'minimax-cn' })
  const withNegative = sourceForOfficial(rows.concat(negative), official, { dataVersion: 2 })
  assert.notEqual(withNegative.calibrationDigest, original.calibrationDigest)
  assert.equal(withNegative.digest, original.digest)

  const schemaSource = sourceForOfficial(rows, official, { dataVersion: 2, featureSchemaVersion: 'behavior-v0' })
  assert.notEqual(schemaSource.digest, original.digest)
  const changedConfig = sourceForOfficial(rows, { ...official, evidenceLevel: 'claimed-only' }, { dataVersion: 2 })
  assert.notEqual(changedConfig.digest, original.digest)

  const configRebuilt = ensureOfficialArtifacts({
    model: { ...official, evidenceLevel: 'claimed-only' },
    observations: rows,
    existingBaseline: first.baseline.artifact,
    existingCalibration: first.calibration.artifact,
    context,
  })
  assert.equal(configRebuilt.baseline.rebuilt, true)
  const schemaRebuilt = ensureOfficialArtifacts({
    model: official,
    observations: rows,
    existingBaseline: first.baseline.artifact,
    existingCalibration: first.calibration.artifact,
    context: artifactContext({ dataVersion: 2, scannerGeneration: 'g1', observationRevision: 1, similarityVersion: SIMILARITY_VERSION, featureSchemaVersion: 'behavior-v0' }),
  })
  assert.equal(schemaRebuilt.baseline.rebuilt, true)
  const qualityRebuilt = ensureOfficialArtifacts({
    model: official,
    observations: rows,
    existingBaseline: first.baseline.artifact,
    existingCalibration: first.calibration.artifact,
    context: artifactContext({ dataVersion: 2, scannerGeneration: 'g1', observationRevision: 1, similarityVersion: SIMILARITY_VERSION, qualityVersion: 999 }),
  })
  assert.equal(qualityRebuilt.baseline.rebuilt, true)
})

test('cache rebuild failure keeps the last valid object and empty cache failure is explicitly unavailable', () => {
  const official = normalizeOfficialModels([{ provider: 'minimax-cn', model: 'MiniMax-M3' }])[0]
  const rows = Array.from({ length: 8 }, (_, index) => row(index))
  const context = artifactContext({ dataVersion: 2, scannerGeneration: 'g', observationRevision: 2, similarityVersion: SIMILARITY_VERSION })
  const valid = ensureOfficialArtifacts({ model: official, observations: rows, context })
  const changed = rows.concat(row(99, 'MiniMax-M3', 'new-session'))
  const failed = ensureOfficialArtifacts({
    model: official,
    observations: changed,
    existingBaseline: valid.baseline.artifact,
    existingCalibration: valid.calibration.artifact,
    context,
    builders: { baseline: () => { throw new Error('rebuild failed') } },
  })
  assert.equal(failed.baseline.artifact.sourceDigest, valid.baseline.artifact.sourceDigest)
  assert.equal(failed.baseline.artifact.stale, true)
  assert.equal(failed.baseline.rebuilt, false)

  const unavailable = ensureOfficialArtifacts({
    model: official,
    observations: changed,
    context,
    builders: { baseline: () => { throw new Error('no cache') } },
  })
  assert.equal(unavailable.baseline.artifact, null)
  assert.equal(unavailable.baseline.stale, true)
  assert.equal(unavailable.baseline.rebuilt, false)
})

test('thresholdAtFpr honors the closed <= rule and rejects unattainable FPR targets', () => {
  const four = [0.1, 0.2, 0.3, 0.4]
  const one = thresholdAtFpr(four, 0.01)
  assert.equal(one.threshold, null)
  assert.equal(one.resolutionSufficient, false)
  assert.equal(one.negativeTrials, 4)
  const fiveFour = thresholdAtFpr(four, 0.05)
  assert.equal(fiveFour.threshold, null)
  assert.equal(fiveFour.minimumObservableNonzeroFpr, 0.25)
  const eighteen = Array.from({ length: 18 }, (_, index) => 0.1 + index)
  assert.equal(thresholdAtFpr(eighteen, 0.05).threshold, null)
  assert.equal(thresholdAtFpr(eighteen, 0.05).resolutionSufficient, false)
  const nineteen = Array.from({ length: 19 }, (_, index) => 0.1 + index)
  assert.equal(thresholdAtFpr(nineteen, 0.05).threshold, null)
  const twenty = Array.from({ length: 20 }, (_, index) => 0.1 + index)
  const fiveTwenty = thresholdAtFpr(twenty, 0.05)
  assert.equal(fiveTwenty.threshold, 0.1)
  assert.equal(fiveTwenty.falseAcceptsAtThreshold, 1)
  assert.equal(fiveTwenty.empiricalTrainFpr, 0.05)
  assert.equal(fiveTwenty.resolutionSufficient, true)
  // Closed boundary: threshold 0.1 accepts exactly 0.1, not 0.1001.
  assert.equal(0.1 <= fiveTwenty.threshold, true)
  assert.equal(0.1000001 <= fiveTwenty.threshold, false)
  const duplicateValues = [0.1, 0.1, 0.1].concat(Array.from({ length: 37 }, (_, index) => 0.2 + index))
  const duplicate = thresholdAtFpr(duplicateValues, 0.05)
  assert.equal(duplicate.threshold, null)
  assert.equal(duplicate.reason.includes('duplicate'), true)
})

test('mixed-model sessions remain atomic and contribute each model rows to its own profile', () => {
  const shared = 'shared-session'
  const rowsA = [
    ...Array.from({ length: 17 }, (_, index) => row(index, 'MiniMax-M3', shared, { time: 100 })),
    ...Array.from({ length: 2 }, (_, index) => row(100 + index, 'MiniMax-M3', 'm3-' + index, { time: 10 + index })),
    ...Array.from({ length: 2 }, (_, index) => row(200 + index, 'MiniMax-M3', 'm3-test-' + index, { time: 200 + index })),
  ]
  const rowsB = [
    row(500, 'MiniMax-M2.7', shared, { time: 100 }),
    ...Array.from({ length: 2 }, (_, index) => row(500 + index, 'MiniMax-M2.7', 'm27-' + index, { time: 15 + index })),
    ...Array.from({ length: 2 }, (_, index) => row(600 + index, 'MiniMax-M2.7', 'm27-test-' + index, { time: 210 + index })),
  ]
  const result = rollingTimeFolds(rowsA, rowsB, { provider: 'minimax-cn', model: 'MiniMax-M3' }, { provider: 'minimax-cn', model: 'MiniMax-M2.7' }, { windows: 5, minTrainSessionsPerModel: 2 })
  assert.ok(result.folds.some((fold) => fold.trainSessionIds.includes(shared)), 'shared session must be atomic and trainable as one unit')
  const mixed = result.folds.find((fold) => fold.trainSessionIds.includes(shared))
  assert.equal(mixed.trainSessionsByModel['MiniMax-M3'] >= 3, true)
  assert.equal(mixed.trainSessionsByModel['MiniMax-M2.7'] >= 2, true)
  assert.equal(mixed.trainSamplesByModel['MiniMax-M3'] >= 17, true)
  assert.equal(mixed.trainSamplesByModel['MiniMax-M2.7'] >= 1, true)
  assert.ok(mixed.mixedModelSessions >= 1)
  for (const fold of result.folds) {
    const overlap = fold.trainSessionIds.filter((id) => fold.testSessionIds.includes(id))
    assert.deepEqual(overlap, [], 'no session may be split across train/test')
  }
})

test('rolling-origin excludes sessions whose end crosses testStart and uses true train end', () => {
  const rowsA = [
    row(1, 'MiniMax-M3', 'a0', { time: 10 }), row(2, 'MiniMax-M3', 'a1', { time: 20 }),
    row(3, 'MiniMax-M3', 'boundary', { time: 50 }), row(4, 'MiniMax-M3', 'boundary', { time: 200 }),
    row(5, 'MiniMax-M3', 'test-a', { time: 100 }),
  ]
  const rowsB = [
    row(11, 'MiniMax-M2.7', 'b0', { time: 15 }), row(12, 'MiniMax-M2.7', 'b1', { time: 25 }),
    row(13, 'MiniMax-M2.7', 'test-b', { time: 110 }),
  ]
  const result = rollingTimeFolds(rowsA, rowsB, { provider: 'minimax-cn', model: 'MiniMax-M3' }, { provider: 'minimax-cn', model: 'MiniMax-M2.7' }, { windows: 5, minTrainSessionsPerModel: 2 })
  const fold = result.folds.find((item) => item.boundaryOverlapSessionIds.includes('boundary'))
  assert.ok(fold)
  assert.equal(fold.trainSessionIds.includes('boundary'), false)
  assert.equal(fold.testSessionIds.includes('boundary'), false)
  assert.equal(fold.boundaryOverlapSessions >= 1, true)
  assert.ok(Date.parse(fold.trainEnd) < Date.parse(fold.testStart))
  assert.deepEqual(fold.trainSessionIds.filter((id) => fold.testSessionIds.includes(id)), [])
})

test('bootstrap groups shared model-session records by underlying session id', () => {
  const records = [
    { sessionId: 'a', model: 'A', sameDistance: 0.2, otherDistance: 2 },
    { sessionId: 'b', model: 'A', sameDistance: 0.3, otherDistance: 2.2 },
    { sessionId: 'c', model: 'A', sameDistance: 0.4, otherDistance: 2.4 },
    { sessionId: 'shared', model: 'A', sameDistance: 0.5, otherDistance: 2.5 },
    { sessionId: 'shared', model: 'B', sameDistance: 0.6, otherDistance: 2.6 },
  ]
  const boot = bootstrapSessionAuc(records, { reps: 20, seed: 9 })
  assert.equal(boot.method, 'session-block-bootstrap')
  assert.equal(boot.clusterUnit, 'underlying-session-id')
  assert.equal(boot.stratifiedByModel, false)
  assert.equal(boot.modelSessionRecords, 5)
  assert.equal(boot.uniqueUnderlyingSessions, 4)
  assert.equal(boot.sharedModelSessionCount, 1)
  assert.deepEqual(boot.blockSizes.sort((a, b) => a - b), [1, 1, 1, 2])
  assert.equal(boot.pairedDistancesPreserved, true)
  assert.equal(boot.pairTrials, 10)
})

test('Clopper-Pearson one-sided upper bound is non-degenerate at zero events', () => {
  const n100 = clopperPearsonUpper({ events: 0, trials: 100 })
  assert.equal(n100.valid, true)
  assert.ok(Math.abs(n100.upper - 0.029513) < 0.0002, '0/100 upper is about 2.95%')
  assert.ok(n100.upper > 0.01, '0/100 cannot establish 1%')
  const n299 = clopperPearsonUpper({ events: 0, trials: 299 })
  assert.ok(n299.upper <= 0.01 + 1e-6, '0/299 meets the 1% upper bound')
  const n298 = clopperPearsonUpper({ events: 0, trials: 298 })
  assert.ok(n298.upper > 0.01, '0/298 does not meet 1%')
  const n59 = clopperPearsonUpper({ events: 0, trials: 59 })
  assert.ok(n59.upper <= 0.05 + 1e-6, '0/59 meets the 5% upper bound')
  const n58 = clopperPearsonUpper({ events: 0, trials: 58 })
  assert.ok(n58.upper > 0.05, '0/58 does not meet 5%')
  assert.equal(zeroEventConfidenceMinimum(0.01), 299)
  assert.equal(zeroEventConfidenceMinimum(0.05), 59)
  const one = clopperPearsonUpper({ events: 1, trials: 100 })
  assert.ok(one.upper > one.point)
  const all = clopperPearsonUpper({ events: 100, trials: 100 })
  assert.equal(all.upper, 1)
  const empty = clopperPearsonUpper({ events: 0, trials: 0 })
  assert.equal(empty.valid, false)
  assert.equal(empty.upper, null)
})

test('cluster false accept is one event when any model record in a shared session fails', () => {
  const records = [
    { sessionId: 'shared', model: 'M3', sameDistance: 0.2, otherDistance: 0.9, thresholds: { '0.05': 1 } },
    { sessionId: 'shared', model: 'M2.7', sameDistance: 0.3, otherDistance: 2.1, thresholds: { '0.05': 1 } },
    { sessionId: 'clean', model: 'M3', sameDistance: 0.1, otherDistance: 2.0, thresholds: { '0.05': 1 } },
  ]
  const stats = clusterDecisionStats(records, '0.05')
  assert.equal(stats.verificationTrialCount, 3)
  assert.equal(stats.uniqueUnderlyingSessions, 2)
  assert.equal(stats.falseAcceptTrials, 1)
  assert.equal(stats.falseAcceptClusters, 1)
  assert.equal(stats.clusterFalseAcceptRate, 0.5)
})

test('verification trials and underlying session clusters are counted separately', () => {
  const two = [
    { sessionId: 'shared', model: 'M3', sameDistance: 0.1, otherDistance: 0.8, thresholds: { '0.05': 1 } },
    { sessionId: 'shared', model: 'M2.7', sameDistance: 0.2, otherDistance: 2, thresholds: { '0.05': 1 } },
  ]
  const stats = clusterDecisionStats(two, '0.05')
  assert.equal(stats.verificationTrialCount, 2)
  assert.equal(stats.uniqueUnderlyingSessions, 1)
  assert.equal(stats.falseAcceptTrials, 1)
  assert.equal(stats.falseAcceptClusters, 1)

  const records = Array.from({ length: 23 }, (_, index) => ({
    sessionId: index === 0 ? 'shared' : 's' + index,
    model: index === 0 ? 'M3' : 'M3',
    sameDistance: 0.2 + index * 0.01,
    otherDistance: 2 + index * 0.01,
  }))
  records.push({ sessionId: 'shared', model: 'M2.7', sameDistance: 0.3, otherDistance: 2.1 })
  const boot = bootstrapSessionAuc(records, { reps: 5, seed: 3 })
  assert.equal(boot.modelSessionRecords, 24)
  assert.equal(boot.uniqueUnderlyingSessions, 23)
  assert.equal(boot.sharedModelSessionCount, 1)
  assert.equal(boot.blockSizes.filter((size) => size === 2).length, 1)
})

test('formal gate requires exact confidence bound, not zero trial FPR or bootstrap zero', () => {
  const base = {
    trainingResolutionSufficient: true,
    testResolutionSufficient: true,
    thresholdResolvable: true,
    allOuterFoldsEvaluable: true,
    falseAcceptClusters: 0,
    targetFpr: 0.01,
  }
  const insufficient100 = evaluateFprGate({ ...base, uniqueUnderlyingSessions: 100 })
  assert.equal(insufficient100.meetsTarget, false)
  assert.equal(insufficient100.formalGateEligible, false)
  assert.equal(insufficient100.status, 'confidence-upper-bound-too-high')
  assert.ok(insufficient100.formalUpperConfidenceBound.upper > 0.01)

  const sufficient299 = evaluateFprGate({ ...base, uniqueUnderlyingSessions: 299 })
  assert.equal(sufficient299.formalGateEligible, true)
  assert.equal(sufficient299.meetsTarget, true)
  assert.equal(sufficient299.status, 'target-met')
  assert.ok(sufficient299.formalUpperConfidenceBound.upper <= 0.01)

  const fivePercent59 = evaluateFprGate({ ...base, targetFpr: 0.05, uniqueUnderlyingSessions: 59 })
  assert.equal(fivePercent59.meetsTarget, true)
  const fivePercent20 = evaluateFprGate({ ...base, targetFpr: 0.05, uniqueUnderlyingSessions: 20 })
  assert.equal(fivePercent20.meetsTarget, false)

  const leaked = evaluateFprGate({ ...base, uniqueUnderlyingSessions: 299, leakage: true })
  assert.equal(leaked.meetsTarget, false)
  assert.ok(leaked.formalGateReasons.includes('data-leakage'))

  const noClusters = evaluateFprGate({ ...base, uniqueUnderlyingSessions: 0 })
  assert.equal(noClusters.formalUpperConfidenceBound.valid, false)
  assert.equal(noClusters.meetsTarget, false)

  const records = Array.from({ length: 100 }, (_, index) => ({
    sessionId: 'cluster-' + index,
    model: 'M3',
    sameDistance: 0.2,
    otherDistance: 2,
    thresholds: { '0.01': 1 },
  }))
  const bootstrap = clusterBootstrapRate(records, (sample) => {
    const stats = clusterDecisionStats(sample, '0.01')
    return stats.uniqueUnderlyingSessions ? stats.clusterFalseAcceptRate : null
  }, { reps: 100, seed: 4 })
  assert.equal(bootstrap.upper, 0, 'zero events make percentile bootstrap degenerate')
  assert.ok(insufficient100.formalUpperConfidenceBound.upper > 0, 'formal CP upper is non-zero')
  assert.equal(insufficient100.status, 'confidence-upper-bound-too-high')
})

