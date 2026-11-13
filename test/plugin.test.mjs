import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'

test('plugin registers routes/tool and serves a report end to end', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-plugin-'))
  const sessionDir = path.join(home, 'sessions', 'workspace', 'session-live')
  await fs.mkdir(sessionDir, { recursive: true })
  const assistant = {
    type: 'assistant/message',
    seq: 4,
    time: 1300,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        source: {
          kind: 'model',
          provider: 'provider-a',
          model: 'claimed-a',
          replayState: {
            response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'provider-a', model: 'claimed-a', responseId: 'abc123', stopReason: 'stop' },
            blocks: [{ type: 'text' }],
          },
        },
        id: 'message-4',
      },
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0 },
      stream: [
        { type: 'chunk', time: 1250, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: 1260, index: 0, dt: [0, 10], texts: ['he', 'llo'] },
        { type: 'chunk', time: 1300, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } } },
        { type: 'chunk', time: 1301, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0 } } },
        { type: 'chunk', time: 1302, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    },
  }
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: 'session-live', createdAt: 1000, cwd: 'C:/work' }),
    JSON.stringify({ type: 'request/context', seq: 2, time: 1100, data: { provider: 'provider-a', model: 'claimed-a', contextWindow: 100000 } }),
    JSON.stringify({ type: 'step/start', seq: 3, time: 1200, data: { turn: 1, step: 1 } }),
    JSON.stringify(assistant),
  ].join('\n') + '\n'
  await fs.writeFile(path.join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)))

  process.env.DSH_HOME = home
  process.env.DSH_SESSIONS_DIR = path.join(home, 'sessions')
  const { apply } = await import('../index.js')

  const routes = new Map()
  const effects = []
  const listeners = new Map()
  let registeredTool = null
  let indexTap = null
  const ctx = {
    logger: { info() {}, warn() {} },
    llm: {
      async *stream(options) {
        const inputTokens = 10 + options.messages[0].content[0].text.length
        yield { type: 'usage', usage: { inputTokens, outputTokens: 2, totalTokens: inputTokens + 2 } }
        yield { type: 'text-delta', index: 0, text: 'OK' }
        yield {
          type: 'finish',
          reason: { kind: 'stop' },
          replayState: {
            response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: options.provider, model: options.model, responseId: 'abc123', stopReason: 'stop' },
            blocks: [{ type: 'text' }],
          },
        }
      },
    },
    on(name, listener) { listeners.set(name, listener); return () => {} },
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') effects.push(dispose) },
    tools: { register(tool) { registeredTool = tool; return () => {} } },
    webServer: {
      register(route) { routes.set(route.path, route.handler); return () => {} },
      tapIndex(fn) { indexTap = fn; return () => {} },
      getOrigin() { return 'http://127.0.0.1:7373' },
    },
  }
  apply(ctx)
  assert.ok(registeredTool, 'tool is registered')
  assert.equal(registeredTool.name, 'model_fingerprint')
  assert.ok(routes.has('/model-fingerprint'))
  assert.ok(routes.has('/model-fingerprint/api/status'))
  assert.ok(routes.has('/model-fingerprint/api/session-view'))
  const injectedIndex = indexTap('<html><body></body></html>')
  assert.match(injectedIndex, /__dshModelFingerprintApiBase="http:\/\/127\.0\.0\.1:7373"/)
  assert.match(injectedIndex, /src="http:\/\/127\.0\.0\.1:7373\/model-fingerprint\/widget\.js"/)

  const toolResult = await registeredTool.execute({ action: 'status' }, {})
  assert.match(toolResult.text, /模型指纹监控/)
  // The scanner discovers history asynchronously; wait for the sample session.
  let latestText = toolResult.text
  for (let attempt = 0; attempt < 60 && !/provider-a\/claimed-a/.test(latestText); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    latestText = (await registeredTool.execute({ action: 'status' }, {})).text
  }
  assert.match(latestText, /provider-a\/claimed-a/)

  let jsonBody = null
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('status route timed out')), 5000)
    const res = {
      headersSent: false,
      writeHead() { this.headersSent = true },
      end(body) { clearTimeout(timer); jsonBody = JSON.parse(String(body)); resolve() },
    }
    Promise.resolve(routes.get('/model-fingerprint/api/status')({
      method: 'GET',
      url: '/model-fingerprint/api/status?limit=20',
      headers: { host: '127.0.0.1:5538' },
    }, res)).catch(reject)
  })
  assert.equal(jsonBody.stats.observations, 1)
  assert.equal(jsonBody.latest.observation.model, 'claimed-a')

  let sessionViewBody = null
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('session-view route timed out')), 5000)
    const res = {
      headersSent: false,
      writeHead() { this.headersSent = true },
      end(body) { clearTimeout(timer); sessionViewBody = JSON.parse(String(body)); resolve() },
    }
    Promise.resolve(routes.get('/model-fingerprint/api/session-view')({
      method: 'GET',
      url: '/model-fingerprint/api/session-view?id=session-live&limit=20',
      headers: { host: '127.0.0.1:5538' },
    }, res)).catch(reject)
  })
  assert.equal(sessionViewBody.version, 1)
  assert.equal(sessionViewBody.sessionId, 'session-live')
  assert.equal(sessionViewBody.status, 'ready')
  assert.equal(sessionViewBody.turns.length, 1)
  assert.equal(sessionViewBody.turns[0].status, 'observed')
  assert.equal(sessionViewBody.turns[0].anchors[0].value, '1')
  assert.ok(sessionViewBody.revision > 0)

  const fingerprintId = jsonBody.latest.fingerprint.id
  const labelResult = await registeredTool.execute({ action: 'label', fingerprintId, label: 'actual-model', note: 'test' }, {})
  assert.match(labelResult.text, /actual-model/)
  const labeled = await registeredTool.execute({ action: 'status' }, {})
  assert.match(labeled.text, /actual-model/)

  const probeResult = await registeredTool.execute({
    action: 'probe',
    provider: 'provider-a',
    model: 'claimed-a',
    repeats: 1,
    confirm: true,
  }, {})
  assert.match(probeResult.text, /固定探针完成/)
  const equivalence = await registeredTool.execute({ action: 'equivalence' }, {})
  assert.match(equivalence.text, /探针观测 6/)

  for (const dispose of effects) dispose()
})
