    class TurnWindowQueue {
      constructor({ fetchWindow, onResult, onFallback, onError, limit = 32 } = {}) {
        this.fetchWindow = fetchWindow
        this.onResult = onResult
        this.onFallback = onFallback
        this.onError = onError
        this.limit = limit
        this.epoch = 0
        this.controller = null
        this.lastKey = ''
        this.inFlight = false
      }
      request(turns, context = {}) {
        const values = []
        const seen = new Set()
        for (const value of turns || []) {
          const turn = Number(value)
          if (!Number.isFinite(turn) || seen.has(turn)) continue
          seen.add(turn)
          values.push(turn)
          if (values.length >= this.limit) break
        }
        if (!values.length) return values
        values.sort((left, right) => left - right)
        const key = [context.sessionId, context.revision, context.generation, values.join(',')].join('|')
        if (key === this.lastKey) return values
        this.lastKey = key
        if (this.controller) {
          try { this.controller.abort() } catch { /* already settled */ }
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        this.controller = controller
        const epoch = this.epoch
        this.inFlight = true
        Promise.resolve()
          .then(() => this.fetchWindow(values, context, controller ? controller.signal : undefined))
          .then((response) => {
            if (epoch !== this.epoch) return null
            if (response && response.status === 404) {
              this.lastKey = ''
              if (this.onFallback) this.onFallback(values, context)
              return null
            }
            if (!response || !response.ok) throw new Error('turn-window HTTP ' + (response ? response.status : 'network'))
            return response.json()
          })
          .then((payload) => {
            if (!payload || epoch !== this.epoch) return
            if (payload.sessionId && context.sessionId && String(payload.sessionId) !== String(context.sessionId)) return
            if (context.generation !== undefined && String(context.generation) !== '0'
              && payload.generation !== undefined && String(payload.generation) !== String(context.generation)) return
            if (Number(payload.revision) < Number(context.revision)) return
            if (this.onResult) this.onResult(payload)
          })
          .catch((error) => {
            if (epoch !== this.epoch) return
            this.lastKey = ''
            if (this.onError) this.onError(error)
          })
          .finally(() => {
            if (epoch !== this.epoch) return
            this.inFlight = false
            if (this.controller === controller) this.controller = null
          })
        return values
      }
      invalidate() {
        this.epoch += 1
        if (this.controller) {
          try { this.controller.abort() } catch { /* already settled */ }
        }
        this.controller = null
        this.lastKey = ''
        this.inFlight = false
      }
    }
