/**
 * Derived official-model artifact lifecycle.
 *
 * Baselines and calibrations are caches, not source data. They are valid only
 * for the canonical observation digest, model configuration, feature schema,
 * similarity version and scanner revision that produced them. A failed rebuild
 * returns the last valid object marked stale; it never overwrites that object.
 */
import { buildCalibration, buildOfficialProfile, sourceForOfficial } from './similarity.mjs'
import { FEATURE_SCHEMA_VERSION, QUALITY_VERSION, freshness } from './official.mjs'

export function artifactContext({
  dataVersion,
  scannerGeneration = null,
  observationRevision = 0,
  similarityVersion,
  featureSchemaVersion = FEATURE_SCHEMA_VERSION,
  qualityVersion = QUALITY_VERSION,
}) {
  return {
    dataVersion: Number(dataVersion) || 0,
    scannerGeneration: scannerGeneration ?? null,
    observationRevision: Number(observationRevision) || 0,
    featureSchemaVersion,
    qualityVersion,
    similarityVersion: Number(similarityVersion) || 0,
  }
}

function staleCopy(artifact, reasons, error) {
  if (!artifact) return null
  return {
    ...artifact,
    stale: true,
    staleReasons: reasons,
    staleError: error ? String(error && error.message ? error.message : error) : null,
  }
}

function ensureOne(existing, source, context, label, build, force = false) {
  const state = freshness(existing, source, context)
  if (existing && state.fresh && !force) {
    return { artifact: existing, rebuilt: false, stale: false, reasons: [], error: null }
  }
  try {
    const built = build()
    return { artifact: { ...built, stale: false, staleReasons: [], staleError: null }, rebuilt: true, stale: false, reasons: state.reasons, error: null }
  } catch (error) {
    return {
      artifact: staleCopy(existing, state.reasons.length ? state.reasons : [label + '-rebuild-failed'], error),
      rebuilt: false,
      stale: true,
      reasons: state.reasons,
      error: String(error && error.message ? error.message : error),
    }
  }
}

export function ensureOfficialArtifacts({
  model,
  observations,
  existingBaseline = null,
  existingCalibration = null,
  context,
  force = false,
  builders = {},
}) {
  const normalized = model
  const source = sourceForOfficial(observations, normalized, context)
  const baseline = ensureOne(existingBaseline, source, context, 'baseline', () => (
    builders.baseline || buildOfficialProfile
  )(observations, normalized, {
    ...context,
    minSamples: normalized.minSamples,
  }), force)
  const calibration = ensureOne(
    existingCalibration,
    { ...source, digest: source.calibrationDigest },
    context,
    'calibration',
    () => (builders.calibration || buildCalibration)(observations, normalized, context),
    force,
  )
  return {
    model: normalized,
    source: source.payload,
    sourceDigest: source.digest,
    excludedSamples: source.excluded.length,
    baseline,
    calibration,
  }
}
