/**
 * Official-model behavior baseline.
 *
 * A fingerprint (`fp_...`) identifies wire protocol shape. This module starts
 * from explicit, user-designated official provider/model routes and builds a
 * behavior profile that later similarity scoring can compare against.
 *
 * Passive observations are noisy; the profile stores medians/MAD, sample
 * counts and time bounds so every later score can expose its evidence.
 */
import { distanceProfiles, profileFor, tokenizerVectorOf } from './equivalence.mjs'
import {
  DEFAULT_MIN_SAMPLES,
  FEATURE_SCHEMA_VERSION,
  QUALITY_VERSION,
  modelKey,
  normalizeOfficialModels,
  sourceDigestFor,
} from './official.mjs'
import { evaluateObservationQuality } from './quality.mjs'

export const SIMILARITY_VERSION = 2
export { DEFAULT_MIN_SAMPLES, modelKey, normalizeOfficialModels }

const text = (value) => (typeof value === 'string' ? value.trim() : '')

export function observationsForModel(observations, official, options = {}) {
  const provider = text(official && official.provider)
  const model = text(official && official.model)
  const requireUsable = options.requireUsable !== false
  return (Array.isArray(observations) ? observations : [])
    .filter((row) => row && row.provider === provider && row.model === model && row.behavior)
    .filter((row) => !requireUsable || evaluateObservationQuality(row).usableForBaseline)
    .sort((left, right) => (left.time || 0) - (right.time || 0))
}

export function sourceForOfficial(observations, official, options = {}) {
  const normalized = normalizeOfficialModels([official])[0]
  if (!normalized) throw new Error('official provider and model are required')
  const allRows = (Array.isArray(observations) ? observations : [])
    .filter((row) => row && row.provider === normalized.provider && row.model === normalized.model && row.behavior)
  const rows = observationsForModel(allRows, normalized)
    .map((row) => ({ ...row, __mfQuality: evaluateObservationQuality(row) }))
  const excluded = allRows.filter((row) => !evaluateObservationQuality(row).usableForBaseline)
  const source = sourceDigestFor({
    official: normalized,
    rows,
    dataVersion: options.dataVersion,
    featureSchemaVersion: options.featureSchemaVersion,
    qualityVersion: options.qualityVersion,
  })
  // Calibration also depends on negative routes, so it gets its own digest.
  const negativeRows = (Array.isArray(observations) ? observations : [])
    .filter((row) => row && row.behavior && (row.provider !== normalized.provider || row.model !== normalized.model))
    .map((row) => ({ row, quality: evaluateObservationQuality(row) }))
    .filter((item) => item.quality.usableForBaseline)
    .map((item) => ({ ...item.row, __mfQuality: item.quality }))
  const calibration = sourceDigestFor({
    official: normalized,
    rows: rows.concat(negativeRows),
    dataVersion: options.dataVersion,
    featureSchemaVersion: options.featureSchemaVersion,
    qualityVersion: options.qualityVersion,
  })
  return {
    official: normalized,
    rows,
    excluded,
    digest: source.digest,
    calibrationDigest: calibration.digest,
    calibrationPayload: calibration.payload,
    payload: source.payload,
  }
}

