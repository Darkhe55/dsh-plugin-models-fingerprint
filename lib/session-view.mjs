/**
 * Versioned session-view contract used by the rail client.
 *
 * The old /api/session endpoint exposes the raw observation groups. The view
 * keeps the same turn objects, but adds explicit data status, revision and
 * coverage so the client no longer has to infer "no data" from a missing DOM
 * node.
 */

export const SESSION_VIEW_VERSION = 1

const firstNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * @param {object} input
 * @param {string} input.sessionId
 * @param {object|null} input.session
 * @param {Array<object>} input.turns newest-first
 * @param {number} input.revision
 * @param {Array<object>} [input.observations]
 * @returns {object}
 */
export function buildTurnWindow({ sessionId, turns = [], index = {}, requested = [], revision = 0, generation = '1', limit = 32 }) {
  const byNumber = turns instanceof Map
    ? turns
    : new Map((Array.isArray(turns) ? turns : []).map((turn) => [Number(turn.turn), turn]))
  const sessionIndex = index && index[String(sessionId)] ? index[String(sessionId)] : {}
  const numbers = []
  const seen = new Set()
  for (const value of requested || []) {
    const turn = firstNumber(value)
    if (turn === null || seen.has(turn)) continue
    seen.add(turn)
    numbers.push(turn)
    if (numbers.length >= Math.max(1, Math.min(32, Number(limit) || 32))) break
  }
  numbers.sort((left, right) => left - right)
  return {
    sessionId,
    revision: Number(revision) || 0,
    generation: String(generation),
    turns: numbers.map((turn) => {
      const data = byNumber.get(turn) || null
      if (data) return { turn, status: 'observed', data }
      const row = sessionIndex[String(turn)] || null
      return row
        ? { turn, status: 'no-data', data: null, index: row }
        : { turn, status: 'missing', data: null }
    }),
  }
}

export function buildSessionView({ sessionId, session = null, turns = [], revision = 0, generation = '1', hasMore = false, nextBefore = null, observations = [] }) {
  const rows = [...(Array.isArray(turns) ? turns : [])].sort((left, right) => Number(right.turn) - Number(left.turn))
  const ids = new Set()
  const seenNumbers = new Set()
  for (const turn of rows) {
    const key = String(turn && turn.id)
    const number = firstNumber(turn && turn.turn)
    if (!key || ids.has(key)) throw new Error('duplicate turn id in session view')
    if (number !== null && seenNumbers.has(number)) throw new Error('duplicate turn number in session view')
    ids.add(key)
    if (number !== null) seenNumbers.add(number)
  }
  const normalized = rows.map((turn) => {
    const steps = Number(turn.steps) || 0
    const model = turn.primaryModel || ''
    const fingerprint = turn.primaryFingerprint || ''
    return {
      ...turn,
      status: steps > 0 && fingerprint ? 'observed' : 'no-data',
      hasModelData: Boolean(steps > 0 && fingerprint),
      anchors: [{ kind: 'turn', value: String(turn.turn) }],
      coverage: {
        steps,
        observations: steps,
        model,
        fingerprint,
      },
    }
  })
  const numbers = normalized.map((turn) => firstNumber(turn.turn)).filter((value) => value !== null)
  const firstTurn = numbers.length ? Math.min(...numbers) : null
  const lastTurn = numbers.length ? Math.max(...numbers) : null
  const observedTurns = normalized.filter((turn) => turn.hasModelData).length
  return {
    version: SESSION_VIEW_VERSION,
    sessionId,
    session: session || { id: sessionId },
    revision: Number(revision) || 0,
    generation: String(generation),
    generatedAt: Date.now(),
    status: normalized.length ? 'ready' : 'empty',
    turns: normalized,
    hasMore: hasMore === true,
    nextBefore: nextBefore === null || nextBefore === undefined ? null : Number(nextBefore),
    coverage: {
      firstTurn,
      lastTurn,
      turns: normalized.length,
      observedTurns,
      observations: Array.isArray(observations) ? observations.length : 0,
    },
  }
}
