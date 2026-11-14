    class TurnWindowStore {
      constructor(maxWindow = 2000) {
        this.maxWindow = Math.max(200, Number(maxWindow) || 2000)
        this.rows = new Map()
        this.byNumber = new Map()
        this.hasMore = false
      }
      reset() {
        this.rows.clear()
        this.byNumber.clear()
        this.hasMore = false
      }
      merge(incoming) {
        for (const turn of incoming || []) {
          if (!turn || turn.id === undefined) continue
          this.rows.set(turn.id, turn)
          const number = Number(turn.turn)
          if (Number.isFinite(number)) this.byNumber.set(number, turn)
        }
        return this.turns()
      }
      get(turn) {
        return this.byNumber.get(Number(turn)) || null
      }
      has(turn) {
        return this.byNumber.has(Number(turn))
      }
      numbers() {
        return [...this.byNumber.keys()]
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
        this.byNumber.clear()
        for (const turn of this.rows.values()) {
          const number = Number(turn.turn)
          if (Number.isFinite(number)) this.byNumber.set(number, turn)
        }
        return true
      }
    }
