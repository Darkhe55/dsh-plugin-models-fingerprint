/**
 * Offline, session-grouped evaluation for official-model behavior evidence.
 *
 * Every split is by session/time window. Observations from one session never
 * appear in both train and test. Bootstrap resampling also uses sessions, not
 * rows, because observations inside a session are strongly correlated.
 */
import { BEHAVIOR_FEATURES, distanceProfiles, profileFor } from './equivalence.mjs'
import { evaluateObservationQuality, qualityForRows } from './quality.mjs'
import { behaviorProfileIdForProfile, transportFamilyId, transportVariantId } from './identity.mjs'

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const round = (value, digits = 3) => (finite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null)

/* Stable log-gamma for the Clopper-Pearson binomial CDF. */
function logGamma(z) {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ]
  let x = z
  let y = z
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let series = 1.000000000190015
  for (const coefficient of coefficients) {
    y += 1
    series += coefficient / y
  }
  return -tmp + Math.log(2.5066282746310005 * series / x)
}

function logSumExp(values) {
  if (!values.length) return -Infinity
  let maximum = -Infinity
  for (const value of values) if (value > maximum) maximum = value
  if (!Number.isFinite(maximum)) return maximum
  let sum = 0
  for (const value of values) sum += Math.exp(value - maximum)
  return maximum + Math.log(sum)
}

function binomialCdf(k, n, p) {
  if (k < 0) return 0
  if (k >= n) return 1
  if (!(p > 0)) return 1
  if (p >= 1) return 0
  const logP = Math.log(p)
  const logQ = Math.log1p(-p)
  const logPmf = []
  for (let index = 0; index <= k; index += 1) {
    const logChoose = logGamma(n + 1) - logGamma(index + 1) - logGamma(n - index + 1)
    logPmf.push(logChoose + index * logP + (n - index) * logQ)
  }
  return Math.min(1, Math.max(0, Math.exp(logSumExp(logPmf))))
}

export function clopperPearsonUpper({ events, trials, confidenceLevel = 0.95 } = {}) {
  const x = Number(events)
  const n = Number(trials)
  const confidence = Number(confidenceLevel)
  const alpha = 1 - confidence
  const invalid = (reason) => ({
    method: 'clopper-pearson-one-sided',
    confidenceLevel: confidence,
    alpha,
    events: Number.isFinite(x) ? x : null,
    trials: Number.isFinite(n) ? n : null,
    point: Number.isFinite(x) && Number.isFinite(n) && n > 0 ? x / n : null,
    upper: null,
    valid: false,
    reason,
  })
  if (!Number.isInteger(x) || !Number.isInteger(n) || n <= 0 || x < 0 || x > n) {
    return invalid('events must be an integer in [0, trials] and trials must be positive')
  }
  if (!(confidence > 0 && confidence < 1)) return invalid('confidenceLevel must be between 0 and 1')
  if (x === 0) {
    return {
      method: 'clopper-pearson-one-sided',
      confidenceLevel: confidence,
      alpha,
      events: 0,
      trials: n,
      point: 0,
      upper: 1 - Math.pow(alpha, 1 / n),
      valid: true,
      reason: 'zero-event exact one-sided upper bound',
    }
  }
  if (x === n) {
    return {
      method: 'clopper-pearson-one-sided',
      confidenceLevel: confidence,
      alpha,
      events: n,
      trials: n,
      point: 1,
      upper: 1,
      valid: true,
      reason: 'all events exact one-sided upper bound',
    }
  }
  let low = 0
  let high = 1
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (low + high) / 2
    if (binomialCdf(x, n, middle) > alpha) low = middle
    else high = middle
  }
  const upper = (low + high) / 2
  if (!finite(upper)) return invalid('binomial CDF root was not finite')
  return {
    method: 'clopper-pearson-one-sided',
    confidenceLevel: confidence,
    alpha,
    events: x,
    trials: n,
    point: x / n,
    upper: Math.min(1, Math.max(x / n, upper)),
    valid: true,
    reason: 'exact one-sided binomial upper bound',
  }
}

export function evaluateFprGate({
  trainingResolutionSufficient = false,
  testResolutionSufficient = false,
  thresholdResolvable = false,
  allOuterFoldsEvaluable = false,
  uniqueUnderlyingSessions = 0,
  falseAcceptClusters = 0,
  targetFpr,
  leakage = false,
  confidenceLevel = 0.95,
} = {}) {
  const formalUpperConfidenceBound = clopperPearsonUpper({
    events: falseAcceptClusters,
    trials: uniqueUnderlyingSessions,
    confidenceLevel,
  })
  const reasons = []
  if (!trainingResolutionSufficient) reasons.push('training-resolution-insufficient')
  if (!allOuterFoldsEvaluable || !thresholdResolvable) reasons.push('outer-fold-not-evaluable')
  if (!testResolutionSufficient) reasons.push('test-cluster-resolution-insufficient')
  if (!formalUpperConfidenceBound.valid) reasons.push('confidence-bound-unavailable')
  if (leakage) reasons.push('data-leakage')
  if (formalUpperConfidenceBound.valid && formalUpperConfidenceBound.upper > targetFpr) reasons.push('confidence-upper-bound-too-high')
  const eligible = reasons.length === 0
  const status = !trainingResolutionSufficient
    ? 'training-resolution-insufficient'
    : !testResolutionSufficient
      ? 'test-cluster-resolution-insufficient'
      : !formalUpperConfidenceBound.valid
        ? 'confidence-bound-unavailable'
        : formalUpperConfidenceBound.upper > targetFpr
          ? 'confidence-upper-bound-too-high'
          : eligible ? 'target-met' : 'not-verified'
  return {
    formalUpperConfidenceBound,
    formalGateEligible: eligible,
    formalGateReasons: reasons,
    meetsTarget: eligible,
    status,
  }
}

export function zeroEventConfidenceMinimum(targetFpr, confidenceLevel = 0.95) {
  const target = Number(targetFpr)
  const confidence = Number(confidenceLevel)
  if (!(target > 0 && target < 1) || !(confidence > 0 && confidence < 1)) return null
  return Math.ceil(Math.log(1 - confidence) / Math.log(1 - target))
}

export function median(values) {
  const list = values.filter(finite).sort((a, b) => a - b)
  if (!list.length) return null
  const middle = Math.floor(list.length / 2)
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2
}

