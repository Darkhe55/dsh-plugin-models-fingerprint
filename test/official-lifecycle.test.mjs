import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { FingerprintStore } from '../lib/store.mjs'
import { normalizeOfficialModels, freshness, FEATURE_SCHEMA_VERSION, QUALITY_VERSION } from '../lib/official.mjs'
import { artifactContext, ensureOfficialArtifacts } from '../lib/lifecycle.mjs'
import { buildOfficialProfile, SIMILARITY_VERSION } from '../lib/similarity.mjs'
import { assessModelIdentity, compareProtocol } from '../lib/identity.mjs'
import { bootstrapSessionAuc, buildHardNegativeBenchmark } from '../lib/benchmark.mjs'
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

