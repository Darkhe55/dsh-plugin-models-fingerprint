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

export const SIMILARITY_VERSION = 1
export const DEFAULT_MIN_SAMPLES = 20

const text = (value) => (typeof value === 'string' ? value.trim() : '')

export function modelKey(provider, model) {
  return text(provider) + '/' + text(model)
}

export function normalizeOfficialModels(models) {
  const result = []
  const seen = new Set()
  for (const input of Array.isArray(models) ? models : []) {
    const provider = text(input && input.provider)
    const model = text(input && input.model)
    if (!provider || !model) continue
    const key = modelKey(provider, model)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      key,
      provider,
      model,
      label: text(input.label) || key,
      minSamples: Math.max(3, Number(input.minSamples) || DEFAULT_MIN_SAMPLES),
    })
  }
  return result
}

export function observationsForModel(observations, official) {
  const provider = text(official && official.provider)
  const model = text(official && official.model)
  return (Array.isArray(observations) ? observations : [])
    .filter((row) => row && row.provider === provider && row.model === model && row.behavior)
    .sort((left, right) => (left.time || 0) - (right.time || 0))
}

export function buildOfficialProfile(observations, official, options = {}) {
  const normalized = normalizeOfficialModels([official])[0]
  if (!normalized) throw new Error('official provider and model are required')
  const rows = observationsForModel(observations, normalized)
  const minSamples = Math.max(3, Number(options.minSamples) || normalized.minSamples)
  const profile = profileFor(rows)
  const fingerprintCounts = new Map()
  let firstTime = null
  let lastTime = null
  for (const row of rows) {
    fingerprintCounts.set(row.fingerprint, (fingerprintCounts.get(row.fingerprint) || 0) + 1)
    if (firstTime === null || row.time < firstTime) firstTime = row.time
    if (lastTime === null || row.time > lastTime) lastTime = row.time
  }
  const fingerprints = [...fingerprintCounts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => right.count - left.count)
  return {
    version: SIMILARITY_VERSION,
    ...normalized,
    minSamples,
    samples: rows.length,
    ready: rows.length >= minSamples && profile.usable > 0,
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
  const rows = observationsForModel(observations, normalized)
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
  const separated = positiveMedian !== null && negativeMedian !== null && positiveMedian < negativeMedian
  const calibrated = positives.length >= minPairs && negatives.length >= minPairs && separated
  const cutoff = calibrated ? (positiveMedian + negativeMedian) / 2 : null
  const slope = calibrated ? Math.max(0.12, (negativeMedian - positiveMedian) / 3) : null
  return {
    version: SIMILARITY_VERSION,
    officialKey: normalized.key,
    calibrated,
    reason: calibrated ? 'empirical same/different separation' : 'insufficient or overlapping calibration pairs',
    positives: positives.length,
    negatives: negatives.length,
    positiveMedian,
    negativeMedian,
    cutoff,
    slope,
    versionedAt: Date.now(),
  }
}

export function scoreSimilarity(rows, baseline, calibration = null) {  const comparison = compareToOfficial(rows, baseline)
  if (!comparison || comparison.distance === null) {
    return {
      calibrated: false,
      probability: null,
      score: null,
      verdict: 'no-data',
      reason: 'no comparable behavior features',
      comparison,
      calibration,
    }
  }
  const ready = Boolean(baseline && baseline.ready)
  const usableCalibration = Boolean(calibration && calibration.calibrated && calibration.cutoff !== null && calibration.slope)
  const probability = usableCalibration
    ? Math.max(0.01, Math.min(0.99, sigmoid((calibration.cutoff - comparison.distance) / calibration.slope)))
    : null
  const score = usableCalibration
    ? probability
    : Math.max(0, Math.min(1, 1 - comparison.distance / Math.max(1, comparison.selfDistance || 1) * 0.35))
  const verdict = !ready
    ? 'unverified'
    : probability === null
      ? comparison.distance <= 1.2 ? 'similar-uncalibrated' : 'different-uncalibrated'
      : probability >= 0.8
        ? 'likely-same-behavior'
        : probability <= 0.2
          ? 'likely-different-behavior'
          : 'ambiguous'
  return {
    calibrated: usableCalibration,
    probability,
    score,
    verdict,
    reason: ready ? (usableCalibration ? 'local empirical calibration' : 'calibration unavailable; score only') : 'official baseline has too few samples',
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
  let level = 'stable'
  let reason = 'behavior remains within the official baseline'
  if (baselineRatio !== null && baselineRatio >= 2.5) {
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
