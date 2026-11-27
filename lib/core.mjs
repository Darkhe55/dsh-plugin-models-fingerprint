/**
 * Model fingerprint core.
 *
 * The fingerprint is evidence about the *route and wire behavior* that produced
 * an assistant message, not a cryptographic proof of a model's identity. It is
 * deliberately derived from protocol metadata (adapter, wire API, response-id
 * shape, tool-call-id shape, usage fields) and task-light behavior statistics
 * (tokenizer ratio, chunk granularity, JSON formatting), never from the claimed
 * model name alone.
 */
import { createHash } from 'node:crypto'

export const ZSTD_MAGIC = 0xfd2fb528
export const STATE_VERSION = 2

export const sha12 = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
}

/**
 * Locate complete Zstandard frames in a concatenated-frame container without
 * decompressing them. Mirrors the session persistence layout: each appended
 * batch is one independent, checksummed frame.
 * @returns {{frames: Array<{start:number,end:number}>, tornStart?: number}}
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** Classify an opaque provider id by shape only; never persist the raw id. */
export function classifyId(value) {
  const id = value === undefined || value === null ? '' : String(value)
  if (!id) return 'none'
  const prefixMatch = /^([A-Za-z][A-Za-z0-9]{0,11})[_-]/.exec(id)
  const prefix = prefixMatch ? prefixMatch[1].toLowerCase() : ''
  const rest = prefixMatch ? id.slice(prefixMatch[0].length) : id
  const body = rest || id
  let alphabet = 'other'
  if (/^[0-9a-f]+$/i.test(body)) alphabet = 'hex'
  else if (/^[0-9a-z]+$/i.test(body)) alphabet = 'alnum'
  else if (/^[A-Za-z0-9+/=_-]+$/.test(body)) alphabet = 'b64ish'
  return (prefix ? prefix + ':' : '') + alphabet + ':' + id.length
}

const countMatches = (text, pattern) => {
  if (!text) return 0
  const matches = String(text).match(pattern)
  return matches ? matches.length : 0
}

const round = (value, digits = 4) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function idShapesFromContent(content) {
  const shapes = new Set()
  if (!Array.isArray(content)) return []
  for (const block of content) {
    if (block && block.type === 'tool-call') shapes.add(classifyId(block.id))
  }
  return [...shapes].sort()
}

function blockPattern(content) {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (!block || typeof block !== 'object') return '?'
    if (block.type === 'text') return 'T'
    if (block.type === 'reasoning') return 'R'
    if (block.type === 'tool-call') return 'C'
    return '?'
  }).join('')
}

function replayParts(message) {
  const replay = message && message.source && message.source.replayState
  const response = replay && replay.response && typeof replay.response === 'object' ? replay.response : undefined
  const blocks = replay && Array.isArray(replay.blocks) ? replay.blocks : undefined
  return { replay, response, blocks }
}

function responseIdOf(response) {
  if (!response || typeof response !== 'object') return ''
  return response.responseId || response.id || response.requestId || ''
}

function buildProtocol(message, usage, stream) {
  const { response, blocks } = replayParts(message)
  const source = (message && message.source) || {}
  const api = response && typeof response.api === 'string' ? response.api : ''
  const kind = response && typeof response.kind === 'string' ? response.kind : ''
  const version = response && (typeof response.version === 'number' || typeof response.version === 'string') ? String(response.version) : ''
  const wireProvider = response && typeof response.provider === 'string' ? response.provider : ''
  const stopReason = response && typeof response.stopReason === 'string' ? response.stopReason : ''
  const toolIds = idShapesFromContent(message && message.content)
  const usageKeys = Object.keys(usage || {}).sort()
  const replayBlocks = Array.isArray(blocks) ? blocks.map((block) => (block && block.type) || '?').join('') : ''
  const core = {
    api: api || '-',
    adapter: kind ? kind + (version ? '@' + version : '') : '-',
    wireProvider: wireProvider || '-',
    responseId: classifyId(responseIdOf(response)),
    replay: blocks ? 'blocks' : (response ? 'response' : 'none'),
  }
  return {
    core,
    api,
    adapter: core.adapter,
    wireProvider,
    stopReason,
    responseIdShape: core.responseId,
    toolIdShapes: toolIds,
    usageKeys,
    replayBlockTypes: replayBlocks,
    hasReplay: Boolean(response),
    blockTypes: blockPattern(message && message.content),
    responseMeta: {
      systemFingerprint: response && typeof response.systemFingerprint === 'string' ? response.systemFingerprint : (response && typeof response.system_fingerprint === 'string' ? response.system_fingerprint : ''),
      serviceTier: response && typeof response.serviceTier === 'string' ? response.serviceTier : (response && typeof response.service_tier === 'string' ? response.service_tier : ''),
      created: response && (typeof response.created === 'number' || typeof response.created === 'string') ? response.created : null,
      responseModel: response && typeof response.model === 'string' ? response.model : '',
      responseKeys: response && typeof response === 'object' ? Object.keys(response).sort() : [],
      logprobs: Boolean(stream && stream.logprobs),
    },
  }
}

