/**
 * DSH model-fingerprint monitor.
 *
 * Reads historical session logs, follows live `session/event` traffic, and
 * exposes a local dashboard + a `model_fingerprint` tool. The fingerprint is
 * protocol/behavior evidence, not a trusted copy of the model name.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReport, buildTurns, fingerprintLabel, protocolLabel, shortId } from './lib/summary.mjs'
import { buildSessionView, buildTurnWindow } from './lib/session-view.mjs'
import { listSessionTurns, normalizeTurnIndex, turnIndexFromObservations } from './lib/turn-index.mjs'
import { analyzeDegradation, buildOfficialProfile, normalizeOfficialModels, scoreSimilarity, SIMILARITY_VERSION } from './lib/similarity.mjs'
import { buildEquivalence } from './lib/equivalence.mjs'
import { runProbeSuite } from './lib/probe.mjs'
import { SessionScanner, defaultSessionRoots, discoverProfileRoots } from './lib/scan.mjs'
import { DATA_VERSION, FingerprintStore } from './lib/store.mjs'
import { artifactContext, ensureOfficialArtifacts } from './lib/lifecycle.mjs'
import { EVIDENCE_LEVELS, normalizeConfirmedAt } from './lib/official.mjs'
import { assessModelIdentity, compareProtocol } from './lib/identity.mjs'
import { qualityForRows } from './lib/quality.mjs'

export const inject = ['webServer', 'tools', 'sessions', 'llm']

const here = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(here, 'public')
const ROUTE = '/model-fingerprint'
const TOKEN = randomBytes(16).toString('hex')
export function currentToken() {
  // Stable for the plugin process lifetime. Rotation without a client refresh
  // handshake made open pages fail after 30 minutes with 403.
  return TOKEN
}
const DSH_HOME = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')

const json = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

const text = (res, status, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

const APP_ORIGIN = 'dsh-app://app'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
let allowedOrigins = new Set([APP_ORIGIN])
let allowedHosts = new Set()
let allowedPort = null

function normalizeOrigin(value) {
  const text = String(value || '').trim().replace(/\/+$/, '')
  if (!text) return ''
  if (text === APP_ORIGIN) return APP_ORIGIN
  try {
    const parsed = new URL(text)
    return parsed.origin
  } catch {
    return ''
  }
}

function hostParts(value) {
  const text = String(value || '').trim()
  const match = text.match(/^(\[[0-9a-fA-F:]+\]|[^:]+)(?::(\d+))?$/)
  if (!match) return null
  const hostname = match[1].toLowerCase()
  const port = match[2] ? Number(match[2]) : null
  return { hostname, port }
}

function configureSecurity(webServer) {
  let origin = ''
  try {
    if (webServer && typeof webServer.getOrigin === 'function') origin = normalizeOrigin(webServer.getOrigin())
  } catch { /* unavailable */ }
  if (!origin) origin = normalizeOrigin(process.env.DSH_WEB_ORIGIN)
  if (!origin) return
  let parsed
  try { parsed = new URL(origin) } catch { return }
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
  allowedPort = Number(port)
  allowedOrigins = new Set([APP_ORIGIN, origin])
  for (const host of LOOPBACK_HOSTS) {
    if (host === '::1') continue
    allowedOrigins.add(parsed.protocol + '//' + host + (port === '80' || port === '443' ? '' : ':' + port))
    allowedHosts.add(host + ':' + port)
  }
  allowedHosts.add('[::1]:' + port)
}

function hostAllowed(req) {
  const parts = hostParts(req && req.headers && req.headers.host)
  if (!parts || !LOOPBACK_HOSTS.has(parts.hostname)) return false
  if (!allowedPort) return true
  return allowedHosts.has(parts.hostname + ':' + parts.port)
}

function originAllowed(req) {
  if (!hostAllowed(req)) return false
  const origin = req.headers && (req.headers.origin || req.headers.Origin)
  if (!origin) return true
  if (String(origin).toLowerCase() === 'null') return false
  const normalized = normalizeOrigin(origin)
  return Boolean(normalized && allowedOrigins.has(normalized))
}

function tokenAllowed(req) {
  const expected = currentToken()
  const given = String((req.headers && (req.headers['x-mf-token'] || req.headers['X-MF-Token'])) || '')
  if (!given || given.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  } catch {
    return false
  }
}

function mutationAllowed(req, res) {
  if (!originAllowed(req)) {
    json(res, 403, { error: 'origin not allowed' })
    return false
  }
  if (!tokenAllowed(req)) {
    json(res, 403, { error: 'bad token' })
    return false
  }
  return true
}

