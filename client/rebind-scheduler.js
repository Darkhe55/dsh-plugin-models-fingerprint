    class RebindScheduler {
      constructor({ delays = [0, 60, 140], onRebind, setTimer = (fn, ms) => window.setTimeout(fn, ms), clearTimer = (id) => window.clearTimeout(id) } = {}) {
        this.delays = delays
        this.onRebind = onRebind
        this.setTimer = setTimer
        this.clearTimer = clearTimer
        this.timers = []
        this.kicks = 0
      }
      kick() {
        this.dispose()
        this.kicks += 1
        for (const delay of this.delays) {
          if (!delay) this.onRebind?.()
          else this.timers.push(this.setTimer(() => this.onRebind?.(), delay))
        }
      }
      dispose() {
        for (const id of this.timers) this.clearTimer(id)
        this.timers = []
      }
      get pending() {
        return this.timers.length
      }
    }