/** Flatten one assistant message's timed stream into behavior and timing facts. */
function analyzeStream(stream) {
  const result = {
    textChunks: 0,
    reasoningChunks: 0,
    toolChunks: 0,
    text: '',
    reasoning: '',
    args: '',
    deltas: [],
    firstTokenTime: null,
    lastTokenTime: null,
    blockStarts: 0,
    blockEnds: 0,
    finishReason: '',
    streamUsage: null,
    logprobs: false,
  }
  if (!Array.isArray(stream)) return result
  const markTime = (time) => {
    if (typeof time !== 'number' || !Number.isFinite(time)) return
    if (result.firstTokenTime === null || time < result.firstTokenTime) result.firstTokenTime = time
    if (result.lastTokenTime === null || time > result.lastTokenTime) result.lastTokenTime = time
  }
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue
    if (record.type !== 'chunk' && record.logprobs) result.logprobs = true
    if (record.type === 'chunk' && record.chunk && record.chunk.logprobs) result.logprobs = true
    if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
      const texts = Array.isArray(record.texts) ? record.texts : []
      const dt = Array.isArray(record.dt) ? record.dt : []
      let time = typeof record.time0 === 'number' ? record.time0 : null
      let started = false
      for (let index = 0; index < texts.length; index += 1) {
        const delta = typeof dt[index] === 'number' && dt[index] >= 0 ? dt[index] : 0
        if (time !== null) time += delta
        const text = typeof texts[index] === 'string' ? texts[index] : ''
        if (!text) continue
        if (!started) {
          started = true
          if (time !== null) markTime(time)
        }
        if (record.type === 'text-chunks') {
          result.text += text
          result.textChunks += 1
        } else {
          result.reasoning += text
          result.reasoningChunks += 1
        }
        if (index > 0 && typeof dt[index] === 'number') result.deltas.push(dt[index])
      }
    } else if (record.type === 'tool-call-chunks') {
      const args = Array.isArray(record.args) ? record.args : []
      const dt = Array.isArray(record.dt) ? record.dt : []
      let time = typeof record.time0 === 'number' ? record.time0 : null
      let started = false
      for (let index = 0; index < args.length; index += 1) {
        const delta = typeof dt[index] === 'number' && dt[index] >= 0 ? dt[index] : 0
        if (time !== null) time += delta
        const text = typeof args[index] === 'string' ? args[index] : ''
        if (!text) continue
        if (!started) {
          started = true
          if (time !== null) markTime(time)
        }
        result.args += text
        result.toolChunks += 1
        if (index > 0 && typeof dt[index] === 'number') result.deltas.push(dt[index])
      }
    } else if (record.type === 'chunk' && record.chunk) {
      const chunk = record.chunk
      const time = typeof record.time === 'number' ? record.time : null
      if (chunk.type === 'block-start') result.blockStarts += 1
      else if (chunk.type === 'block-end') result.blockEnds += 1
      else if (chunk.type === 'finish' && chunk.reason && typeof chunk.reason.kind === 'string') result.finishReason = chunk.reason.kind
      else if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') result.streamUsage = chunk.usage
      else if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
        result.text += chunk.text
        result.textChunks += 1
        if (time !== null) markTime(time)
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text) {
        result.reasoning += chunk.text
        result.reasoningChunks += 1
        if (time !== null) markTime(time)
      } else if (chunk.type === 'tool-call-delta') {
        const fragment = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
        if (fragment || chunk.name) {
          result.args += fragment
          result.toolChunks += fragment ? 1 : 0
          if (time !== null) markTime(time)
        }
      }
    }
  }
  return result
}

function median(values) {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (!list.length) return null
  const middle = Math.floor(list.length / 2)
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2
}

