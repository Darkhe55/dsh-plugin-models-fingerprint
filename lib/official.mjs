/**
 * Explicit official-source registry and derived-artifact provenance.
 *
 * A provider name is not evidence. Official identity is only accepted from a
 * persisted configuration that names the route and records how it was
 * confirmed. Every derived baseline/calibration carries a digest of that
 * configuration plus the canonical observations it was built from.
 */
import { createHash } from 'node:crypto'

export const OFFICIAL_EVIDENCE_VERSION = 1
export const FEATURE_SCHEMA_VERSION = 'behavior-v1'
export const QUALITY_VERSION = 1
export const DEFAULT_MIN_SAMPLES = 20

export const EVIDENCE_LEVELS = Object.freeze([
  'user-confirmed-official-api',
  'official-provider-route',
  'verified-deployment',
  'claimed-only',
  'unknown',
])

const EVIDENCE_RANK = Object.freeze({
  'user-confirmed-official-api': 4,
  'official-provider-route': 3,
  'verified-deployment': 2,
  'claimed-only': 1,
  unknown: 0,
})

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/

export function modelKey(provider, model) {
  return text(provider) + '/' + text(model)
}

export function normalizeEvidenceLevel(value) {
  const level = text(value)
  return EVIDENCE_LEVELS.includes(level) ? level : 'unknown'
}

export function evidenceRank(level) {
  return EVIDENCE_RANK[normalizeEvidenceLevel(level)] || 0
}

export function isVerifiedEvidence(level) {
  return evidenceRank(level) >= 2
}

export function normalizeConfirmedAt(value) {
  if (!value) return null
  const raw = text(value)
  if (!ISO_DATE.test(raw)) return null
  const parsed = Date.parse(raw.length === 10 ? raw + 'T00:00:00.000Z' : raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
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
      evidenceLevel: normalizeEvidenceLevel(input.evidenceLevel),
      evidenceSource: text(input.evidenceSource).slice(0, 240),
      confirmedAt: normalizeConfirmedAt(input.confirmedAt),
      minSamples: Math.max(3, Number(input.minSamples) || DEFAULT_MIN_SAMPLES),
    })
  }
  return result
}

/**
 * One-time, explicit registry bootstrap. These routes were named and confirmed
 * by the user; they are not inferred from the provider prefix.
 */
export function officialModelSeeds(confirmedAt = '2026-11-14') {
  return normalizeOfficialModels([
    {
      provider: 'minimax-cn',
      model: 'MiniMax-M3',
      label: '官方 MiniMax M3',
      evidenceLevel: 'user-confirmed-official-api',
      evidenceSource: 'user-confirmed:' + confirmedAt,
      confirmedAt,
      minSamples: 20,
    },
    {
      provider: 'minimax-cn',
      model: 'MiniMax-M2.7',
      label: '官方 MiniMax M2.7',
      evidenceLevel: 'user-confirmed-official-api',
      evidenceSource: 'user-confirmed:' + confirmedAt,
      confirmedAt,
      minSamples: 20,
    },
  ])
}

export function mergeOfficialSeeds(models, version = 0, confirmedAt = '2026-11-14') {
  if (Number(version) >= OFFICIAL_EVIDENCE_VERSION) {
    return { models: normalizeOfficialModels(models), changed: false, version: Number(version) || 0 }
  }
  const normalized = normalizeOfficialModels(models)
  const existing = new Set(normalized.map((model) => model.key))
  const added = officialModelSeeds(confirmedAt).filter((model) => !existing.has(model.key))
  return {
    models: normalized.concat(added),
    changed: added.length > 0,
    version: OFFICIAL_EVIDENCE_VERSION,
    added,
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

export function officialConfigDigest(official) {
  const normalized = normalizeOfficialModels([official])[0]
  if (!normalized) return null
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex').slice(0, 24)
}

export function sourceDigestFor({ official, rows, dataVersion, featureSchemaVersion = FEATURE_SCHEMA_VERSION, qualityVersion = QUALITY_VERSION }) {
  const routeKey = text(official && official.key) || modelKey(official && official.provider, official && official.model)
  const list = Array.isArray(rows) ? rows : []
  const sessions = new Set()
  let firstTime = null
  let lastTime = null
  const fingerprints = new Map()
  for (const row of list) {
    if (row && row.sessionId) sessions.add(row.sessionId)
    if (row && Number.isFinite(row.time)) {
      if (firstTime === null || row.time < firstTime) firstTime = row.time
      if (lastTime === null || row.time > lastTime) lastTime = row.time
    }
    if (row && row.fingerprint) fingerprints.set(row.fingerprint, (fingerprints.get(row.fingerprint) || 0) + 1)
  }
  const payload = {
    routeKey,
    configDigest: officialConfigDigest(official),
    observations: list.length,
    sessions: sessions.size,
    firstTime,
    lastTime,
    featureSchemaVersion,
    qualityVersion,
    dataVersion: Number(dataVersion) || 0,
    fingerprints: [...fingerprints.entries()].sort((left, right) => left[0].localeCompare(right[0])),
  }
  return {
    digest: createHash('sha256').update(canonicalJson(payload)).digest('hex').slice(0, 32),
    payload,
  }
}

export function freshness(artifact, source, context) {
  const reasons = []
  if (!artifact) reasons.push('missing')
  if (artifact) {
    if (Number(artifact.similarityVersion || artifact.version || 0) !== Number(context.similarityVersion)) reasons.push('similarity-version')
    if (Number(artifact.dataVersion) !== Number(context.dataVersion)) reasons.push('data-version')
    if (text(artifact.featureSchemaVersion) !== text(context.featureSchemaVersion)) reasons.push('feature-schema')
    if (text(artifact.sourceDigest) !== text(source && source.digest)) reasons.push('source-digest')
    if (artifact.scannerGeneration !== context.scannerGeneration) reasons.push('scanner-generation')
    if (Number(artifact.observationRevision) !== Number(context.observationRevision)) reasons.push('observation-revision')
  }
  return { fresh: reasons.length === 0, reasons }
}
