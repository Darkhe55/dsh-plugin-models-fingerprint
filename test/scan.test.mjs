import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { scanSessionFile, SessionScanner } from '../lib/scan.mjs'

function sessionLine() {
  return JSON.stringify({ type: 'session', version: 4, id: 'session-test-1', createdAt: 1000, cwd: 'C:/work' })
}
function contextLine() {
  return JSON.stringify({ type: 'request/context', seq: 2, time: 1100, data: { provider: 'provider-a', model: 'claimed-a', contextWindow: 100000 } })
}
function stepLine(seq, time, step) {
  return JSON.stringify({ type: 'step/start', seq, time, data: { turn: 1, step } })
}
function assistantLine(seq, time, step, text = 'hello') {
  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
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
        { type: 'chunk', time, chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } },
        { type: 'chunk', time: time + 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0 } } },
        { type: 'chunk', time: time + 2, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    },
  })
}

test('scanSessionFile resumes from appended zstd frames', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-scan-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const first = [sessionLine(), contextLine(), stepLine(3, 1200, 1), assistantLine(4, 1300, 1)].join('\n') + '\n'
  await fs.writeFile(file, zstdCompressSync(Buffer.from(first)))
  const observations = []
  const cache = await scanSessionFile(file, undefined, (observation) => observations.push(observation))
  assert.equal(observations.length, 1)
  assert.equal(cache.frames, 1)
  assert.equal(cache.offset, (await fs.stat(file)).size)
  assert.equal(observations[0].provider, 'provider-a')
  assert.equal(observations[0].behavior.ttftMs, 60)

  const second = [stepLine(5, 2000, 2), assistantLine(6, 2100, 2, 'again')].join('\n') + '\n'
  await fs.appendFile(file, zstdCompressSync(Buffer.from(second)))
  const next = []
  const cache2 = await scanSessionFile(file, cache, (observation) => next.push(observation))
  assert.equal(next.length, 1, 'only the appended frame is parsed')
  assert.equal(next[0].seq, 6)
  assert.equal(cache2.frames, 1)
  assert.equal(cache2.offset, (await fs.stat(file)).size)
})

test('SessionScanner deduplicates live and historical observations', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-scanner-'))
  const sessionDir = path.join(dir, 'workspace', 'session-1')
  await fs.mkdir(sessionDir, { recursive: true })
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd')
  const body = [sessionLine(), contextLine(), stepLine(3, 1200, 1), assistantLine(4, 1300, 1)].join('\n') + '\n'
  await fs.writeFile(file, zstdCompressSync(Buffer.from(body)))
  const scanner = new SessionScanner({ roots: [dir] })
  await scanner.discover()
  await scanner.waitIdle()
  assert.equal(scanner.observations.size, 1)
  const observation = [...scanner.observations.values()][0]
  scanner.liveEvent('session-test-1', JSON.parse(assistantLine(4, 1300, 1)))
  assert.equal(scanner.observations.size, 1, 'same session/seq is deduplicated')
  scanner.addObservation({ ...observation, id: 'session-test-1:99', seq: 99, time: 9999 })
  assert.equal(scanner.observations.size, 2)
  const serialized = scanner.serialize()
  assert.equal(serialized.turnIndex['session-test-1']['1'].steps, 2, 'turn index aggregates without dropping old turns')
  scanner.stop()
})

test('retention is opt-in and the turn index follows removed observations', () => {
  const scanner = new SessionScanner({ roots: [], perSessionLimit: 1, totalLimit: 0 })
  const observation = {
    id: 's:1',
    sessionId: 's',
    turn: 1,
    seq: 1,
    time: 10,
    fingerprint: 'fp_a',
    model: 'm',
  }
  scanner.addObservation(observation)
  scanner.addObservation({ ...observation, id: 's:2', turn: 2, seq: 2, time: 20 })
  assert.equal(scanner.observations.size, 1, 'explicit per-session cap still trims observations')
  assert.equal(scanner.turnIndex.s['1'], undefined, 'removed observations cannot leave a stale index turn')
  assert.ok(scanner.turnIndex.s['2'])
  assert.deepEqual(scanner.serialize().turnIndex, scanner.turnIndex, 'persisted index is rebuilt from observations')
  scanner.stop()
})

