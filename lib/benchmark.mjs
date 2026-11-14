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

function resampleByModel(records, random) {
  const groups = new Map()
  for (const record of records) {
    const key = record.model || 'unknown'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(record)
  }
  const sampled = []
  for (const group of groups.values()) {
    for (let index = 0; index < group.length; index += 1) {
      sampled.push(group[Math.floor(random() * group.length)])
    }
  }
  return sampled
}

export function bootstrapSessionAuc(records, { reps = 2000, seed = 17, twoWay = true } = {}) {
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
      twoWay: Boolean(twoWay),
      sessions: usable.length,
      pairTrials: usable.length * 2,
      seed,
    }
  }
  const pointScores = []
  const pointLabels = []
  for (const record of usable) {
    // A session is one record: its same and different distances are always
    // resampled together. They are never independent bootstrap units.
    pointScores.push(-record.sameDistance, -record.otherDistance)
    pointLabels.push(1, 0)
  }
  const point = auc(pointScores, pointLabels)
  const random = seededRandom(seed)
  const values = []
  for (let rep = 0; rep < Math.max(1, reps); rep += 1) {
    const sample = twoWay ? resampleByModel(usable, random) : Array.from({ length: usable.length }, () => usable[Math.floor(random() * usable.length)])
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
    twoWay: Boolean(twoWay),
    sessions: usable.length,
    pairTrials: usable.length * 2,
    sessionsByModel: usable.reduce((counts, record) => {
      const key = record.model || 'unknown'
      counts[key] = (counts[key] || 0) + 1
      return counts
    }, {}),
    seed,
  }
}

