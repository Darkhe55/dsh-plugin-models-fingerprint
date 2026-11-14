/**
 * Data-quality gate for canonical observations.
 *
 * Raw observations are never deleted. A row that cannot support identity or
 * baseline work is returned with explicit flags and exclusion reasons so the
 * report can still show that it existed.
 */
import { QUALITY_VERSION } from './official.mjs'

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '' && value.trim() !== '-'

export function evaluateObservationQuality(row) {
  const protocol = row && row.protocol && typeof row.protocol === 'object' ? row.protocol : null
  const detail = row && row.protocolDetail && typeof row.protocolDetail === 'object' ? row.protocolDetail : null
  const behavior = row && row.behavior && typeof row.behavior === 'object' ? row.behavior : null
  const reasons = []

  const protocolPresent = Boolean(protocol && Object.keys(protocol).length)
  const missingProtocolFields = []
  for (const field of ['api', 'adapter', 'wireProvider', 'responseId', 'replay']) {
    if (!protocol || !nonEmpty(protocol[field]) || protocol[field] === 'none') missingProtocolFields.push(field)
  }
  const completeProtocol = protocolPresent
    ? Boolean(nonEmpty(protocol.api) && nonEmpty(protocol.adapter) && nonEmpty(protocol.wireProvider)
      && nonEmpty(protocol.responseId) && protocol.responseId !== 'none' && nonEmpty(protocol.replay))
    : null
  if (protocolPresent && !completeProtocol) reasons.push('protocol-fields-missing')

  const completeBehavior = Boolean(behavior
    && finite(behavior.tokensPerChar) && behavior.tokensPerChar > 0
    && finite(behavior.charsPerChunk) && behavior.charsPerChunk >= 0
    && finite(behavior.reasoningRatio))
  if (!behavior) reasons.push('behavior-missing')
  else if (!completeBehavior) reasons.push('behavior-fields-missing')

  const tokens = row && row.tokens && typeof row.tokens === 'object' ? row.tokens : null
  const hasUsage = Boolean(tokens && (finite(tokens.input) || finite(tokens.output) || finite(tokens.total)) && (tokens.input > 0 || tokens.output > 0))
  if (!hasUsage) reasons.push('usage-missing')

  const hasReplay = Boolean(detail && detail.hasReplay)
  if (!hasReplay) reasons.push('replay-missing')

  const routeKey = row && row.routeKey ? String(row.routeKey) : ''
  const expectedRoute = row ? String(row.provider || '') + '/' + String(row.model || '') : ''
  const responseModel = row && row.protocolDetail ? String(row.protocolDetail.responseModel || '') : ''
  const routeConsistent = Boolean(!routeKey || routeKey === expectedRoute)
    && Boolean(!responseModel || responseModel === String(row.model || ''))
  if (!routeConsistent) reasons.push('route-inconsistent')

  const reasoningOnly = Boolean(behavior && behavior.reasoningChars > 0
    && !finite(behavior.textChars || null)
    && Number(row && row.textBlocks || 0) === 0
    && Number(row && row.toolCalls || 0) === 0)
  if (reasoningOnly && !hasUsage) reasons.push('reasoning-only-no-response')

  const canonicalSource = Boolean(row && row.canonicalSource !== false)
  if (!canonicalSource) reasons.push('non-canonical-source')

  // Two separate gates. Legacy rows with complete behavior can contribute to a
  // behavior distribution, but never to protocol identity or strong identity.
  const behaviorBaselineEligible = Boolean(completeBehavior && routeConsistent && canonicalSource)
  const usableForIdentity = Boolean(completeProtocol && completeBehavior && routeConsistent && hasReplay && hasUsage && canonicalSource)
  const usableForBaseline = behaviorBaselineEligible
  const baselineClass = !behaviorBaselineEligible
    ? 'excluded'
    : completeProtocol ? 'canonical' : 'behavior-only-legacy'
  const baselineExclusionReasons = behaviorBaselineEligible ? [] : reasons.slice()
  const identityExclusionReasons = usableForIdentity
    ? []
    : reasons.slice().concat(completeProtocol ? [] : ['protocol-identity-ineligible'])

  return {
    qualityVersion: QUALITY_VERSION,
    completeProtocol,
    completeBehavior,
    canonicalSource,
    routeConsistent,
    baselineClass,
    behaviorBaselineEligible,
    missingProtocolFields,
    usableForIdentity,
    usableForBaseline,
    exclusionReasons: reasons,
    baselineExclusionReasons,
    identityExclusionReasons,
  }
}

export function qualityForRows(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : []
  const maxSamples = Math.max(1, Number(options.maxSamples) || 50)
  let usable = 0
  let identity = 0
  let excludedCount = 0
  let identityExcludedCount = 0
  const baselineClasses = new Map()
  const reasons = new Map()
  const identityReasons = new Map()
  const missingProtocolFields = new Map()
  const excluded = []
  for (const row of list) {
    const quality = evaluateObservationQuality(row)
    if (quality.usableForBaseline) {
      usable += 1
      baselineClasses.set(quality.baselineClass, (baselineClasses.get(quality.baselineClass) || 0) + 1)
    } else {
      excludedCount += 1
      for (const reason of quality.baselineExclusionReasons) reasons.set(reason, (reasons.get(reason) || 0) + 1)
    }
    if (quality.usableForIdentity) identity += 1
    else {
      identityExcludedCount += 1
      for (const reason of quality.identityExclusionReasons) identityReasons.set(reason, (identityReasons.get(reason) || 0) + 1)
      for (const field of quality.missingProtocolFields) missingProtocolFields.set(field, (missingProtocolFields.get(field) || 0) + 1)
    }
    if (!quality.usableForBaseline && excluded.length < maxSamples) {
      excluded.push({
        id: row && row.id || null,
        sessionId: row && row.sessionId || null,
        turn: (row && row.turn) ?? null,
        step: (row && row.step) ?? null,
        time: row && row.time || null,
        fingerprint: row && row.fingerprint || null,
        quality,
      })
    }
  }
  return {
    total: list.length,
    usableForBaseline: usable,
    usableForIdentity: identity,
    excluded: excludedCount,
    identityExcluded: identityExcludedCount,
    baselineClasses: [...baselineClasses.entries()].map(([baselineClass, count]) => ({ baselineClass, count })),
    samplesTruncated: excludedCount > excluded.length,
    reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((left, right) => right.count - left.count),
    identityReasons: [...identityReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((left, right) => right.count - left.count),
    missingProtocolFields: [...missingProtocolFields.entries()].map(([field, count]) => ({ field, count })).sort((left, right) => right.count - left.count),
    samples: excluded,
  }
}