export function buildOfficialProfile(observations, official, options = {}) {
  const normalized = normalizeOfficialModels([official])[0]
  if (!normalized) throw new Error('official provider and model are required')
  const source = sourceForOfficial(observations, normalized, options)
  const rows = source.rows
  const minSamples = Math.max(3, Number(options.minSamples) || normalized.minSamples)
  const profile = profileFor(rows)
  const fingerprintCounts = new Map()
  let firstTime = null
  let lastTime = null
  const sessions = new Set()
  for (const row of rows) {
    fingerprintCounts.set(row.fingerprint, (fingerprintCounts.get(row.fingerprint) || 0) + 1)
    if (row.sessionId) sessions.add(row.sessionId)
    if (firstTime === null || row.time < firstTime) firstTime = row.time
    if (lastTime === null || row.time > lastTime) lastTime = row.time
  }
  const fingerprints = [...fingerprintCounts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => right.count - left.count)
  const baselineClasses = {}
  for (const row of rows) {
    const className = row.__mfQuality && row.__mfQuality.baselineClass
    if (className) baselineClasses[className] = (baselineClasses[className] || 0) + 1
  }
  return {
    version: SIMILARITY_VERSION,
    similarityVersion: SIMILARITY_VERSION,
    featureSchemaVersion: options.featureSchemaVersion || FEATURE_SCHEMA_VERSION,
    qualityVersion: options.qualityVersion || QUALITY_VERSION,
    dataVersion: Number(options.dataVersion) || 0,
    scannerGeneration: options.scannerGeneration ?? null,
    observationRevision: Number(options.observationRevision) || 0,
    sourceDigest: source.digest,
    source: source.payload,
    ...normalized,
    minSamples,
    samples: rows.length,
    excludedSamples: source.excluded.length,
    baselineClasses,
    legacySamples: baselineClasses['behavior-only-legacy'] || 0,
    protocolIdentitySamples: baselineClasses.canonical || 0,
    sessions: sessions.size,
    ready: rows.length >= minSamples && profile.usable > 0,
    stale: false,
    staleReasons: [],
    profile,
    fingerprints,
    tokenizer: tokenizerVectorOf(rows),
    firstTime,
    lastTime,
    generatedAt: Date.now(),
  }
}

export function compareToOfficial(rows, baseline) {
  if (!baseline || !baseline.profile) return null
  const profile = profileFor(Array.isArray(rows) ? rows : [])
  const distance = distanceProfiles(profile, baseline.profile)
  return {
    samples: profile.rows,
    usable: profile.usable,
    distance: distance.distance,
    coverage: distance.coverage,
    contributions: distance.contributions,
    selfDistance: profile.selfDistance,
  }
}

const numericMedian = (values) => {
  const list = (values || []).filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (!list.length) return null
  const middle = Math.floor(list.length / 2)
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2
}

const sigmoid = (value) => 1 / (1 + Math.exp(-value))

function separationAuc(positives, negatives) {
  if (!positives.length || !negatives.length) return null
  let wins = 0
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive < negative) wins += 1
      else if (positive === negative) wins += 0.5
    }
  }
  return wins / (positives.length * negatives.length)
}

/**
 * Build an empirical same/different calibration from local history.
 * Positive: two time windows of the same official route.
 * Negative: the official route versus other model routes.
 *
 * This is not identity proof. It is a local, versioned behavioral calibration.
 */