export function quantile(values, p) {
  const list = values.filter(finite).sort((a, b) => a - b)
  if (!list.length) return null
  const position = Math.max(0, Math.min(1, p)) * (list.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return list[lower]
  return list[lower] + (list[upper] - list[lower]) * (position - lower)
}

export function mad(values, center = median(values)) {
  if (center === null) return null
  return median(values.filter(finite).map((value) => Math.abs(value - center)))
}

export function summarize(values) {
  const list = values.filter(finite)
  if (!list.length) return { samples: 0, min: null, p25: null, median: null, p75: null, max: null, mean: null }
  return {
    samples: list.length,
    min: round(Math.min(...list)),
    p25: round(quantile(list, 0.25)),
    median: round(median(list)),
    p75: round(quantile(list, 0.75)),
    max: round(Math.max(...list)),
    mean: round(list.reduce((sum, value) => sum + value, 0) / list.length),
  }
}

function auc(scores, labels) {
  const positives = []
  const negatives = []
  for (let index = 0; index < scores.length; index += 1) {
    if (labels[index]) positives.push(scores[index])
    else negatives.push(scores[index])
  }
  if (!positives.length || !negatives.length) return null
  let wins = 0
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive > negative) wins += 1
      else if (positive === negative) wins += 0.5
    }
  }
  return wins / (positives.length * negatives.length)
}

function seededRandom(seed) {
  let state = Number(seed) || 17
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

function sessionBlocks(records) {
  const blocks = new Map()
  for (const record of records) {
    const key = record.sessionId || record.id || 'unknown'
    if (!blocks.has(key)) blocks.set(key, [])
    blocks.get(key).push(record)
  }
  return blocks
}

function resampleSessionBlocks(records, random) {
  const blocks = [...sessionBlocks(records).values()]
  if (!blocks.length) return []
  const sample = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[Math.floor(random() * blocks.length)]
    sample.push(...block)
  }
  return sample
}

function bootstrapShape(records) {
  const blocks = sessionBlocks(records)
  let sharedModelSessionCount = 0
  for (const block of blocks.values()) {
    if (new Set(block.map((record) => record.model)).size > 1) sharedModelSessionCount += 1
  }
  return {
    modelSessionRecords: records.length,
    uniqueUnderlyingSessions: blocks.size,
    sharedModelSessionCount,
    blockSizes: [...blocks.values()].map((block) => block.length),
    clusterUnit: 'underlying-session-id',
    method: 'session-block-bootstrap',
    stratifiedByModel: false,
    pairedDistancesPreserved: true,
  }
}

export function bootstrapSessionAuc(records, { reps = 2000, seed = 17 } = {}) {
  const usable = records.filter((record) => finite(record.sameDistance) && finite(record.otherDistance))
  if (usable.length < 2) {
    return {
      metric: 'session-paired-verification-auc',
      paired: true,
      auc: null,
      lower: null,
      upper: null,
      reps: 0,
      unit: 'session',
      sessions: usable.length,
      pairTrials: usable.length * 2,
      ...bootstrapShape(usable),
      seed,
    }
  }
  const pointScores = []
  const pointLabels = []
  for (const record of usable) {
    // A model-session record is sampled with its other model record when both
    // share an underlying session; same/other distances stay paired.
    pointScores.push(-record.sameDistance, -record.otherDistance)
    pointLabels.push(1, 0)
  }
  const point = auc(pointScores, pointLabels)
  const random = seededRandom(seed)
  const values = []
  for (let rep = 0; rep < Math.max(1, reps); rep += 1) {
    const sample = resampleSessionBlocks(usable, random)
    const sampleScores = []
    const sampleLabels = []
    for (const record of sample) {
      sampleScores.push(-record.sameDistance, -record.otherDistance)
      sampleLabels.push(1, 0)
    }
    const value = auc(sampleScores, sampleLabels)
    if (value !== null) values.push(value)
  }
  values.sort((a, b) => a - b)
  return {
    metric: 'session-paired-verification-auc',
    paired: true,
    auc: round(point),
    lower: round(quantile(values, 0.025)),
    upper: round(quantile(values, 0.975)),
    reps: values.length,
    unit: 'session',
    sessions: new Set(usable.map((record) => record.sessionId)).size,
    pairTrials: usable.length * 2,
    ...bootstrapShape(usable),
    sessionsByModel: usable.reduce((counts, record) => {
      const key = record.model || 'unknown'
      counts[key] = (counts[key] || 0) + 1
      return counts
    }, {}),
    seed,
  }
}

/**
 * Closed-interval (`distance <= threshold`) order-statistic threshold.
 *
 * For n training negatives, accepting any observed positive number of them
 * gives at least 1/n empirical FPR. We only return a finite threshold when the
 * largest attainable accepted count is <= floor(n * target); otherwise no
 * finite observed threshold can resolve the target and `threshold` is null.
 */
export function thresholdAtFpr(differentDistances, fpr) {
  const target = Number(fpr)
  const values = differentDistances.filter(finite).sort((a, b) => a - b)
  const negativeTrials = values.length
  const minimumObservableNonzeroFpr = negativeTrials ? 1 / negativeTrials : null
  const requiredNegativeTrials = Number.isFinite(target) && target > 0 ? Math.ceil(1 / target) : null
  const allowedFalseAccepts = Number.isFinite(target) && target > 0 ? Math.floor(negativeTrials * target + 1e-12) : 0
  const base = {
    targetFpr: Number.isFinite(target) ? target : null,
    negativeTrials,
    falseAcceptsAtThreshold: 0,
    empiricalTrainFpr: negativeTrials ? 0 : null,
    resolutionSufficient: false,
    minimumObservableNonzeroFpr: round(minimumObservableNonzeroFpr),
    requiredNegativeTrials,
    orderStatisticIndex: null,
    threshold: null,
    reason: null,
  }
  if (!negativeTrials) {
    base.reason = 'no finite training negatives'
    return base
  }
  if (!Number.isFinite(target) || target <= 0) {
    base.reason = 'target FPR must be positive'
    return base
  }
  if (allowedFalseAccepts < 1) {
    base.reason = 'target FPR is below 1/negativeTrials; no finite observed threshold can resolve it'
    return base
  }
  // Collapse duplicates; the closed <= rule accepts the whole tie block.
  const distinct = []
  for (let index = 0; index < values.length; index += 1) {
    if (!distinct.length || values[index] !== distinct[distinct.length - 1].value) {
      distinct.push({ value: values[index], count: 1 })
    } else {
      distinct[distinct.length - 1].count += 1
    }
  }
  let cumulative = 0
  let chosen = null
  for (const item of distinct) {
    cumulative += item.count
    if (cumulative > allowedFalseAccepts) break
    chosen = { ...item, cumulative }
  }
  if (!chosen) {
    base.reason = 'duplicate distances make every finite threshold accept more than the target allows'
    return base
  }
  return {
    ...base,
    threshold: chosen.value,
    falseAcceptsAtThreshold: chosen.cumulative,
    empiricalTrainFpr: round(chosen.cumulative / negativeTrials),
    resolutionSufficient: true,
    orderStatisticIndex: chosen.cumulative - 1,
    reason: 'largest observed threshold satisfying accepted/negativeTrials <= targetFpr',
  }
}

