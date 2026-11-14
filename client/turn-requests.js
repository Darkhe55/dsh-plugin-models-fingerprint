    class TurnRequestQueue {
      constructor({ fetchTurn, onTurn, onNoData, limit = 4 } = {}) {
        this.fetchTurn = fetchTurn
        this.onTurn = onTurn
        this.onNoData = onNoData
        this.limit = limit
        this.epoch = 0
        this.inFlight = new Map()
      }
      invalidate() {
        this.epoch += 1
        this.inFlight.clear()
        return this.epoch
      }
      request(domTurns, knownTurns = [], offset = 0, context = {}) {
        const known = new Set((knownTurns || []).map((turn) => Number(turn.turn)))
        const missing = []
        for (const value of domTurns || []) {
          const turn = Number(value) - offset
          if (!Number.isFinite(turn) || known.has(turn)) continue
          if (!missing.includes(turn)) missing.push(turn)
          if (missing.length >= this.limit) break
        }
        const epoch = this.epoch
        for (const turn of missing) {
          if (this.inFlight.has(turn)) continue
          this.inFlight.set(turn, epoch)
          Promise.resolve()
            .then(() => this.fetchTurn(turn, context))
            .then((payload) => {
              if (epoch !== this.epoch) return
              if (!payload) return
              if (context.sessionId && payload.sessionId && String(payload.sessionId) !== String(context.sessionId)) return
              const revision = Number(payload.revision)
              if (Number.isFinite(revision) && Number.isFinite(Number(context.revision)) && revision < Number(context.revision)) return
              const generation = payload.generation === undefined ? context.generation : payload.generation
              const expected = context.generation === undefined ? '' : String(context.generation)
              if (expected && expected !== '0' && generation !== undefined && String(generation) !== expected) return
              if (payload.turn) this.onTurn(payload.turn, payload)
              else if (this.onNoData) this.onNoData(payload)
            })
            .catch(() => { /* keep the last stable cards */ })
            .finally(() => {
              if (this.inFlight.get(turn) === epoch) this.inFlight.delete(turn)
            })
        }
        return missing
      }
      get pending() {
        return this.inFlight.size
      }
    }