export function buildCalibration(observations, official, options = {}) {
  const normalized = normalizeOfficialModels([official])[0]
  if (!normalized) throw new Error('official provider and model are required')
  const minPairs = Math.max(1, Number(options.minPairs) || 4)
  const source = sourceForOfficial(observations, normalized, options)
  const rows = source.rows
  const chunksOf = (items) => {
    const count = Math.max(1, Math.min(5, Math.floor(items.length / 3)))
    if (count <= 1) return [{ rows: items, profile: profileFor(items) }]
    const size = Math.ceil(items.length / count)
    return Array.from({ length: count }, (_, index) => {
      const part = items.slice(index * size, (index + 1) * size)
      return { rows: part, profile: profileFor(part) }
    }).filter((chunk) => chunk.rows.length >= 2)
  }
  const positives = []
  const officialChunks = chunksOf(rows)
  for (let left = 0; left < officialChunks.length; left += 1) {
    for (let right = left + 1; right < officialChunks.length; right += 1) {
      const distance = distanceProfiles(officialChunks[left].profile, officialChunks[right].profile).distance
      if (distance !== null) positives.push(distance)
    }
  }
  const negativeGroups = new Map()
  for (const row of Array.isArray(observations) ? observations : []) {
    if (!row || !row.behavior) continue
    if (row.provider === normalized.provider && row.model === normalized.model) continue
    if (!evaluateObservationQuality(row).usableForBaseline) continue
    const key = String(row.provider) + '/' + String(row.model)
    if (!negativeGroups.has(key)) negativeGroups.set(key, [])
    negativeGroups.get(key).push(row)
  }
  const negatives = []
  const officialProfile = profileFor(rows)
  for (const group of negativeGroups.values()) {
    for (const chunk of chunksOf(group)) {
      const distance = distanceProfiles(chunk.profile, officialProfile).distance
      if (distance !== null) negatives.push(distance)
    }
  }
  const positiveMedian = numericMedian(positives)
  const negativeMedian = numericMedian(negatives)
  const auc = separationAuc(positives, negatives)
  const aucError = auc === null ? null : 1.96 * Math.sqrt((auc * (1 - auc)) / Math.max(1, Math.min(positives.length, negatives.length)))
  const separated = positiveMedian !== null && negativeMedian !== null && positiveMedian < negativeMedian && auc !== null && auc >= 0.7
  const calibrated = positives.length >= minPairs && negatives.length >= minPairs && separated
  const cutoff = calibrated ? (positiveMedian + negativeMedian) / 2 : null
  const slope = calibrated ? Math.max(0.12, (negativeMedian - positiveMedian) / 3) : null
  let firstTime = null
  let lastTime = null
  for (const row of rows) {
    if (firstTime === null || row.time < firstTime) firstTime = row.time
    if (lastTime === null || row.time > lastTime) lastTime = row.time
  }
  return {
    version: SIMILARITY_VERSION,
    similarityVersion: SIMILARITY_VERSION,
    featureSchemaVersion: options.featureSchemaVersion || FEATURE_SCHEMA_VERSION,
    qualityVersion: options.qualityVersion || QUALITY_VERSION,
    dataVersion: Number(options.dataVersion) || 0,
    scannerGeneration: options.scannerGeneration ?? null,
    observationRevision: Number(options.observationRevision) || 0,
    sourceDigest: source.calibrationDigest,
    source: source.calibrationPayload,
    samples: rows.length,
    sessions: new Set(rows.map((row) => row.sessionId).filter(Boolean)).size,
    firstTime,
    lastTime,
    generatedAt: Date.now(),
    officialKey: normalized.key,
    calibrated,
    reason: calibrated ? 'empirical same/different separation' : 'insufficient or overlapping calibration pairs',
    positives: positives.length,
    negatives: negatives.length,
    positiveMedian,
    negativeMedian,
    auc,
    aucLower: aucError === null ? null : Math.max(0, auc - aucError),
    aucUpper: aucError === null ? null : Math.min(1, auc + aucError),
    separation: positiveMedian !== null && negativeMedian !== null ? negativeMedian - positiveMedian : null,
    cutoff,
    slope,
    versionedAt: Date.now(),
  }
}

export function scoreSimilarity(rows, baseline, calibration = null, options = {}) {
  const comparison = compareToOfficial(rows, baseline)
  if (!comparison || comparison.distance === null) {
    return {
      calibrated: false,
      similarity: null,
      score: null,
      verdict: 'no-data',
      reason: 'no comparable behavior features',
      protocolConfidence: options.protocolConfidence ?? null,
      behaviorSimilarity: null,
      modelIdentityConfidence: null,
      evidenceLevel: options.evidenceLevel || 'unknown',
      passiveOnly: options.source !== 'fixed-probe',
      comparison,
      calibration,
    }
  }
  const ready = Boolean(baseline && baseline.ready)
  const usableCalibration = Boolean(calibration && calibration.calibrated && calibration.cutoff !== null && calibration.slope)
  let similarity = usableCalibration
    ? Math.max(0.01, Math.min(0.99, sigmoid((calibration.cutoff - comparison.distance) / calibration.slope)))
    : null
  // An identical distribution must not be reported as a weak match just
  // because the empirical cutoff sits close to zero.
  if (similarity !== null && comparison.distance <= 0.15) similarity = 0.99
  const score = similarity !== null
    ? similarity
    : Math.max(0, Math.min(1, 1 - comparison.distance / Math.max(1, comparison.selfDistance || 1) * 0.35))
  const verdict = !ready
    ? 'unverified'
    : similarity === null
      ? comparison.distance <= 1.2 ? 'similar-uncalibrated' : 'different-uncalibrated'
      : similarity >= 0.8
        ? 'likely-same-behavior'
        : similarity <= 0.2
          ? 'likely-different-behavior'
          : 'ambiguous'
  // Raw behavior similarity is symmetric by distance. Calibrated similarity
  // is direction-dependent (each official model has its own cutoff), so it
  // must not drive identity confidence on its own.
  const behaviorSimilarity = Math.max(0, Math.min(1, 1 - comparison.distance / 4))
  const passiveOnly = options.source !== 'fixed-probe'
  const identityCeiling = passiveOnly ? 0.45 : 0.85
  return {
    calibrated: usableCalibration,
    similarity,
    calibratedScore: similarity,
    score,
    verdict,
    protocolConfidence: options.protocolConfidence ?? null,
    behaviorSimilarity,
    modelIdentityConfidence: Math.min(identityCeiling, Math.max(0, behaviorSimilarity * (passiveOnly ? 0.45 : 0.85))),
    identityCeiling,
    evidenceLevel: options.evidenceLevel || 'unknown',
    passiveOnly,
    reason: ready ? (usableCalibration ? 'local empirical calibration' : 'calibration unavailable; score only') : 'official baseline has too few samples',
    evidence: {
      distance: comparison.distance,
      selfDistance: comparison.selfDistance,
      coverage: comparison.coverage,
      auc: calibration ? calibration.auc : null,
      separation: calibration ? calibration.separation : null,
      positives: calibration ? calibration.positives : 0,
      negatives: calibration ? calibration.negatives : 0,
    },
    comparison,
    calibration,
  }
}

