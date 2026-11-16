/**
 * Session-level behavior drift diagnostics.
 *
 * This is an observability aid, not model identity evidence. Sessions are the
 * independent units: multiple observations in one session must never be
 * counted as independent change-point samples.
 */

export const DRIFT_FEATURES = [
  'tokensPerChar',
  'jsonSpacing',
  'reasoningRatio',
  'charsPerChunk',
  'escapedUnicode',
  'asciiRatio',
  'cjkRatio',
  'punctuationRatio',
  'markdownPerK',
  'newlineRatio',
]

const round = (value, digits = 3) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null)
const finite = (value) => typeof value === 'number' && Number.isFinite(value)

function mean(values) {
  if (!values.length) return null
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

function median(values) {
  if (!values.length) return null
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}

function variance(values, center) {
  if (values.length < 2) return 0
  let sum = 0
  for (const value of values) sum += (value - center) ** 2
  return sum / (values.length - 1)
}

function dominant(counts) {
  let best = null
  for (const [key, count] of counts) {
    if (!best || count > best.count || (count === best.count && String(key) < String(best.key))) {
      best = { key, count }
    }
  }
  return best ? best.key : null
}

export function buildSessionUnits(observations) {
  const groups = new Map()
  for (const row of observations || []) {
    if (!row || !row.sessionId) continue
    if (!groups.has(row.sessionId)) {
      groups.set(row.sessionId, {
        sessionId: row.sessionId,
        start: Infinity,
        end: -Infinity,
        rows: 0,
        routes: new Map(),
        fingerprints: new Map(),
        behavior: Object.fromEntries(DRIFT_FEATURES.map((field) => [field, []])),
      })
    }
    const unit = groups.get(row.sessionId)
    const time = Number(row.time)
    if (Number.isFinite(time)) {
      unit.start = Math.min(unit.start, time)
      unit.end = Math.max(unit.end, time)
    }
    unit.rows += 1
    const routeKey = row.routeKey || [row.provider, row.model].filter(Boolean).join('/')
    if (routeKey) unit.routes.set(routeKey, (unit.routes.get(routeKey) || 0) + 1)
    if (row.fingerprint) unit.fingerprints.set(row.fingerprint, (unit.fingerprints.get(row.fingerprint) || 0) + 1)
    for (const field of DRIFT_FEATURES) {
      const value = row.behavior && row.behavior[field]
      if (finite(value)) unit.behavior[field].push(value)
    }
  }
  return [...groups.values()]
    .filter((unit) => Number.isFinite(unit.start))
    .map((unit) => {
      const features = {}
      for (const field of DRIFT_FEATURES) features[field] = mean(unit.behavior[field])
      return {
        sessionId: unit.sessionId,
        start: unit.start,
        end: unit.end,
        rows: unit.rows,
        routeKey: dominant(unit.routes),
        fingerprint: dominant(unit.fingerprints),
        features,
      }
    })
    .sort((left, right) => left.end - right.end || String(left.sessionId).localeCompare(String(right.sessionId)))
}

/**
 * Robust two-window change point over session-level means. Prefix sums keep
 * this O(sessions * features) and avoid per-observation pseudo-replication.
 */
export function detectBehaviorChangePoints(units, { minimumSessions = 6, minimumScore = 1 } = {}) {
  if (!Array.isArray(units) || units.length < minimumSessions) return []
  const candidates = []
  for (const field of DRIFT_FEATURES) {
    const values = []
    for (const unit of units) {
      const value = unit.features[field]
      if (finite(value)) values.push({ time: unit.end, value })
    }
    if (values.length < minimumSessions) continue
    const prefix = [0]
    const prefixSquares = [0]
    for (const item of values) {
      prefix.push(prefix[prefix.length - 1] + item.value)
      prefixSquares.push(prefixSquares[prefixSquares.length - 1] + item.value * item.value)
    }
    const total = prefix[prefix.length - 1]
    const totalSquares = prefixSquares[prefixSquares.length - 1]
    let best = null
    for (let split = 3; split <= values.length - 3; split += 1) {
      const beforeCount = split
      const afterCount = values.length - split
      const beforeSum = prefix[split]
      const afterSum = total - beforeSum
      const beforeMean = beforeSum / beforeCount
      const afterMean = afterSum / afterCount
      const beforeVar = Math.max(0, (prefixSquares[split] - beforeSum * beforeSum / beforeCount) / Math.max(1, beforeCount - 1))
      const afterVar = Math.max(0, ((totalSquares - prefixSquares[split]) - afterSum * afterSum / afterCount) / Math.max(1, afterCount - 1))
      const pooled = Math.sqrt((beforeVar + afterVar) / 2)
      const globalMean = total / values.length
      const globalVar = Math.max(0, (totalSquares - total * total / values.length) / Math.max(1, values.length - 1))
      const globalSd = Math.sqrt(globalVar)
      const delta = Math.abs(afterMean - beforeMean)
      const effect = globalSd > 0 ? delta / globalSd : (delta > 0 ? Infinity : 0)
      const score = delta / Math.max(1e-9, pooled)
      if (!best || score > best.score) {
        best = {
          field,
          score,
          effect,
          before: beforeMean,
          after: afterMean,
          delta: afterMean - beforeMean,
          time: values[split].time,
          sessionsBefore: beforeCount,
          sessionsAfter: afterCount,
          globalSd,
        }
      }
    }
    if (best && best.score >= minimumScore) candidates.push(best)
  }
  return candidates
    .sort((left, right) => right.score - left.score)
    .map((item) => ({
      field: item.field,
      time: item.time,
      score: round(item.score, 2),
      effect: round(item.effect, 2),
      before: round(item.before),
      after: round(item.after),
      delta: round(item.delta),
      sessionsBefore: item.sessionsBefore,
      sessionsAfter: item.sessionsAfter,
      method: 'session-level-robust-change-point',
      identityEligible: false,
    }))
}

export function routeTransitions(units) {
  const transitions = []
  for (let index = 1; index < units.length; index += 1) {
    const previous = units[index - 1]
    const current = units[index]
    if (previous.fingerprint && current.fingerprint && previous.fingerprint !== current.fingerprint) {
      transitions.push({
        type: 'fingerprint',
        time: current.end,
        from: previous.fingerprint,
        to: current.fingerprint,
        sessionId: current.sessionId,
        identityEligible: false,
      })
    } else if (previous.routeKey && current.routeKey && previous.routeKey !== current.routeKey) {
      transitions.push({
        type: 'route',
        time: current.end,
        from: previous.routeKey,
        to: current.routeKey,
        sessionId: current.sessionId,
        identityEligible: false,
      })
    }
  }
  return transitions
}

export function buildDriftReport(observations, options = {}) {
  const minimumSessions = Math.max(4, Number(options.minimumSessions) || 6)
  const units = buildSessionUnits(observations)
  const changePoints = detectBehaviorChangePoints(units, { minimumSessions, minimumScore: Number(options.minimumScore) || 2.5 })
  const transitions = routeTransitions(units)
  const status = units.length < minimumSessions
    ? 'insufficient-sessions'
    : (changePoints.length || transitions.length ? 'drift' : 'stable')
  return {
    method: 'session-level-drift',
    unit: 'underlying-session',
    status,
    minimumSessions,
    sessions: units.length,
    observations: (observations || []).length,
    changePoints,
    routeTransitions: transitions.slice(-20),
    note: 'Exploratory observability only; sessions are the independent unit and this does not establish model identity.',
  }
}
