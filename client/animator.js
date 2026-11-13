    class SlotAnimator {
      constructor({ eased, reduced, cardWidth }) {
        this.eased = eased
        this.reduced = reduced
        this.cardWidth = cardWidth
        this.states = new WeakMap()
      }
      duration(role, scale = 1) {
        const base = role === 'squeeze' ? 380 : role === 'incoming' ? 260 : 340
        return Math.max(100, Math.round(base * (this.reduced ? 0.45 : scale)))
      }
      animation(node, id) {
        const state = node ? this.states.get(node) : null
        return state && state.id === id ? state.animation : null
      }
      state(node) {
        return node ? this.states.get(node) || null : null
      }
      cancel(node, ids = ['mf-shift', 'mf-enter', 'mf-eject'], options = {}) {
        if (!node) return false
        const state = this.states.get(node)
        if (!state || !ids.includes(state.id)) return false
        if (options.commit !== false) {
          try { state.animation.commitStyles?.() } catch { /* not rendered */ }
        }
        try { state.animation.cancel() } catch { /* already gone */ }
        this.states.delete(node)
        return true
      }
      play(node, { id, key, frames, options }) {
        if (!node || typeof node.animate !== 'function') return null
        const current = this.states.get(node)
        if (current && current.id === id && current.key === key && current.animation.playState !== 'finished') {
          return current.animation
        }
        if (current) this.cancel(node, [current.id])
        let animation
        try {
          animation = node.animate(frames, { ...options, id })
        } catch {
          return null
        }
        const lastFrame = frames[frames.length - 1]
        if (lastFrame && lastFrame.transform) node.style.transform = lastFrame.transform
        if (lastFrame && lastFrame.opacity !== undefined) node.style.opacity = lastFrame.opacity
        const state = { id, key, animation }
        this.states.set(node, state)
        animation.onfinish = () => {
          if (this.states.get(node) === state) this.states.delete(node)
        }
        return animation
      }
      shift(node, { left, fromTop, fromScale, toTop, toScale, role, motionScale }) {
        const key = [role, left, fromTop, fromScale, toTop, toScale, motionScale].map((value) => typeof value === 'number' ? Math.round(value * 10) / 10 : value).join('|')
        return this.play(node, {
          id: 'mf-shift',
          key,
          frames: [
            { transform: 'translate3d(' + left + 'px,' + fromTop + 'px,0) scale(' + fromScale + ')' },
            { transform: 'translate3d(' + left + 'px,' + toTop + 'px,0) scale(' + toScale + ')' },
          ],
          options: { duration: this.duration(role, motionScale), easing: this.eased },
        })
      }
      enter(node, { left, fromTop, fromScale, toTop, toScale, toOpacity = 1, delay, motionScale }) {
        const key = [left, fromTop, fromScale, toTop, toScale, toOpacity, delay, motionScale].map((value) => typeof value === 'number' ? Math.round(value * 10) / 10 : value).join('|')
        return this.play(node, {
          id: 'mf-enter',
          key,
          frames: [
            { transform: 'translate3d(' + left + 'px,' + fromTop + 'px,0) scale(' + fromScale + ')', opacity: 0 },
            { transform: 'translate3d(' + left + 'px,' + toTop + 'px,0) scale(' + toScale + ')', opacity: toOpacity },
          ],
          options: { duration: this.duration('incoming', motionScale), easing: this.eased, delay, fill: 'backwards' },
        })
      }
      eject(node, { fromTransform, fromOpacity, toTransform, motionScale }) {
        const key = [fromTransform, fromOpacity, toTransform, motionScale].join('|')
        const animation = this.play(node, {
          id: 'mf-eject',
          key,
          frames: [
            { transform: fromTransform, opacity: fromOpacity },
            { transform: toTransform, opacity: 0 },
          ],
          options: { duration: this.duration('ejecting', motionScale), easing: this.eased, fill: 'forwards' },
        })
        return Boolean(animation)
      }
    }