export function recallAtThreshold(sameDistances, threshold) {
  const values = sameDistances.filter(finite)
  if (!values.length || !finite(threshold)) return null
  return values.filter((value) => value <= threshold).length / values.length
}

function crossSessionDistances(sessionGroup, otherProfile) {
  const distances = []
  for (const rows of sessionGroup.values()) {
    const value = distanceProfiles(profileFor(rows), otherProfile).distance
    if (finite(value)) distances.push(value)
  }
  return distances
}

export function clusterBootstrapRate(records, metric, { reps = 2000, seed = 17 } = {}) {
  if (!records.length) {
    return {
      point: null,
      lower: null,
      upper: null,
      upper95: null,
      reps: 0,
      unit: 'session',
      ...bootstrapShape(records),
      seed,
    }
  }
  const point = metric(records)
  const random = seededRandom(seed)
  const values = []
  for (let rep = 0; rep < Math.max(1, reps); rep += 1) {
    const sample = resampleSessionBlocks(records, random)
    const value = metric(sample)
    if (value !== null) values.push(value)
  }
  values.sort((a, b) => a - b)
  return {
    point: round(point),
    lower: round(quantile(values, 0.025)),
    upper: round(quantile(values, 0.975)),
    upper95: round(quantile(values, 0.95)),
    reps: values.length,
    unit: 'session',
    ...bootstrapShape(records),
    seed,
  }
}

export function clusterDecisionStats(records, key) {
  const clusters = new Map()
  let falseAcceptTrials = 0
  let trueAcceptTrials = 0
  for (const record of records) {
    const threshold = record.thresholds && record.thresholds[key]
    if (!finite(threshold) || !finite(record.sameDistance) || !finite(record.otherDistance)) continue
    const clusterId = record.sessionId
    if (!clusters.has(clusterId)) clusters.set(clusterId, { falseAccept: false, trueAccept: false, models: new Set(), records: [] })
    const cluster = clusters.get(clusterId)
    const falseAccept = record.otherDistance <= threshold
    const trueAccept = record.sameDistance <= threshold
    if (falseAccept) falseAcceptTrials += 1
    if (trueAccept) trueAcceptTrials += 1
    cluster.falseAccept = cluster.falseAccept || falseAccept
    cluster.trueAccept = cluster.trueAccept || trueAccept
    cluster.models.add(record.model)
    cluster.records.push(record)
  }
  const falseAcceptClusters = [...clusters.values()].filter((cluster) => cluster.falseAccept).length
  const trueAcceptClusters = [...clusters.values()].filter((cluster) => cluster.trueAccept).length
  return {
    verificationTrialCount: records.length,
    uniqueUnderlyingSessions: clusters.size,
    modelSessionRecords: records.length,
    sharedModelSessions: [...clusters.values()].filter((cluster) => cluster.models.size > 1).length,
    falseAcceptTrials,
    trueAcceptTrials,
    falseAcceptClusters,
    trueAcceptClusters,
    trialFpr: records.length ? falseAcceptTrials / records.length : null,
    clusterFalseAcceptRate: clusters.size ? falseAcceptClusters / clusters.size : null,
    clusters,
  }
}

