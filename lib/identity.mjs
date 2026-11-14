/**
 * Three-layer identity model.
 *
 * `fp_...` remains the exact transport/protocol fingerprint for compatibility.
 * It is intentionally *not* a model identity. The shadow layers separate:
 *   transport family  (api/adapter/wire provider)
 *   transport variant (stable response/usage/tool shape)
 *   behavior profile  (content-generation statistics)
 */
import { createHash } from 'node:crypto'

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const stable = (value) => {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
const hash = (kind, value) => kind + '_' + createHash('sha256').update(stable(value)).digest('hex').slice(0, 12)

function protocolParts(row) {
  const protocol = row && row.protocol && typeof row.protocol === 'object' ? row.protocol : {}
  const detail = row && row.protocolDetail && typeof row.protocolDetail === 'object' ? row.protocolDetail : {}
  const usageKeys = Array.isArray(detail.usageKeys) ? detail.usageKeys : []
  const usageFlags = {
    input: usageKeys.includes('inputTokens'),
    output: usageKeys.includes('outputTokens'),
    total: usageKeys.includes('totalTokens'),
    cacheRead: usageKeys.includes('cacheReadTokens'),
    cacheWrite: usageKeys.includes('cacheWriteTokens'),
    reasoning: usageKeys.includes('reasoningTokens'),
  }
  return {
    family: {
      api: text(protocol.api),
      adapter: text(protocol.adapter),
      wireProvider: text(protocol.wireProvider),
    },
    variant: {
      // Deliberately coarser than fp_...: content-dependent stop/replay/block
      // shape and tool-id alphabet are not a different transport variant.
      responseIdShape: text(protocol.responseId) || text(detail.responseIdShape),
      hasReplay: Boolean(detail.hasReplay),
      usageFlags: {
        cacheRead: usageFlags.cacheRead,
        cacheWrite: usageFlags.cacheWrite,
        reasoning: usageFlags.reasoning,
      },
      logprobs: Boolean(detail.logprobs),
      serviceTier: text(detail.serviceTier),
      systemFingerprint: text(detail.systemFingerprint),
    },
  }
}

export function transportFamilyId(row) {
  return hash('tf', protocolParts(row).family)
}

export function transportVariantId(row) {
  return hash('tv', protocolParts(row).variant)
}

export function behaviorProfileIdForProfile(profile) {
  if (!profile || !profile.features) return null
  const bins = {}
  for (const [key, value] of Object.entries(profile.features)) {
    bins[key] = value && Number.isFinite(value.median) ? Math.round(value.median * 100) / 100 : null
  }
  return hash('bp', bins)
}

export function behaviorProfileId(row) {
  const behavior = row && row.behavior
  if (!behavior) return null
  const bins = {
    tokensPerChar: Number.isFinite(behavior.tokensPerChar) ? Math.round(behavior.tokensPerChar * 100) : null,
    charsPerChunk: Number.isFinite(behavior.charsPerChunk) ? Math.round(behavior.charsPerChunk) : null,
    reasoningRatio: Number.isFinite(behavior.reasoningRatio) ? Math.round(behavior.reasoningRatio * 20) / 20 : null,
    jsonSpacing: Number.isFinite(behavior.jsonSpacing) ? Math.round(behavior.jsonSpacing * 10) : null,
  }
  return hash('bp', bins)
}

export function protocolLayers(row) {
  return {
    fingerprint: row && row.fingerprint || null,
    transportFamilyId: transportFamilyId(row),
    transportVariantId: transportVariantId(row),
    behaviorProfileId: behaviorProfileId(row),
  }
}

export function compareProtocol(left, right) {
  const leftLayers = protocolLayers(left)
  const rightLayers = protocolLayers(right)
  return {
    sameFingerprint: Boolean(leftLayers.fingerprint && leftLayers.fingerprint === rightLayers.fingerprint),
    sameExact: Boolean(leftLayers.fingerprint && leftLayers.fingerprint === rightLayers.fingerprint),
    sameFamily: leftLayers.transportFamilyId === rightLayers.transportFamilyId,
    sameVariant: leftLayers.transportVariantId === rightLayers.transportVariantId,
    left: leftLayers,
    right: rightLayers,
  }
}

/**
 * Passive behavior cannot confirm model identity. Fixed repeated probes raise
 * the ceiling; no combination of natural-chat observations alone can.
 */
export function assessModelIdentity({
  protocol = null,
  behaviorSimilarity = null,
  behaviorDistance = null,
  evidenceLevel = 'unknown',
  source = 'passive',
} = {}) {
  const passiveOnly = source !== 'fixed-probe'
  const verified = evidenceLevel === 'user-confirmed-official-api'
    || evidenceLevel === 'official-provider-route'
    || evidenceLevel === 'verified-deployment'
  const behavior = Number.isFinite(behaviorSimilarity)
    ? behaviorSimilarity
    : (Number.isFinite(behaviorDistance) ? Math.max(0, Math.min(1, 1 - behaviorDistance / 4)) : null)
  let protocolConfidence = 0
  if (protocol && protocol.sameExact) protocolConfidence = 1
  else if (protocol && protocol.sameVariant) protocolConfidence = 0.85
  else if (protocol && protocol.sameFamily) protocolConfidence = 0.55
  else if (protocol && protocol.sameFamily === false) protocolConfidence = 0
  const ceiling = passiveOnly ? (verified ? 0.45 : 0.2) : (verified ? 0.85 : 0.5)
  const modelIdentityConfidence = behavior === null
    ? null
    : Math.min(ceiling, Math.max(0, behavior * ceiling))
  let status = 'insufficient-evidence'
  if (!passiveOnly && behavior !== null && behavior >= 0.8) status = 'identity-supported'
  else if (passiveOnly && behaviorDistance !== null && behaviorDistance >= 1.2) status = 'possible-different-model-insufficient-evidence'
  else if (protocol && protocol.sameExact && passiveOnly) status = 'protocol-consistent-behavior-inconclusive'
  else if (passiveOnly && behavior !== null && behavior >= 0.7) status = 'behavior-similar-passive-only'
  return {
    protocolConfidence,
    behaviorSimilarity: behavior === null ? null : Math.round(behavior * 1000) / 1000,
    modelIdentityConfidence,
    evidenceLevel,
    verifiedEvidence: verified,
    passiveOnly,
    ceiling,
    status,
    note: passiveOnly
      ? '自然会话行为只能作为被动证据，不能单独确认模型身份。'
      : '固定重复探针可提高身份置信度上限，但仍不是数学证明。',
  }
}