export function thresholdAtFpr(differentDistances, fpr) {
  const values = differentDistances.filter(finite).sort((a, b) => a - b)
  if (!values.length) return null
  return values[Math.min(values.length - 1, Math.max(0, Math.floor(values.length * fpr)))]
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

function clusterBootstrapRate(records, metric, { reps = 2000, seed = 17, twoWay = true } = {}) {
  if (records.length < 2) return { point: metric(records), lower: null, upper: null, upper95: null, reps: 0, unit: 'session', twoWay, sessions: records.length, seed }
  const point = metric(records)
  const random = seededRandom(seed)
  const values = []
  for (let rep = 0; rep < Math.max(1, reps); rep += 1) {
    const sample = twoWay ? resampleByModel(records, random) : Array.from({ length: records.length }, () => records[Math.floor(random() * records.length)])
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
    twoWay,
    sessions: records.length,
    seed,
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
      const base = { sessionId, model, testSamples: testRows.length, trainSessionsByModel: { [modelA.model]: 0, [modelB.model]: 0 } }
      if (model === modelA.model) {
        base.trainSessionsByModel = { [modelA.model]: trainOwnSessions.size, [modelB.model]: otherTrainSessions.size }
      } else {
        base.trainSessionsByModel = { [modelA.model]: otherTrainSessions.size, [modelB.model]: trainOwnSessions.size }
      }
      if (trainOwnSessions.size < minTrainSessionsPerModel
        || otherTrainSessions.size < minTrainSessionsPerModel
        || !trainOwnRows.length || !otherRows.length) {
        records.push({ ...base, status: 'insufficient-training-history', skipReason: 'need at least ' + minTrainSessionsPerModel + ' sessions per model', thresholds: {} })
        continue
      }
      const ownProfile = profileFor(trainOwnRows)
      const otherProfile = profileFor(otherRows)
      const testProfile = profileFor(testRows)
      const sameDistance = distanceProfiles(testProfile, ownProfile).distance
      const otherDistance = distanceProfiles(testProfile, otherProfile).distance
      const trainCross = model === modelA.model
        ? crossSessionDistances(trainOwnSessions, otherProfile)
        : crossSessionDistances(trainOwnSessions, otherProfile)
      const thresholds = {}
      for (const target of targets) thresholds[String(target)] = thresholdAtFpr(trainCross, target)
      records.push({
        ...base,
        status: finite(sameDistance) && finite(otherDistance) ? 'ok' : 'no-distance',
        skipReason: finite(sameDistance) && finite(otherDistance) ? null : 'distance unavailable',
        sameDistance,
        otherDistance,
        thresholds,
        trainCrossSessions: trainCross.length,
      })
    }
  }
  const results = {}
  for (const target of targets) {
    const usable = records.filter((record) => record.status === 'ok' && finite(record.thresholds[String(target)])
      && finite(record.sameDistance) && finite(record.otherDistance))
    const falseAccepts = usable.filter((record) => record.otherDistance <= record.thresholds[String(target)]).length
    const trueAccepts = usable.filter((record) => record.sameDistance <= record.thresholds[String(target)]).length
    const negativeTrials = usable.length
    const positiveTrials = usable.length
    const minimumObservableNonzeroFpr = negativeTrials ? 1 / negativeTrials : null
    const requiredNegativeTrials = Math.ceil(1 / target)
    const resolutionInsufficient = negativeTrials < requiredNegativeTrials
    const point = {
      fpr: negativeTrials ? round(falseAccepts / negativeTrials) : null,
      recall: positiveTrials ? round(trueAccepts / positiveTrials) : null,
      falseAccepts,
      negativeTrials,
      trueAccepts,
      positiveTrials,
    }
    const thresholdValues = usable.map((record) => record.thresholds[String(target)])
    const fprBootstrap = clusterBootstrapRate(usable, (sample) => {
      const negatives = sample.length
      return negatives ? sample.filter((record) => record.otherDistance <= record.thresholds[String(target)]).length / negatives : null
    }, { reps: options.reps || 2000, seed: options.seed || 17 })
    const recallBootstrap = clusterBootstrapRate(usable, (sample) => {
      const positives = sample.length
      return positives ? sample.filter((record) => record.sameDistance <= record.thresholds[String(target)]).length / positives : null
    }, { reps: options.reps || 2000, seed: (options.seed || 17) + 1 })
    results[String(target)] = {
      targetFpr: target,
      method: 'nested-session-level',
      thresholdSource: 'outer-training-sessions-only',
      testDataUsedForThreshold: false,
      featureSelectionUsedTest: false,
      thresholdRange: {
        min: round(thresholdValues.length ? Math.min(...thresholdValues) : null),
        median: round(median(thresholdValues)),
        max: round(thresholdValues.length ? Math.max(...thresholdValues) : null),
      },
      point,
      fpr: point.fpr,
      recall: point.recall,
      pointEstimateReliable: !resolutionInsufficient,
      falseAccepts,
      negativeTrials,
      trueAccepts,
      positiveTrials,
      fprUnit: 'held-out session',
      independentSessions: new Set(usable.map((record) => record.model + ':' + record.sessionId)).size,
      uniqueSessionIds: new Set(usable.map((record) => record.sessionId)).size,
      effectiveOuterFolds: usable.length,
      resolutionInsufficient,
      minimumObservableNonzeroFpr: round(minimumObservableNonzeroFpr),
      requiredNegativeTrials,
      thresholdResolvable: !resolutionInsufficient,
      fprConfidence: {
        point: point.fpr,
        lower: fprBootstrap.lower,
        upper: fprBootstrap.upper,
        upper95: fprBootstrap.upper95,
        unit: 'session',
        clustered: true,
        twoWayCluster: true,
        reps: fprBootstrap.reps,
        seed: fprBootstrap.seed,
        meaningful: !resolutionInsufficient,
      },
      recallConfidence: {
        point: point.recall,
        lower: recallBootstrap.lower,
        upper: recallBootstrap.upper,
        unit: 'session',
        clustered: true,
        twoWayCluster: true,
        reps: recallBootstrap.reps,
        seed: recallBootstrap.seed,
      },
      meetsTarget: !resolutionInsufficient && fprBootstrap.upper95 !== null && fprBootstrap.upper95 <= target,
      status: resolutionInsufficient ? 'resolution-insufficient' : (fprBootstrap.upper95 !== null && fprBootstrap.upper95 <= target ? 'target-met' : 'not-verified'),
      note: resolutionInsufficient
        ? 'negative sessions are fewer than ' + requiredNegativeTrials + '; cannot resolve ' + (target * 100) + '% FPR'
        : (fprBootstrap.upper95 !== null && fprBootstrap.upper95 <= target ? 'session-clustered upper 95% bound meets target' : 'session-clustered upper bound does not meet target'),
      records: usable.map((record) => ({
        sessionId: record.sessionId,
        model: record.model,
        threshold: round(record.thresholds[String(target)]),
        sameDistance: round(record.sameDistance),
        otherDistance: round(record.otherDistance),
        trueAccept: record.sameDistance <= record.thresholds[String(target)],
        falseAccept: record.otherDistance <= record.thresholds[String(target)],
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
    bootstrap: bootstrapSessionAuc(records, { ...options, twoWay: true }),
  }
}

function isoTime(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null
}

export function rollingTimeFolds(rowsA, rowsB, modelA, modelB, options = {}) {
  const windows = Math.max(2, Number(options.windows) || 5)
  const minTrainSessionsPerModel = Math.max(1, Number(options.minTrainSessionsPerModel) || 2)
  const all = [...rowsA, ...rowsB]
  const sessions = [...groupedSessions(all).entries()].map(([sessionId, rows]) => ({
    sessionId,
    model: rows[0].model,
    start: Math.min(...rows.map((row) => row.time || 0)),
    rows,
  })).sort((left, right) => left.start - right.start || left.sessionId.localeCompare(right.sessionId))
  const folds = []
  for (let index = 0; index < windows; index += 1) {
    const start = Math.floor(index * sessions.length / windows)
    const end = Math.floor((index + 1) * sessions.length / windows)
    const test = sessions.slice(start, end)
    if (!test.length) continue
    const testStart = Math.min(...test.map((item) => item.start))
    // Strict rolling origin: only sessions whose start is strictly before the
    // test window can train. No post-window or same-window session is allowed.
    const train = sessions.filter((item) => item.start < testStart)
    const future = sessions.filter((item) => item.start >= testStart && !test.includes(item))
    const trainA = train.filter((item) => item.model === modelA.model)
    const trainB = train.filter((item) => item.model === modelB.model)
    const testA = test.filter((item) => item.model === modelA.model)
    const testB = test.filter((item) => item.model === modelB.model)
    const rowsTrainA = trainA.flatMap((item) => item.rows)
    const rowsTrainB = trainB.flatMap((item) => item.rows)
    const rowsTestA = testA.flatMap((item) => item.rows)
    const rowsTestB = testB.flatMap((item) => item.rows)
    const base = {
      window: index,
      method: 'rolling-origin',
      trainStart: train.length ? isoTime(Math.min(...train.map((item) => item.start))) : null,
      trainEnd: train.length ? isoTime(Math.max(...train.map((item) => item.start))) : null,
      testStart: isoTime(testStart),
      testEnd: isoTime(Math.max(...test.map((item) => item.start))),
      trainSessionsByModel: { [modelA.model]: trainA.length, [modelB.model]: trainB.length },
      testSessionsByModel: { [modelA.model]: testA.length, [modelB.model]: testB.length },
      trainSamplesByModel: { [modelA.model]: rowsTrainA.length, [modelB.model]: rowsTrainB.length },
      testSamplesByModel: { [modelA.model]: rowsTestA.length, [modelB.model]: rowsTestB.length },
      futureSessionsExcluded: future.length,
      leakage: train.some((item) => item.start >= testStart),
    }
    base.futureSessionsExcluded = future.length
    if (trainA.length < minTrainSessionsPerModel || trainB.length < minTrainSessionsPerModel) {
      base.status = 'insufficient-training-history'
      base.skipReason = 'need at least ' + minTrainSessionsPerModel + ' sessions per model before testStart'
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
