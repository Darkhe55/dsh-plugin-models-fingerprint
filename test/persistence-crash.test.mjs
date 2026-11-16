import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { FingerprintStore } from '../lib/store.mjs'
import { SessionScanner } from '../lib/scan.mjs'

test('a killed writer leaves a readable store and a subsequent append recovers', { timeout: 30000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-crash-'))
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'crash-writer.mjs')
  const child = spawn(process.execPath, [fixture, home, '12000'], { stdio: 'ignore' })
  const closed = new Promise((resolve) => child.once('close', resolve))
  await new Promise((resolve) => setTimeout(resolve, 40))
  child.kill('SIGKILL')
  await closed

  const recovered = new FingerprintStore({ home })
  await recovered.load()
  const before = Object.keys(recovered.state.observations).length
  assert.ok(before <= 12000)
  const scanner = new SessionScanner({ roots: [] })
  scanner.addObservation({ id: 'after-crash:1', sessionId: 'after-crash', seq: 1, time: Date.now(), fingerprint: 'fp_aaaaaaaaaaaa' })
  await recovered.save(scanner, 'post-crash')
  const final = new FingerprintStore({ home })
  await final.load()
  assert.equal(final.state.observations['after-crash:1'].sessionId, 'after-crash')
  await fs.rm(home, { recursive: true, force: true }).catch(() => {})
})
