/**
 * Evidence aggregation for the fingerprint store.
 *
 * A fingerprint groups observations by protocol shape (wire API, adapter,
 * response-id shape, tool-id shape, usage-field set). Claimed provider/model
 * names are attributes of an observation, never inputs to the fingerprint.
 */
import { medianOf } from './core.mjs'
import { buildDriftReport } from './drift.mjs'

const NUMBER_FIELDS = ['tokensPerChar', 'charsPerChunk', 'cjkRatio', 'newlineRatio', 'markdownPerK', 'jsonSpacing', 'reasoningRatio', 'ttftMs', 'streamMs', 'deltaMedianMs', 'deltaP90Ms', 'charsPerSecond']

const severityRank = { high: 0, warn: 1, info: 2 }

function rowsArray(rows) {
  return rows instanceof Map ? [...rows.values()] : rows
}

function routeKeyOf(row) {
  return row.routeKey || [row.provider, row.model].filter(Boolean).join('/') || 'unknown/unknown'
}

const round = (value, digits = 3) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function medianOfField(rows, field) {
  return medianOf(rows.map((row) => row.behavior && row.behavior[field]))
}

function madOfField(rows, field, center) {
  if (center === null || center === undefined) return null
  const deviations = rows
    .map((row) => row.behavior && row.behavior[field])
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .map((value) => Math.abs(value - center))
  return medianOf(deviations)
}

function shortId(id) {
  return String(id || '').replace(/^fp_/, '').slice(0, 8).toUpperCase()
}

export function makeFingerprint(id, rows, labels) {
  const sorted = rowsArray(rows).sort((left, right) => left.time - right.time)
  const latest = sorted[sorted.length - 1]
  const sessions = new Set(sorted.map((row) => row.sessionId))
  const routeCounts = new Map()
  const nameCounts = new Map()
  for (const row of sorted) {
    routeCounts.set(routeKeyOf(row), (routeCounts.get(routeKeyOf(row)) || 0) + 1)
    nameCounts.set(row.model, (nameCounts.get(row.model) || 0) + 1)
  }
  const routes = [...routeCounts.entries()]
    .map(([routeKey, count]) => {
      const [provider, ...rest] = routeKey.split('/')
      return { routeKey, provider, model: rest.join('/'), count, share: round(count / sorted.length, 3) }
    })
    .sort((left, right) => right.count - left.count)
  const names = [...nameCounts.entries()]
    .map(([name, count]) => ({ name, count, share: round(count / sorted.length, 3) }))
    .sort((left, right) => right.count - left.count)
  const behavior = {}
  const spread = {}
  for (const field of NUMBER_FIELDS) {
    const center = medianOfField(sorted, field)
    behavior[field] = round(center, field === 'ttftMs' || field === 'streamMs' ? 0 : 3)
    spread[field] = round(madOfField(sorted, field, center), 3)
  }
  const toolShapeCounts = new Map()
  const usageFieldCounts = new Map()
  const stopCounts = new Map()
  for (const row of sorted) {
    const detail = row.protocolDetail || {}
    const shapes = Array.isArray(detail.toolIdShapes) && detail.toolIdShapes.length ? detail.toolIdShapes : ['none']
    for (const shape of shapes) toolShapeCounts.set(shape, (toolShapeCounts.get(shape) || 0) + 1)
    const fields = Array.isArray(detail.usageKeys) && detail.usageKeys.length ? detail.usageKeys.join('+') : 'none'
    usageFieldCounts.set(fields, (usageFieldCounts.get(fields) || 0) + 1)
    const stop = detail.stopReason || 'unknown'
    stopCounts.set(stop, (stopCounts.get(stop) || 0) + 1)
  }
  const toShares = (counts) => [...counts.entries()]
    .map(([key, count]) => ({ key, count, share: round(count / sorted.length, 3) }))
    .sort((left, right) => right.count - left.count)
  const label = labels[id] && labels[id].label ? labels[id].label : null
  const status = sorted.length < 3 ? 'new' : routes.length > 1 || names.length > 1 ? 'alias' : 'stable'
  return {
    id,
    short: shortId(id),
    label,
    note: labels[id] && labels[id].note ? labels[id].note : null,
    protocol: latest.protocol || {},
    protocolDetail: latest.protocolDetail || {},
    observations: sorted.length,
    sessions: sessions.size,
    routes: routes.length,
    routeList: routes.slice(0, 12),
    names,
    primaryName: names[0] ? names[0].name : null,
    behavior,
    behaviorSpread: spread,
    toolShapes: toShares(toolShapeCounts),
    usageFields: toShares(usageFieldCounts),
    stopReasons: toShares(stopCounts),
    firstSeen: sorted[0].time,
    lastSeen: latest.time,
    latestId: latest.id,
    status,
    confidence: round(Math.min(0.94, 0.24 + Math.min(0.5, Math.log10(sorted.length + 1) * 0.28)), 2),
  }
}

