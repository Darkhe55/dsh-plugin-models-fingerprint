/**
 * Incremental grouping index for dashboard reports.
 *
 * It stores only observation references and invalidates the derived summary
 * for the one fingerprint/route/session affected by a change. It never
 * serializes observations or rebuilds the whole history.
 */
export class ReportIndex {
  constructor(observations = []) {
    this.byId = new Map()
    this.buckets = {
      fingerprint: new Map(),
      route: new Map(),
      session: new Map(),
    }
    this.summaries = {
      fingerprint: new Map(),
      route: new Map(),
      session: new Map(),
    }
    this.labelSignature = null
    for (const observation of observations) this.upsert(observation)
  }

  keyFor(type, observation) {
    if (type === 'fingerprint') return observation.fingerprint || 'unknown'
    if (type === 'route') return observation.routeKey || [observation.provider, observation.model].filter(Boolean).join('/') || 'unknown/unknown'
    return observation.sessionId || 'unknown'
  }

  removeFrom(type, observation) {
    const key = this.keyFor(type, observation)
    const bucket = this.buckets[type].get(key)
    if (bucket) {
      bucket.delete(observation.id)
      if (!bucket.size) this.buckets[type].delete(key)
    }
    this.summaries[type].delete(key)
  }

  addTo(type, observation) {
    const key = this.keyFor(type, observation)
    if (!this.buckets[type].has(key)) this.buckets[type].set(key, new Map())
    this.buckets[type].get(key).set(observation.id, observation)
    this.summaries[type].delete(key)
  }

  remove(observation) {
    if (!observation || !observation.id) return
    const previous = this.byId.get(observation.id)
    if (!previous) return
    for (const type of ['fingerprint', 'route', 'session']) this.removeFrom(type, previous)
    this.byId.delete(observation.id)
  }

  removeById(id) {
    const previous = this.byId.get(id)
    if (previous) this.remove(previous)
  }

  upsert(observation) {
    if (!observation || !observation.id) return
    this.remove(observation)
    this.byId.set(observation.id, observation)
    for (const type of ['fingerprint', 'route', 'session']) this.addTo(type, observation)
  }

  rows(type, key) {
    const bucket = this.buckets[type].get(key)
    return bucket ? [...bucket.values()] : []
  }

  entries(type) {
    return [...this.buckets[type].entries()].map(([key, bucket]) => [key, bucket])
  }

  all() {
    return [...this.byId.values()]
  }

  invalidateLabels(signature) {
    if (this.labelSignature === signature) return
    this.labelSignature = signature
    for (const type of ['fingerprint', 'route', 'session']) this.summaries[type].clear()
  }

  summarize(type, key, builder) {
    if (this.summaries[type].has(key)) return this.summaries[type].get(key)
    const value = builder()
    this.summaries[type].set(key, value)
    return value
  }

  stats() {
    return {
      observations: this.byId.size,
      fingerprints: this.buckets.fingerprint.size,
      routes: this.buckets.route.size,
      sessions: this.buckets.session.size,
      cachedSummaries: this.summaries.fingerprint.size + this.summaries.route.size + this.summaries.session.size,
    }
  }
}
