import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { canonicalSessionFiles, discoverSessionFiles, semanticKeyOf, SessionScanner } from '../lib/scan.mjs'
import { buildTurns } from '../lib/summary.mjs'
import { buildSessionView } from '../lib/session-view.mjs'
import { listSessionTurns } from '../lib/turn-index.mjs'
import { DATA_VERSION, FingerprintStore } from '../lib/store.mjs'

function sessionLine(id = 'semantic-session') {
  return JSON.stringify({ type: 'session', version: 4, id, createdAt: 1000, cwd: 'C:/work' })
}
function contextLine() {
  return JSON.stringify({ type: 'request/context', seq: 2, time: 1100, data: { provider: 'provider-a', model: 'claimed-a', contextWindow: 100000 } })
}
function stepLine(seq, time, turn = 1, step = 1) {
  return JSON.stringify({ type: 'step/start', seq, time, data: { turn, step } })
}
function assistantLine(seq, time, turn = 1, step = 1, fingerprintText = 'hello') {
  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn,
      step,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: fingerprintText }],
        source: {
          kind: 'model',
          provider: 'provider-a',
          model: 'claimed-a',
          replayState: {
            response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'provider-a', model: 'claimed-a', responseId: 'abc123', stopReason: 'stop' },
            blocks: [{ type: 'text' }],
          },
        },
        id: 'message-' + seq,
      },
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0 },
      stream: [
        { type: 'chunk', time: time - 50, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: time - 40, index: 0, dt: [0, 10], texts: ['he', 'llo'] },
        { type: 'chunk', time, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: fingerprintText } } },
        { type: 'chunk', time: time + 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0 } } },
        { type: 'chunk', time: time + 2, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    },
  })
}
const log = [sessionLine(), contextLine(), stepLine(3, 1200), assistantLine(4, 1300)].join('\n') + '\n'

test('only the highest session log version is discovered', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-canonical-'))
  const sessionDir = path.join(dir, 'workspace', 'one')
  await fs.mkdir(sessionDir, { recursive: true })
  for (const name of ['session.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v4.jsonl.zstd']) {
    await fs.writeFile(path.join(sessionDir, name), zstdCompressSync(Buffer.from(log)))
  }
  const files = await discoverSessionFiles([dir])
  assert.equal(files.length, 1)
  assert.equal(path.basename(files[0].path), 'session.v4.jsonl.zstd')
  assert.equal(files[0].version, 4)
  assert.equal(files[0].candidates.length, 4)
  const grouped = canonicalSessionFiles(files[0].candidates)
  assert.equal(grouped.length, 1)
  assert.equal(path.basename(grouped[0].path), 'session.v4.jsonl.zstd')
})

test('a corrupt highest version falls back to the next canonical version', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-fallback-'))
  const sessionDir = path.join(dir, 'workspace', 'fallback')
  await fs.mkdir(sessionDir, { recursive: true })
  await fs.writeFile(path.join(sessionDir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(log)))
  await fs.writeFile(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd frame'))
  const scanner = new SessionScanner({ roots: [dir] })
  await scanner.discover()
  await scanner.waitIdle()
  assert.equal(scanner.observations.size, 1)
  assert.equal(scanner.sessionFiles.size, 1, 'one canonical session, not one per version')
  const cached = [...scanner.files.values()][0]
  assert.equal(cached.fallback, true)
  assert.equal(cached.version, 3)
  assert.equal(scanner.observations.size, 1, 'fallback is not merged with the corrupt primary')
  scanner.stop()
})

test('semantic duplicates are dropped even when seq/id differ', () => {
  const scanner = new SessionScanner({ roots: [] })
  const first = {
    id: 's:1',
    sessionId: 's',
    seq: 1,
    time: 100,
    turn: 1,
    step: 1,
    model: 'm',
    fingerprint: 'fp_a',
    protocol: { api: 'x', adapter: 'y' },
  }
  scanner.addObservation(first)
  const duplicate = { ...first, id: 's:99', seq: 99 }
  assert.equal(semanticKeyOf(first), semanticKeyOf(duplicate))
  assert.equal(scanner.addObservation(duplicate), false)
  assert.equal(scanner.observations.size, 1)
  assert.equal(scanner.turnIndex.s['1'].steps, 1)
  scanner.stop()
})