export function makeRoute(routeKey, rows) {
  const sorted = rowsArray(rows).sort((left, right) => left.time - right.time)
  const latest = sorted[sorted.length - 1]
  const fingerprints = new Map()
  const sessions = new Set()
  for (const row of sorted) {
    fingerprints.set(row.fingerprint, (fingerprints.get(row.fingerprint) || 0) + 1)
    sessions.add(row.sessionId)
  }
  const fpList = [...fingerprints.entries()]
    .map(([id, count]) => ({ id, short: shortId(id), count, share: round(count / sorted.length, 3) }))
    .sort((left, right) => right.count - left.count)
  const dominant = fpList[0]
  const dominantRow = dominant ? sorted.find((row) => row.fingerprint === dominant.id) : undefined
  const mixed = fpList.length > 1 && dominant && dominant.share < 0.7 && sorted.length >= 4
  return {
    routeKey,
    provider: latest.provider,
    model: latest.model,
    observations: sorted.length,
    sessions: sessions.size,
    fingerprints: fpList,
    fingerprintCount: fpList.length,
    dominantFingerprint: dominant ? dominant.id : null,
    dominantProtocol: dominantRow ? dominantRow.protocol : null,
    dominantShare: dominant ? dominant.share : null,
    latestFingerprint: latest.fingerprint,
    firstSeen: sorted[0].time,
    lastSeen: latest.time,
    latestId: latest.id,
    status: mixed ? 'mixed' : sorted.length < 2 ? 'new' : 'stable',
  }
}

export function makeSession(sessionId, rows, meta) {
  const sorted = rowsArray(rows).sort((left, right) => left.time - right.time)
  const latest = sorted[sorted.length - 1]
  const routes = new Map()
  const fingerprints = new Set()
  for (const row of sorted) {
    routes.set(routeKeyOf(row), (routes.get(routeKeyOf(row)) || 0) + 1)
    fingerprints.add(row.fingerprint)
  }
  return {
    id: sessionId,
    cwd: meta && meta.cwd ? meta.cwd : '',
    createdAt: meta && meta.createdAt ? meta.createdAt : sorted[0].time,
    observations: sorted.length,
    lastSeen: latest.time,
    latestId: latest.id,
    routes: [...routes.entries()].map(([routeKey, count]) => ({ routeKey, count })).sort((a, b) => b.count - a.count),
    fingerprints: [...fingerprints],
    status: fingerprints.size > 1 ? 'mixed' : 'stable',
  }
}

function robustZ(value, center, mad) {
  if (typeof value !== 'number' || typeof center !== 'number') return 0
  const scale = Math.max(0.0001, (mad || 0) * 1.4826)
  return (value - center) / scale
}

function behaviorDrift(latest, fingerprint) {
  if (!fingerprint) return []
  const reasons = []
  const checks = [
    ['tokensPerChar', 4.0, 'tokenizer 比例'],
    ['charsPerChunk', 5.0, '流式分块粒度'],
    ['jsonSpacing', 3.0, '工具参数 JSON 风格'],
    ['reasoningRatio', 4.0, '推理内容占比'],
  ]
  for (const [field, threshold, label] of checks) {
    const value = latest.behavior && latest.behavior[field]
    const center = fingerprint.behavior && fingerprint.behavior[field]
    const mad = fingerprint.behaviorSpread && fingerprint.behaviorSpread[field]
    if (value === null || value === undefined || center === null || center === undefined) continue
    const z = robustZ(value, center, mad)
    if (Math.abs(z) >= threshold) reasons.push({ field, label, z: round(z, 2), value: round(value, 3), baseline: round(center, 3) })
  }
  return reasons
}

