/**
 * Lightweight per-session turn index.
 *
 * The scanner may trim full observations under memory pressure, but the turn
 * index is intentionally small and durable. It lets the client navigate to old
 * turns and request their full detail later without retaining every protocol
 * payload in memory.
 */

const turnNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function emptyTurnIndex() {
  return {}
}

export function normalizeTurnIndex(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [sessionId, turns] of Object.entries(value)) {
    if (!turns || typeof turns !== 'object' || Array.isArray(turns)) continue
    const session = {}
    for (const [key, row] of Object.entries(turns)) {
      const turn = turnNumber(row && row.turn !== undefined ? row.turn : key)
      if (turn === null) continue
      session[String(turn)] = {
        turn,
        startTime: Number(row.startTime || row.time || 0) || 0,
        endTime: Number(row.endTime || row.time || 0) || 0,
        steps: Math.max(1, Number(row.steps) || 1),
        status: row.status === 'no-data' ? 'no-data' : 'observed',
        lastSeq: Number(row.lastSeq) || 0,
        primaryFingerprint: typeof row.primaryFingerprint === 'string' ? row.primaryFingerprint : '',
        primaryModel: typeof row.primaryModel === 'string' ? row.primaryModel : '',
      }
    }
    if (Object.keys(session).length) result[String(sessionId)] = session
  }
  return result
}

export function turnIndexFromObservations(observations) {
  const index = {}
  for (const observation of observations || []) {
    if (!observation || !observation.sessionId) continue
    recordTurnIndex(index, observation)
  }
  return index
}

export function recordTurnIndex(index, observation) {
  if (!index || !observation || !observation.sessionId) return
  const turn = turnNumber(observation.turn)
  if (turn === null) return
  const sessionId = String(observation.sessionId)
  if (!index[sessionId]) index[sessionId] = {}
  const existing = index[sessionId][String(turn)]
  const time = Number(observation.time) || 0
  const next = existing || {
    turn,
    startTime: time,
    endTime: time,
    steps: 0,
    status: 'observed',
    lastSeq: 0,
    primaryFingerprint: '',
    primaryModel: '',
  }
  next.startTime = next.startTime ? Math.min(next.startTime, time) : time
  next.endTime = Math.max(next.endTime, time)
  next.steps += 1
  next.status = 'observed'
  next.lastSeq = Math.max(next.lastSeq, Number(observation.seq) || 0)
  next.primaryFingerprint = observation.fingerprint || next.primaryFingerprint
  next.primaryModel = observation.model || next.primaryModel
  index[sessionId][String(turn)] = next
}

export function listSessionTurns(index, sessionId, { before = null, limit = 200 } = {}) {
  const turns = index && index[String(sessionId)] ? index[String(sessionId)] : {}
  const rows = Object.values(turns)
    .filter((row) => before === null || row.turn < before)
    .sort((left, right) => right.turn - left.turn)
  return {
    turns: rows.slice(0, Math.max(1, limit)),
    hasMore: rows.length > limit,
    nextBefore: rows.length ? rows[Math.min(rows.length - 1, limit - 1)].turn : null,
  }
}