export function nestedSessionFpr(rowsA, rowsB, modelA, modelB, options = {}) {
  const targets = options.targets || [0.01, 0.05]
  const minTrainSessionsPerModel = Math.max(2, Number(options.minTrainSessionsPerModel) || 2)
  const sessionsA = groupedSessions(rowsA)
  const sessionsB = groupedSessions(rowsB)
  const records = []
  for (const [model, ownRows, ownSessions, otherSessions] of [
    [modelA.model, rowsA, sessionsA, sessionsB],
    [modelB.model, rowsB, sessionsB, sessionsA],
  ]) {
    for (const [sessionId, testRows] of ownSessions) {
      const trainOwnSessions = new Map([...ownSessions.entries()].filter(([id]) => id !== sessionId))
      const otherTrainSessions = new Map([...otherSessions.entries()].filter(([id]) => id !== sessionId))
      const trainOwnRows = [...trainOwnSessions.values()].flat()
      const otherRows = [...otherTrainSessions.values()].flat()
      const base = {
        sessionId,
        model,
        testSamples: testRows.length,
        trainSessionsByModel: { [modelA.model]: 0, [modelB.model]: 0 },
      }
      if (model === modelA.model) {
        base.trainSessionsByModel = { [modelA.model]: trainOwnSessions.size, [modelB.model]: otherTrainSessions.size }
      } else {
        base.trainSessionsByModel = { [modelA.model]: otherTrainSessions.size, [modelB.model]: trainOwnSessions.size }
      }
      if (trainOwnSessions.size < minTrainSessionsPerModel
        || otherTrainSessions.size < minTrainSessionsPerModel
        || !trainOwnRows.length || !otherRows.length) {
        records.push({
          ...base,
          status: 'insufficient-training-history',
          skipReason: 'need at least ' + minTrainSessionsPerModel + ' sessions per model',
          thresholds: {},
          thresholdDetails: {},
          trainCrossSessions: 0,
        })
        continue
      }
      const ownProfile = profileFor(trainOwnRows)
      const otherProfile = profileFor(otherRows)
      const testProfile = profileFor(testRows)
      const sameDistance = distanceProfiles(testProfile, ownProfile).distance
      const otherDistance = distanceProfiles(testProfile, otherProfile).distance
      const trainCross = crossSessionDistances(trainOwnSessions, otherProfile)
      const thresholds = {}
      const thresholdDetails = {}
      for (const target of targets) {
        const detail = thresholdAtFpr(trainCross, target)
        thresholdDetails[String(target)] = detail
        thresholds[String(target)] = detail.resolutionSufficient ? detail.threshold : null
      }
      records.push({
        ...base,
        status: finite(sameDistance) && finite(otherDistance) ? 'ok' : 'no-distance',
        skipReason: finite(sameDistance) && finite(otherDistance) ? null : 'distance unavailable',
        sameDistance,
        otherDistance,
        thresholds,
        thresholdDetails,
        trainCrossSessions: trainCross.length,
      })
    }
  }
  const results = {}
  for (const target of targets) {
    const key = String(target)
    const details = records
      .map((record) => record.thresholdDetails && record.thresholdDetails[key])
      .filter(Boolean)
    const trainNegativeTrials = details.map((detail) => detail.negativeTrials).filter(finite)
    const minimumTrainNegativeTrials = trainNegativeTrials.length ? Math.min(...trainNegativeTrials) : null
    const maximumTrainResolution = minimumTrainNegativeTrials ? 1 / minimumTrainNegativeTrials : null
    const trainingResolutionSufficient = records.length > 0
      && records.every((record) => record.thresholdDetails && record.thresholdDetails[key] && record.thresholdDetails[key].resolutionSufficient)
    const usable = records.filter((record) => record.status === 'ok'
      && record.thresholdDetails && record.thresholdDetails[key] && record.thresholdDetails[key].resolutionSufficient
      && finite(record.thresholds[key]) && finite(record.sameDistance) && finite(record.otherDistance))
    const skipped = records.filter((record) => !usable.includes(record))
    const skippedReasons = {}
    for (const record of skipped) {
      let reason = record.status === 'ok' ? 'training-resolution-insufficient' : record.status
      if (record.status === 'ok' && record.thresholdDetails && record.thresholdDetails[key] === undefined) reason = 'threshold-missing'
      skippedReasons[reason] = (skippedReasons[reason] || 0) + 1
    }
    const allTestRecords = records.filter((record) => record.status === 'ok'
      && finite(record.sameDistance) && finite(record.otherDistance))
    const allTestShape = bootstrapShape(allTestRecords)
    const testTrialCount = allTestShape.modelSessionRecords
    const testClusterCount = allTestShape.uniqueUnderlyingSessions
    const requiredNegativeTrials = Math.ceil(1 / target)
    const testResolutionSufficient = testClusterCount >= requiredNegativeTrials
    const trialResolution = {
      verificationTrialCount: testTrialCount,
      minimumObservableNonzeroFpr: round(testTrialCount ? 1 / testTrialCount : null),
      requiredTrials: requiredNegativeTrials,
      sufficient: testTrialCount >= requiredNegativeTrials,
    }
    const clusterResolution = {
      uniqueUnderlyingSessions: testClusterCount,
      minimumObservableNonzeroFpr: round(testClusterCount ? 1 / testClusterCount : null),
      requiredClusters: requiredNegativeTrials,
      sufficient: testResolutionSufficient,
    }
    const eligibleStats = clusterDecisionStats(usable, key)
    const falseAccepts = eligibleStats.falseAcceptTrials
    const trueAccepts = eligibleStats.trueAcceptTrials
    const exploratoryPoint = {
      fpr: eligibleStats.verificationTrialCount ? round(eligibleStats.trialFpr) : null,
      recall: eligibleStats.verificationTrialCount ? round(trueAccepts / eligibleStats.verificationTrialCount) : null,
      falseAccepts,
      verificationTrialCount: eligibleStats.verificationTrialCount,
      trueAccepts,
      falseAcceptClusters: eligibleStats.falseAcceptClusters,
      uniqueUnderlyingSessions: eligibleStats.uniqueUnderlyingSessions,
      trialFpr: eligibleStats.verificationTrialCount ? round(eligibleStats.trialFpr) : null,
      clusterFalseAcceptRate: eligibleStats.uniqueUnderlyingSessions ? round(eligibleStats.clusterFalseAcceptRate) : null,
    }
    const thresholdValues = usable.map((record) => record.thresholds[key])
    const fprBootstrap = clusterBootstrapRate(usable, (sample) => {
      const stats = clusterDecisionStats(sample, key)
      return stats.uniqueUnderlyingSessions ? stats.clusterFalseAcceptRate : null
    }, { reps: options.reps || 2000, seed: options.seed || 17 })
    const recallBootstrap = clusterBootstrapRate(usable, (sample) => {
      const positives = sample.filter((record) => finite(record.thresholds[key]) && record.sameDistance <= record.thresholds[key]).length
      return positives ? positives / sample.length : null
    }, { reps: options.reps || 2000, seed: (options.seed || 17) + 1 })
    const allFoldsUsable = records.length > 0 && usable.length === records.length
    const thresholdResolvable = trainingResolutionSufficient && allFoldsUsable
    const gate = evaluateFprGate({
      trainingResolutionSufficient,
      testResolutionSufficient,
      thresholdResolvable,
      allOuterFoldsEvaluable: allFoldsUsable,
      uniqueUnderlyingSessions: eligibleStats.uniqueUnderlyingSessions,
      falseAcceptClusters: eligibleStats.falseAcceptClusters,
      targetFpr: target,
      leakage: records.some((record) => record.leakage),
    })
    const formalUpperConfidenceBound = gate.formalUpperConfidenceBound
    if (!formalUpperConfidenceBound.valid && eligibleStats.uniqueUnderlyingSessions === 0) {
      formalUpperConfidenceBound.reason = 'no eligible verification trials; formal upper bound unavailable'
    }
    const formalGateEligible = gate.formalGateEligible
    const formalGateReasons = gate.formalGateReasons
    const status = gate.status
    results[key] = {
      targetFpr: target,
      method: 'nested-session-level',
      thresholdSource: 'outer-training-sessions-only',
      testDataUsedForThreshold: false,
      featureSelectionUsedTest: false,
      finiteSampleRule: 'closed interval distance <= threshold; threshold only chosen when accepted/negativeTrials <= targetFpr',
      thresholdRange: {
        min: round(thresholdValues.length ? Math.min(...thresholdValues) : null),
        median: round(median(thresholdValues)),
        max: round(thresholdValues.length ? Math.max(...thresholdValues) : null),
      },
      point: { ...exploratoryPoint, formal: formalGateEligible },
      exploratoryPoint,
      verificationTrialCount: testTrialCount,
      uniqueUnderlyingSessions: testClusterCount,
      modelSessionRecords: allTestShape.modelSessionRecords,
      sharedModelSessions: allTestShape.sharedModelSessionCount,
      falseAcceptTrials: eligibleStats.verificationTrialCount ? falseAccepts : null,
      falseAcceptClusters: eligibleStats.uniqueUnderlyingSessions ? eligibleStats.falseAcceptClusters : null,
      trialFpr: eligibleStats.verificationTrialCount ? round(eligibleStats.trialFpr) : null,
      clusterFalseAcceptRate: eligibleStats.uniqueUnderlyingSessions ? round(eligibleStats.clusterFalseAcceptRate) : null,
      fpr: formalGateEligible ? round(eligibleStats.clusterFalseAcceptRate) : null,
      recall: formalGateEligible && eligibleStats.verificationTrialCount
        ? round(trueAccepts / eligibleStats.verificationTrialCount)
        : null,
      pointEstimateReliable: formalGateEligible,
      trialResolution,
      clusterResolution,
      testResolutionSufficient,
      testNegativeTrials: testTrialCount,
      testClusterCount,
      fprUnit: 'underlying session',
      eligibleOuterFolds: usable.length,
      skippedOuterFolds: skipped.length,
      skippedReasons,
      effectiveOuterFolds: usable.length,
      trainingResolutionSufficient,
      thresholdResolvable,
      resolutionInsufficient: !formalGateEligible,
      minimumTrainNegativeTrials: minimumTrainNegativeTrials === null ? null : minimumTrainNegativeTrials,
      maximumTrainResolution: round(maximumTrainResolution),
      minimumObservableNonzeroFpr: round(testClusterCount ? 1 / testClusterCount : null),
      requiredNegativeTrials,
      empiricalResolutionMinimum: requiredNegativeTrials,
      zeroEventConfidenceMinimum: zeroEventConfidenceMinimum(target),
      exploratoryClusterBootstrap: {
        method: 'session-block-bootstrap',
        clusterUnit: 'underlying-session-id',
        ...bootstrapShape(usable),
        pointTrialFpr: eligibleStats.verificationTrialCount ? round(eligibleStats.trialFpr) : null,
        pointClusterFalseAcceptRate: eligibleStats.uniqueUnderlyingSessions ? round(eligibleStats.clusterFalseAcceptRate) : null,
        lower: fprBootstrap.lower,
        upper: fprBootstrap.upper,
        upper95: fprBootstrap.upper95,
        reps: fprBootstrap.reps,
        seed: fprBootstrap.seed,
        meaningful: false,
        note: 'exploratory only; never used to declare target-met',
      },
      recallClusterBootstrap: {
        method: 'session-block-bootstrap',
        clusterUnit: 'underlying-session-id',
        ...bootstrapShape(usable),
        point: eligibleStats.verificationTrialCount ? round(trueAccepts / eligibleStats.verificationTrialCount) : null,
        lower: recallBootstrap.lower,
        upper: recallBootstrap.upper,
        reps: recallBootstrap.reps,
        seed: recallBootstrap.seed,
        meaningful: formalGateEligible,
      },
      formalUpperConfidenceBound,
      formalGateEligible,
      formalGateReasons,
      meetsTarget: formalGateEligible,
      status,
      note: formalGateReasons.length
        ? 'formal gate blocked: ' + formalGateReasons.join(', ')
        : 'formal one-sided Clopper-Pearson upper bound meets target',
      records: usable.map((record) => ({
        sessionId: record.sessionId,
        model: record.model,
        threshold: round(record.thresholds[key]),
        trainNegativeTrials: record.thresholdDetails[key].negativeTrials,
        sameDistance: round(record.sameDistance),
        otherDistance: round(record.otherDistance),
        trueAccept: record.sameDistance <= record.thresholds[key],
        falseAccept: record.otherDistance <= record.thresholds[key],
      })),
      exploratoryRecords: records.filter((record) => record.status === 'ok').map((record) => ({
        sessionId: record.sessionId,
        model: record.model,
        threshold: record.thresholds[key] === null ? null : round(record.thresholds[key]),
        trainNegativeTrials: record.thresholdDetails && record.thresholdDetails[key] ? record.thresholdDetails[key].negativeTrials : null,
        trainResolutionSufficient: Boolean(record.thresholdDetails && record.thresholdDetails[key] && record.thresholdDetails[key].resolutionSufficient),
        sameDistance: finite(record.sameDistance) ? round(record.sameDistance) : null,
        otherDistance: finite(record.otherDistance) ? round(record.otherDistance) : null,
      })),
    }
  }
  return {
    method: 'nested-session-level',
    thresholdSource: 'outer-training-sessions-only',
    testDataUsedForThreshold: false,
    featureSelectionUsedTest: false,
    unit: 'session',
    outerFolds: records.length,
    skippedFolds: records.filter((record) => record.status !== 'ok').length,
    records,
    targets: results,
    note: 'Threshold is chosen inside each outer fold from training sessions only; test sessions are scored once. Session pairs are not independent.',
  }
}

