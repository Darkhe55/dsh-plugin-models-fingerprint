/**
 * Provider-invariant behavior comparison.
 *
 * The route fingerprint answers "which transport/adapter produced this"; this
 * module answers a different question: "do two routes behave like the same
 * model after transport differences are ignored?"
 *
 * This is deliberately a separate layer: `fp_...` keeps wireProvider/API/id
 * shape, while behavior profiles exclude them. Distance is calibrated against
 * each route's own run-to-run dispersion. Passive history is noisy; active
 * probes (when available) should be preferred and are marked as such.
 */

const FEATURES = [  { key: 'tokensPerChar', weight: 0.30, min: 0.03 },
  { key: 'jsonSpacing', weight: 0.15, min: 0.08 },
  { key: 'reasoningRatio', weight: 0.15, min: 0.05 },
  { key: 'charsPerChunk', weight: 0.10, min: 0.5 },
  { key: 'cjkRatio', weight: 0.05, min: 0.03 },
  { key: 'asciiRatio', weight: 0.05, min: 0.03 },
  { key: 'punctuationRatio', weight: 0.05, min: 0.015 },
  { key: 'markdownPerK', weight: 0.05, min: 1.0 },
  { key: 'escapedUnicode', weight: 0.05, min: 0.01 },
  { key: 'newlineRatio', weight: 0.05, min: 0.015 },
]

export const BEHAVIOR_FEATURES = FEATURES

function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function median(values) {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (!list.length) return null
  const middle = Math.floor(list.length / 2)
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2
}

function mad(values, center) {
  if (center === null) return null
  return median(values.filter((value) => typeof value === 'number' && Number.isFinite(value)).map((value) => Math.abs(value - center)))
}

export function profileFor(rows) {
  const features = {}
  for (const feature of FEATURES) {
    const values = rows
      .map((row) => row.behavior && row.behavior[feature.key])
      .filter((value) => typeof value === 'number' && Number.isFinite(value))
    const center = median(values)
    features[feature.key] = {
      median: center,
      mad: mad(values, center),
      samples: values.length,
      weight: feature.weight,
      min: feature.min,
    }
  }
  const usable = FEATURES.filter((feature) => features[feature.key].samples >= 2 && features[feature.key].median !== null)
  const selfDistance = usable.length
    ? usable.reduce((sum, feature) => {
        const item = features[feature.key]
        return sum + feature.weight * Math.min(1, (item.mad || 0) * 1.4826 / feature.min)
      }, 0) / usable.reduce((sum, feature) => sum + feature.weight, 0)
    : null
  return {
    rows: rows.length,
    features,
    selfDistance: round(selfDistance, 3),
    usable: usable.length,
  }
}

export function distanceProfiles(a, b) {
  let weighted = 0
  let weight = 0
  const contributions = []
  for (const feature of FEATURES) {
    const left = a.features[feature.key]
    const right = b.features[feature.key]
    if (!left || !right || left.median === null || right.median === null) continue
    const scale = Math.max(feature.min, 1.4826 * ((left.mad || 0) + (right.mad || 0)) / 2)
    const z = Math.min(6, Math.abs(left.median - right.median) / scale)
    weighted += z * feature.weight
    weight += feature.weight
    contributions.push({ key: feature.key, z: round(z, 2), weight: feature.weight, a: round(left.median, 3), b: round(right.median, 3) })
  }
  return {
    distance: weight > 0 ? round(weighted / weight, 3) : null,
    coverage: round(weight, 3),
    contributions: contributions.sort((left, right) => right.weight * right.z - left.weight * left.z).slice(0, 5),
  }
}

function routeProtocols(rows) {
  const protocols = new Map()
  for (const row of rows) {
    const key = (row.protocol && row.protocol.api) + '|' + (row.protocol && row.protocol.adapter)
    protocols.set(key, (protocols.get(key) || 0) + 1)
  }
  return [...protocols.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count)
}

