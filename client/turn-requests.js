    class TurnRequestQueue {
      constructor({ fetchTurn, onTurn, limit = 4 } = {}) {
        this.fetchTurn = fetchTurn
        this.onTurn = onTurn
        this.limit = limit
        this.inFlight = new Set()
      }
      request(domTurns, knownTurns = [], offset = 0) {
        const known = new Set((knownTurns || []).map((turn) => Number(turn.turn)))
        const missing = []
        for (const value of domTurns || []) {
          const turn = Number(value) - offset
          if (!Number.isFinite(turn) || known.has(turn)) continue
          if (!missing.includes(turn)) missing.push(turn)
          if (missing.length >= this.limit) break
        }
        for (const turn of missing) {
          if (this.inFlight.has(turn)) continue
          this.inFlight.add(turn)
          Promise.resolve()
            .then(() => this.fetchTurn(turn))
            .then((payload) => {
              if (payload && payload.turn) this.onTurn(payload.turn)
            })
            .catch(() => { /* keep the last stable cards */ })
            .finally(() => this.inFlight.delete(turn))
        }
        return missing
      }
      get pending() {
        return this.inFlight.size
      }
    }