function distanceSubset(a, b, omit = new Set()) {
  let weighted = 0
  let weight = 0
  for (const feature of BEHAVIOR_FEATURES) {
    if (omit.has(feature.key)) continue
    const left = a && a.features && a.features[feature.key]
    const right = b && b.features && b.features[feature.key]
    if (!left || !right || left.median === null || right.median === null) continue
    const scale = Math.max(feature.min, 1.4826 * ((left.mad || 0) + (right.mad || 0)) / 2)
    const z = Math.min(6, Math.abs(left.median - right.median) / scale)
    weighted += z * feature.weight
    weight += feature.weight
  }
  return weight > 0 ? weighted / weight : null
}

function groupedSessions(rows) {
  const map = new Map()
  for (const row of rows) {
    const id = row.sessionId || row.id
    if (!map.has(id)) map.set(id, [])
    map.get(id).push(row)
  }
  return map
}

function routeRows(observations, model) {
  return observations.filter((row) => row && row.provider === model.provider && row.model === model.model
    && row.behavior && evaluateObservationQuality(row).usableForBaseline)
}

function protocolDistribution(rows) {
  const fingerprint = new Map()
  const family = new Map()
  const variant = new Map()
  const apis = new Map()
  for (const row of rows) {
    fingerprint.set(row.fingerprint, (fingerprint.get(row.fingerprint) || 0) + 1)
    const familyId = transportFamilyId(row)
    const variantId = transportVariantId(row)
    family.set(familyId, (family.get(familyId) || 0) + 1)
    variant.set(variantId, (variant.get(variantId) || 0) + 1)
    const api = row.protocol && row.protocol.api || '-'
    apis.set(api, (apis.get(api) || 0) + 1)
  }
  const list = (map) => [...map.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count)
  return { fingerprints: list(fingerprint), families: list(family), variants: list(variant), apis: list(apis) }
}

function featureTable(rows) {
  const profile = profileFor(rows)
  const result = {}
  for (const feature of BEHAVIOR_FEATURES) {
    const item = profile.features[feature.key]
    result[feature.key] = {
      median: round(item.median),
      mad: round(item.mad),
      samples: item.samples,
      coverage: rows.length ? round(item.samples / rows.length) : 0,
    }
  }
  return result
}