test('replacement and removal rebuild the affected turn index', () => {
  const scanner = new SessionScanner({ roots: [] })
  const first = { id: 's:1', sessionId: 's', seq: 1, time: 100, turn: 1, step: 1, model: 'm', fingerprint: 'fp_a', protocol: { api: 'x' } }
  const second = { id: 's:2', sessionId: 's', seq: 2, time: 101, turn: 1, step: 2, model: 'm', fingerprint: 'fp_b', protocol: { api: 'x' } }
  scanner.addObservation(first)
  scanner.addObservation(second)
  assert.equal(scanner.turnIndex.s['1'].steps, 2)
  scanner.addObservation({ ...first, time: 102, fingerprint: 'fp_c' })
  assert.equal(scanner.turnIndex.s['1'].steps, 2, 'replacement removes the old contribution')
  assert.equal(scanner.turnIndex.s['1'].primaryFingerprint, 'fp_c')
  scanner.removeObservation('s:2')
  assert.equal(scanner.turnIndex.s['1'].steps, 1)
  scanner.removeObservation('s:1')
  assert.equal(scanner.turnIndex.s, undefined)
  scanner.stop()
})

test('turns are numeric newest-first and pagination never duplicates', () => {
  const rows = [1, 2, 3, 4, 5].map((turn) => ({
    id: 's:turn:' + turn,
    sessionId: 's',
    turn,
    step: 1,
    seq: 100 - turn,
    time: 1000 - turn,
    provider: 'p',
    model: 'm',
    fingerprint: 'fp_a',
    protocol: { adapter: 'a', api: 'x' },
    behavior: {},
    tokens: {},
  }))
  const turns = buildTurns(rows, 's')
  assert.deepEqual(turns.map((turn) => turn.turn), [5, 4, 3, 2, 1])
  const view = buildSessionView({ sessionId: 's', turns: turns.slice(0, 2), revision: 1, generation: '7', hasMore: true, nextBefore: 4 })
  assert.equal(view.generation, '7')
  assert.equal(view.nextBefore, 4)
  assert.throws(() => buildSessionView({ sessionId: 's', turns: [turns[0], turns[0]] }), /duplicate/)
  const index = { s: Object.fromEntries(turns.map((turn) => [String(turn.turn), { turn: turn.turn, steps: 1 }])) }
  const first = listSessionTurns(index, 's', { limit: 2 })
  const next = listSessionTurns(index, 's', { before: first.nextBefore, limit: 10 })
  const ids = [...first.turns, ...next.turns].map((row) => row.turn)
  assert.deepEqual(ids, [5, 4, 3, 2, 1])
  assert.equal(new Set(ids).size, ids.length)
})

test('old state is backed up before semantic migration', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-migrate-'))
  const root = path.join(home, 'model-fingerprint')
  await fs.mkdir(root, { recursive: true })
  const oldState = { version: 1, createdAt: 1, observations: { 's:1': { id: 's:1', sessionId: 's', time: 1, turn: 1 } }, turnIndex: { s: { '1': { turn: 1, steps: 1 } } } }
  await fs.writeFile(path.join(root, 'state.json.zst'), zstdCompressSync(Buffer.from(JSON.stringify(oldState))))
  const store = new FingerprintStore({ home })
  await store.load()
  assert.equal(store.needsMigration, true)
  assert.ok(store.state.observations['s:1'], 'old data remains until migration succeeds')
  const backup = await store.backupMigration()
  assert.ok(backup)
  const backupState = JSON.parse(zstdDecompressSync(await fs.readFile(backup)).toString('utf8'))
  assert.equal(backupState.version, 1)
  store.markMigrated()
  assert.equal(store.state.dataVersion, DATA_VERSION)
})