function corsHeaders(req) {
  const origin = req.headers && (req.headers.origin || req.headers.Origin)
  if (!origin || !originAllowed(req)) return null
  return {
    'access-control-allow-origin': normalizeOrigin(origin) === APP_ORIGIN ? APP_ORIGIN : normalizeOrigin(origin),    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-mf-token',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}

async function readJson(req, limit = 32 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('request body too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function scanLine(report) {
  const scan = report.scan || {}
  if (scan.scanning) return `扫描中 ${scan.cachedFiles || 0}/${scan.discovered || 0}，待处理 ${scan.queue || 0}`
  if (scan.lastError) return `扫描错误：${scan.lastError}`
  return `已载入 ${scan.cachedFiles || 0}/${scan.discovered || 0} 个会话`
}

function formatObservation(observation, assessment) {
  if (!observation) return '暂无观测。'
  const detail = observation.protocolDetail || {}
  const behavior = observation.behavior || {}
  const bits = []
  if (behavior.tokensPerChar != null) bits.push(`tok/字 ${behavior.tokensPerChar}`)
  if (behavior.charsPerChunk != null) bits.push(`${behavior.charsPerChunk} 字/块`)
  if (behavior.reasoningRatio != null && behavior.reasoningRatio > 0.01) bits.push(`推理 ${Math.round(behavior.reasoningRatio * 100)}%`)
  if (behavior.ttftMs != null) bits.push(`首 token ${Math.round(behavior.ttftMs)}ms`)
  return [
    `${observation.provider}/${observation.model} · ${fingerprintLabel(observation.fingerprint)}`,
    `会话 ${observation.sessionId} · 事件 #${observation.seq} · ${new Date(observation.time).toISOString()}`,
    `协议 ${detail.api || '-'} · ${detail.adapter || '-'} · id ${detail.responseIdShape || 'none'} · 工具 ${(detail.toolIdShapes || []).join('+') || 'none'}`,
    `行为 ${bits.join(' · ') || '—'}`,
    `判定 ${assessment ? assessment.verdictLabel + ' (' + Math.round(assessment.confidence * 100) + '%)' : '—'}${assessment && assessment.reasons && assessment.reasons.length ? ' · ' + assessment.reasons.join('；') : ''}`,
  ].join('\n')
}

function statusText(report) {
  const latest = report.latest
  const lines = [
    `模型指纹监控：${report.stats.sessions} 个历史会话 / ${report.stats.observations} 条响应观测 / ${report.stats.fingerprints} 个协议指纹`,
    scanLine(report),
  ]
  if (!latest) {
    lines.push('还没有可用的助手消息。历史扫描会在后台继续。')
    return lines.join('\n')
  }
  lines.push('')
  lines.push(formatObservation(latest.observation, latest.assessment))
  if (latest.fingerprint) {
    lines.push(`该指纹历史：${latest.fingerprint.observations} 条 · 声称名称 ${latest.fingerprint.names ? latest.fingerprint.names.map((item) => item.name + '×' + item.count).join('、') : '—'}`)
  }
  if (report.alerts.length) {
    lines.push('')
    lines.push('证据提示：')
    for (const alert of report.alerts.slice(0, 6)) lines.push(`- [${alert.severity}] ${alert.title} — ${alert.detail || ''}`)
  }
  lines.push('')
  lines.push('说明：指纹来自协议形状与行为统计，不是模型身份证明；人工标签可作为已确认的实际模型基线。')
  return lines.join('\n')
}

function fingerprintsText(report) {
  const lines = [`协议指纹（${report.fingerprints.length} 个，样本数降序）`]
  const rows = [...report.fingerprints].sort((a, b) => b.observations - a.observations).slice(0, 25)
  for (const fp of rows) {
    const names = (fp.names || []).map((item) => item.name + '×' + item.count).join('、')
    const label = fp.label ? ` [人工标签: ${fp.label}]` : ''
    lines.push(`- ${fingerprintLabel(fp.id)} · ${fp.observations} 条 · ${fp.sessions} 会话 · ${protocolLabel(fp.protocol)}${label}`)
    lines.push(`  声称: ${names || '—'} · 行为: ${fp.behavior && fp.behavior.tokensPerChar != null ? 'tok/字 ' + fp.behavior.tokensPerChar : '—'}`)
  }
  if (report.fingerprints.length > rows.length) lines.push(`- …其余 ${report.fingerprints.length - rows.length} 个省略`)
  return lines.join('\n')
}

function equivalenceText(report) {
  const lines = [
    `模型等价性（被动行为层）：${report.stats.routes} 条路由 / ${report.stats.pairs} 对比较 · 探针观测 ${report.stats.probes}`,
    `阈值：same≤${report.methods.sameThreshold} · different≥${report.methods.differentThreshold} · 自身基线 ${report.methods.selfMedian}`,
    '说明：距离为单位化行为差异；越低越像。被动历史只能作为候选证据，固定探针更强。',
  ]
  if (report.claims.length) {
    lines.push('', '同名跨供应商：')
    for (const claim of report.claims.slice(0, 8)) {
      lines.push(`- ${claim.model}：${claim.routes.map((route) => route.provider + '×' + route.observations).join(' / ')} · 同行为 ${claim.same} · 不同行为 ${claim.different}`)
    }
  }
  const meaningful = report.pairs.filter((pair) => pair.verdict !== 'inconclusive').slice(0, 12)
  if (meaningful.length) {
    lines.push('', '可比对：')
    for (const pair of meaningful) {
      lines.push(`- ${pair.a} ↔ ${pair.b}：${pair.verdict} · D=${pair.distance} · 相对=${pair.relative} · 覆盖=${pair.coverage} · 样本 ${pair.samplesA}/${pair.samplesB}`)
    }
  } else {
    lines.push('', '暂无可比对的跨路由行为样本。')
  }
  return lines.join('\n')
}

function probeText(result) {
  const lines = [
    `固定探针完成：${result.routeKey} · ${result.calls} 次调用（repeats=${result.repeats}）`,
    `tokenizer 增量：${result.tokenizerVector.map((item) => `${item.promptId}=${item.delta == null ? '—' : item.delta}`).join(' · ')}`,
    `行为中位数：tok/字 ${result.behavior.tokensPerChar == null ? '—' : result.behavior.tokensPerChar} · 字/块 ${result.behavior.charsPerChunk == null ? '—' : result.behavior.charsPerChunk} · JSON ${result.behavior.jsonSpacing == null ? '—' : result.behavior.jsonSpacing} · 推理 ${result.behavior.reasoningRatio == null ? '—' : result.behavior.reasoningRatio}`,
    '探针结果已缓存；再次查看等价性面板不会重复调用模型。',
  ]
  return lines.join('\n')
}

function sessionText(report, scanner, sessionId) {
  const target = sessionId || (report.latest && report.latest.observation && report.latest.observation.sessionId)
  if (!target) return '没有指定会话，也没有已解析的会话。'
  const session = (report.sessions || []).find((item) => item.id === target)
  const rows = scanner
    ? [...scanner.observations.values()].filter((observation) => observation.sessionId === target).sort((left, right) => right.time - left.time).slice(0, 12)
    : []
  if (!session && !rows.length) return `会话 ${target} 暂无指纹观测。`
  const lines = [`会话 ${target}`]
  if (session && session.cwd) lines.push(`工作目录：${session.cwd}`)
  if (session) lines.push(`观测：${session.observations} 条 · 最近 ${new Date(session.lastSeen).toISOString()}`)
  if (session) lines.push(`指纹：${session.fingerprints.map((id) => fingerprintLabel(id)).join('、')}`)
  if (session) {
    lines.push('声称模型：')
    for (const route of session.routes) lines.push(`- ${route.routeKey} ×${route.count}`)
  }
  if (rows.length) {
    lines.push('最近响应：')
    for (const observation of rows) {
      const detail = observation.protocolDetail || {}
      lines.push(`- #${observation.seq} · ${observation.provider}/${observation.model} · ${fingerprintLabel(observation.fingerprint)} · ${detail.api || '-'} / ${detail.adapter || '-'}`)
    }
  }
  return lines.join('\n')
}

export function apply(ctx) {
  configureSecurity(ctx.webServer)
  const disposers = []
  let disposed = false
  let scanner
  let store
  let initialized = false
  let initializing
  let saveTimer
  const reportCache = new Map()
  const turnCache = new Map()
  const turnsForSession = (sessionId) => {
    if (!scanner) return []
    const key = String(sessionId) + '|' + scanner.version
    const cached = turnCache.get(key)
    if (cached) return cached
    const turns = buildTurns(scanner.observationsForSession(sessionId), sessionId)
    turnCache.set(key, turns)
    if (turnCache.size > 16) turnCache.delete(turnCache.keys().next().value)
    return turns
  }

  const reportNow = (limit = 200) => {
    if (!scanner) return null
    const labels = store ? store.labels() : {}
    const key = scanner.version + '|' + JSON.stringify(labels) + '|' + limit
    if (reportCache.has(key)) {
      return { ...reportCache.get(key), generatedAt: Date.now() }
    }
    const report = buildReport(scanner, labels, { limit })
    reportCache.set(key, report)
    if (reportCache.size > 6) reportCache.delete(reportCache.keys().next().value)
    return report
  }

  const officialModelsNow = () => normalizeOfficialModels(store ? store.officialModels() : [])
  const allObservationsNow = () => (scanner ? [...scanner.observations.values()] : [])
  const artifactContextNow = () => artifactContext({
    dataVersion: DATA_VERSION,
    scannerGeneration: scanner ? scanner.generation : null,
    observationRevision: scanner ? scanner.version : 0,
    similarityVersion: SIMILARITY_VERSION,
  })
  const refreshOfficialArtifacts = (models = officialModelsNow(), options = {}) => {
    const observations = allObservationsNow()
    const context = artifactContextNow()
    const result = []
    for (const model of models) {
      const ensured = ensureOfficialArtifacts({
        model,
        observations,
        existingBaseline: store.officialBaseline(model.key),
        existingCalibration: store.calibrationFor(model.key),
        context,
        force: options.force === true,
      })
      if (ensured.baseline.rebuilt && !ensured.baseline.stale && ensured.baseline.artifact) {
        store.saveOfficialBaseline(ensured.baseline.artifact)
      } else if (ensured.baseline.stale) {
        store.markOfficialArtifactsStale(model.key, ensured.baseline.reasons, ensured.baseline.error, 'baseline')
      }
      if (ensured.calibration.rebuilt && !ensured.calibration.stale && ensured.calibration.artifact) {
        store.saveCalibration(model.key, ensured.calibration.artifact)
      } else if (ensured.calibration.stale) {
        store.markOfficialArtifactsStale(model.key, ensured.calibration.reasons, ensured.calibration.error, 'calibration')
      }
      result.push(ensured)
    }
    return result
  }

  const executeProbe = async ({ provider, model, repeats = 1 }) => {    await init()
    let targetProvider = provider
    let targetModel = model
    if (!targetProvider || !targetModel) {
      const report = reportNow(1)
      const latest = report && report.latest && report.latest.observation
      targetProvider = latest && latest.provider
      targetModel = latest && latest.model
    }
    if (!targetProvider || !targetModel) throw new Error('no provider/model to probe')
    const result = await runProbeSuite({
      llm: ctx.llm,
      provider: targetProvider,
      model: targetModel,
      repeats: Math.max(1, Math.min(3, Number(repeats) || 1)),
    })
    store.addProbes(result.results)
    await store.flush(scanner)
    return result
  }

  const init = async () => {
    if (disposed) return
    if (initialized) return
    if (initializing) return initializing
    initializing = (async () => {
      store = new FingerprintStore({ home: DSH_HOME, logger: ctx.logger })
      const state = await store.load()
      const migrating = store.needsMigration === true
      if (migrating) {
        const backup = await store.backupMigration()
        ctx.logger?.info?.(`model-fingerprint: migrating state from canonical logs${backup ? ' (backup: ' + backup + ')' : ''}`)
      }
      const roots = defaultSessionRoots(DSH_HOME)
      roots.push(...await discoverProfileRoots(DSH_HOME))
      scanner = new SessionScanner({
        roots: [...new Set(roots)],
        // A semantic migration must rebuild observations and the turn index
        // from canonical logs. Labels, probes and baselines are preserved.
        state: migrating ? { files: {}, observations: {}, turnIndex: {} } : { files: state.files, observations: state.observations, turnIndex: state.turnIndex },
        // During migration nothing is persisted until the canonical rebuild
        // passes its guard; a partial state must never replace the backup.
        onChange: migrating ? () => {} : () => store.scheduleSave(scanner),
        logger: ctx.logger,
      })
      scanner.onBackfill = migrating ? null : async () => {
        await store.flush(scanner)
      }
      scanner.start()
      if (migrating) {
        const previousObservations = Object.keys(state.observations || {}).length
        scanner.ready.then(async () => {
          if (scanner.lastError) {
            throw new Error('canonical scan failed: ' + scanner.lastError)
          }
          if (previousObservations > 0 && scanner.discovered === 0) {
            throw new Error('canonical session logs are unavailable; keeping the previous state and backup')
          }
          await store.flush(scanner)
          store.markMigrated()
          // Canonical rebuild invalidates every derived baseline/calibration.
          // Rebuild them now instead of serving pre-migration artifacts.
          refreshOfficialArtifacts()
          await store.flush(scanner)
          ctx.logger?.info?.(`model-fingerprint: migration complete, ${scanner.observations.size} observation(s), derived official artifacts refreshed`)
        }).catch((error) => ctx.logger?.warn?.(`model-fingerprint: migration failed: ${error && error.message ? error.message : String(error)}`))
      }
      if (disposed) {
        scanner.stop()
        scanner = undefined
        return
      }
      initialized = true
      ctx.logger?.info?.(`model-fingerprint: monitoring ${scanner.roots.length} session root(s), ${scanner.observations.size} historical observation(s)`)
    })().catch((error) => {
      initializing = undefined
      throw error
    })
    return initializing
  }

  // Start loading history without blocking DSH's own startup.
  void init().catch((error) => ctx.logger?.warn?.(`model-fingerprint: init failed: ${error && error.message ? error.message : String(error)}`))

  disposers.push(ctx.on('session/created', (session) => {
    if (!scanner) return
    scanner.liveCreated(session)
  }))
  disposers.push(ctx.on('session/event', (session, event) => {
    if (!scanner) return
    try {
      scanner.liveEvent(session.id, event)
    } catch (error) {
      ctx.logger?.warn?.(`model-fingerprint: live event failed: ${error && error.message ? error.message : String(error)}`)
    }
  }))
  disposers.push(ctx.on('session/disposed', (session) => {
    if (scanner) scanner.liveDisposed(session)
  }))

  const html = async (res) => {
    try {
      const source = await fs.readFile(path.join(PUBLIC, 'dashboard.html'), 'utf8')
      text(res, 200, source.replaceAll('__MF_TOKEN__', currentToken()), 'text/html; charset=utf-8')
    } catch (error) {
      text(res, 500, 'dashboard asset missing: ' + (error && error.message ? error.message : String(error)))
    }
  }

  const widget = async (res) => {
    try {
      const source = await fs.readFile(path.join(PUBLIC, 'widget.js'), 'utf8')
      text(res, 200, source, 'application/javascript; charset=utf-8')
    } catch (error) {
      text(res, 500, 'widget asset missing: ' + (error && error.message ? error.message : String(error)))
    }
  }

  const route = (pathName, handler) => {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: ROUTE + pathName,
      handler: (req, res) => {
        const cors = corsHeaders(req)
        if (cors) for (const [name, value] of Object.entries(cors)) res.setHeader(name, value)
        if (req.method === 'OPTIONS') {
          res.writeHead(cors ? 204 : 403, cors || {})
          res.end()
          return
        }
        if (!originAllowed(req)) {
          json(res, 403, { error: 'origin not allowed' })
          return
        }
        Promise.resolve(handler(req, res)).catch((error) => {
          if (!res.headersSent) json(res, error && error.statusCode ? error.statusCode : 500, { error: error && error.message ? error.message : String(error) })
        })
      },
    }))
  }

  route('', async (req, res) => {
    if (!originAllowed(req)) return text(res, 403, 'origin not allowed')
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'GET only')
    return html(res)
  })
  route('/widget.js', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'GET only')
    return widget(res)
  })
  let lastClientDebug = null
  let clientCommand = null
  route('/api/client-command', async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return json(res, 200, { command: clientCommand })
    if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST only' })
    if (!mutationAllowed(req, res)) return
    const body = await readJson(req)
    if (!body || typeof body.railOn !== 'boolean') return json(res, 400, { error: 'railOn boolean required' })
    clientCommand = { id: Date.now(), railOn: body.railOn }
    return json(res, 200, { ok: true, command: clientCommand })
  })
  route('/api/client-debug', async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return json(res, 200, { client: lastClientDebug })
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST only' })
    const body = await readJson(req)
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'invalid body' })
    lastClientDebug = {
      time: Date.now(),
      apiBase: typeof body.apiBase === 'string' ? body.apiBase : null,
      railOn: body.railOn === true,
      railSessionId: body.railSessionId || null,
      canvasOpen: body.canvasOpen === true,
      sessionViewRevision: Number(body.sessionViewRevision) || 0,
      sessionViewStatus: typeof body.sessionViewStatus === 'string' ? body.sessionViewStatus : null,
      latestTurn: body.latestTurn && typeof body.latestTurn === 'object' ? body.latestTurn : null,
      canvasProbe: Array.isArray(body.canvasProbe) ? body.canvasProbe.slice(0, 6) : [],
      widget: body.widget === true,
      nativeToggle: body.nativeToggle === true,
      lastFetchError: typeof body.lastFetchError === 'string' ? body.lastFetchError : null,
      commandError: typeof body.commandError === 'string' ? body.commandError : null,
      build: typeof body.build === 'string' ? body.build : null,
      debug: body.debug && typeof body.debug === 'object' ? body.debug : (body.rail && typeof body.rail === 'object' ? body.rail : null),
      href: typeof body.href === 'string' ? body.href : null,
      globals: Array.isArray(body.globals) ? body.globals.slice(0, 80).map(String) : [],
      globalInfo: body.globalInfo && typeof body.globalInfo === 'object' ? body.globalInfo : null,
    }
    return json(res, 200, { ok: true })
  })
  route('/api/status', async (req, res) => {
    if (!originAllowed(req)) return json(res, 403, { error: 'origin not allowed' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' })
    await init()
    const url = new URL(req.url || '/', 'http://local')
    const report = reportNow(Math.min(500, Number(url.searchParams.get('limit')) || 200))
    return json(res, 200, report)
  })
  route('/api/session-view', async (req, res) => {
    if (!originAllowed(req)) return json(res, 403, { error: 'origin not allowed' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' })
    await init()
    const url = new URL(req.url || '/', 'http://local')
    const report = reportNow(50)
    const sessionId = url.searchParams.get('id') || (report.latest && report.latest.observation && report.latest.observation.sessionId)
    if (!sessionId) return json(res, 404, { error: 'no session id' })
    const session = (report.sessions || []).find((item) => item.id === sessionId) || null
    const sessionRows = scanner.observationsForSession(sessionId)
    const rows = sessionRows
      .slice()
      .sort((left, right) => right.time - left.time)
      .slice(0, Math.min(300, Number(url.searchParams.get('limit')) || 300))
    const turns = turnsForSession(sessionId)
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200))
    const before = Number(url.searchParams.get('before'))
    const filtered = Number.isFinite(before) && before > 0
      ? turns.filter((turn) => Number(turn.turn) < before)
      : turns
    const windowTurns = filtered.slice(0, limit)
    const view = buildSessionView({
      sessionId,
      session,
      turns: windowTurns,
      revision: scanner.version,
      generation: scanner.generation,
      hasMore: filtered.length > windowTurns.length,
      nextBefore: windowTurns.length ? Number(windowTurns[windowTurns.length - 1].turn) : null,
      observations: rows,
    })
    return json(res, 200, view)
  })
  route('/api/turn-window', async (req, res) => {
    if (!originAllowed(req)) return json(res, 403, { error: 'origin not allowed' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' })
    await init()
    const url = new URL(req.url || '/', 'http://local')
    const sessionId = url.searchParams.get('id')
    const requested = String(url.searchParams.get('turns') || '')
      .split(',')
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
    if (!sessionId || !requested.length) return json(res, 400, { error: 'id and turns required' })
    const turns = turnsForSession(sessionId)
    const byNumber = new Map(turns.map((turn) => [Number(turn.turn), turn]))
    const window = buildTurnWindow({
      sessionId,
      turns: byNumber,
      index: normalizeTurnIndex(scanner.turnIndex),
      requested,
      revision: scanner.version,
      generation: scanner.generation,
      limit: 32,
    })
    return json(res, 200, window)
  })

  route('/api/session-index', async (req, res) => {
    if (!originAllowed(req)) return json(res, 403, { error: 'origin not allowed' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' })
    await init()
    const url = new URL(req.url || '/', 'http://local')
    const report = reportNow(50)
    const sessionId = url.searchParams.get('id') || (report.latest && report.latest.observation && report.latest.observation.sessionId)
    if (!sessionId) return json(res, 404, { error: 'no session id' })
    let index = normalizeTurnIndex(scanner.turnIndex)
    if (!index[sessionId] || !Object.keys(index[sessionId]).length) {
      index = turnIndexFromObservations(scanner.observationsForSession(sessionId))
    }
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200))
    const before = Number(url.searchParams.get('before'))
    const page = listSessionTurns(index, sessionId, {
      before: Number.isFinite(before) && before > 0 ? before : null,
      limit,
    })
    return json(res, 200, {
      sessionId,
      revision: scanner.version,
      generation: scanner.generation,
      turns: page.turns,
      hasMore: page.hasMore,
      nextBefore: page.nextBefore,
    })
  })

  route('/api/turn-view', async (req, res) => {
    if (!originAllowed(req)) return json(res, 403, { error: 'origin not allowed' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' })
    await init()
    const url = new URL(req.url || '/', 'http://local')
    const sessionId = url.searchParams.get('id')
    const turn = Number(url.searchParams.get('turn'))
    if (!sessionId || !Number.isFinite(turn)) return json(res, 400, { error: 'id and turn required' })
    const turns = turnsForSession(sessionId)
    const found = turns.find((item) => Number(item.turn) === turn) || null
    if (found) return json(res, 200, { sessionId, revision: scanner.version, generation: scanner.generation, turn: found })
    const index = normalizeTurnIndex(scanner.turnIndex)
    const row = index[sessionId] && index[sessionId][String(turn)] ? index[sessionId][String(turn)] : null
    return json(res, 200, {
      sessionId,
      revision: scanner.version,
      generation: scanner.generation,
      status: row ? 'no-data' : 'missing',
      index: row,
      turn: row ? { ...row, status: 'no-data', hasModelData: false, primaryFingerprint: '', fingerprints: [] } : null,
    })
  })

  route('/api/official-models', async (req, res) => {
    if (!originAllowed(req)) return json(res, 403, { error: 'origin not allowed' })
    await init()
    const baselineView = (model, ensured) => {
      const baseline = ensured.baseline.artifact
      const calibration = ensured.calibration.artifact
      return {
        key: model.key,
        label: model.label,
        evidenceLevel: model.evidenceLevel,
        samples: baseline ? baseline.samples : 0,
        sessions: baseline ? baseline.sessions : 0,
        excludedSamples: ensured.excludedSamples,
        ready: Boolean(baseline && baseline.ready),
        minSamples: model.minSamples,
        fingerprints: baseline ? baseline.fingerprints : [],
        firstTime: baseline ? baseline.firstTime : null,
        lastTime: baseline ? baseline.lastTime : null,
        dataVersion: baseline ? baseline.dataVersion : null,
        similarityVersion: baseline ? baseline.similarityVersion : null,
        featureSchemaVersion: baseline ? baseline.featureSchemaVersion : null,
        qualityVersion: baseline ? baseline.qualityVersion : null,
        scannerGeneration: baseline ? baseline.scannerGeneration : null,
        observationRevision: baseline ? baseline.observationRevision : null,
        sourceDigest: baseline ? baseline.sourceDigest : null,
        generatedAt: baseline ? baseline.generatedAt : null,
        stale: Boolean(ensured.baseline.stale || ensured.calibration.stale),
        staleReasons: ensured.baseline.stale ? ensured.baseline.reasons : ensured.calibration.reasons,
        rebuilt: Boolean(ensured.baseline.rebuilt),
        calibrated: Boolean(calibration && calibration.calibrated),
        calibrationReason: calibration ? calibration.reason : 'calibration unavailable',
      }
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const models = officialModelsNow()
      const ensured = refreshOfficialArtifacts(models)
      if (ensured.some((item) => item.baseline.rebuilt || item.calibration.rebuilt || item.baseline.stale || item.calibration.stale)) await store.flush(scanner)
      return json(res, 200, {
        models,
        evidenceLevels: EVIDENCE_LEVELS,
        baselines: models.map((model, index) => baselineView(model, ensured[index])),
      })
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST only' })
    if (!mutationAllowed(req, res)) return
    const body = await readJson(req)
    if (!body || !Array.isArray(body.models)) return json(res, 400, { error: 'models array is required' })
    for (const input of body.models) {
      if (input && input.evidenceLevel !== undefined && !EVIDENCE_LEVELS.includes(String(input.evidenceLevel))) {
        return json(res, 400, { error: 'invalid evidenceLevel', allowed: EVIDENCE_LEVELS })
      }
      if (input && input.confirmedAt && !normalizeConfirmedAt(input.confirmedAt)) {
        return json(res, 400, { error: 'invalid confirmedAt' })
      }
    }
    const models = normalizeOfficialModels(body.models)
    store.setOfficialModels(models)
    const ensured = refreshOfficialArtifacts(models, { force: true })
    await store.flush(scanner)
    return json(res, 200, {
      ok: true,
      models,
      baselines: models.map((model, index) => baselineView(model, ensured[index])),
    })
  })

  route('/api/similarity', async (req, res) => {
    if (!originAllowed(req)) return json(res, 403, { error: 'origin not allowed' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' })
    await init()
    const url = new URL(req.url || '/', 'http://local')
    const report = reportNow(50)
    const latest = report && report.latest && report.latest.observation
    const provider = url.searchParams.get('provider') || (latest && latest.provider) || ''
    const model = url.searchParams.get('model') || (latest && latest.model) || ''
    if (!provider || !model) return json(res, 400, { error: 'provider/model required' })
    const models = officialModelsNow()
    if (!models.length) return json(res, 409, { error: 'no official model configured', hint: 'POST /api/official-models' })
    const observations = allObservationsNow()
    const probes = store.probes().filter((row) => row && row.behavior)
    const probeRows = probes.filter((row) => row.provider === provider && row.model === model)
    const passiveRows = observations.filter((row) => row.provider === provider && row.model === model && row.behavior)
    const ensured = refreshOfficialArtifacts(models)
    const results = []
    for (const [index, official] of models.entries()) {
      const officialProbes = probes.filter((row) => row.provider === official.provider && row.model === official.model)
      const officialPassive = observations.filter((row) => row.provider === official.provider && row.model === official.model && row.behavior)
      const useProbes = probeRows.length >= 2 && officialProbes.length >= 2
      const rows = useProbes ? probeRows : passiveRows
      const baseline = useProbes
        ? buildOfficialProfile(officialProbes, official, { minSamples: 2 })
        : ensured[index].baseline.artifact
      const calibration = useProbes ? null : ensured[index].calibration.artifact
      const targetRow = (useProbes ? probeRows[0] : passiveRows[0]) || null
      const officialRow = (useProbes ? officialProbes[0] : officialPassive[0]) || null
      const protocol = targetRow && officialRow
        ? compareProtocol(targetRow, officialRow)
        : { sameFingerprint: false, sameExact: false, sameFamily: false, sameVariant: false, left: null, right: null }
      const score = scoreSimilarity(rows, baseline, calibration, {
        source: useProbes ? 'fixed-probe' : 'passive',
        evidenceLevel: official.evidenceLevel,
        protocolConfidence: protocol.sameVariant ? 1 : protocol.sameFamily ? 0.55 : 0,
      })
      const identity = assessModelIdentity({
        protocol,
        behaviorSimilarity: score.behaviorSimilarity,
        behaviorDistance: score.evidence ? score.evidence.distance : null,
        evidenceLevel: official.evidenceLevel,
        source: useProbes ? 'fixed-probe' : 'passive',
      })
      results.push({
        officialKey: official.key,
        officialLabel: official.label,
        evidenceLevel: official.evidenceLevel,
        evidenceSource: official.evidenceSource,
        source: useProbes ? 'fixed-probe' : 'passive',
        probeSamples: probeRows.length,
        ...score,
        protocolConfidence: identity.protocolConfidence,
        behaviorSimilarity: identity.behaviorSimilarity,
        modelIdentityConfidence: identity.modelIdentityConfidence,
        modelIdentityStatus: identity.status,
        modelIdentityCeiling: identity.ceiling,
        passiveOnly: identity.passiveOnly,
        layers: {
          protocol,
          transport: protocol.left,
          behaviorProfileId: protocol.left && protocol.left.behaviorProfileId,
        },
        quality: qualityForRows(rows),
        baselineStale: Boolean(ensured[index].baseline.stale),
        baselineStaleReasons: ensured[index].baseline.reasons,
        degradation: analyzeDegradation(rows, baseline),
      })
    }
    results.sort((left, right) => (right.similarity ?? right.score ?? -1) - (left.similarity ?? left.score ?? -1))
    return json(res, 200, {
      provider,
      model,
      samples: results[0] && results[0].source === 'fixed-probe' ? probeRows.length : passiveRows.length,
      passiveSamples: passiveRows.length,
      probeSamples: probeRows.length,
      source: results[0] ? results[0].source : 'passive',
      officialModels: models.length,
      calibrated: Boolean(results[0] && results[0].calibrated),
      behaviorSimilarity: results[0] ? results[0].behaviorSimilarity : null,
      protocolConfidence: results[0] ? results[0].protocolConfidence : null,
      modelIdentityConfidence: results[0] ? results[0].modelIdentityConfidence : null,
      modelIdentityStatus: results[0] ? results[0].modelIdentityStatus : 'no-data',
      evidenceLevel: results[0] ? results[0].evidenceLevel : 'unknown',
      passiveOnly: results[0] ? results[0].passiveOnly : true,
      calibratedScore: results[0] ? results[0].calibratedScore : null,
      score: results[0] ? results[0].score : null,
      verdict: results[0] ? results[0].verdict : 'no-data',
      best: results[0] || null,
      candidates: results,
      generatedAt: Date.now(),
    })
  })

  route('/api/session', async (req, res) => {
    if (!originAllowed(req)) return json(res, 403, { error: 'origin not allowed' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' })
    await init()
    const url = new URL(req.url || '/', 'http://local')
    const report = reportNow(50)
    const sessionId = url.searchParams.get('id') || (report.latest && report.latest.observation && report.latest.observation.sessionId)
    if (!sessionId) return json(res, 404, { error: 'no session id' })
    const session = (report.sessions || []).find((item) => item.id === sessionId)
    const sessionRows = scanner.observationsForSession(sessionId)
    const rows = sessionRows
      .slice()
      .sort((left, right) => right.time - left.time)
      .slice(0, Math.min(300, Number(url.searchParams.get('limit')) || 100))
    const turns = turnsForSession(sessionId)
      .slice(0, Math.min(300, Number(url.searchParams.get('limit')) || 100))
    return json(res, 200, { session: session || null, observations: rows, turns })
  })
  route('/api/equivalence', async (req, res) => {
    if (!originAllowed(req)) return json(res, 403, { error: 'origin not allowed' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' })
    await init()
    const url = new URL(req.url || '/', 'http://local')
    const report = buildEquivalence([...scanner.observations.values()], store.labels(), {
      limit: Math.min(200, Number(url.searchParams.get('limit')) || 80),
      probes: store.probes(),
    })
    return json(res, 200, report)
  })
  route('/api/probe', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
    if (!mutationAllowed(req, res)) return
    const body = await readJson(req)
    if (body.confirm !== true) return json(res, 400, { error: 'confirm=true is required; probes consume provider tokens' })
    const result = await executeProbe({ provider: body.provider, model: body.model, repeats: body.repeats })
    return json(res, 200, {
      ok: true,
      routeKey: result.routeKey,
      calls: result.calls,
      repeats: result.repeats,
      tokenizerVector: result.tokenizerVector,
      behavior: result.behavior,
      stored: result.results.length,
    })
  })
  route('/api/label', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
    if (!mutationAllowed(req, res)) return
    await init()
    const body = await readJson(req)
    const result = store.setLabel(body.fingerprintId, body.label, body.note)
    await store.flush(scanner)
    return json(res, 200, { ok: true, label: result })
  })
  route('/api/backfill', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
    if (!mutationAllowed(req, res)) return
    await init()
    await scanner.waitIdle()
    const summary = await scanner.backfillMissing({ force: true })
    await store.flush(scanner)
    return json(res, 200, { ok: true, backfill: summary, scan: scanner.status() })
  })
  route('/api/scan', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
    if (!mutationAllowed(req, res)) return
    await init()
    await scanner.discover()
    return json(res, 200, { ok: true, scan: scanner.status() })
  })

  const tool = {
    name: 'model_fingerprint',
    description:
      'Inspect the local evidence-based model fingerprint monitor for DSH sessions. Use it when the user asks which model was actually called, whether a claimed model name matches history, or whether two routes behave like the same model. Fingerprints come from protocol shape and behavior statistics, never from trusting the model name. Actions: status (summary), session (one session), fingerprints (list), equivalence (cross-route behavior comparison), probe (opt-in fixed probes; consumes provider tokens and requires confirm=true), label (set a human-confirmed actual model label), scan (refresh discovery), backfill (reparse logs for missing turns and persist).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'session', 'fingerprints', 'equivalence', 'probe', 'label', 'scan', 'backfill'], description: 'Operation to run. Default status. backfill reparses session logs for missing turn observations and persists them.' },
        provider: { type: 'string', description: 'Provider route for action=probe; defaults to the latest observation route.' },
        model: { type: 'string', description: 'Model id for action=probe; defaults to the latest observation model.' },
        repeats: { type: 'number', description: 'Probe repeats 1-3 for action=probe (default 1).' },
        confirm: { type: 'boolean', description: 'Required true for action=probe; each repeat calls the model with the fixed suite.' },
        sessionId: { type: 'string', description: 'Session id for action=session.' },
        fingerprintId: { type: 'string', description: 'Fingerprint id (fp_...) for action=label.' },
        label: { type: 'string', description: 'Human-confirmed actual model name for action=label; empty removes the label.' },
        note: { type: 'string', description: 'Optional note for action=label.' },
        limit: { type: 'number', description: 'Maximum rows for status/fingerprints (default 200).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value && value.text || '') }],
    },
    async execute(args) {
      const action = String(args && args.action || 'status')
      await init()
      const report = reportNow(Math.min(500, Number(args && args.limit) || 200))
      if (!report) return { text: '模型指纹监控尚未初始化。' }
      if (action === 'status') return { text: statusText(report) }
      if (action === 'session') return { text: sessionText(report, scanner, args && args.sessionId) }
      if (action === 'fingerprints') return { text: fingerprintsText(report) }
      if (action === 'equivalence') {
        const equivalence = buildEquivalence([...scanner.observations.values()], store.labels(), { limit: 80, probes: store.probes() })
        return { text: equivalenceText(equivalence) }
      }
      if (action === 'probe') {
        if (!args || args.confirm !== true) throw new Error('confirm=true is required; probe calls consume provider tokens')
        const result = await executeProbe({ provider: args.provider, model: args.model, repeats: args.repeats })
        return { text: probeText(result) }
      }
      if (action === 'label') {
        if (!args || !args.fingerprintId) throw new Error('fingerprintId is required for label')
        const saved = store.setLabel(args.fingerprintId, args.label, args.note)
        await store.flush(scanner)
        return { text: saved ? `已给 ${fingerprintLabel(args.fingerprintId)} 写入标签「${saved.label}」。` : `已删除 ${fingerprintLabel(args.fingerprintId)} 的标签。` }
      }
      if (action === 'scan') {
        await scanner.discover()
        return { text: '已触发会话发现。\n' + scanLine(reportNow(20)) }
      }
      if (action === 'backfill') {
        await scanner.waitIdle()
        const summary = await scanner.backfillMissing({ force: true })
        await store.flush(scanner)
        return { text: `补算完成：扫描 ${summary.scanned} 个文件，补充 ${summary.added} 条轮次观测。` }
      }
      throw new Error('unknown action: ' + action)
    },
  }
  disposers.push(ctx.tools.register(tool))

  disposers.push(ctx.webServer.tapIndex((htmlSource) => {
    let origin = ''
    try { origin = ctx.webServer.getOrigin() } catch { /* listen not ready */ }
    const base = origin ? origin.replace(/\/+$/, '') : ''
    const widgetSource = (base || '') + '/model-fingerprint/widget.js'
    const tokenTag = `<script>window.__dshModelFingerprintToken=${JSON.stringify(currentToken())}</script>`
    let source = String(htmlSource || '')
    if (!source.includes('__dshModelFingerprintToken=')) {
      source = source.includes('</head>') ? source.replace('</head>', tokenTag + '</head>') : tokenTag + source
    }
    if (source.includes(widgetSource)) return source
    const baseTag = base ? `<script>window.__dshModelFingerprintApiBase=${JSON.stringify(base)}</script>` : ''
    const tag = baseTag + `<script defer src="${widgetSource}"></script>`
    if (source.includes('</body>')) return source.replace('</body>', tag + '</body>')
    return source + tag
  }))

  // Periodic save catches a quiet log whose debounce was interrupted.
  saveTimer = setInterval(() => {
    if (scanner && store) store.scheduleSave(scanner)
  }, 60000)
  saveTimer.unref?.()

  ctx.effect(() => () => {
    disposed = true
    if (saveTimer) clearInterval(saveTimer)
    if (scanner) scanner.stop()
    if (store && scanner) store.flush(scanner).catch(() => {})
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* best effort */ }
    }
  })
}
