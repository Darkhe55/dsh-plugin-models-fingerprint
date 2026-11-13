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