function assess({ latest, fingerprint, route, labels }) {
  if (!latest) {
    return { verdict: 'no-data', verdictLabel: '暂无观测', confidence: 0, reasons: [], expectedName: null, label: null }
  }
  const fpObs = fingerprint ? fingerprint.observations : 0
  const routeObs = route ? route.observations : 0
  const expectedName = fingerprint && fingerprint.primaryName ? fingerprint.primaryName : null
  const label = fingerprint && fingerprint.label ? fingerprint.label : null
  const reasons = []
  let verdict = 'consistent'
  if (fpObs < 3) {
    verdict = 'unverified'
    reasons.push('该指纹的历史样本少于 3 条')
  }
  if (route && route.dominantFingerprint && route.dominantFingerprint !== latest.fingerprint && routeObs >= 4) {
    const dominant = route.dominantProtocol || {}
    const current = latest.protocol || {}
    const generationChanged = dominant.adapter !== current.adapter || dominant.api !== current.api
    if (generationChanged) {
      verdict = 'generation'
      reasons.push(`协议记录方式发生变化（${dominant.adapter || '-'} / ${dominant.api || '-'} → ${current.adapter || '-'} / ${current.api || '-'}），可能来自适配器或 DSH 版本升级`)
    } else if (route.status === 'mixed' && fpObs >= 3) {
      verdict = 'mixed'
      reasons.push(`该路由存在 ${route.fingerprints.length} 个协议指纹，本次为 ${shortId(latest.fingerprint)}（${Math.round((route.fingerprints.find((item) => item.id === latest.fingerprint)?.share || 0) * 100)}%）`)
    } else {
      verdict = 'changed'
      reasons.push(`本路由最常见指纹为 ${shortId(route.dominantFingerprint)}，本次为 ${shortId(latest.fingerprint)}`)
    }
  }
  if (fingerprint && fingerprint.names && fingerprint.names.length > 1 && expectedName && expectedName !== latest.model) {
    if (verdict === 'consistent') verdict = 'alias'
    reasons.push(`同一指纹还出现过 ${fingerprint.names.length} 个声称模型：${fingerprint.names.slice(0, 3).map((item) => item.name).join('、')}`)
  }
  if (label && latest.model !== label) {
    if (verdict === 'consistent' || verdict === 'unverified') verdict = 'label-mismatch'
    reasons.push(`人工标签为「${label}」，本次声称「${latest.model}」`)
  }
  const drift = behaviorDrift(latest, fingerprint)
  if (drift.length && verdict === 'consistent') {
    verdict = 'behavior-drift'
    reasons.push('行为统计偏离该指纹基线：' + drift.map((item) => item.label).join('、'))
  }
  let confidence = 0.18
  confidence += Math.min(0.32, fpObs * 0.035)
  if (route && route.dominantFingerprint === latest.fingerprint) confidence += 0.22
  if (expectedName === latest.model) confidence += 0.16
  if (label && label === latest.model) confidence += 0.08
  if (drift.length === 0 && fpObs >= 3) confidence += 0.08
  if (verdict === 'generation') confidence -= 0.22
  if (verdict === 'unverified') confidence -= 0.1
  confidence = round(Math.max(0.05, Math.min(0.9, confidence)), 2)
  const verdictLabels = {
    consistent: '与历史指纹一致',
    unverified: '样本不足，暂不能判断',
    changed: '协议指纹发生变化',
    mixed: '该路由存在多个协议指纹',
    generation: '协议记录代际变化',
    alias: '同一指纹出现多个名称',
    'label-mismatch': '名称与人工标签不一致',
    'behavior-drift': '行为统计偏离基线',
  }
  return {
    verdict,
    verdictLabel: verdictLabels[verdict] || verdict,
    confidence,
    expectedName,
    label,
    reasons,
    drift,
  }
}

/**
 * Build the dashboard/API report from the scanner's current observations.
 * @param {{observations: Map<string,object>, status: Function, sessionMeta?: Map<string,object>}} scanner
 * @param {object} labels
 * @param {{limit?:number, now?:number}} options
 */