function quantile(values, fraction) {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (!list.length) return null
  const position = (list.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return list[lower]
  return list[lower] + (list[upper] - list[lower]) * (position - lower)
}

function mean(values) {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (!list.length) return null
  return list.reduce((sum, value) => sum + value, 0) / list.length
}

function behaviorOf(stream, message, usage) {
  const text = stream.text || ''
  const reasoning = stream.reasoning || ''
  const args = stream.args || ''
  const visibleChars = text.length + reasoning.length + args.length
  const outputTokens = Number(usage && usage.outputTokens) || 0
  const chunkCount = stream.textChunks + stream.reasoningChunks + stream.toolChunks
  const deltaValues = stream.deltas.filter((value) => value >= 0)
  const positive = deltaValues.filter((value) => value > 0)
  const cjk = countMatches(text, /[\u3400-\u9fff\uf900-\ufaff]/g)
  const emoji = countMatches(text, /[\u{1f300}-\u{1faff}\u{2600}-\u{27bf}]/gu)
  const ascii = countMatches(text, /[\x20-\x7e]/g)
  const punctuation = countMatches(text, /[.,!?;:'"()[\]{}，。！？；：、“”‘’（）【】]/g)
  const codeFence = countMatches(text, /```/g)
  const markdown = countMatches(text, /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```)/gm)
  const newlines = countMatches(text, /\n/g)
  const spacedColon = countMatches(args, /":\s+/g)
  const spacedComma = countMatches(args, /,\s+"/g)
  const tightColon = countMatches(args, /":(?=\S)/g)
  const tightComma = countMatches(args, /,(?=\S)/g)
  const jsonTotal = spacedColon + spacedComma + tightColon + tightComma
  return {
    tokensPerChar: outputTokens > 0 && visibleChars > 0 ? round(outputTokens / visibleChars) : null,
    charsPerChunk: chunkCount > 0 ? round(visibleChars / chunkCount, 2) : null,
    cjkRatio: text.length ? round(cjk / text.length, 4) : null,
    emojiRatio: text.length ? round(emoji / text.length, 4) : null,
    asciiRatio: text.length ? round(ascii / text.length, 4) : null,
    punctuationRatio: text.length ? round(punctuation / text.length, 4) : null,
    codeFenceRatio: text.length ? round(codeFence / text.length, 4) : null,
    newlineRatio: text.length ? round(newlines / text.length, 4) : null,
    markdownPerK: text.length ? round((markdown * 1000) / text.length, 2) : null,
    jsonSpacing: jsonTotal >= 8 ? round((spacedColon + spacedComma) / jsonTotal, 3) : null,
    escapedUnicode: args.length ? round(countMatches(args, /\\u[0-9a-f]{4}/gi) / args.length, 4) : null,
    reasoningRatio: visibleChars ? round(reasoning.length / visibleChars, 4) : null,
    textChars: text.length,
    reasoningChars: reasoning.length,
    argChars: args.length,
    chunkCount,
    ttftMs: null,
    streamMs: null,
    deltaMedianMs: median(positive),
    deltaP90Ms: quantile(positive, 0.9),
    deltaMeanMs: mean(positive),
    deltaZeroFraction: deltaValues.length ? round(deltaValues.filter((value) => value === 0).length / deltaValues.length, 3) : null,
    charsPerSecond: null,
    tokensPerSecond: null,
  }
}

/**
 * Build one compact observation from an `assistant/message` event.
 * @param {{sessionId:string,cursor:object,event:object}} input
 * @returns {object|null}
 */
export function observationFromEvent({ sessionId, cursor, event }) {
  if (!event || event.type !== 'assistant/message' || !event.data || !event.data.message) return null
  const data = event.data
  const message = data.message
  const source = message.source || {}
  const context = cursor.context || {}
  const headerConfig = cursor.headerConfig || {}
  const provider = String(source.provider || context.provider || headerConfig.provider || 'unknown')
  const model = String(source.model || context.model || headerConfig.model || 'unknown')
  const usage = data.usage || {}
  const stream = analyzeStream(data.stream)
  const behavior = behaviorOf(stream, message, usage)
  const protocol = buildProtocol(message, usage, stream)
  const usageTotal = Number(usage.totalTokens) || 0
  const usageComponents = (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
  const stepKey = String(data.turn) + ':' + String(data.step)
  const stepStart = cursor.stepStarts && cursor.stepStarts[stepKey]
  if (stream.firstTokenTime !== null && typeof stepStart === 'number' && stepStart > 0) {
    behavior.ttftMs = round(Math.max(0, stream.firstTokenTime - stepStart), 0)
  }
  if (stream.firstTokenTime !== null && stream.lastTokenTime !== null) {
    behavior.streamMs = round(Math.max(0, stream.lastTokenTime - stream.firstTokenTime), 0)
    if (behavior.streamMs > 0) {
      behavior.charsPerSecond = round((stream.text.length + stream.reasoning.length + stream.args.length) / (behavior.streamMs / 1000), 1)
      if (Number(usage.outputTokens) > 0) behavior.tokensPerSecond = round(Number(usage.outputTokens) / (behavior.streamMs / 1000), 1)
    }
  }
  const fingerprint = 'fp_' + sha12(stableStringify(protocol.core))
  return {
    id: String(sessionId) + ':' + String(event.seq),
    sessionId: String(sessionId),
    seq: event.seq,
    time: event.time,
    turn: data.turn,
    step: data.step,
    provider,
    model,
    routeKey: provider + '/' + model,
    fingerprint,
    protocol: protocol.core,
    protocolDetail: {
      api: protocol.api,
      adapter: protocol.adapter,
      wireProvider: protocol.wireProvider,
      stopReason: protocol.stopReason || stream.finishReason,
      responseIdShape: protocol.responseIdShape,
      toolIdShapes: protocol.toolIdShapes,
      usageKeys: protocol.usageKeys,
      blockTypes: protocol.blockTypes,
      replayBlockTypes: protocol.replayBlockTypes,
      hasReplay: protocol.hasReplay,
      systemFingerprint: protocol.responseMeta.systemFingerprint,
      serviceTier: protocol.responseMeta.serviceTier,
      responseModel: protocol.responseMeta.responseModel,
      responseKeys: protocol.responseMeta.responseKeys,
      logprobs: protocol.responseMeta.logprobs,
    },
    aux: {
      systemFingerprint: protocol.responseMeta.systemFingerprint,
      serviceTier: protocol.responseMeta.serviceTier,
      created: protocol.responseMeta.created,
      responseModel: protocol.responseMeta.responseModel,
      responseKeys: protocol.responseMeta.responseKeys,
      logprobs: protocol.responseMeta.logprobs,
      usageInvariant: {
        totalMinusComponents: usageTotal ? usageTotal - usageComponents : null,
        totalEqualsComponents: usageTotal ? Math.abs(usageTotal - usageComponents) <= 2 : null,
        hasCacheRead: Object.prototype.hasOwnProperty.call(usage, 'cacheReadTokens'),
        hasCacheWrite: Object.prototype.hasOwnProperty.call(usage, 'cacheWriteTokens'),
        hasReasoning: Object.prototype.hasOwnProperty.call(usage, 'reasoningTokens'),
      },
    },
    behavior,
    timing: {
      stepStart: typeof stepStart === 'number' ? stepStart : null,
      firstToken: stream.firstTokenTime,
      lastToken: stream.lastTokenTime,
    },
    tokens: {
      input: Number(usage.inputTokens) || 0,
      output: Number(usage.outputTokens) || 0,
      total: Number(usage.totalTokens) || 0,
      cacheRead: Number(usage.cacheReadTokens) || 0,
      cacheWrite: Number(usage.cacheWriteTokens) || 0,
      reasoning: Number(usage.reasoningTokens) || 0,
    },
    toolCalls: Array.isArray(message.content) ? message.content.filter((block) => block && block.type === 'tool-call').length : 0,
    textBlocks: Array.isArray(message.content) ? message.content.filter((block) => block && block.type === 'text').length : 0,
    reasoningBlocks: Array.isArray(message.content) ? message.content.filter((block) => block && block.type === 'reasoning').length : 0,
  }
}

/**
 * Build an observation from a live/probe raw chunk stream. Used by the opt-in
 * probe runner; it deliberately does not invent a user prompt or content.
 */
export function observationFromChunks({ sessionId, id, provider, model, chunks, time = Date.now(), probe = null }) {
  let text = ''
  let reasoning = ''
  let usage = {}
  let finish = null
  const toolCalls = new Map()
  const timed = []
  for (const entry of Array.isArray(chunks) ? chunks : []) {
    const chunk = entry && entry.chunk ? entry.chunk : entry
    const stamp = entry && typeof entry.time === 'number' ? entry.time : time
    timed.push({ type: 'chunk', time: stamp, chunk })
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
    else if (chunk.type === 'tool-call-delta') {
      const index = Number(chunk.index) || 0
      const call = toolCalls.get(index) || { id: chunk.id, name: chunk.name || '', arguments: '' }
      if (chunk.name) call.name = chunk.name
      if (chunk.argumentsDelta) call.arguments += chunk.argumentsDelta
      toolCalls.set(index, call)
    } else if (chunk.type === 'usage' && chunk.usage) usage = { ...usage, ...chunk.usage }
    else if (chunk.type === 'finish') finish = chunk
  }
  const content = []
  if (text) content.push({ type: 'text', text })
  if (reasoning) content.push({ type: 'reasoning', text: reasoning })
  for (const call of [...toolCalls.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
  }
  const message = {
    role: 'assistant',
    content,
    source: {
      kind: 'model',
      provider,
      model,
      replayState: finish && finish.replayState ? finish.replayState : undefined,
    },
    id: 'probe-message',
  }
  const cursor = createCursor({ id: sessionId || 'probe:' + provider + '/' + model })
  const firstTime = timed.length ? timed[0].time : time
  cursor.stepStarts['1:1'] = firstTime
  const event = {
    type: 'assistant/message',
    seq: 0,
    time,
    data: { turn: 1, step: 1, message, usage, stream: timed },
  }
  const observation = observationFromEvent({ sessionId: sessionId || 'probe:' + provider + '/' + model, cursor, event })
  if (!observation) return null
  observation.id = id || 'probe:' + provider + '/' + model + ':' + time
  observation.probe = true
  if (probe) observation.probeMeta = probe
  return observation
}

export function createCursor(header = null) {  return {
    header: header || null,
    context: null,
    headerConfig: null,
    stepStarts: {},
    lastTime: 0,
  }
}

function trimStepStarts(stepStarts) {
  const entries = Object.entries(stepStarts || {})
  if (entries.length <= 80) return stepStarts || {}
  entries.sort((a, b) => Number(a[1]) - Number(b[1]))
  return Object.fromEntries(entries.slice(-40))
}

/**
 * Fold one session event into a scanner cursor and emit observations for
 * assistant messages. The cursor is JSON-serializable so an incremental scan
 * can resume from a byte offset after a restart.
 */
export function applySessionEvent(cursor, event, emit) {
  if (!event || typeof event !== 'object') return
  if (typeof event.time === 'number') cursor.lastTime = event.time
  if (event.type === 'session') {
    cursor.header = {
      id: event.id,
      version: event.version,
      createdAt: event.createdAt,
      cwd: event.cwd,
      parentSession: event.parentSession,
      delegationDepth: event.delegationDepth,
      origin: event.origin,
      agentPreset: event.agentPreset,
    }
    return
  }
  if (event.type === 'request/context' && event.data) {
    cursor.context = {
      provider: event.data.provider,
      model: event.data.model,
      contextWindow: event.data.contextWindow,
      systemPromptUpdate: event.data.systemPromptUpdate,
    }
    return
  }
  if (event.type === 'request/header' && event.data && event.data.header) {
    const header = event.data.header
    const config = header.config || {}
    cursor.headerConfig = {
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      topP: config.topP,
      toolCount: Array.isArray(header.tools) ? header.tools.length : 0,
    }
    return
  }
  if (event.type === 'step/start' && event.data) {
    cursor.stepStarts[String(event.data.turn) + ':' + String(event.data.step)] = event.time
    cursor.stepStarts = trimStepStarts(cursor.stepStarts)
    return
  }
  if (event.type === 'assistant/message') {
    const sessionId = cursor.header && cursor.header.id ? cursor.header.id : 'unknown'
    const observation = observationFromEvent({ sessionId, cursor, event })
    // The event travels with the observation so an opt-in provenance channel
    // can read the turn text without persisting it.
    if (observation && typeof emit === 'function') emit(observation, event)
  }
}

/**
 * Visible assistant text of one `assistant/message` event. Used only by the
 * opt-in watermark channel; the text is never stored.
 *
 * @param {object|null} event
 * @returns {string}
 */
export function assistantTextFromEvent(event) {
  if (!event || event.type !== 'assistant/message' || !event.data || !event.data.message) return ''
  const content = Array.isArray(event.data.message.content) ? event.data.message.content : []
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text) parts.push(block.text)
  }
  return parts.join('\n')
}

export function quantileOf(values, fraction) {
  return quantile(values, fraction)
}

export function medianOf(values) {
  return median(values)
}