export function tokenizerVectorOf(rows) {
  const probeRows = rows.filter((row) => row.probe && row.probeMeta && row.probeMeta.promptId)
  if (probeRows.length < 2) return null
  const byPrompt = new Map()
  for (const row of probeRows) {
    const id = row.probeMeta.promptId
    if (!byPrompt.has(id)) byPrompt.set(id, [])
    byPrompt.get(id).push(row.tokens && row.tokens.input)
  }
  const baseline = median(byPrompt.get('baseline') || [])
  if (baseline === null) return null
  const vector = {}
  for (const [id, values] of byPrompt) {
    if (id === 'baseline') continue
    const center = median(values)
    if (center !== null) vector[id] = center - baseline
  }
  return Object.keys(vector).length ? vector : null
}

function tokenizerVectorDistance(left, right) {
  if (!left || !right) return null
  const keys = Object.keys(left).filter((key) => Object.prototype.hasOwnProperty.call(right, key))
  if (!keys.length) return null
  const values = keys.map((key) => Math.abs(left[key] - right[key]) / Math.max(3, (Math.abs(left[key]) + Math.abs(right[key])) / 2))
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 3)
}

function verdictFor(pair, sameThreshold, differentThreshold) {
  if (pair.distance === null) return 'inconclusive'
  if (!pair.enoughA || !pair.enoughB) return 'inconclusive'
  if (pair.distance <= sameThreshold && pair.relative <= 1.8) return 'same-behavior'
  if (pair.distance >= differentThreshold || pair.relative >= 3.0) return 'different-behavior'
  return 'inconclusive'
}

function enoughSamples(route) {
  return route.source === 'probe' ? route.sampleRows >= 2 : route.sampleRows >= 5
}

/**
 * Build a passive behavior-equivalence report.
 * @param {object[]} observations
 * @param {object} labels fingerprint-id -> {label,note}
 * @param {{limit?:number}} options
 */