export function buildReport(scanner, labels = {}, options = {}) {
  const limit = Math.max(20, Math.min(500, Number(options.limit) || 200))
  const index = typeof scanner.ensureReportIndex === 'function'
    ? scanner.ensureReportIndex()
    : (scanner.reportIndex && typeof scanner.reportIndex.entries === 'function' ? scanner.reportIndex : null)
  if (index) index.invalidateLabels(JSON.stringify(labels || {}))
  const all = (index ? index.all() : [...scanner.observations.values()])
    .map((row) => row.routeKey ? row : { ...row, routeKey: [row.provider, row.model].filter(Boolean).join('/') || 'unknown/unknown' })
    .sort((left, right) => right.time - left.time)
  const fpEntries = index ? index.entries('fingerprint') : (() => {
    const grouped = new Map()
    for (const row of all) {
      if (!grouped.has(row.fingerprint)) grouped.set(row.fingerprint, [])
      grouped.get(row.fingerprint).push(row)
    }
    return [...grouped.entries()]
  })()
  const routeEntries = index ? index.entries('route') : (() => {
    const grouped = new Map()
    for (const row of all) {
      if (!grouped.has(row.routeKey)) grouped.set(row.routeKey, [])
      grouped.get(row.routeKey).push(row)
    }
    return [...grouped.entries()]
  })()
  const sessionEntries = index ? index.entries('session') : (() => {
    const grouped = new Map()
    for (const row of all) {
      if (!grouped.has(row.sessionId)) grouped.set(row.sessionId, [])
      grouped.get(row.sessionId).push(row)
    }
    return [...grouped.entries()]
  })()

  const fingerprints = fpEntries
    .map(([id, rows]) => index ? index.summarize('fingerprint', id, () => makeFingerprint(id, rows, labels)) : makeFingerprint(id, rows, labels))
    .sort((left, right) => right.lastSeen - left.lastSeen)
  const byId = new Map(fingerprints.map((item) => [item.id, item]))
  const routes = routeEntries
    .map(([routeKey, rows]) => index ? index.summarize('route', routeKey, () => makeRoute(routeKey, rows)) : makeRoute(routeKey, rows))
    .sort((left, right) => right.observations - left.observations)
  const routeById = new Map(routes.map((item) => [item.routeKey, item]))
  const sessions = sessionEntries
    .map(([id, rows]) => index
      ? index.summarize('session', id, () => makeSession(id, rows, scanner.sessionMeta && scanner.sessionMeta.get(id)))
      : makeSession(id, rows, scanner.sessionMeta && scanner.sessionMeta.get(id)))
    .sort((left, right) => right.lastSeen - left.lastSeen)

  const drift = scanner && typeof scanner.driftReport === 'function' ? scanner.driftReport() : buildDriftReport(all)
  const alerts = []
  const addAlert = (alert) => alerts.push({ id: `${alert.kind}:${alert.fingerprintId || alert.routeKey || alert.sessionId || ''}`, time: alert.time || Date.now(), ...alert })
  for (const change of drift.changePoints.slice(0, 2)) {
    addAlert({
      kind: 'session-behavior-change',
      severity: 'info',
      title: `会话级行为变化点：${change.field}`,
      detail: `会话中位数 ${change.before} → ${change.after}，score=${change.score}，前后 ${change.sessionsBefore}/${change.sessionsAfter} 个 session；仅作探索性告警`,
      time: change.time,
    })
  }
  for (const transition of drift.routeTransitions.slice(-2)) {
    addAlert({
      kind: 'session-route-transition',
      severity: 'info',
      title: `会话级 ${transition.type} 变化`,
      detail: `${transition.from} → ${transition.to}；不表示模型身份切换`,
      time: transition.time,
      sessionId: transition.sessionId,
    })
  }
  for (const route of routes) {
    if (route.status === 'mixed') {
      addAlert({
        kind: 'route-mixed',
        severity: 'warn',
        title: `${route.provider} / ${route.model} 出现多个协议指纹`,
        detail: route.fingerprints.slice(0, 3).map((item) => `${shortId(item.id)} ${Math.round(item.share * 100)}%`).join(' · '),
        routeKey: route.routeKey,
        time: route.lastSeen,
      })
    }
    const latestRow = all.find((row) => row.id === route.latestId)
    if (latestRow && route.dominantFingerprint && route.dominantFingerprint !== latestRow.fingerprint && route.observations >= 4) {
      const dominant = byId.get(route.dominantFingerprint)
      const current = byId.get(latestRow.fingerprint)
      const generationChanged = dominant && current && (dominant.protocol.adapter !== current.protocol.adapter || dominant.protocol.api !== current.protocol.api)
      addAlert({
        kind: generationChanged ? 'protocol-generation' : 'fingerprint-shift',
        severity: generationChanged ? 'info' : 'high',
        title: generationChanged
          ? `${route.provider} / ${route.model} 的协议记录代际变化`
          : `${route.provider} / ${route.model} 的协议指纹变了`,
        detail: `${shortId(route.dominantFingerprint)} → ${shortId(latestRow.fingerprint)}` + (generationChanged ? '（可能来自适配器/DSH 升级，不直接等于模型切换）' : ''),
        routeKey: route.routeKey,
        fingerprintId: latestRow.fingerprint,
        sessionId: route.latestId ? route.latestId.split(':')[0] : null,
        time: route.lastSeen,
      })
    }
    if (latestRow) {
      const fp = byId.get(latestRow.fingerprint)
      const drift = behaviorDrift(latestRow, fp)
      if (drift.length >= 2) {
        addAlert({
          kind: 'behavior-drift',
          severity: 'warn',
          title: `${route.provider} / ${route.model} 行为统计偏离基线`,
          detail: drift.map((item) => `${item.label} z=${item.z}`).join(' · '),
          routeKey: route.routeKey,
          fingerprintId: latestRow.fingerprint,
          sessionId: latestRow.sessionId,
          time: latestRow.time,
        })
      }
    }
  }
  for (const fingerprint of fingerprints) {
    if (fingerprint.names.length > 1 && fingerprint.observations >= 3) {
      addAlert({
        kind: 'alias-collision',
        severity: 'info',
        title: `指纹 ${fingerprint.short} 对应多个声称模型`,
        detail: fingerprint.names.slice(0, 4).map((item) => `${item.name} ×${item.count}`).join(' · '),
        fingerprintId: fingerprint.id,
        time: fingerprint.lastSeen,
      })
    }
    if (fingerprint.label && fingerprint.primaryName && fingerprint.label !== fingerprint.primaryName) {
      addAlert({
        kind: 'label-mismatch',
        severity: 'warn',
        title: `指纹 ${fingerprint.short} 的名称与人工标签不符`,
        detail: `标签「${fingerprint.label}」 · 最常见声称「${fingerprint.primaryName}」`,
        fingerprintId: fingerprint.id,
        time: fingerprint.lastSeen,
      })
    }
    if (fingerprint.status === 'new' && Date.now() - fingerprint.firstSeen < 24 * 3600 * 1000) {
      addAlert({
        kind: 'new-fingerprint',
        severity: 'info',
        title: `新指纹 ${fingerprint.short}`,
        detail: `${fingerprint.protocol.api} · ${fingerprint.protocol.adapter} · 声称 ${fingerprint.primaryName || 'unknown'}`,
        fingerprintId: fingerprint.id,
        time: fingerprint.lastSeen,
      })
    }
  }
  const scanStatus = scanner.status ? scanner.status() : {}
  if (scanStatus.lastError) {
    addAlert({
      kind: 'scan-error',
      severity: 'warn',
      title: '历史会话扫描出现错误',
      detail: String(scanStatus.lastError).slice(0, 240),
      time: Date.now(),
    })
  }
  alerts.sort((left, right) => (severityRank[left.severity] ?? 9) - (severityRank[right.severity] ?? 9) || right.time - left.time)

  const latestRow = all[0] || null
  const latestFingerprint = latestRow ? byId.get(latestRow.fingerprint) : null
  const latestRoute = latestRow ? routeById.get(latestRow.routeKey) : null
  const assessment = assess({ latest: latestRow, fingerprint: latestFingerprint, route: latestRoute, labels })
  const sessionMeta = latestRow && scanner.sessionMeta ? scanner.sessionMeta.get(latestRow.sessionId) : null

  return {
    generatedAt: Date.now(),
    scan: scanStatus,
    drift,
    stats: {
      sessions: sessions.length,
      observations: all.length,
      fingerprints: fingerprints.length,
      routes: routes.length,
      alerts: alerts.length,
      highAlerts: alerts.filter((alert) => alert.severity === 'high').length,
      labeled: Object.keys(labels || {}).length,
    },
    latest: latestRow
      ? {
          observation: latestRow,
          assessment,
          fingerprint: latestFingerprint ? { id: latestFingerprint.id, short: latestFingerprint.short, label: latestFingerprint.label, status: latestFingerprint.status, observations: latestFingerprint.observations, primaryName: latestFingerprint.primaryName, names: latestFingerprint.names } : null,
          route: latestRoute ? { routeKey: latestRoute.routeKey, provider: latestRoute.provider, model: latestRoute.model, dominantFingerprint: latestRoute.dominantFingerprint, status: latestRoute.status, observations: latestRoute.observations } : null,
          session: latestRow ? { id: latestRow.sessionId, cwd: sessionMeta && sessionMeta.cwd ? sessionMeta.cwd : '' } : null,
        }
      : null,
    alerts: alerts.slice(0, 40),
    fingerprints: fingerprints.slice(0, limit),
    routes: routes.slice(0, limit),
    sessions: sessions.slice(0, limit),
    labels: labels || {},
  }
}

