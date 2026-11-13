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
  scanner.stop()
})