export function buildEquivalence(observations, labels = {}, options = {}) {
  const limit = Math.max(20, Math.min(200, Number(options.limit) || 80))
  const allRows = [...observations, ...(Array.isArray(options.probes) ? options.probes : [])]
  const groups = new Map()
  for (const row of allRows) {
    if (!row || !row.routeKey) continue
    if (!groups.has(row.routeKey)) groups.set(row.routeKey, [])
    groups.get(row.routeKey).push(row)
  }
  const routes = []
  for (const [routeKey, rows] of groups) {
    const probeRows = rows.filter((row) => row.probe)
    const sampleRows = (probeRows.length >= 2 ? probeRows : rows).filter((row) => row.behavior)
    if (!sampleRows.length) continue
    const sorted = [...sampleRows].sort((left, right) => left.time - right.time)
    const [provider, ...rest] = routeKey.split('/')
    const profile = profileFor(sorted)
    const latest = sorted[sorted.length - 1]
    const label = labels[latest.fingerprint] ? labels[latest.fingerprint].label : null
    routes.push({
      routeKey,
      provider,
      model: rest.join('/'),
      observations: rows.length,
      sampleRows: sorted.length,
      label,
      profile,
      protocols: routeProtocols(sorted),
      tokenizer: tokenizerVectorOf(probeRows),
      logprobs: sorted.filter((row) => row.aux && row.aux.logprobs).length,
      probes: probeRows.length,
      source: probeRows.length >= 2 ? 'probe' : 'passive',
      lastSeen: latest.time,
    })
  }
  routes.sort((left, right) => right.observations - left.observations)
  const selfValues = routes.filter((route) => enoughSamples(route)).map((route) => route.profile.selfDistance).filter((value) => value !== null)
  const selfMedian = median(selfValues) || 0.35
  const sameThreshold = Math.max(0.9, round(selfMedian * 1.8, 3))
  const differentThreshold = Math.max(2.4, round(sameThreshold * 2.6, 3))
  const probeCount = routes.reduce((sum, route) => sum + route.probes, 0)
  const pairs = []
  for (let i = 0; i < routes.length; i += 1) {
    for (let j = i + 1; j < routes.length; j += 1) {
      const a = routes[i]
      const b = routes[j]
      const distance = distanceProfiles(a.profile, b.profile)
      const relative = distance.distance === null ? null : distance.distance / Math.max(0.2, ((a.profile.selfDistance || 0) + (b.profile.selfDistance || 0)) / 2)
      const tokenizerDistance = tokenizerVectorDistance(a.tokenizer, b.tokenizer)
      const protocolIntersection = a.protocols.some((left) => b.protocols.some((right) => right.key === left.key))
      const pair = {
        id: a.routeKey + '::' + b.routeKey,
        a: a.routeKey,
        b: b.routeKey,
        aModel: a.model,
        bModel: b.model,
        sameModelName: a.model === b.model,
        sameProvider: a.provider === b.provider,
        sameLabel: Boolean(a.label && b.label && a.label === b.label),
        protocolCompatible: protocolIntersection,
        distance: distance.distance,
        tokenizerDistance,
        relative: round(relative, 3),
        coverage: distance.coverage,
        contributions: distance.contributions,
        samplesA: a.sampleRows,
        samplesB: b.sampleRows,
        sourceA: a.source,
        sourceB: b.source,
        probesA: a.probes,
        probesB: b.probes,
        enoughA: enoughSamples(a),
        enoughB: enoughSamples(b),
        selfA: a.profile.selfDistance,
        selfB: b.profile.selfDistance,
        labelA: a.label,
        labelB: b.label,
      }
      pair.verdict = verdictFor(pair, sameThreshold, differentThreshold)
      if (pair.verdict !== 'inconclusive' && tokenizerDistance !== null) {
        if (tokenizerDistance >= 0.35) pair.verdict = 'different-behavior'
        else if (tokenizerDistance <= 0.1 && pair.verdict === 'same-behavior') pair.verdict = 'same-behavior'
      }
      pair.confidence = round(Math.min(0.9, Math.max(0.1,
        0.2
        + Math.min(0.25, (a.observations + b.observations) / 200)
        + (pair.coverage || 0) * 0.25
        + (pair.verdict === 'inconclusive' ? 0 : 0.2)
        + (pair.probesA && pair.probesB ? 0.15 : 0),
      )), 2)
      pairs.push(pair)
    }
  }
  pairs.sort((left, right) => {
    if (left.sameModelName !== right.sameModelName) return left.sameModelName ? -1 : 1
    return (left.distance === null ? 99 : left.distance) - (right.distance === null ? 99 : right.distance)
  })
  const modelNames = new Map()
  for (const route of routes) {
    if (!modelNames.has(route.model)) modelNames.set(route.model, [])
    modelNames.get(route.model).push(route)
  }
  const claims = [...modelNames.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([model, list]) => {
      const listPairs = pairs.filter((pair) => pair.sameModelName && (list.some((route) => route.routeKey === pair.a) || list.some((route) => route.routeKey === pair.b)))
      return {
        model,
        routes: list.map((route) => ({ routeKey: route.routeKey, provider: route.provider, observations: route.observations, label: route.label })),
        pairs: listPairs.length,
        different: listPairs.filter((pair) => pair.verdict === 'different-behavior').length,
        same: listPairs.filter((pair) => pair.verdict === 'same-behavior').length,
      }
    })
    .sort((left, right) => right.different - left.different || right.routes.length - left.routes.length)
  return {
    generatedAt: Date.now(),
    methods: {
      version: 1,
      passiveOnly: probeCount === 0,
      probeRoutes: routes.filter((route) => route.source === 'probe').length,
      features: FEATURES.map(({ key, weight }) => ({ key, weight })),
      sameThreshold,
      differentThreshold,
      selfMedian: round(selfMedian, 3),
    },
    stats: {
      routes: routes.length,
      pairs: pairs.length,
      comparable: pairs.filter((pair) => pair.verdict !== 'inconclusive').length,
      sameBehavior: pairs.filter((pair) => pair.verdict === 'same-behavior').length,
      differentBehavior: pairs.filter((pair) => pair.verdict === 'different-behavior').length,
      claimsWithMultipleRoutes: claims.length,
      probes: probeCount,
    },
    routes: routes.map((route) => ({
      routeKey: route.routeKey,
      provider: route.provider,
      model: route.model,
      observations: route.observations,
      samples: route.sampleRows,
      label: route.label,
      probes: route.probes,
      source: route.source,
      selfDistance: route.profile.selfDistance,
      usableFeatures: route.profile.usable,
      protocols: route.protocols,
      tokenizer: route.tokenizer,
      logprobs: route.logprobs,
      lastSeen: route.lastSeen,
    })).slice(0, limit),
    pairs: pairs.slice(0, limit),
    claims: claims.slice(0, limit),
  }
}

export { FEATURES }
