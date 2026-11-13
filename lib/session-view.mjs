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
export function buildSessionView({ sessionId, session = null, turns = [], revision = 0, observations = [] }) {
  const rows = Array.isArray(turns) ? turns : []
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
    generatedAt: Date.now(),
    status: normalized.length ? 'ready' : 'empty',
    turns: normalized,
    coverage: {
      firstTurn,
      lastTurn,
      turns: normalized.length,
      observedTurns,
      observations: Array.isArray(observations) ? observations.length : 0,
    },
  }
}
