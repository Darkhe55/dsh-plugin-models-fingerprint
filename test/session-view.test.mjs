import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSessionView, SESSION_VIEW_VERSION } from '../lib/session-view.mjs'

const turns = [
  {
    id: 's:turn:3',
    sessionId: 's',
    turn: 3,
    steps: 2,
    primaryModel: 'model-a',
    primaryFingerprint: 'fp_aaaaaaaaaaaa',
  },
  {
    id: 's:turn:2',
    sessionId: 's',
    turn: 2,
    steps: 0,
    primaryModel: '',
    primaryFingerprint: '',
  },
  {
    id: 's:turn:1',
    sessionId: 's',
    turn: 1,
    steps: 1,
    primaryModel: 'model-a',
    primaryFingerprint: 'fp_aaaaaaaaaaaa',
  },
]

test('session view exposes revision, status and explicit no-data turns', () => {
  const view = buildSessionView({
    sessionId: 's',
    session: { id: 's', cwd: '/tmp/project' },
    turns,
    revision: 12,
    observations: [{ id: 'a' }, { id: 'b' }],
  })
  assert.equal(view.version, SESSION_VIEW_VERSION)
  assert.equal(view.revision, 12)
  assert.equal(view.status, 'ready')
  assert.equal(view.turns.length, 3)
  assert.equal(view.turns[0].status, 'observed')
  assert.equal(view.turns[0].hasModelData, true)
  assert.equal(view.turns[1].status, 'no-data')
  assert.equal(view.turns[1].hasModelData, false)
  assert.equal(view.turns[0].anchors[0].value, '3')
  assert.equal(view.coverage.firstTurn, 1)
  assert.equal(view.coverage.lastTurn, 3)
  assert.equal(view.coverage.turns, 3)
  assert.equal(view.coverage.observedTurns, 2)
  assert.equal(view.coverage.observations, 2)
})

test('session view remains explicit when a session has no turns', () => {
  const view = buildSessionView({ sessionId: 'empty', turns: [], revision: 0 })
  assert.equal(view.status, 'empty')
  assert.deepEqual(view.turns, [])
  assert.equal(view.coverage.firstTurn, null)
  assert.equal(view.coverage.lastTurn, null)
  assert.equal(view.coverage.observedTurns, 0)
})