function sessionHeldOut(rowsA, rowsB, modelA, modelB, options = {}) {
  const omit = options.omit || null
  const measure = (left, right) => {
    const value = omit
      ? distanceSubset(left, right, omit)
      : distanceProfiles(left, right).distance
    return value
  }
  const sessionsA = groupedSessions(rowsA)
  const sessionsB = groupedSessions(rowsB)
  const allRowsA = [...sessionsA.values()].flat()
  const allRowsB = [...sessionsB.values()].flat()
  const records = []
  for (const [sessionId, testRows] of sessionsA) {
    const trainRows = allRowsA.filter((row) => row.sessionId !== sessionId)
    const sameProfile = profileFor(trainRows)
    const testProfile = profileFor(testRows)
    // Exclude the held-out session from the opposite model as well: a session
    // may contain observations for both routes, and it must be one unit.
    const otherProfile = profileFor(allRowsB.filter((row) => row.sessionId !== sessionId))
    const sameDistance = measure(testProfile, sameProfile)
    const otherDistance = measure(testProfile, otherProfile)
    records.push({
      model: modelA.model,
      sessionId,
      testSamples: testRows.length,
      sameDistance,
      otherDistance,
      trainSessionIds: {
        [modelA.model]: [...sessionsA.keys()].filter((id) => id !== sessionId),
        [modelB.model]: [...sessionsB.keys()].filter((id) => id !== sessionId),
      },
    })
  }
  for (const [sessionId, testRows] of sessionsB) {
    const trainRows = allRowsB.filter((row) => row.sessionId !== sessionId)
    const sameProfile = profileFor(trainRows)
    const testProfile = profileFor(testRows)
    const otherProfile = profileFor(allRowsA.filter((row) => row.sessionId !== sessionId))
    const sameDistance = measure(testProfile, sameProfile)
    const otherDistance = measure(testProfile, otherProfile)
    records.push({
      model: modelB.model,
      sessionId,
      testSamples: testRows.length,
      sameDistance,
      otherDistance,
      trainSessionIds: {
        [modelA.model]: [...sessionsA.keys()].filter((id) => id !== sessionId),
        [modelB.model]: [...sessionsB.keys()].filter((id) => id !== sessionId),
      },
    })
  }
  return records.map((record) => ({
    ...record,
    margin: finite(record.sameDistance) && finite(record.otherDistance) ? round(record.otherDistance - record.sameDistance) : null,
    correct: finite(record.sameDistance) && finite(record.otherDistance) ? record.sameDistance < record.otherDistance : null,
    uncertain: finite(record.sameDistance) && finite(record.otherDistance) ? Math.abs(record.otherDistance - record.sameDistance) < 0.25 : false,
  }))
}

function verificationAuc(records) {
  const scores = []
  const labels = []
  for (const record of records) {
    if (!finite(record.sameDistance) || !finite(record.otherDistance)) continue
    scores.push(-record.sameDistance, -record.otherDistance)
    labels.push(1, 0)
  }
  return round(auc(scores, labels))
}

function heldOutAuc(records, options = {}) {
  const scores = []
  const labels = []
  for (const record of records) {
    if (!finite(record.sameDistance) || !finite(record.otherDistance)) continue
    scores.push(-record.sameDistance, -record.otherDistance)
    labels.push(1, 0)
  }
  return {
    metric: 'session-paired-verification-auc',
    note: 'Each held-out session contributes one paired same-distance and one different-distance trial; observations are not independent units.',
    auc: round(auc(scores, labels)),
    sessions: records.length,
    uniqueSessionIds: new Set(records.map((record) => record.sessionId)).size,
    sessionsByModel: records.reduce((counts, record) => {
      const key = record.model || 'unknown'
      counts[key] = (counts[key] || 0) + 1
      return counts
    }, {}),
    pairs: scores.length,
    bootstrap: bootstrapSessionAuc(records, options),
  }
}

function isoTime(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null
}

function timeSessions(rowsA, rowsB, modelA, modelB) {
  const map = new Map()
  for (const row of [...rowsA, ...rowsB]) {
    if (!row || !row.sessionId) continue
    const model = row.model
    if (model !== modelA.model && model !== modelB.model) continue
    if (!map.has(row.sessionId)) {
      map.set(row.sessionId, {
        sessionId: row.sessionId,
        start: null,
        end: null,
        rowsByModel: { [modelA.model]: [], [modelB.model]: [] },
        sampleCountsByModel: { [modelA.model]: 0, [modelB.model]: 0 },
        models: [],
      })
    }
    const session = map.get(row.sessionId)
    session.rowsByModel[model].push(row)
    const time = Number.isFinite(row.time) ? row.time : null
    if (time !== null) {
      session.start = session.start === null ? time : Math.min(session.start, time)
      session.end = session.end === null ? time : Math.max(session.end, time)
    }
  }
  for (const session of map.values()) {
    session.models = [modelA.model, modelB.model].filter((model) => session.rowsByModel[model].length > 0)
    for (const model of [modelA.model, modelB.model]) session.sampleCountsByModel[model] = session.rowsByModel[model].length
    if (session.start === null) session.start = 0
    if (session.end === null) session.end = session.start
  }
  return [...map.values()].sort((left, right) => left.start - right.start || left.sessionId.localeCompare(right.sessionId))
}

