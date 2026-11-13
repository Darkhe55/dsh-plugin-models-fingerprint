/**
 * Opt-in fixed probes.
 *
 * Unlike passive history, probes send the same small prompts to every candidate
 * route. They cost provider tokens, so nothing here runs automatically: the
 * caller must explicitly request and confirm a suite.
 */
import { observationFromChunks } from './core.mjs'

export const PROBE_SUITE = [
  {
    id: 'baseline',
    text: 'Reply with exactly OK.',
    description: 'baseline input-token anchor',
  },
  {
    id: 'en',
    text: 'The quick brown fox jumps over the lazy dog. Reply with exactly OK.',
    description: 'English tokenizer marker',
  },
  {
    id: 'zh',
    text: '快速的棕色狐狸跳过懒狗。只回复 OK。',
    description: 'Chinese tokenizer marker',
  },
  {
    id: 'code',
    text: 'function add(a, b) { return a + b }\nReply with exactly OK.',
    description: 'code tokenizer marker',
  },
  {
    id: 'emoji',
    text: '🙂🚀🧪🔬\nReply with exactly OK.',
    description: 'emoji / astral-plane marker',
  },
  {
    id: 'tool',
    text: 'Use the echo tool to echo the number 42.',
    description: 'tool-call JSON / tool-ID marker',
    tools: [{
      name: 'echo',
      description: 'Echo one value back to the caller.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'number', description: 'Value to echo.' } },
        required: ['value'],
        additionalProperties: false,
      },
    }],
  },
]

export const PROBE_SYSTEM = 'You are a controlled fingerprint probe. Follow the instruction exactly. Do not explain.'

const median = (values) => {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (!list.length) return null
  const middle = Math.floor(list.length / 2)
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2
}

async function collect(llm, options) {
  const chunks = []
  const startedAt = Date.now()
  let firstAt = null
  for await (const chunk of llm.stream(options)) {
    const now = Date.now()
    if (firstAt === null) firstAt = now
    chunks.push({ chunk, time: now - startedAt })
  }
  return { chunks, firstAt, startedAt, endedAt: Date.now() }
}

/**
 * Execute the fixed suite.
 * @param {object} input
 * @param {object} input.llm - ctx.llm runtime
 * @param {string} input.provider
 * @param {string} input.model
 * @param {number} [input.repeats]
 * @param {(progress:object)=>void} [input.onProgress]
 * @returns {Promise<object>}
 */
export async function runProbeSuite({ llm, provider, model, repeats = 1, onProgress }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm runtime is unavailable')
  if (!provider || !model) throw new Error('provider and model are required')
  const count = Math.max(1, Math.min(3, Number(repeats) || 1))
  const sessionId = 'probe:' + provider + '/' + model
  const results = []
  const calls = PROBE_SUITE.length * count
  let completed = 0
  for (let repeat = 1; repeat <= count; repeat += 1) {
    for (const prompt of PROBE_SUITE) {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined
      const startedAt = Date.now()
      const collected = await collect(llm, {
        provider,
        model,
        system: PROBE_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.text }] }],
        tools: prompt.tools,
        temperature: 0,
        maxTokens: prompt.id === 'tool' ? 64 : 8,
        signal,
        purpose: 'model-fingerprint-probe',
      })
      const observation = observationFromChunks({
        sessionId,
        id: sessionId + ':' + prompt.id + ':' + repeat + ':' + startedAt,
        provider,
        model,
        chunks: collected.chunks,
        time: collected.endedAt,
        probe: {
          promptId: prompt.id,
          prompt: prompt.text,
          repeat,
          latencyMs: collected.endedAt - startedAt,
          firstTokenMs: collected.firstAt === null ? null : collected.firstAt - collected.startedAt,
        },
      })
      if (observation) {
        observation.time = collected.endedAt
        observation.turn = repeat
        observation.step = PROBE_SUITE.findIndex((item) => item.id === prompt.id) + 1
        results.push(observation)
      }
      completed += 1
      if (onProgress) {
        try { onProgress({ completed, calls, promptId: prompt.id, repeat, provider, model }) } catch { /* progress is optional */ }
      }
    }
  }
  const byPrompt = new Map()
  for (const observation of results) {
    const id = observation.probeMeta && observation.probeMeta.promptId
    if (!byPrompt.has(id)) byPrompt.set(id, [])
    byPrompt.get(id).push(observation)
  }
  const baseline = byPrompt.get('baseline') || []
  const baselineInput = median(baseline.map((observation) => observation.tokens.input))
  const tokenizerVector = []
  for (const prompt of PROBE_SUITE) {
    if (prompt.id === 'baseline') continue
    const rows = byPrompt.get(prompt.id) || []
    const inputs = rows.map((observation) => observation.tokens.input).filter((value) => value > 0)
    const value = median(inputs)
    tokenizerVector.push({
      promptId: prompt.id,
      inputTokens: value,
      delta: value !== null && baselineInput !== null ? value - baselineInput : null,
      samples: rows.length,
    })
  }
  const behavior = {}
  for (const field of ['tokensPerChar', 'charsPerChunk', 'jsonSpacing', 'reasoningRatio']) {
    behavior[field] = median(results.map((observation) => observation.behavior && observation.behavior[field]))
  }
  return {
    provider,
    model,
    routeKey: provider + '/' + model,
    repeats: count,
    calls,
    completed,
    tokenizerVector,
    behavior,
    results,
  }
}
