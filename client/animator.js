    class SlotAnimator {
      constructor({ eased, reduced, cardWidth }) {
        this.eased = eased
        this.reduced = reduced
        this.cardWidth = cardWidth
      }
      duration(role, scale = 1) {
        const base = role === 'squeeze' ? 380 : role === 'incoming' ? 260 : 340
        return Math.max(100, Math.round(base * (this.reduced ? 0.45 : scale)))
      }
      cancel(node, ids = ['mf-shift', 'mf-enter', 'mf-eject']) {
        if (!node || typeof node.getAnimations !== 'function') return
        for (const animation of node.getAnimations()) {
          if (ids.includes(animation.id)) animation.cancel()
        }
      }
      shift(node, { left, fromTop, fromScale, toTop, toScale, role, motionScale }) {
        if (!node || typeof node.animate !== 'function') return
        this.cancel(node, ['mf-shift'])
        node.animate(
          [
            { transform: 'translate3d(' + left + 'px,' + fromTop + 'px,0) scale(' + fromScale + ')' },
            { transform: 'translate3d(' + left + 'px,' + toTop + 'px,0) scale(' + toScale + ')' },
          ],
          { duration: this.duration(role, motionScale), easing: this.eased, id: 'mf-shift' },
        )
      }
      enter(node, { left, fromTop, fromScale, toTop, toScale, toOpacity = 1, delay, motionScale }) {
        if (!node || typeof node.animate !== 'function') return
        this.cancel(node, ['mf-enter'])
        node.animate(
          [
            { transform: 'translate3d(' + left + 'px,' + fromTop + 'px,0) scale(' + fromScale + ')', opacity: 0 },
            { transform: 'translate3d(' + left + 'px,' + toTop + 'px,0) scale(' + toScale + ')', opacity: toOpacity },
          ],
          { duration: this.duration('incoming', motionScale), easing: this.eased, delay, fill: 'backwards', id: 'mf-enter' },
        )
      }
      eject(node, { fromTransform, fromOpacity, toTransform, motionScale }) {
        if (!node || typeof node.animate !== 'function') return false
        this.cancel(node, ['mf-eject'])
        node.animate(
          [
            { transform: fromTransform, opacity: fromOpacity },
            { transform: toTransform, opacity: 0 },
          ],
          { duration: this.duration('ejecting', motionScale), easing: this.eased, fill: 'forwards', id: 'mf-eject' },
        )
        return true
      }
    }