export function rollingTimeFolds(rowsA, rowsB, modelA, modelB, options = {}) {
  const windows = Math.max(2, Number(options.windows) || 5)
  const minTrainSessionsPerModel = Math.max(1, Number(options.minTrainSessionsPerModel) || 2)
  const sessions = timeSessions(rowsA, rowsB, modelA, modelB)
  const folds = []
  for (let index = 0; index < windows; index += 1) {
    const start = Math.floor(index * sessions.length / windows)
    const end = Math.floor((index + 1) * sessions.length / windows)
    const test = sessions.slice(start, end)
    if (!test.length) continue
    const testStart = Math.min(...test.map((item) => item.start))
    const testEnd = Math.max(...test.map((item) => item.end))
    // A session is atomic. It may train only when its entire observed lifespan
    // ends before the test window starts. A session that starts earlier but
    // crosses testStart is boundary-overlap, not training data.
    const train = sessions.filter((item) => item.end < testStart)
    const boundaryOverlap = sessions.filter((item) => item.start < testStart && item.end >= testStart)
    const future = sessions.filter((item) => item.start >= testStart && !test.includes(item))
    const rowsFor = (items, model) => items.flatMap((item) => item.rowsByModel[model] || [])
    const rowsTrainA = rowsFor(train, modelA.model)
    const rowsTrainB = rowsFor(train, modelB.model)
    const rowsTestA = rowsFor(test, modelA.model)
    const rowsTestB = rowsFor(test, modelB.model)
    const trainSessionsByModel = {
      [modelA.model]: train.filter((item) => item.rowsByModel[modelA.model].length > 0).length,
      [modelB.model]: train.filter((item) => item.rowsByModel[modelB.model].length > 0).length,
    }
    const testSessionsByModel = {
      [modelA.model]: test.filter((item) => item.rowsByModel[modelA.model].length > 0).length,
      [modelB.model]: test.filter((item) => item.rowsByModel[modelB.model].length > 0).length,
    }
    const base = {
      window: index,
      method: 'rolling-origin',
      trainStart: train.length ? isoTime(Math.min(...train.map((item) => item.start))) : null,
      trainEnd: train.length ? isoTime(Math.max(...train.map((item) => item.end))) : null,
      testStart: isoTime(testStart),
      testEnd: isoTime(testEnd),
      trainUniqueSessions: train.length,
      testUniqueSessions: test.length,
      trainSessionIds: train.map((item) => item.sessionId),
      testSessionIds: test.map((item) => item.sessionId),
      trainSessionsByModel,
      testSessionsByModel,
      mixedModelSessions: train.concat(test).filter((item) => item.models.length > 1).length,
      mixedModelSessionsBySplit: {
        train: train.filter((item) => item.models.length > 1).length,
        test: test.filter((item) => item.models.length > 1).length,
      },
      trainSamplesByModel: { [modelA.model]: rowsTrainA.length, [modelB.model]: rowsTrainB.length },
      testSamplesByModel: { [modelA.model]: rowsTestA.length, [modelB.model]: rowsTestB.length },
      boundaryOverlapSessions: boundaryOverlap.length,
      boundaryOverlapSessionIds: boundaryOverlap.map((item) => item.sessionId),
      futureSessionsExcluded: future.length,
      leakage: train.some((item) => item.end >= testStart)
        || test.some((item) => train.some((other) => other.sessionId === item.sessionId)),
    }
    if (trainSessionsByModel[modelA.model] < minTrainSessionsPerModel
      || trainSessionsByModel[modelB.model] < minTrainSessionsPerModel) {
      base.status = 'insufficient-training-history'
      base.skipReason = 'need at least ' + minTrainSessionsPerModel + ' sessions per model with sessionEnd < testStart'
      base.distances = null
      base.auc = null
      folds.push(base)
      continue
    }
    if (!rowsTestA.length && !rowsTestB.length) {
      base.status = 'insufficient-test-data'
      base.skipReason = 'no usable test rows in the window'
      base.distances = null
      base.auc = null
      folds.push(base)
      continue
    }
    const profileA = profileFor(rowsTrainA)
    const profileB = profileFor(rowsTrainB)
    base.status = 'ok'
    base.skipReason = null
    base.distances = {
      [modelA.model + 'ToOwn']: rowsTestA.length ? round(distanceProfiles(profileFor(rowsTestA), profileA).distance) : null,
      [modelB.model + 'ToOwn']: rowsTestB.length ? round(distanceProfiles(profileFor(rowsTestB), profileB).distance) : null,
      [modelA.model + 'ToOther']: rowsTestA.length ? round(distanceProfiles(profileFor(rowsTestA), profileB).distance) : null,
      [modelB.model + 'ToOther']: rowsTestB.length ? round(distanceProfiles(profileFor(rowsTestB), profileA).distance) : null,
    }
    base.auc = null
    folds.push(base)
  }
  return {
    method: 'rolling-origin-forward-chaining',
    unit: 'session',
    windows,
    minTrainSessionsPerModel,
    folds,
    leakage: folds.some((fold) => fold.leakage),
    validFolds: folds.filter((fold) => fold.status === 'ok').length,
    skippedFolds: folds.filter((fold) => fold.status !== 'ok').length,
  }
}

function timeHeldOut(rowsA, rowsB, modelA, modelB, windows = 5) {
  return rollingTimeFolds(rowsA, rowsB, modelA, modelB, { windows })
}

function featureAblation(rowsA, rowsB, modelA, modelB) {
  const fullFolds = sessionHeldOut(rowsA, rowsB, modelA, modelB)
  const fullAuc = verificationAuc(fullFolds)
  const results = []
  for (const feature of BEHAVIOR_FEATURES) {
    // The omission is evaluated on held-out sessions but is never selected from
    // them. This is exploratory; production weights are not changed.
    const folds = sessionHeldOut(rowsA, rowsB, modelA, modelB, { omit: new Set([feature.key]) })
    const coverageByFold = folds.map((record) => {
      const testRows = (record.model === modelA.model ? groupedSessions(rowsA) : groupedSessions(rowsB)).get(record.sessionId) || []
      const present = testRows.filter((row) => row.behavior && finite(row.behavior[feature.key])).length
      return { sessionId: record.sessionId, model: record.model, coverage: testRows.length ? round(present / testRows.length) : 0 }
    })
    const aucValue = verificationAuc(folds)
    results.push({
      omitted: feature.key,
      productionWeight: feature.weight,
      auc: aucValue,
      delta: round((aucValue ?? 0) - (fullAuc ?? 0)),
      coverageByFold,
      lowCoverage: coverageByFold.length
        ? coverageByFold.reduce((sum, item) => sum + item.coverage, 0) / coverageByFold.length < 0.5
        : true,
    })
  }
  return {
    mode: 'exploratory-only',
    selectionUsedTest: false,
    productionWeightsChanged: false,
    missingValuesTreatedAsZero: false,
    fullAuc,
    features: results,
  }
}