test('discovery drops deleted file cursors and rescans a recreated path from zero', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-delete-'))
  const sessionDir = path.join(dir, 'workspace', 'session-del')
  await fs.mkdir(sessionDir, { recursive: true })
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd')
  const body = [sessionLine(), contextLine(), stepLine(3, 1200, 1), assistantLine(4, 1300, 1)].join('\n') + '\n'
  await fs.writeFile(file, zstdCompressSync(Buffer.from(body)))
  const scanner = new SessionScanner({ roots: [dir] })
  await scanner.discover()
  await scanner.waitIdle()
  assert.equal(scanner.files.size, 1)
  assert.equal(scanner.sessionFiles.size, 1)
  await fs.unlink(file)
  await scanner.discover()
  assert.equal(scanner.files.size, 0)
  assert.equal(scanner.sessionFiles.size, 0)
  assert.equal(scanner.status().removedFiles, 1)
  assert.equal(scanner.observations.size, 1, 'history is retained after the source file is removed')
  await fs.writeFile(file, zstdCompressSync(Buffer.from(body)))
  await scanner.discover()
  await scanner.waitIdle()
  assert.equal(scanner.files.size, 1, 'recreated path gets a fresh cursor')
  assert.equal(scanner.observations.size, 1)
  scanner.stop()
})

test('backfill reparses a log and restores observations missing from in-memory state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-backfill-'))
  const sessionDir = path.join(dir, 'workspace', 'session-backfill')
  await fs.mkdir(sessionDir, { recursive: true })
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd')
  const body = [sessionLine(), contextLine(), stepLine(3, 1200, 1), assistantLine(4, 1300, 1)].join('\n') + '\n'
  await fs.writeFile(file, zstdCompressSync(Buffer.from(body)))
  const scanner = new SessionScanner({ roots: [dir] })
  await scanner.discover()
  await scanner.waitIdle()
  const observation = [...scanner.observations.values()][0]
  scanner.observations.delete(observation.id)
  scanner.unindexObservation(observation)
  assert.equal(scanner.observations.size, 0)
  const summary = await scanner.backfillMissing({ force: true })
  assert.equal(summary.added, 1)
  assert.equal(scanner.observations.size, 1)
  assert.equal(scanner.status().backfill.added, 1)
  scanner.stop()
})

test('incremental persistence acknowledgement never drops a newer replacement', () => {
  const scanner = new SessionScanner({ roots: [] })
  const first = { id: 's:1', sessionId: 's', seq: 1, time: 1, turn: 1, step: 1, fingerprint: 'fp_a', protocol: {} }
  scanner.addObservation(first)
  const checkedOut = scanner.checkoutChanges()
  scanner.addObservation({ ...first, time: 2, fingerprint: 'fp_b' })
  scanner.ackChanges(checkedOut.token)
  assert.equal(scanner.hasPendingChanges(), true)
  const next = scanner.checkoutChanges()
  assert.equal(next.observations.length, 1)
  assert.equal(next.observations[0].fingerprint, 'fp_b')
  scanner.ackChanges(next.token)
  scanner.removeObservation('s:1')
  const removed = scanner.checkoutChanges()
  assert.deepEqual(removed.deleted, ['s:1'])
  scanner.stop()
})

test('pending journal changes expose backpressure and clear after acknowledgement', () => {
  const scanner = new SessionScanner({ roots: [] })
  for (let index = 0; index < 20001; index += 1) {
    scanner.addObservation({ id: 'bp:' + index, sessionId: 'bp', seq: index, time: index + 1, fingerprint: 'fp_a' })
  }
  assert.equal(scanner.backpressure, true)
  const delta = scanner.checkoutChanges()
  scanner.ackChanges(delta.token)
  assert.equal(scanner.backpressure, false)
  assert.equal(scanner.hasPendingChanges(), false)
  scanner.stop()
})

test('session window materializes only the requested newest rows', () => {
  const scanner = new SessionScanner({ roots: [] })
  for (let index = 0; index < 1000; index += 1) {
    scanner.addObservation({ id: 'window:' + index, sessionId: 'window', seq: index, time: index + 1, fingerprint: 'fp_a' })
  }
  const rows = scanner.sessionWindow('window', { limit: 25 })
  assert.equal(rows.length, 25)
  assert.equal(rows[0].seq, 999)
  assert.equal(rows[24].seq, 975)
  const older = scanner.sessionWindow('window', { limit: 10, before: 900 })
  assert.equal(older.length, 10)
  assert.equal(older[0].seq, 898)
  scanner.stop()
})

test('normal startup does not launch an unconditional full-history backfill', async () => {
  const scanner = new SessionScanner({ roots: [] })
  scanner.backfillMissing = async () => { throw new Error('automatic backfill is forbidden') }
  scanner.start()
  await scanner.ready
  assert.equal(scanner.lastError, null)
  scanner.stop()
})