export function fingerprintLabel(id) {
  return 'FP-' + shortId(id)
}

export function protocolLabel(protocol) {
  if (!protocol) return 'unknown'
  const parts = []
  if (protocol.api && protocol.api !== '-') parts.push(protocol.api)
  if (protocol.adapter && protocol.adapter !== '-') parts.push(protocol.adapter)
  if (protocol.responseId && protocol.responseId !== 'none') parts.push('id ' + protocol.responseId)
  return parts.join(' · ') || 'unknown'
}

function behaviorMedian(rows, field) {
  return medianOf(rows.map((row) => row.behavior && row.behavior[field]))
}

function turnDelta(rows, previousRows) {
  if (!previousRows || !previousRows.length) return null
  const fields = ['tokensPerChar', 'charsPerChunk', 'reasoningRatio', 'jsonSpacing', 'ttftMs']
  const delta = {}
  for (const field of fields) {
    const current = behaviorMedian(rows, field)
    const previous = behaviorMedian(previousRows, field)
    delta[field] = current === null || current === undefined || previous === null || previous === undefined ? null : round(current - previous, 3)
  }
  return delta
}

/**
 * One detection per model turn (not per stream step), with step-level detail.
 * This is the "every round is separate" view: tool-loop steps remain visible
 * inside the turn, while the turn-level verdict compares the round's dominant
 * fingerprint with the previous round.
 */
