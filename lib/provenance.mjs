/**
 * Optional watermark-provenance channel.
 *
 * A watermark is provenance evidence, never model identity: it is produced by
 * the model owner with a secret key, and it can be stripped by rewriting or a
 * proxy. Therefore:
 *
 * - nothing here feeds `fingerprint`, `verdict`, similarity or baselines;
 * - only a positive answer from a detector the user explicitly configured is
 *   kept, so an observation stays byte-identical when nothing is detected;
 * - the turn text is only ever held for the duration of one request and is
 *   never written to state.
 *
 * Configuration lives in the environment because the plugin has no Config
 * schema:
 *
 *   DSH_MF_WATERMARK_ENDPOINT   POST target; unset means the channel is off
 *   DSH_MF_WATERMARK_TOKEN      optional bearer token
 *   DSH_MF_WATERMARK_TIMEOUT_MS optional, default 5000
 *   DSH_MF_WATERMARK_MIN_CHARS  optional minimum text length, default 200
 *
 * The detector receives `{text, provider, model, turn}` and answers with
 * `{detected: true, vendor, scheme, confidence, score, threshold}`. Any other
 * shape, error, timeout or non-2xx reply is treated as "no evidence".
 */

export const PROVENANCE_VERSION = 1

const MAX_TEXT_CHARS = 200000
const MAX_QUEUE = 32
const MAX_SEEN = 4000

const asText = (value) => (typeof value === 'string' ? value.trim() : '')

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

const finiteOrNull = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const clampUnit = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const unit = number > 1 && number <= 100 ? number / 100 : number
  return Math.min(1, Math.max(0, unit))
}

/**
 * @param {Record<string,string|undefined>} env
 * @returns {{enabled:boolean,endpoint:string|null,token:string|null,timeoutMs:number,minChars:number}}
 */
export function provenanceConfig(env = process.env) {
  const endpoint = asText(env && env.DSH_MF_WATERMARK_ENDPOINT)
  return {
    enabled: Boolean(endpoint),
    endpoint: endpoint || null,
    token: asText(env && env.DSH_MF_WATERMARK_TOKEN) || null,
    timeoutMs: clampNumber(env && env.DSH_MF_WATERMARK_TIMEOUT_MS, 250, 30000, 5000),
    minChars: clampNumber(env && env.DSH_MF_WATERMARK_MIN_CHARS, 0, 100000, 200),
  }
}

/**
 * Normalize a detector reply into the compact record persisted on a turn.
 * Only an explicit positive with a labelled scheme or vendor survives; a
 * negative or malformed answer returns null and leaves the observation alone.
 *
 * @param {object|null} body
 * @param {{now?:number,detector?:string|null}} [context]
 * @returns {object|null}
 */
export function normalizeDetectorReply(body, context = {}) {
  if (!body || typeof body !== 'object') return null
  if (body.detected !== true && body.watermarked !== true) return null
  const scheme = asText(body.scheme).slice(0, 64) || null
  const vendor = asText(body.vendor).slice(0, 64) || null
  const detector = asText(body.detector).slice(0, 64) || asText(context.detector).slice(0, 64) || null
  if (!scheme && !vendor) return null
  const record = {
    v: PROVENANCE_VERSION,
    state: 'detected',
    scheme,
    vendor,
    detector,
    confidence: clampUnit(body.confidence),
    score: finiteOrNull(body.score),
    threshold: finiteOrNull(body.threshold),
    checkedAt: Number.isFinite(Number(context.now)) ? Number(context.now) : Date.now(),
  }
  return record
}

/**
 * Ask one configured detector about one piece of text.
 *
 * @param {{text?:string,config?:object,context?:object,fetchImpl?:Function}} input
 * @returns {Promise<{record:object|null,reason:string|null}>}
 */
export async function detectWatermark({ text, config, context = {}, fetchImpl } = {}) {
  const settings = config || provenanceConfig()
  if (!settings.enabled) return { record: null, reason: 'disabled' }
  const body = typeof text === 'string' ? text : ''
  if (!body || body.length < settings.minChars) return { record: null, reason: 'short-text' }
  const request = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (typeof request !== 'function') return { record: null, reason: 'no-fetch' }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), settings.timeoutMs) : null
  timer?.unref?.()
  try {
    const response = await request(settings.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(settings.token ? { authorization: 'Bearer ' + settings.token } : {}),
      },
      body: JSON.stringify({
        text: body.slice(0, MAX_TEXT_CHARS),
        provider: context.provider || null,
        model: context.model || null,
        turn: context.turn ?? null,
      }),
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (!response || response.ok !== true) return { record: null, reason: 'http-error' }
    let reply
    try {
      reply = await response.json()
    } catch {
      return { record: null, reason: 'bad-json' }
    }
    const record = normalizeDetectorReply(reply, context)
    return { record, reason: record ? null : 'not-detected' }
  } catch (error) {
    return { record: null, reason: error && error.name === 'AbortError' ? 'timeout' : 'detector-error' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * A single-flight queue in front of {@link detectWatermark}. Positive results
 * are attached through the caller's `attach(record)` callback; negatives and
 * failures are dropped after being counted for diagnostics.
 *
 * @param {{env?:object,logger?:object,fetchImpl?:Function}} [options]
 */
export function createProvenanceChannel({ env = process.env, logger, fetchImpl } = {}) {
  const config = provenanceConfig(env)
  const queue = []
  const seen = new Set()
  const stats = { checked: 0, detected: 0, skipped: 0, errors: 0, lastReason: null }
  let running = false
  let disposed = false

  const pump = async () => {
    if (running || disposed) return
    running = true
    while (!disposed && queue.length) {
      const job = queue.shift()
      stats.checked += 1
      try {
        const result = await detectWatermark({
          text: job.text,
          config,
          context: { provider: job.observation.provider, model: job.observation.model, turn: job.observation.turn },
          fetchImpl,
        })
        stats.lastReason = result.reason
        if (result.record && !disposed) {
          stats.detected += 1
          job.attach(result.record)
        }
      } catch (error) {
        stats.errors += 1
        stats.lastReason = 'detector-error'
        try { logger?.warn?.(`model-fingerprint: watermark detector failed: ${error && error.message ? error.message : String(error)}`) } catch { /* logging must not break the loop */ }
      }
    }
    running = false
  }

  const observe = ({ observation, text, attach } = {}) => {
    if (!config.enabled || disposed) return
    if (!observation || !observation.id || typeof attach !== 'function') return
    if (seen.has(observation.id)) return
    seen.add(observation.id)
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value)
    if (queue.length >= MAX_QUEUE) {
      queue.shift()
      stats.skipped += 1
    }
    queue.push({ observation, text: typeof text === 'string' ? text : '', attach })
    void pump()
  }

  const dispose = () => {
    disposed = true
    queue.length = 0
  }

  const status = () => ({
    enabled: config.enabled,
    pending: queue.length,
    ...stats,
  })

  return { config, observe, dispose, status }
}