/**
 * Behavioral degradation proxy. This cannot measure semantic answer quality;
 * it measures whether a route moves away from the official behavior baseline
 * or from its own recent history.
 */
export function analyzeDegradation(rows, baseline, options = {}) {
  const minSamples = Math.max(4, Number(options.minSamples) || 12)
  const windowSize = Math.max(8, Number(options.window) || 40)
  const sorted = (Array.isArray(rows) ? rows : []).filter((row) => row && row.behavior).sort((left, right) => (left.time || 0) - (right.time || 0))
  const recent = sorted.slice(-windowSize)
  if (!baseline || !baseline.profile || recent.length < minSamples) {
    return {
      level: 'insufficient',
      reason: recent.length < minSamples ? 'not enough recent samples' : 'official baseline unavailable',
      samples: recent.length,
      minSamples,
      evidence: [],
    }
  }
  const comparison = compareToOfficial(recent, baseline)
  const split = Math.max(2, Math.floor(recent.length / 2))
  const before = profileFor(recent.slice(0, split))
  const after = profileFor(recent.slice(split))
  const selfDistance = distanceProfiles(before, after).distance
  const scale = Math.max(0.25, baseline.profile.selfDistance || 0.5)
  const baselineRatio = comparison && comparison.distance !== null ? comparison.distance / scale : null
  const selfRatio = selfDistance !== null ? selfDistance / scale : null
  const contributions = comparison ? comparison.contributions : []
  const strong = contributions.filter((item) => item.z >= 3.5)
  const closeToBaseline = comparison && comparison.distance !== null && comparison.distance <= 0.5
  let level = 'stable'
  let reason = 'behavior remains within the official baseline'
  if (closeToBaseline) {
    level = 'stable'
    reason = 'recent behavior is close to the official baseline'
  } else if (baselineRatio !== null && baselineRatio >= 2.5) {
    level = 'degrading'
    reason = 'recent behavior is far from the official baseline'
  } else if (baselineRatio !== null && baselineRatio >= 1.5 || strong.length >= 2) {
    level = 'watch'
    reason = 'some behavior features have drifted from the official baseline'
  } else if (selfRatio !== null && selfRatio >= 2.2) {
    level = 'watch'
    reason = 'recent behavior changed relative to its own recent history'
  }
  return {
    level,
    reason,
    samples: recent.length,
    minSamples,
    baselineDistance: comparison ? comparison.distance : null,
    baselineRatio,
    selfDistance,
    selfRatio,
    strongFeatures: strong,
    evidence: contributions,
    recentSince: recent[0] ? recent[0].time : null,
    recentUntil: recent[recent.length - 1] ? recent[recent.length - 1].time : null,
  }
}