export function buildTurns(observations, sessionId) {
  const rows = observations
    .filter((row) => !sessionId || row.sessionId === sessionId)
    .sort((left, right) => left.time - right.time)
  const groups = new Map()
  for (const row of rows) {
    const key = String(row.turn === undefined || row.turn === null ? 0 : row.turn)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  // Turn order is semantic and numeric. A log can interleave turns or contain
  // observations whose first timestamp is not the turn order (tool loops,
  // resumed sessions), so timestamps must never decide the turn sequence.
  const ordered = [...groups.entries()].sort((left, right) => Number(left[0]) - Number(right[0]))
  const turns = []
  let previousRows = null
  for (const [turn, group] of ordered) {
    const sorted = [...group].sort((left, right) => (Number(left.time) || 0) - (Number(right.time) || 0) || (Number(left.seq) || 0) - (Number(right.seq) || 0))
    const latest = sorted[sorted.length - 1]
    const fpCounts = new Map()
    const modelCounts = new Map()
    const routeCounts = new Map()
    const protocols = new Set()
    const steps = []
    let tokens = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
    let textChars = 0
    let reasoningChars = 0
    let toolCalls = 0
    for (const row of sorted) {
      fpCounts.set(row.fingerprint, (fpCounts.get(row.fingerprint) || 0) + 1)
      modelCounts.set(row.model, (modelCounts.get(row.model) || 0) + 1)
      routeCounts.set(routeKeyOf(row), (routeCounts.get(routeKeyOf(row)) || 0) + 1)
      protocols.add((row.protocol && row.protocol.adapter) + '|' + (row.protocol && row.protocol.api))
      tokens.input += row.tokens ? row.tokens.input || 0 : 0
      tokens.output += row.tokens ? row.tokens.output || 0 : 0
      tokens.total += row.tokens ? row.tokens.total || 0 : 0
      tokens.cacheRead += row.tokens ? row.tokens.cacheRead || 0 : 0
      tokens.cacheWrite += row.tokens ? row.tokens.cacheWrite || 0 : 0
      tokens.reasoning += row.tokens ? row.tokens.reasoning || 0 : 0
      textChars += row.behavior ? row.behavior.textChars || 0 : 0
      reasoningChars += row.behavior ? row.behavior.reasoningChars || 0 : 0
      toolCalls += row.toolCalls || 0
      steps.push({
        seq: row.seq,
        step: row.step,
        time: row.time,
        provider: row.provider,
        model: row.model,
        fingerprint: row.fingerprint,
        protocol: row.protocol,
        behavior: row.behavior,
        tokens: row.tokens,
      })
    }
    const fpList = [...fpCounts.entries()].map(([id, count]) => ({ id, short: shortId(id), count })).sort((left, right) => right.count - left.count)
    const models = [...modelCounts.entries()].map(([name, count]) => ({ name, count })).sort((left, right) => right.count - left.count)
    const primary = fpList[0]
    const previousPrimary = previousRows
      ? [...previousRows.reduce((map, row) => map.set(row.fingerprint, (map.get(row.fingerprint) || 0) + 1), new Map()).entries()].sort((left, right) => right[1] - left[1])[0]
      : null
    const currentProtocol = latest.protocol || {}
    const previousProtocol = previousRows && previousRows.length ? previousRows[previousRows.length - 1].protocol || {} : null
    let verdict = 'first'
    if (previousPrimary) {
      if (fpList.length > 1) verdict = 'mixed'
      else if (primary.id !== previousPrimary[0]) {
        verdict = previousProtocol && (previousProtocol.adapter !== currentProtocol.adapter || previousProtocol.api !== currentProtocol.api)
          ? 'generation'
          : 'changed'
      } else verdict = 'same'
    } else if (fpList.length > 1) {
      verdict = 'mixed'
    }
    turns.push({
      id: `${latest.sessionId}:turn:${turn}`,
      sessionId: latest.sessionId,
      turn: Number(turn),
      startTime: sorted[0].time,
      endTime: latest.time,
      steps: steps.length,
      stepList: steps,
      models,
      primaryModel: models[0] ? models[0].name : latest.model,
      routes: [...routeCounts.entries()].map(([routeKey, count]) => ({ routeKey, count })).sort((a, b) => b.count - a.count),
      fingerprints: fpList,
      primaryFingerprint: primary.id,
      primaryShort: primary.short,
      mixed: fpList.length > 1,
      protocols: [...protocols],
      verdict,
      verdictLabel: {
        first: '首轮基线',
        same: '与上一轮一致',
        changed: '与上一轮指纹不同',
        mixed: '本轮内出现多个指纹',
        generation: '协议记录代际变化',
      }[verdict] || verdict,
      behavior: {
        tokensPerChar: round(behaviorMedian(sorted, 'tokensPerChar'), 3),
        charsPerChunk: round(behaviorMedian(sorted, 'charsPerChunk'), 2),
        reasoningRatio: round(behaviorMedian(sorted, 'reasoningRatio'), 3),
        jsonSpacing: round(behaviorMedian(sorted, 'jsonSpacing'), 3),
        ttftMs: round(behaviorMedian(sorted, 'ttftMs'), 0),
        streamMs: round(behaviorMedian(sorted, 'streamMs'), 0),
      },
      delta: turnDelta(sorted, previousRows),
      tokens,
      textChars,
      reasoningChars,
      toolCalls,
    })
    previousRows = sorted
  }
  turns.sort((left, right) => Number(right.turn) - Number(left.turn))
  return turns
}

export { shortId }