export function buildHardNegativeBenchmark(observations, options = {}) {
  const models = options.models || [
    { provider: 'minimax-cn', model: 'MiniMax-M3', label: '官方 MiniMax M3' },
    { provider: 'minimax-cn', model: 'MiniMax-M2.7', label: '官方 MiniMax M2.7' },
  ]
  const modelA = models[0]
  const modelB = models[1]
  const rowsA = routeRows(observations, modelA)
  const rowsB = routeRows(observations, modelB)
  const sessionsA = groupedSessions(rowsA)
  const sessionsB = groupedSessions(rowsB)
  const folds = sessionHeldOut(rowsA, rowsB, modelA, modelB)
  const sameDistances = folds.map((record) => record.sameDistance)
  const otherDistances = folds.map((record) => record.otherDistance)
  const sameModelDistances = { [modelA.model]: [], [modelB.model]: [] }
  for (const [model, group] of [[modelA.model, sessionsA], [modelB.model, sessionsB]]) {
    const list = [...group.values()]
    for (let left = 0; left < list.length; left += 1) {
      for (let right = left + 1; right < list.length; right += 1) {
        const value = distanceProfiles(profileFor(list[left]), profileFor(list[right])).distance
        if (finite(value)) sameModelDistances[model].push(value)
      }
    }
  }
  const crossModelDistances = []
  for (const left of sessionsA.values()) {
    for (const right of sessionsB.values()) {
      const value = distanceProfiles(profileFor(left), profileFor(right)).distance
      if (finite(value)) crossModelDistances.push(value)
    }
  }
  const timeFolds = timeHeldOut(rowsA, rowsB, modelA, modelB)
  const fullAuc = heldOutAuc(folds, { reps: options.bootstrapReps || 2000, seed: options.seed || 17 })
  const fpr = nestedSessionFpr(rowsA, rowsB, modelA, modelB, {
    targets: [0.01, 0.05],
    reps: options.bootstrapReps || 2000,
    seed: options.seed || 17,
  })
  const anomaly = observations
    .filter((row) => row && row.provider === 'minimax-cn' && row.model === 'MiniMax-M2.7')
    .map((row) => ({ row, quality: evaluateObservationQuality(row) }))
    .filter((item) => !item.quality.usableForBaseline)
    .map(({ row, quality }) => {
      const sameSession = observations
        .filter((item) => item && item.sessionId === row.sessionId)
        .sort((left, right) => (left.time || 0) - (right.time || 0))
      const index = sameSession.findIndex((item) => item.id === row.id)
      const neighbors = [sameSession[index - 1], sameSession[index + 1]].filter(Boolean)
      const routeSwitchObserved = neighbors.some((item) => item.model !== row.model || item.provider !== row.provider)
      const likelyCause = !quality.completeProtocol && !quality.completeBehavior
        ? 'incomplete-reasoning-only-response-or-missing-replay'
        : !quality.completeProtocol
          ? 'legacy-adapter-missing-protocol-fields'
          : !quality.routeConsistent
            ? 'route-switch'
            : 'unknown'
      return {
        id: row.id,
        sessionId: row.sessionId,
        turn: row.turn,
        step: row.step,
        time: row.time,
        fingerprint: row.fingerprint,
        protocol: row.protocol,
        quality,
        analysis: {
          likelyCause,
          routeSwitchObserved,
          neighboringModels: neighbors.map((item) => ({ model: item.model, fingerprint: item.fingerprint })),
          rawRetained: true,
        },
      }
    })
  const protocolA = protocolDistribution(rowsA)
  const protocolB = protocolDistribution(rowsB)
  const fullProfileA = profileFor(rowsA)
  const fullProfileB = profileFor(rowsB)
  const fullCross = distanceProfiles(fullProfileA, fullProfileB)
  const report = {
    schema: 'model-fingerprint-hard-negative/v2',
    generatedAt: new Date().toISOString(),
    statisticalMethods: {
      timeHeldOut: 'rolling-origin-forward-chaining',
      fpr: 'nested-session-level',
      auc: 'session-paired-verification-auc',
      ablation: 'exploratory-only',
      bootstrapUnit: 'session',
      oldCartesianFprRetired: true,
    },
    models: [
      {
        key: modelA.provider + '/' + modelA.model,
        label: modelA.label,
        observations: rowsA.length,
        sessions: sessionsA.size,
        excluded: observations.filter((row) => row.provider === modelA.provider && row.model === modelA.model).length - rowsA.length,
      },
      {
        key: modelB.provider + '/' + modelB.model,
        label: modelB.label,
        observations: rowsB.length,
        sessions: sessionsB.size,
        excluded: observations.filter((row) => row.provider === modelB.provider && row.model === modelB.model).length - rowsB.length,
      },
    ],
    quality: {
      [modelA.model]: qualityForRows(observations.filter((row) => row.provider === modelA.provider && row.model === modelA.model)),
      [modelB.model]: qualityForRows(observations.filter((row) => row.provider === modelB.provider && row.model === modelB.model)),
    },
    protocol: { [modelA.model]: protocolA, [modelB.model]: protocolB },
    rawProtocol: {
      [modelA.model]: protocolDistribution(observations.filter((row) => row.provider === modelA.provider && row.model === modelA.model && row.behavior)),
      [modelB.model]: protocolDistribution(observations.filter((row) => row.provider === modelB.provider && row.model === modelB.model && row.behavior)),
    },
    transportLayers: {
      familyA: protocolA.families[0] ? protocolA.families[0].id : null,
      familyB: protocolB.families[0] ? protocolB.families[0].id : null,
      sameFamily: Boolean(protocolA.families[0] && protocolB.families[0]
        && protocolA.families[0].id === protocolB.families[0].id),
      variantA: protocolA.variants[0] ? protocolA.variants[0].id : null,
      variantB: protocolB.variants[0] ? protocolB.variants[0].id : null,
      sameMajorVariant: Boolean(protocolA.variants[0] && protocolB.variants[0]
        && protocolA.variants[0].id === protocolB.variants[0].id),
      variantBShare: protocolB.variants[0] && rowsB.length ? round(protocolB.variants[0].count / rowsB.length) : null,
      behaviorProfileIdA: behaviorProfileIdForProfile(fullProfileA),
      behaviorProfileIdB: behaviorProfileIdForProfile(fullProfileB),
      sameBehaviorProfile: behaviorProfileIdForProfile(fullProfileA) === behaviorProfileIdForProfile(fullProfileB),
    },
    behavior: { [modelA.model]: featureTable(rowsA), [modelB.model]: featureTable(rowsB) },
    directDistance: {
      distance: fullCross.distance,
      coverage: fullCross.coverage,
      contributions: fullCross.contributions,
      selfDistance: { [modelA.model]: fullProfileA.selfDistance, [modelB.model]: fullProfileB.selfDistance },
      ratioToSelf: {
        [modelA.model]: finite(fullProfileA.selfDistance) && fullProfileA.selfDistance > 0 ? round(fullCross.distance / fullProfileA.selfDistance) : null,
        [modelB.model]: finite(fullProfileB.selfDistance) && fullProfileB.selfDistance > 0 ? round(fullCross.distance / fullProfileB.selfDistance) : null,
      },
    },
    sessionHeldOut: {
      unit: 'session',
      method: 'leave-one-session-out; each training profile excludes the held-out session',
      folds: folds.length,
      independentSessions: folds.length,
      uniqueSessionIds: new Set(folds.map((record) => record.sessionId)).size,
      sessionsByModel: folds.reduce((counts, record) => {
        counts[record.model] = (counts[record.model] || 0) + 1
        return counts
      }, {}),
      leakage: folds.some((record) => record.testSamples <= 0
        || Object.values(record.trainSessionIds || {}).some((ids) => ids.includes(record.sessionId))),
      records: folds,
      sameDistance: summarize(sameDistances),
      crossDistance: summarize(otherDistances),
      correct: folds.filter((record) => record.correct).length,
      misclassified: folds.filter((record) => record.correct === false).length,
      uncertain: folds.filter((record) => record.uncertain).length,
      auc: fullAuc,
      aucName: 'session-paired verification AUC',
    },
    pairDistances: {
      sameModelAcrossSessions: {
        [modelA.model]: summarize(sameModelDistances[modelA.model]),
        [modelB.model]: summarize(sameModelDistances[modelB.model]),
      },
      crossModel: { models: [modelA.model, modelB.model], ...summarize(crossModelDistances) },
    },
    timeHeldOut: timeFolds,
    fpr,
    ablation: featureAblation(rowsA, rowsB, modelA, modelB),
    anomalies: anomaly,
    limitations: [
      sessionsB.size < 10 ? modelB.model + ' only has ' + sessionsB.size + ' sessions; bootstrap CIs and FPR estimates are unstable.' : null,
      'Session-held-out bootstrap resamples sessions; it does not make individual observations independent.',
      'Passive natural-chat behavior cannot establish model identity without fixed repeated probes.',
    ].filter(Boolean),
  }
  return report
}
