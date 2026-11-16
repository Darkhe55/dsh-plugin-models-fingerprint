import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { FingerprintStore } from '../lib/store.mjs'

test('init migrates a mixed-version state from canonical logs and keeps a backup', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-migration-'))
  const root = path.join(home, 'model-fingerprint')
  const sessionDir = path.join(home, 'sessions', 'workspace', 'session-old')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(sessionDir, { recursive: true })
  const old = {
    version: 1,
    createdAt: 1,
    labels: { fp_aaaaaaaaaaaa: { label: 'keep-me', note: null, updatedAt: 1 } },
    observations: {
      's:1': { id: 's:1', sessionId: 's', seq: 1, time: 1, turn: 1, step: 1, model: 'm', fingerprint: 'fp_a', protocol: { api: 'x' } },
      's:1-old': { id: 's:1-old', sessionId: 's', seq: 1, time: 1, turn: 1, step: 1, model: 'm', fingerprint: 'fp_a', protocol: { api: 'x' } },
    },
    turnIndex: { s: { '1': { turn: 1, steps: 2 } } },
    officialEvidenceVersion: 1,
    officialModels: [{ key: 'p/m', provider: 'p', model: 'm', label: 'legacy', evidenceLevel: 'unknown', evidenceSource: '', confirmedAt: null, minSamples: 3 }],
    officialBaselines: { 'p/m': { key: 'p/m', provider: 'p', model: 'm', version: 1, samples: 999, ready: true, dataVersion: 1, profile: { features: {}, usable: 0 } } },
    similarityCalibration: { 'p/m': { version: 1, officialKey: 'p/m', calibrated: true, dataVersion: 1, positives: 999 } },
  }
  await fs.writeFile(path.join(root, 'state.json.zst'), zstdCompressSync(Buffer.from(JSON.stringify(old))))
  const line = (value) => JSON.stringify(value) + '\n'
  const response = {
    type: 'assistant/message',
    seq: 4,
    time: 1300,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'model', provider: 'p', model: 'm', replayState: { response: { kind: 'pi-ai', version: 2, api: 'x', provider: 'p', model: 'm', responseId: 'abc123' }, blocks: [{ type: 'text' }] } },
        id: 'message-4',
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      stream: [{ type: 'chunk', time: 1300, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
    },
  }
  const body = [
    line({ type: 'session', version: 4, id: 's', createdAt: 1, cwd: 'C:/work' }),
    line({ type: 'step/start', seq: 3, time: 1200, data: { turn: 1, step: 1 } }),
    line(response),
  ].join('')
  await fs.writeFile(path.join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body)))

  process.env.DSH_HOME = home
  process.env.DSH_SESSIONS_DIR = path.join(home, 'sessions')
  const { apply } = await import('../index.js')
  const routes = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    llm: {},
    on() { return () => {} },
    effect() {},
    tools: { register() { return () => {} } },
    webServer: {
      register(route) { routes.set(route.path, route.handler); return () => {} },
      tapIndex() { return () => {} },
      getOrigin() { return 'http://127.0.0.1:5538' },
    },
  }
  apply(ctx)
  const request = (pathName) => new Promise((resolve, reject) => {
    const full = '/model-fingerprint/' + pathName.replace(/^\//, '')
    const timer = setTimeout(() => reject(new Error(pathName + ' timed out')), 5000)
    const res = {
      headersSent: false,
      writeHead() { this.headersSent = true },
      end(value) { clearTimeout(timer); resolve(JSON.parse(String(value))) },
    }
    Promise.resolve(routes.get(full.split('?')[0])({
      method: 'GET',
      url: full,
      headers: { host: '127.0.0.1:5538' },
    }, res)).catch(reject)
  })
  let status = null
  for (let attempt = 0; attempt < 80; attempt += 1) {
    status = await request('api/status')
    if (status && status.stats && status.stats.observations === 1) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(status.stats.observations, 1)
  const view = await request('api/session-view?id=s')
  assert.equal(view.turns.length, 1)
  assert.equal(view.turns[0].steps, 1, 'migration repaired the duplicated turn index')
  let official = null
  for (let attempt = 0; attempt < 80; attempt += 1) {
    official = await request('api/official-models')
    const baseline = official.baselines.find((item) => item.key === 'p/m')
    if (baseline && baseline.samples !== 999) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const migratedBaseline = official.baselines.find((item) => item.key === 'p/m')
  assert.equal(migratedBaseline.samples !== 999, true, 'old baseline was replaced')
  assert.equal(migratedBaseline.dataVersion, 2)
  assert.equal(typeof migratedBaseline.sourceDigest, 'string')
  assert.equal(migratedBaseline.stale, false)
  const backups = (await fs.readdir(root)).filter((name) => name.startsWith('state.json.zst.pre-semantic-v'))
  assert.equal(backups.length, 1)
  const reloaded = new FingerprintStore({ home })
  await reloaded.load()
  assert.equal(Object.keys(reloaded.state.observations).length, 1, 'journal reset prevents legacy duplicates from returning')
  assert.equal(reloaded.state.observations['s:1-old'], undefined)
})
