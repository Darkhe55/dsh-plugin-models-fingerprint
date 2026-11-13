    class ScrollScheduler {
      constructor({ settleMs = 110, onSettle, setTimer = (fn, ms) => window.setTimeout(fn, ms), clearTimer = (id) => window.clearTimeout(id) } = {}) {
        this.settleMs = settleMs
        this.onSettle = onSettle
        this.setTimer = setTimer
        this.clearTimer = clearTimer
        this.timer = 0
        this.scrolling = false
      }
      noteScroll() {
        this.scrolling = true
        if (this.timer) this.clearTimer(this.timer)
        this.timer = this.setTimer(() => {
          this.timer = 0
          this.scrolling = false
          this.onSettle?.()
        }, this.settleMs)
      }
      markIdle() {
        if (this.timer) this.clearTimer(this.timer)
        this.timer = 0
        this.scrolling = false
      }
      dispose() {
        this.markIdle()
        this.onSettle = null
      }
    }
