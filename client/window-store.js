    class TurnWindowStore {
      constructor(maxWindow = 2000) {
        this.maxWindow = Math.max(200, Number(maxWindow) || 2000)
        this.rows = new Map()
        this.hasMore = false
      }
      reset() {
        this.rows.clear()
        this.hasMore = false
      }
      merge(incoming) {
        for (const turn of incoming || []) {
          if (!turn || turn.id === undefined) continue
          this.rows.set(turn.id, turn)
        }
        return this.turns()
      }
      turns() {
        return [...this.rows.values()].sort((left, right) => Number(right.turn) - Number(left.turn))
      }
      get size() {
        return this.rows.size
      }
      oldest() {
        return this.turns()[this.size - 1] || null
      }
      pruneAround(focusTurn) {
        if (this.rows.size <= this.maxWindow) return false
        const focus = Number(focusTurn)
        const rows = this.turns()
        rows.sort((left, right) => {
          const leftDistance = Number.isFinite(focus) ? Math.abs(Number(left.turn) - focus) : 0
          const rightDistance = Number.isFinite(focus) ? Math.abs(Number(right.turn) - focus) : 0
          return leftDistance - rightDistance
        })
        const keep = new Set(rows.slice(0, this.maxWindow).map((turn) => turn.id))
        for (const id of [...this.rows.keys()]) {
          if (!keep.has(id)) this.rows.delete(id)
        }
        return true
      }
    }
