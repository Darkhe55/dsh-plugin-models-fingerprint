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

export function bootstrapSessionAuc(records, { reps = 2000, seed = 17 } = {}) {
  const usable = records.filter((record) => finite(record.sameDistance) && finite(record.otherDistance))
  if (usable.length < 2) return { auc: null, lower: null, upper: null, reps: 0, unit: 'session' }
  const pointScores = []
  const pointLabels = []
  for (const record of usable) {
    pointScores.push(-record.sameDistance, -record.otherDistance)
    pointLabels.push(1, 0)
  }
  const point = auc(pointScores, pointLabels)
  const random = seededRandom(seed)
  const values = []
  for (let rep = 0; rep < Math.max(1, reps); rep += 1) {
    const sampleScores = []
    const sampleLabels = []
    for (let index = 0; index < usable.length; index += 1) {
      const record = usable[Math.floor(random() * usable.length)]
      sampleScores.push(-record.sameDistance, -record.otherDistance)
      sampleLabels.push(1, 0)
    }
    const value = auc(sampleScores, sampleLabels)
    if (value !== null) values.push(value)
  }
  values.sort((a, b) => a - b)
  return {
    auc: round(point),
    lower: round(quantile(values, 0.025)),
    upper: round(quantile(values, 0.975)),
    reps: values.length,
    unit: 'session',
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

function sessionHeldOut(rowsA, rowsB, modelA, modelB) {
  const sessionsA = groupedSessions(rowsA)
  const sessionsB = groupedSessions(rowsB)
  const allRowsA = [...sessionsA.values()].flat()
  const allRowsB = [...sessionsB.values()].flat()
  const records = []
  for (const [sessionId, testRows] of sessionsA) {
    const trainRows = allRowsA.filter((row) => row.sessionId !== sessionId)
    const sameProfile = profileFor(trainRows)
    const testProfile = profileFor(testRows)
    const otherProfile = profileFor(allRowsB)
    const sameDistance = distanceProfiles(testProfile, sameProfile).distance
    const otherDistance = distanceProfiles(testProfile, otherProfile).distance
    records.push({ model: modelA.model, sessionId, testSamples: testRows.length, sameDistance, otherDistance })
  }
  for (const [sessionId, testRows] of sessionsB) {
    const trainRows = allRowsB.filter((row) => row.sessionId !== sessionId)
    const sameProfile = profileFor(trainRows)
    const testProfile = profileFor(testRows)
    const otherProfile = profileFor(allRowsA)
    const sameDistance = distanceProfiles(testProfile, sameProfile).distance
    const otherDistance = distanceProfiles(testProfile, otherProfile).distance
    records.push({ model: modelB.model, sessionId, testSamples: testRows.length, sameDistance, otherDistance })
  }
  return records.map((record) => ({
    ...record,
    margin: finite(record.sameDistance) && finite(record.otherDistance) ? round(record.otherDistance - record.sameDistance) : null,
    correct: finite(record.sameDistance) && finite(record.otherDistance) ? record.sameDistance < record.otherDistance : null,
    uncertain: finite(record.sameDistance) && finite(record.otherDistance) ? Math.abs(record.otherDistance - record.sameDistance) < 0.25 : false,
  }))
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
    auc: round(auc(scores, labels)),
    pairs: scores.length,
    bootstrap: bootstrapSessionAuc(records, options),
  }
}

function timeHeldOut(rowsA, rowsB, modelA, modelB, windows = 4) {
  const all = [...rowsA, ...rowsB]
  const sessions = [...groupedSessions(all).entries()].map(([sessionId, rows]) => ({
    sessionId,
    model: rows[0].model,
    start: Math.min(...rows.map((row) => row.time || 0)),
    rows,
  })).sort((a, b) => a.start - b.start)
  const folds = []
  for (let index = 0; index < windows; index += 1) {
    const start = Math.floor(index * sessions.length / windows)
    const end = Math.floor((index + 1) * sessions.length / windows)
    const test = sessions.slice(start, end)
    const train = sessions.slice(0, start).concat(sessions.slice(end))
    const trainA = train.filter((item) => item.model === modelA.model).flatMap((item) => item.rows)
    const trainB = train.filter((item) => item.model === modelB.model).flatMap((item) => item.rows)
    const testA = test.filter((item) => item.model === modelA.model).flatMap((item) => item.rows)
    const testB = test.filter((item) => item.model === modelB.model).flatMap((item) => item.rows)
    if (!testA.length && !testB.length) continue
    const profileA = profileFor(trainA)
    const profileB = profileFor(trainB)
    const record = {
      window: index,
      testSessions: test.length,
      testSamples: testA.length + testB.length,
      m3: testA.length ? round(distanceProfiles(profileFor(testA), profileA).distance) : null,
      m27: testB.length ? round(distanceProfiles(profileFor(testB), profileB).distance) : null,
      cross: testA.length && trainB.length ? round(distanceProfiles(profileFor(testA), profileB).distance) : null,
    }
    if (testA.length) record.m3ToM27 = trainB.length ? round(distanceProfiles(profileFor(testA), profileB).distance) : null
    if (testB.length) record.m27ToM3 = trainA.length ? round(distanceProfiles(profileFor(testB), profileA).distance) : null
    folds.push(record)
  }
  return folds
}

function featureAblation(rowsA, rowsB) {
  const folds = sessionHeldOut(rowsA, rowsB, { model: 'M3' }, { model: 'M2.7' })
  const full = heldOutAuc(folds)
  const results = []
  for (const feature of BEHAVIOR_FEATURES) {
    const scores = []
    const labels = []
    const sessionsA = groupedSessions(rowsA)
    const sessionsB = groupedSessions(rowsB)
    const allA = [...sessionsA.values()].flat()
    const allB = [...sessionsB.values()].flat()
    for (const [sessionId, testRows] of sessionsA) {
      const testProfile = profileFor(testRows)
      const same = distanceSubset(testProfile, profileFor(allA.filter((row) => row.sessionId !== sessionId)), new Set([feature.key]))
      const other = distanceSubset(testProfile, profileFor(allB), new Set([feature.key]))
      if (finite(same) && finite(other)) {
        scores.push(-same, -other)
        labels.push(1, 0)
      }
    }
    for (const [sessionId, testRows] of sessionsB) {
      const testProfile = profileFor(testRows)
      const same = distanceSubset(testProfile, profileFor(allB.filter((row) => row.sessionId !== sessionId)), new Set([feature.key]))
      const other = distanceSubset(testProfile, profileFor(allA), new Set([feature.key]))
      if (finite(same) && finite(other)) {
        scores.push(-same, -other)
        labels.push(1, 0)
      }
    }
    results.push({
      omitted: feature.key,
      auc: round(auc(scores, labels)),
      delta: round((auc(scores, labels) ?? 0) - (full.auc ?? 0)),
    })
  }
  return { fullAuc: full.auc, features: results }
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
  const fpr = {}
  for (const rate of [0.01, 0.05]) {
    const threshold = thresholdAtFpr(crossModelDistances, rate)
    fpr[String(rate)] = {
      threshold: round(threshold),
      recall: round(recallAtThreshold(sameDistances, threshold)),
      actualFpr: round(crossModelDistances.filter((value) => value <= threshold).length / Math.max(1, crossModelDistances.length)),
      fprUnit: 'cross-model session pair',
    }
  }
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
    schema: 'model-fingerprint-hard-negative/v1',
    generatedAt: new Date().toISOString(),
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
      leakage: false,
      records: folds,
      sameDistance: summarize(sameDistances),
      crossDistance: summarize(otherDistances),
      correct: folds.filter((record) => record.correct).length,
      misclassified: folds.filter((record) => record.correct === false).length,
      uncertain: folds.filter((record) => record.uncertain).length,
      auc: fullAuc,
    },
    pairDistances: {
      sameModelAcrossSessions: {
        [modelA.model]: summarize(sameModelDistances[modelA.model]),
        [modelB.model]: summarize(sameModelDistances[modelB.model]),
      },
      crossModel: { models: [modelA.model, modelB.model], ...summarize(crossModelDistances) },
    },
    timeHeldOut: {
      unit: 'time-window',
      windows: timeFolds.length,
      folds: timeFolds,
    },
    fpr,
    ablation: featureAblation(rowsA, rowsB),
    anomalies: anomaly,
    limitations: [
      sessionsB.size < 10 ? modelB.model + ' only has ' + sessionsB.size + ' sessions; bootstrap CIs and FPR estimates are unstable.' : null,
      'Session-held-out bootstrap resamples sessions; it does not make individual observations independent.',
      'Passive natural-chat behavior cannot establish model identity without fixed repeated probes.',
    ].filter(Boolean),
  }
  return report
}
