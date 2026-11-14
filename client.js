window.__ModuleLoader__.load({
  id: 'dsh-plugin-model-fingerprint',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const apiBase = () => {
      try {
        const injected = String(window.__dshModelFingerprintApiBase || '').replace(/\/+$/, '')
        if (injected) return injected
        const transport = window.__DSH_TRANSPORT__
        return transport && typeof transport.streamBaseUrl === 'string' ? transport.streamBaseUrl.replace(/\/+$/, '') : ''
      } catch { return '' }
    }
    const apiUrl = (path) => apiBase() + path
    class SlotAnimator {
      constructor({ eased, reduced, cardWidth }) {
        this.eased = eased
        this.reduced = reduced
        this.cardWidth = cardWidth
        this.states = new WeakMap()
      }
      duration(role, scale = 1) {
        if (this.reduced) return 0
        const base = role === 'squeeze' ? 300
          : role === 'pushing' ? 260
            : role === 'incoming' ? 200
              : role === 'ejecting' ? 200
                : 220
        // Fast scrolling may shorten motion, but never to zero.
        return Math.max(120, Math.round(base * scale))
      }
      animation(node, id) {
        const state = node ? this.states.get(node) : null
        return state && state.id === id ? state.animation : null
      }
      state(node) {
        return node ? this.states.get(node) || null : null
      }
      cancelAll(nodes) {
        for (const node of nodes || []) this.cancel(node)
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
      play(node, { id, key, frames, options, onDone }) {
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
        const state = { id, key, animation, onDone }
        this.states.set(node, state)
        animation.onfinish = () => {
          if (this.states.get(node) === state) this.states.delete(node)
          if (typeof onDone === 'function') onDone('finish')
        }
        return animation
      }
      /**
       * FLIP from the rectangle currently on screen. Reading the rectangle is
       * the caller's job before any style write; this method only animates the
       * measured visual position to the new target.
       */
      flip(node, { fromRect, fromOpacity, toTop, toScale, toOpacity, role = 'pushed', motionScale = 1, onDone } = {}) {
        if (!node) return null
        const current = node.getBoundingClientRect ? node.getBoundingClientRect() : null
        const rect = fromRect || current
        const width = node.offsetWidth || this.cardWidth
        const fromTop = rect && Number.isFinite(rect.top) ? rect.top : toTop
        const rawScale = rect && width ? rect.width / width : toScale
        const fromScale = Math.max(0.5, Math.min(1.2, Number.isFinite(rawScale) ? rawScale : toScale))
        const toAlpha = toOpacity === undefined ? 1 : toOpacity
        const fromAlpha = fromOpacity === undefined ? toAlpha : fromOpacity
        const key = [fromTop, fromScale, toTop, toScale, fromAlpha, toAlpha, role, motionScale].map((value) => typeof value === 'number' ? Math.round(value * 10) / 10 : value).join('|')
        return this.play(node, {
          id: 'mf-shift',
          key,
          frames: [
            { transform: 'translate3d(0,' + fromTop + 'px,0) scale(' + fromScale + ')', opacity: fromAlpha },
            { transform: 'translate3d(0,' + toTop + 'px,0) scale(' + toScale + ')', opacity: toAlpha },
          ],
          options: { duration: this.duration(role, motionScale), easing: this.eased },
          onDone,
        })
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
      eject(node, { fromTransform, fromOpacity, toTransform, motionScale, onDone }) {
        const key = [fromTransform, fromOpacity, toTransform, motionScale].join('|')
        const animation = this.play(node, {
          id: 'mf-eject',
          key,
          frames: [
            { transform: fromTransform, opacity: fromOpacity },
            { transform: toTransform, opacity: 0 },
          ],
          options: { duration: this.duration('ejecting', motionScale), easing: this.eased, fill: 'forwards' },
          onDone,
        })
        return Boolean(animation)
      }
    }
    class TurnGeometry {
      /**
       * Choose exactly one canonical reply anchor for a Turn. A Turn can have
       * user, tool, assistant-step and finalized rows; selecting all of them is
       * what produced several disconnected braces in the rail.
       */
      static pickCanonicalRow(rows) {
        const usable = (rows || []).filter((row) => row && Number(row.height) > 0)
        if (!usable.length) return null
        const legacy = usable.filter((row) => row.kind === 'assistant' || row.kind === 'message')
        const replies = usable.filter((row) => row.kind === 'assistant-step'
          && !row.insideProcess
          && row.groupPart !== 'reasoning')
        const nonProcess = usable.filter((row) => row.kind === 'assistant-step' && !row.insideProcess)
        const nonReasoning = usable.filter((row) => row.kind === 'assistant-step' && row.groupPart !== 'reasoning')
        const assistants = usable.filter((row) => row.kind === 'assistant-step')
        const pool = legacy.length ? legacy
          : replies.length ? replies
            : nonProcess.length ? nonProcess
              : nonReasoning.length ? nonReasoning : assistants
        if (!pool.length) return null
        return pool.slice().sort((left, right) => {
          const leftStep = Number.isFinite(Number(left.step)) ? Number(left.step) : -1
          const rightStep = Number.isFinite(Number(right.step)) ? Number(right.step) : -1
          if (leftStep !== rightStep) return rightStep - leftStep
          return (Number(right.order) || 0) - (Number(left.order) || 0)
        })[0]
      }
      static visibleRange(rect, clipTop, clipBottom) {
        if (!rect) return null
        const top = Math.max(Number(rect.top) || 0, Number(clipTop) || 0)
        const bottom = Math.min(Number(rect.bottom) || 0, Number(clipBottom) || 0)
        return bottom > top ? { top, bottom } : null
      }
      static canonicalAnchor(rows, clipTop, clipBottom) {
        const row = TurnGeometry.pickCanonicalRow(rows)
        if (!row) return null
        const range = TurnGeometry.visibleRange(row.rect, clipTop, clipBottom)
        return {
          row,
          anchorTop: range ? range.top : null,
          anchorBottom: range ? range.bottom : null,
        }
      }
      static anchorRight(flowRect, sidebarRight, safeLeft, cardWidth = 176) {
        const safe = Number.isFinite(safeLeft) ? safeLeft : (sidebarRight > 0 ? sidebarRight + 2 : Math.max(8, flowRect.left - 64))
        return Math.min(flowRect.right - 6, Math.max(safe + cardWidth, flowRect.left - 6))
      }
      static isUserNode(node) {
        if (!node || !node.getAttribute) return false
        const kind = String(node.getAttribute('data-chat-flow-kind') || '').toLowerCase()
        if (kind === 'user' || kind.includes('user')) return true
        if (node.matches && node.matches('[data-role="user"], [data-author="user"], [data-message-role="user"]')) return true
        const className = String(node.className || '').toLowerCase()
        return /(^|\s)(user|user-message|message-user|chat-user)(\s|$)/.test(className)
      }
      static responseNodes(nodes) {
        const source = Array.from(nodes || [])
        const result = []
        for (const node of source) {
          if (!node || TurnGeometry.isUserNode(node)) continue
          const kind = String(node.getAttribute && node.getAttribute('data-chat-flow-kind') || '').toLowerCase()
          const hasOwnKind = Boolean(kind)
          let children = []
          let hasUserChild = false
          try {
            hasUserChild = Boolean(node.querySelector && node.querySelector('[data-chat-flow-kind="user"], [data-role="user"], [data-author="user"], [data-message-role="user"], .user, .user-message'))
            children = node.querySelectorAll
              ? [...node.querySelectorAll('[data-chat-flow-kind="assistant"], [data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="message"]')]
              : []
          } catch { children = [] }
          if (children.length && (!hasOwnKind || hasUserChild || kind === 'turn' || kind === 'conversation-turn')) {
            result.push(...children)
            continue
          }
          result.push(node)
        }
        const deduped = []
        for (const node of result) {
          if (!node) continue
          if (deduped.includes(node)) continue
          const covered = deduped.some((other) => other !== node && other.contains && other.contains(node))
          if (!covered) {
            for (let index = deduped.length - 1; index >= 0; index -= 1) {
              if (node.contains && node.contains(deduped[index])) deduped.splice(index, 1)
            }
            deduped.push(node)
          }
        }
        return deduped.length ? deduped : source
      }
      static box(nodes) {
        let top = Infinity
        let bottom = -Infinity
        for (const node of nodes || []) {
          if (!node || !node.getClientRects().length) continue
          const box = node.getBoundingClientRect()
          if (!box.height) continue
          top = Math.min(top, box.top)
          bottom = Math.max(bottom, box.bottom)
        }
        return Number.isFinite(top) && Number.isFinite(bottom) ? { top, bottom } : null
      }
      static measure(rawNodes, clipTop, clipBottom) {
        return TurnGeometry.measureNormalized(TurnGeometry.responseNodes(rawNodes), clipTop, clipBottom)
      }
      static measureNormalized(nodes, clipTop, clipBottom) {
        const union = TurnGeometry.box(nodes)
        if (!union) return null
        const visibleNodes = []
        for (const node of nodes) {
          if (!node.getClientRects().length) continue
          const box = node.getBoundingClientRect()
          if (!box.height) continue
          const visibleTop = Math.max(box.top, clipTop + 4)
          const visibleBottom = Math.min(box.bottom, clipBottom - 4)
          const area = Math.max(0, visibleBottom - visibleTop)
          if (area <= 0) continue
          const kind = node.getAttribute('data-chat-flow-kind') || ''
          visibleNodes.push({ visibleTop, visibleBottom, area, preferred: kind === 'assistant' || kind === 'assistant-step' || kind === 'message' })
        }
        const preferred = visibleNodes.filter((entry) => entry.preferred)
        const anchor = (preferred.length ? preferred : visibleNodes).sort((left, right) => right.area - left.area)[0] || null
        const segments = (preferred.length ? preferred : visibleNodes)
          .slice()
          .sort((left, right) => left.visibleTop - right.visibleTop)
          .slice(0, 3)
          .map((entry) => ({ top: entry.visibleTop, bottom: entry.visibleBottom }))
        return { ...union, visibleNodes, anchor, segments }
      }
      static classify(entry, clipTop, clipBottom, previousZone) {
        const aboveRaw = previousZone === 'top' ? entry.bottom < clipTop + 8 : entry.bottom < clipTop - 2
        const belowRaw = previousZone === 'bottom' ? entry.top > clipBottom - 8 : entry.top > clipBottom + 2
        return { aboveRaw, belowRaw }
      }
    }
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
    const RAIL_TOP_ENTER = 18
    const RAIL_TOP_LEAVE = 30
    const RAIL_BOTTOM_ENTER = 18
    const RAIL_BOTTOM_LEAVE = 30

    function railTurnNumber(value) {
      const number = Number(value)
      return Number.isFinite(number) ? number : null
    }

    /**
     * Pure target derivation. It never mutates the snapshot, refs, DOM or
     * animations. A target can come only from a row measured in this exact
     * frame, and every turn id appears at most once.
     */
    function deriveRailTargets(snapshot, turns, mapping, viewport, previousZones) {
      const clipTop = Number(viewport && viewport.clipTop) || 0
      const clipBottom = Number(viewport && viewport.clipBottom) || 0
      const offset = Number(mapping && mapping.offset) || 0
      const turnByNumber = new Map()
      for (const turn of turns || []) {
        const number = railTurnNumber(turn && turn.turn)
        if (number !== null) turnByNumber.set(number, turn)
      }
      const previous = previousZones || new Map()
      const candidates = []
      const seen = new Set()
      for (const row of (snapshot && snapshot.rows) || []) {
        const domTurn = railTurnNumber(row.domTurn)
        if (domTurn === null) continue
        const turn = turnByNumber.get(domTurn - offset)
        if (!turn || !turn.id || seen.has(turn.id)) continue
        const turnTop = Number(row.turnTop === undefined ? row.top : row.turnTop)
        const turnBottom = Number(row.turnBottom === undefined ? row.bottom : row.turnBottom)
        const anchorFinite = row.anchorTop !== null && row.anchorTop !== undefined
          && row.anchorBottom !== null && row.anchorBottom !== undefined
        const anchorTop = anchorFinite ? Number(row.anchorTop) : null
        const anchorBottom = anchorFinite ? Number(row.anchorBottom) : null
        if (!Number.isFinite(turnTop) || !Number.isFinite(turnBottom) || turnBottom <= turnTop) continue
        seen.add(turn.id)
        const priorZone = previous.get(turn.id) || null
        let zone = 'middle'
        if (priorZone === 'top') {
          if (turnBottom <= clipTop + RAIL_TOP_LEAVE) zone = 'top'
        } else if (turnBottom <= clipTop - RAIL_TOP_ENTER) {
          zone = 'top'
        }
        if (zone === 'middle') {
          if (priorZone === 'bottom') {
            if (turnTop >= clipBottom - RAIL_BOTTOM_LEAVE) zone = 'bottom'
          } else if (turnTop >= clipBottom + RAIL_BOTTOM_ENTER) {
            zone = 'bottom'
          }
        }
        if (zone === 'middle' && !(turnBottom > clipTop && turnTop < clipBottom)) continue
        candidates.push({ turn, row, top: turnTop, bottom: turnBottom, anchorTop, anchorBottom, hasAnchor: anchorFinite, zone })
      }
      let top = null
      let bottom = null
      for (const entry of candidates) {
        if (entry.zone === 'top' && (!top || entry.bottom > top.bottom)) top = entry
        if (entry.zone === 'bottom' && (!bottom || entry.top < bottom.top)) bottom = entry
      }
      const middle = candidates
        .filter((entry) => entry.zone === 'middle' && entry !== top && entry !== bottom && entry.turn.id !== (top && top.turn.id) && entry.turn.id !== (bottom && bottom.turn.id))
        .sort((left, right) => left.top - right.top || railTurnNumber(left.turn.turn) - railTurnNumber(right.turn.turn))
      const ids = new Set()
      if (top) ids.add(top.turn.id)
      if (bottom) ids.add(bottom.turn.id)
      for (const entry of middle) ids.add(entry.turn.id)
      return { top, middle, bottom, ids }
    }

    /**
     * Collision-free middle layout. Space is allowed to run out: cards are
     * selected (center first, with the two boundary cards retained when
     * possible) and the rest are reported as collapsed instead of stacking at
     * the bottom edge and pretending to be visible.
     */
    function layoutMiddleCards(items, { top, bottom, cardHeight, gap = 4 } = {}) {
      const list = (items || [])
        .filter((item) => item && item.id !== undefined)
        .map((item, index) => ({
          ...item,
          index,
          center: Number.isFinite(Number(item.center))
            ? Number(item.center)
            : (Number(item.anchorTop) + Number(item.anchorBottom)) / 2,
        }))
        .sort((left, right) => left.center - right.center || left.index - right.index)
      const available = Math.max(0, Number(bottom) - Number(top))
      const height = Math.max(1, Number(cardHeight) || 1)
      const space = Math.max(0, Number(gap) || 0)
      const capacity = Math.max(0, Math.floor((available + space) / (height + space)))
      if (!list.length || capacity <= 0) {
        return { items: [], collapsed: list.length, collapsedIds: list.map((item) => item.id) }
      }
      let selected = list
      if (list.length > capacity) {
        const keep = new Map()
        const center = available / 2 + Number(top)
        const byCenter = list.slice().sort((left, right) => Math.abs(left.center - center) - Math.abs(right.center - center))
        if (capacity === 1) {
          keep.set(byCenter[0].id, byCenter[0])
        } else {
          keep.set(list[0].id, list[0])
          keep.set(list[list.length - 1].id, list[list.length - 1])
          for (const item of byCenter) {
            if (keep.size >= capacity) break
            keep.set(item.id, item)
          }
        }
        selected = list.filter((item) => keep.has(item.id))
      }
      const positions = selected.map((item) => Math.min(
        Math.max(item.center - height / 2, Number(top)),
        Math.max(Number(top), Number(bottom) - height),
      ))
      let cursor = Number(top)
      for (let index = 0; index < positions.length; index += 1) {
        positions[index] = Math.max(positions[index], cursor)
        cursor = positions[index] + height + space
      }
      if (cursor - space > Number(bottom)) {
        let next = Number(bottom) - height
        for (let index = positions.length - 1; index >= 0; index -= 1) {
          positions[index] = Math.min(positions[index], next)
          next = positions[index] - space - height
        }
        cursor = Number(top)
        for (let index = 0; index < positions.length; index += 1) {
          positions[index] = Math.max(positions[index], cursor)
          cursor = positions[index] + height + space
        }
      }
      const visible = new Set(selected.map((item) => item.id))
      return {
        items: selected.map((item, index) => ({ ...item, top: Math.round(positions[index]) })),
        collapsed: list.length - selected.length,
        collapsedIds: list.filter((item) => !visible.has(item.id)).map((item) => item.id),
      }
    }

    function validateRailTargets(targets) {
      const ids = new Set()
      const check = (target, zone) => {
        if (!target) return
        if (!target.turn || !target.turn.id) throw new Error('target without turn id')
        if (ids.has(target.turn.id)) throw new Error('duplicate target ' + target.turn.id)
        ids.add(target.turn.id)
        if (target.zone !== undefined && target.zone !== zone) throw new Error('target in wrong zone')
      }
      check(targets && targets.top, 'top')
      for (const entry of (targets && targets.middle) || []) check(entry, 'middle')
      check(targets && targets.bottom, 'bottom')
      return targets
    }

    /**
     * Mapping offsets are never chosen by "first candidate". A tie keeps the
     * previous offset, and a new offset needs at least three matches (unless
     * only one or two DOM turns are visible and the previous offset agrees).
     */
    function chooseRailMapping(apiTurns, domTurns, previous) {
      const api = [...new Set((apiTurns || []).map(Number).filter(Number.isFinite))]
      const dom = [...new Set((domTurns || []).map(Number).filter(Number.isFinite))]
      const domSet = new Set(dom)
      const matchCount = (delta) => api.reduce((count, turn) => count + (domSet.has(turn + delta) ? 1 : 0), 0)
      const oldOffset = previous && Number.isFinite(previous.offset) ? Number(previous.offset) : 0
      const oldScore = matchCount(oldOffset)
      if (dom.length <= 2) {
        if (previous && previous.confidence > 0) return { offset: oldOffset, confidence: Math.min(0.7, previous.confidence), score: oldScore }
        const direct = matchCount(0)
        return { offset: 0, confidence: direct > 0 ? 0.7 : 0, score: direct }
      }
      // `data-chat-turn` is the official Turn number. Never infer an arbitrary
      // offset from pairwise arithmetic: with a loaded window of 700–800 and a
      // visible DOM range of 80–90 that would map 80 onto 787 and hide the real
      // 80–90 fingerprints. Only the identity offset or an already-confirmed
      // previous offset may be used.
      const direct = matchCount(0)
      let bestOffset = oldOffset
      let bestScore = oldScore
      let tie = false
      if (direct > bestScore) {
        bestOffset = 0
        bestScore = direct
      } else if (direct === bestScore && bestOffset !== 0) {
        tie = true
      }
      if (bestScore < 2) return { offset: oldOffset, confidence: oldScore > 0 ? (previous.confidence || 0.6) : 0, score: oldScore, tie }
      if (tie) return { offset: oldOffset, confidence: previous && previous.confidence ? previous.confidence : 0, score: oldScore, tie }
      return { offset: bestOffset, confidence: bestScore >= 3 ? 1 : 0.6, score: bestScore, tie }
    }

    function railJumpDetected(previous, next, options = {}) {
      if (options.flowChanged) return 'flow'
      const delta = Number(options.scrollDelta)
      if (Number.isFinite(delta) && Math.abs(delta) > (options.threshold || 180)) return 'scroll'
      const before = new Set((previous && previous.rows ? previous.rows : []).map((row) => Number(row.domTurn)))
      const after = new Set((next && next.rows ? next.rows : []).map((row) => Number(row.domTurn)))
      if (!before.size || !after.size) return null
      let common = 0
      for (const value of before) if (after.has(value)) common += 1
      const union = before.size + after.size - common
      if (!common) return 'no-common-turn'
      if (union && common / union < (options.minOverlap || 0.2)) return 'visible-set'
      return null
    }

    class RailSnapshotTracker {
      constructor({ maxWaitMs = 600 } = {}) {
        this.maxWaitMs = maxWaitMs
        this.reset()
      }
      reset() {
        this.signature = ''
        this.count = 0
        this.startedAt = null
      }
      observe(signature, now = Date.now()) {
        if (this.startedAt === null) this.startedAt = now
        if (signature && signature === this.signature) this.count += 1
        else {
          this.signature = signature
          this.count = 1
        }
        const waited = now - this.startedAt
        return {
          stable: this.count >= 2 || waited >= this.maxWaitMs,
          timedOut: waited >= this.maxWaitMs,
          count: this.count,
          waited,
        }
      }
    }
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
    /**
     * Official lifecycle hints from `conversation.chat.turnTail`. This is not a
     * visible-turn source: the slot only mounts completed Turn tails. It is a
     * stable mount/unmount signal and a turn-number authority, used to wake the
     * rail adapter without trusting recycled DOM attributes.
     */
    class OfficialTurnRegistry {
      constructor() {
        this.entries = new Map()
        this.listeners = new Set()
        this.version = 0
      }
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }
      emit() {
        this.version += 1
        for (const listener of this.listeners) {
          try { listener(this.version) } catch { /* one listener must not break lifecycle tracking */ }
        }
      }
      add(turn, entry) {
        const number = Number(turn)
        if (!Number.isFinite(number)) return () => {}
        const token = { turn: number, ...entry }
        this.entries.set(number, token)
        this.emit()
        return () => {
          if (this.entries.get(number) === token) {
            this.entries.delete(number)
            this.emit()
          }
        }
      }
      get(turn) {
        return this.entries.get(Number(turn)) || null
      }
      turns() {
        return [...this.entries.keys()]
      }
      dispose() {
        this.entries.clear()
        this.listeners.clear()
      }
    }

    const officialTurnRegistry = new OfficialTurnRegistry()

    /**
     * Zero-layout probe mounted by the official Turn-tail slot. The parent
     * `[data-chat-turn]` is observed, never cached as a geometry source.
     */
    function TurnLifecycleProbe(props) {
      const markerRef = React.useRef(null)
      const turnNumber = Number(props && props.turn && props.turn.turn)
      const seq = Number(props && props.seq) || 0
      React.useEffect(() => {
        const marker = markerRef.current
        if (!marker || !Number.isFinite(turnNumber)) return undefined
        // No DOM node is retained: the official slot is only a mount/unmount
        // and turn-number signal. Geometry is always taken from the current
        // adapter snapshot.
        return officialTurnRegistry.add(turnNumber, { seq })
      }, [turnNumber, seq])
      return h('span', {
        ref: markerRef,
        'data-mf-turn-probe': Number.isFinite(turnNumber) ? String(turnNumber) : '',
        'aria-hidden': 'true',
        style: { display: 'contents' },
      })
    }
    /**
     * DOM compatibility adapter. DSH 0.2.2-rc.3 exposes the official
     * `conversation.chat.turnTail` slot for completed-turn lifecycle, but no
     * public visible-turn/scroll hook. Geometry and viewport reads therefore
     * stay here, behind one interface, instead of being scattered through the
     * rail. The official registry only wakes this adapter; it never substitutes
     * for a current-frame DOM measurement.
     */
    class VisibleTurnAdapter {
      constructor({ registry = officialTurnRegistry, onDirty } = {}) {
        this.registry = registry
        this.onDirty = typeof onDirty === 'function' ? onDirty : () => {}
        this.listeners = new Set()
        this.observer = null
        this.resizeObserver = null
        this.observedFlow = null
        this.unsubscribeRegistry = registry && typeof registry.subscribe === 'function'
          ? registry.subscribe(() => this.emit())
          : null
      }
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }
      emit() {
        this.onDirty()
        for (const listener of this.listeners) {
          try { listener() } catch { /* one adapter subscriber must not stop the rail */ }
        }
      }
      getFlow() {
        const candidates = [...document.querySelectorAll('[data-slot="conversation.chat.flow"], [data-chat-flow]')]
        const usable = (node) => {
          if (!node || !node.getBoundingClientRect) return false
          const box = node.getBoundingClientRect()
          if (box.width < 320 || box.height < 120) return false
          if (node.closest('aside, nav, [data-slot*="sidebar"], [class*="sidebar"], [class*="workspace"]')) return false
          return node.querySelectorAll('[data-chat-turn]').length > 0
        }
        const preferred = candidates.find((node) => node.matches('[data-slot="conversation.chat.flow"]') && usable(node))
        if (preferred) return preferred
        let best = null
        let bestWidth = Infinity
        for (const candidate of candidates) {
          if (!usable(candidate)) continue
          const width = candidate.getBoundingClientRect().width
          if (width < bestWidth) {
            best = candidate
            bestWidth = width
          }
        }
        if (best) return best
        let cursor = document.querySelector('[data-slot="conversation.chat.flow"] [data-chat-turn], main [data-chat-turn], [data-chat-turn]')
        while (cursor && cursor !== document.body) {
          if (!cursor.closest('aside, nav, [data-slot*="sidebar"], [class*="sidebar"], [class*="workspace"]') && cursor.querySelectorAll('[data-chat-turn]').length) return cursor
          cursor = cursor.parentElement
        }
        return null
      }
      measureViewport(flow) {
        const flowRect = flow.getBoundingClientRect()
        let sidebarRight = 0
        for (const node of document.querySelectorAll('aside, nav, [data-slot*="sidebar"], [class*="sidebar"]')) {
          const box = node.getBoundingClientRect()
          if (box.width >= 150 && box.height >= 280 && box.height <= window.innerHeight + 4 && box.right <= flowRect.left + 2) {
            sidebarRight = Math.max(sidebarRight, box.right)
          }
        }
        let clipTop = 0
        let clipBottom = window.innerHeight
        let scrollContainer = null
        let container = flow.parentElement
        while (container && container !== document.body) {
          const style = window.getComputedStyle(container)
          const box = container.getBoundingClientRect()
          if (/(auto|scroll)/.test(style.overflowY) && box.height > 180) {
            clipTop = Math.max(0, box.top)
            clipBottom = Math.min(window.innerHeight, box.bottom)
            scrollContainer = container
            break
          }
          container = container.parentElement
        }
        if (clipBottom - clipTop < 120) {
          clipTop = Math.max(0, flowRect.top)
          clipBottom = Math.min(window.innerHeight, flowRect.bottom)
        }
        if (clipBottom - clipTop < 120) {
          clipTop = 0
          clipBottom = window.innerHeight
        }
        let composerTop = null
        const composerSeat = document.querySelector('[data-composer-seat]')
        if (composerSeat) {
          const box = composerSeat.getBoundingClientRect()
          if (box.height > 20 && box.top > clipTop + 60) {
            composerTop = box.top
            clipBottom = Math.min(clipBottom, box.top - 8)
          }
        }
        const safeLeft = sidebarRight > 0 ? sidebarRight + 2 : Math.max(8, flowRect.left - 64)
        const gap = flowRect.left - sidebarRight
        const cardWidth = 176
        const compact = gap < cardWidth + 24 || (sidebarRight === 0 && flowRect.left < cardWidth * 2)
        const anchorRight = TurnGeometry.anchorRight(flowRect, sidebarRight, safeLeft, cardWidth)
        return {
          ready: true,
          flowIdentity: flow,
          flowRect,
          left: anchorRight,
          right: Math.max(6, window.innerWidth - anchorRight),
          anchorRight,
          clipTop,
          clipBottom,
          composerTop,
          scrollContainer,
          compact,
          sidebarRight,
          flowLeft: flowRect.left,
          flowWidth: flowRect.width,
        }
      }
      capture(flow, layout) {
        const raw = []
        let invalid = false
        let order = 0
        for (const node of flow.querySelectorAll('[data-chat-turn]')) {
          const value = node.getAttribute('data-chat-turn')
          const domTurn = Number(value)
          if (!Number.isFinite(domTurn)) continue
          if (node.getAttribute('data-chat-turn') !== value) {
            invalid = true
            break
          }
          if (!node.getClientRects || !node.getClientRects().length) continue
          const rect = node.getBoundingClientRect()
          if (!rect || !rect.height) continue
          const kind = String(node.getAttribute('data-chat-flow-kind') || '').toLowerCase()
          const processRoot = node.closest ? node.closest('[data-chat-flow-kind="turn-process"], [data-step-process]') : null
          const groupPart = node.getAttribute('data-chat-group-part') || null
          const nodeKey = node.getAttribute('data-chat-node-key') || ''
          const stepPart = nodeKey.includes(':') ? Number(nodeKey.slice(nodeKey.lastIndexOf(':') + 1)) : null
          raw.push({
            node,
            domTurn,
            value,
            kind,
            groupPart,
            step: Number.isFinite(stepPart) ? stepPart : null,
            insideProcess: Boolean(processRoot && processRoot !== node),
            rect,
            height: rect.height,
            order: order++,
          })
        }
        if (invalid) return { invalid: true, flow, rows: [], domTurns: [], signature: '' }
        const groups = new Map()
        for (const row of raw) {
          if (!groups.has(row.domTurn)) groups.set(row.domTurn, [])
          groups.get(row.domTurn).push(row)
        }
        const rows = []
        for (const [domTurn, group] of groups) {
          for (const row of group) {
            if (row.node.getAttribute('data-chat-turn') !== row.value) {
              invalid = true
              break
            }
          }
          if (invalid) break
          const canonical = TurnGeometry.canonicalAnchor(group, layout.clipTop, layout.clipBottom)
          const turnTop = Math.min(...group.map((row) => row.rect.top))
          const turnBottom = Math.max(...group.map((row) => row.rect.bottom))
          const anchorRow = canonical ? canonical.row : null
          const anchorNode = anchorRow ? anchorRow.node : group[0].node
          let anchorTop = canonical ? canonical.anchorTop : null
          let anchorBottom = canonical ? canonical.anchorBottom : null
          let anchorRect = anchorRow ? anchorRow.rect : { top: turnTop, bottom: turnBottom, height: turnBottom - turnTop }
          if (!anchorRow) {
            // A turn with no Assistant reply falls back to the whole turn, but
            // only its visible portion may become a range.
            anchorTop = Math.max(turnTop, layout.clipTop + 4)
            anchorBottom = Math.min(turnBottom, layout.clipBottom - 4)
            if (!(anchorBottom > anchorTop)) anchorTop = anchorBottom = null
            anchorRect = { top: turnTop, bottom: turnBottom, height: turnBottom - turnTop }
          }
          rows.push({
            domTurn,
            anchorNode,
            anchorKind: anchorRow ? anchorRow.kind : 'turn',
            anchorStep: anchorRow ? anchorRow.step : null,
            anchorTop,
            anchorBottom,
            turnTop,
            turnBottom,
            rect: anchorRect,
          })
        }
        rows.sort((left, right) => left.turnTop - right.turnTop || left.domTurn - right.domTurn)
        const domTurns = rows.map((row) => row.domTurn)
        const signature = rows.map((row) => [
          row.domTurn,
          row.anchorKind,
          row.anchorStep === null ? '' : row.anchorStep,
          Math.round(row.turnTop),
          Math.round(row.turnBottom),
          Math.round(row.anchorTop),
          Math.round(row.anchorBottom),
        ].join(':')).join('|')
        return { flow, rows, domTurns, signature, time: performance.now() }
      }
      observe(flow) {
        if (!flow || this.observedFlow === flow) return
        this.disconnectObservers()
        this.observedFlow = flow
        if (typeof MutationObserver === 'function') {
          this.observer = new MutationObserver(() => this.emit())
          this.observer.observe(flow, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['hidden', 'data-chat-turn', 'data-chat-flow-kind', 'data-chat-group-part'],
          })
        }
        if (typeof ResizeObserver === 'function') {
          this.resizeObserver = new ResizeObserver(() => this.emit())
          this.resizeObserver.observe(flow)
        }
      }
      disconnectObservers() {
        if (this.observer) this.observer.disconnect()
        if (this.resizeObserver) this.resizeObserver.disconnect()
        this.observer = null
        this.resizeObserver = null
        this.observedFlow = null
      }
      dispose() {
        this.disconnectObservers()
        if (this.unsubscribeRegistry) this.unsubscribeRegistry()
        this.unsubscribeRegistry = null
        this.listeners.clear()
      }
    }
    const listeners = new Set()
    let open = false
    let railOn = false
    let railSessionId = null
    let canvasOpen = false
    let sessionViewRevision = 0
    let sessionViewStatus = 'unknown'
    let canvasProbe = []
    let latestTurnSummary = null
    let railDebug = { flow: false, flowTurns: 0, turns: 0, cards: 0, reason: 'init' }
    let lastFetchError = null
    let commandError = null
    const CLIENT_BUILD = '2026-11-14-4'
    try { railOn = window.localStorage.getItem('dsh.mf.rail') === '1' } catch { /* private mode */ }
    window.__dshModelFingerprintRailState = { on: railOn, sessionId: railSessionId }
    window.__dshModelFingerprintPanelOpen = open

    const emit = () => {
      for (const listener of listeners) {
        try { listener() } catch { /* one listener must not break the rest */ }
      }
    }
    const publishRail = () => {
      window.__dshModelFingerprintRailState = { on: railOn, sessionId: railSessionId }
      window.dispatchEvent(new window.CustomEvent('dsh-mf-rail', { detail: { on: railOn, sessionId: railSessionId } }))
    }
    const setOpen = (value) => {
      open = Boolean(value)
      window.__dshModelFingerprintPanelOpen = open
      try { window.localStorage.setItem('dsh.mf.open', open ? '1' : '0') } catch { /* private mode */ }
      window.dispatchEvent(new window.CustomEvent('dsh-mf-panel', { detail: { open } }))
      emit()
    }
    const setRailOn = (value) => {
      const next = Boolean(value)
      const changed = next !== railOn
      railOn = next
      try { window.localStorage.setItem('dsh.mf.rail', railOn ? '1' : '0') } catch { /* private mode */ }
      publishRail()
      emit()
      if (changed) requestBackfill()
    }
    let backfillRunning = false
    const requestBackfill = () => {
      if (backfillRunning) return
      const token = window.__dshModelFingerprintToken
      if (!token) return
      backfillRunning = true
      fetch(apiUrl('/model-fingerprint/api/backfill'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mf-token': token },
        body: '{}',
        cache: 'no-store',
      })
        .then((response) => {
          if (!response.ok) throw new Error('backfill HTTP ' + response.status)
          return response.json()
        })
        .catch((error) => {
          lastFetchError = error && error.message ? error.message : String(error)
        })
        .finally(() => { backfillRunning = false })
    }
    const setRailSession = (sessionId) => {
      railSessionId = sessionId || null
      publishRail()
      emit()
    }
    const setLatestTurnSummary = (value) => {
      const next = value
        ? {
            id: value.id || null,
            turn: value.turn,
            verdict: value.verdict || 'first',
            verdictLabel: value.verdictLabel || '',
            primaryShort: value.primaryShort || '',
            primaryModel: value.primaryModel || '',
            hasModelData: Boolean(value.primaryFingerprint || value.primaryShort),
          }
        : null
      const previous = latestTurnSummary
      const same = JSON.stringify(previous) === JSON.stringify(next)
      if (same) return
      latestTurnSummary = next
      emit()
    }
    const useOpen = () => {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        listeners.add(force)
        return () => listeners.delete(force)
      }, [])
      return open
    }
    const useRailOn = () => {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        listeners.add(force)
        return () => listeners.delete(force)
      }, [])
      return railOn
    }
    const useRailSession = () => {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        listeners.add(force)
        return () => listeners.delete(force)
      }, [])
      return railSessionId
    }
    const useLatestTurn = () => {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        listeners.add(force)
        return () => listeners.delete(force)
      }, [])
      return latestTurnSummary
    }
    const useCanvasOpen = () => {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        listeners.add(force)
        return () => listeners.delete(force)
      }, [])
      return canvasOpen
    }
    const detectCanvasOpen = () => {
      try {        const nodes = document.querySelectorAll('.dshcv-root, .dshcv-head')
        canvasProbe = []
        for (const node of nodes) {
          const rect = node.getBoundingClientRect()
          const style = window.getComputedStyle(node)
          canvasProbe.push({
            className: String(node.className || '').slice(0, 60),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            top: Math.round(rect.top),
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
          })
          if (node.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05 && rect.width > 80 && rect.height > 20) return true
        }
      } catch { /* canvas plugin is optional */ }
      return false
    }

    const styles = {
      dock: {
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        padding: '0 2px',
        pointerEvents: 'auto',
      },
      toggle: {
        appearance: 'none',
        border: 0,
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 5px',
        fontSize: 11,
        lineHeight: '18px',
        cursor: 'pointer',
        borderRadius: 6,
      },
      panelButton: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2, #d0d5dd)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        padding: '2px 7px',
        fontSize: 11,
        lineHeight: '16px',
        cursor: 'pointer',
        borderRadius: 6,
      },
      track: (on) => ({
        width: 26,
        height: 14,
        borderRadius: 999,
        background: on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l3)',
        position: 'relative',
        transition: 'background .15s ease',
        flex: '0 0 auto',
      }),
      knob: (on) => ({
        position: 'absolute',
        top: 2,
        left: on ? 14 : 2,
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: '#fff',
        transition: 'left .15s ease',
        boxShadow: '0 1px 2px rgba(0,0,0,.25)',
      }),
      mask: {
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        background: 'rgba(8, 12, 20, .42)',
        backdropFilter: 'blur(3px)',
        pointerEvents: 'auto',
      },
      panel: {
        width: 'min(1280px, 96vw)',
        height: 'min(90vh, 920px)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: 16,
        background: 'var(--dsw-specific-menu, #fff)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(20,30,45,.16))',
        boxShadow: '0 24px 80px rgba(16,24,40,.36)',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #e7ebf0)',
        flex: '0 0 auto',
      },
      title: { minWidth: 0 },
      h1: { margin: 0, fontSize: 13, lineHeight: '19px', fontWeight: 650, letterSpacing: '-.01em', color: 'var(--dsw-alias-label-primary, #1b1f24)' },
      sub: { marginTop: 1, fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #667085)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      actions: { display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' },
      action: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2, #d0d5dd)',
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'var(--dsw-alias-label-primary, #344054)',
        borderRadius: 8,
        padding: '5px 9px',
        fontSize: 11,
        lineHeight: '16px',
        cursor: 'pointer',
      },
      close: {
        appearance: 'none',
        border: 0,
        background: 'var(--dsw-alias-interactive-bg-hover, #f2f4f7)',
        color: 'var(--dsw-alias-label-secondary, #667085)',
        borderRadius: 8,
        width: 28,
        height: 28,
        cursor: 'pointer',
        fontSize: 16,
        lineHeight: 1,
      },
      frame: { width: '100%', flex: '1 1 auto', minHeight: 0, border: 0, background: 'var(--dsw-alias-bg-base, #f5f6f8)' },
    }

    function Overlay() {
      const visible = useOpen()
      React.useEffect(() => {
        if (!visible) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [visible])
      if (!visible) return null
      return h('div', {
        style: styles.mask,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) setOpen(false)
        },
      }, h('div', { style: styles.panel, role: 'dialog', 'aria-modal': 'true', 'aria-label': '逐轮模型指纹' },
        h('div', { style: styles.head },
          h('div', { style: styles.title },
            h('div', { style: styles.h1 }, '逐轮模型指纹'),
            h('div', { style: styles.sub }, '每次会话每一轮单独检测 · 对比上一轮的协议指纹与行为'),
          ),
          h('div', { style: styles.actions },
            h('button', {
              type: 'button',
              style: styles.close,
              title: '关闭',
              'aria-label': '关闭',
              onClick: () => setOpen(false),
            }, '×'),
          ),
        ),
        h('iframe', {
          src: apiUrl('/model-fingerprint?embed=1&tab=turns'),
          style: styles.frame,
          title: '逐轮模型指纹检测',
        }),
      ))
    }

    const railColors = {
      same: '#0f8a5f',
      changed: '#dc2626',
      mixed: '#d97706',
      generation: '#2f6fed',
      first: '#98a2b3',
    }

    function TurnRailFast() {
      const on = useRailOn()
      const sessionId = useRailSession()
      const canvasOpen = useCanvasOpen()
      const [turns, setTurns] = React.useState([])
      const [hasMore, setHasMore] = React.useState(false)
      const [renderTurns, setRenderTurns] = React.useState([])
      const [compact, setCompact] = React.useState(false)
      const [clip, setClip] = React.useState({ top: 0, bottom: 0 })
      const [flowReady, setFlowReady] = React.useState(true)
      const railRef = React.useRef(null)
      const placeholderRef = React.useRef(null)
      const cardRefs = React.useRef(new Map())
      const visual = React.useRef(new Map())
      const committed = React.useRef(new Map())
      const absent = React.useRef(new Map())
      const exiting = React.useRef(new Map())
      const renderTurnsRef = React.useRef([])
      const loadedSessionRef = React.useRef(null)
      const turnsKey = React.useRef('')
      const turnsRef = React.useRef([])
      const turnByNumber = React.useRef(new Map())
      const dataCache = React.useRef(new Map())
      const dataRevision = React.useRef(0)
      const batchDisabled = React.useRef(false)
      const turnWindow = React.useRef(new TurnWindowStore())
      const hasMoreRef = React.useRef(false)
      const autoPreloadRef = React.useRef(false)
      const loadOlderRef = React.useRef(null)
      const refreshRef = React.useRef(null)
      const scheduleRef = React.useRef(null)
      const requestView = React.useRef({ sessionId: null, revision: 0, generation: '0', epoch: 0 })
      const geometry = React.useRef({ ready: false, right: 0, anchorRight: 0, offset: 0, clipTop: 0, clipBottom: 0, compact: false })
      const mapping = React.useRef({ offset: 0, confidence: 0, generation: 0, flowIdentity: null })
      const jump = React.useRef({ pending: false, generation: 0, at: 0 })
      const tracker = React.useRef(null)
      const recovery = React.useRef({ timer: 0, attempt: 0, deadline: 0, reason: null })
      const recoveryEvent = React.useRef(null)
      const scrollDirection = React.useRef(1)
      const placeholderPosition = React.useRef({ right: 0, top: -9999, visible: false })

      const applyTurns = (next) => {
        const list = Array.isArray(next) ? next : []
        turnsRef.current = list
        const map = new Map()
        for (const turn of list) {
          const number = Number(turn && turn.turn)
          if (Number.isFinite(number)) map.set(number, turn)
        }
        turnByNumber.current = map
        setTurns(list)
      }

      React.useEffect(() => {
        const latest = turns.length
          ? turns.slice().sort((left, right) => Number(right.turn) - Number(left.turn))[0]
          : null
        setLatestTurnSummary(latest)
      }, [turns])

      React.useEffect(() => {
        const targetSession = sessionId || null
        if (loadedSessionRef.current !== targetSession) {
          loadedSessionRef.current = targetSession
          turnsKey.current = ''
          turnWindow.current.reset()
          hasMoreRef.current = false
          setHasMore(false)
          applyTurns([])
          dataCache.current.clear()
          dataRevision.current = 0
          batchDisabled.current = false
          setRenderTurns([])
          renderTurnsRef.current = []
          cardRefs.current.clear()
          visual.current.clear()
          committed.current.clear()
          absent.current.clear()
          exiting.current.clear()
          geometry.current = { ready: false, right: 0, anchorRight: 0, offset: 0, clipTop: 0, clipBottom: 0, compact: false }
          mapping.current = { offset: 0, confidence: 0, generation: 0, flowIdentity: null }
          jump.current = { pending: false, generation: 0, at: 0 }
          recovery.current = { timer: 0, attempt: 0, deadline: 0, reason: null }
          placeholderPosition.current = { right: 0, top: -9999, visible: false }
          sessionViewRevision = 0
          sessionViewStatus = 'loading'
          const token = requestView.current
          token.sessionId = targetSession
          token.generation = '0'
          token.epoch += 1
        }
        let cancelled = false
        let timer = null
        let requestSeq = 0
        let controller = null
        const load = async () => {
          if (controller) controller.abort()
          controller = typeof AbortController === 'function' ? new AbortController() : null
          const seq = ++requestSeq
          const signal = controller ? controller.signal : undefined
          let target = sessionId
          if (!target) {
            try {
              const response = await fetch(apiUrl('/model-fingerprint/api/status?limit=1'), { cache: 'no-store', signal })
              if (response.ok) {
                const status = await response.json()
                if (cancelled || seq !== requestSeq) return
                target = status && status.latest && status.latest.session ? status.latest.session.id : null
                if (target) setRailSession(target)
              }
            } catch { /* status is best effort */ }
          }
          if (!target || cancelled || seq !== requestSeq) return
          try {
            let response = null
            let legacy = false
            try {
              response = await fetch(apiUrl('/model-fingerprint/api/session-view?id=' + encodeURIComponent(target) + '&limit=200'), { cache: 'no-store', signal })
            } catch (error) {
              if (cancelled || seq !== requestSeq) return
              response = null
            }
            if (!response || response.status === 404 || !response.ok) {
              legacy = true
              response = await fetch(apiUrl('/model-fingerprint/api/session?id=' + encodeURIComponent(target) + '&limit=200'), { cache: 'no-store', signal })
            }
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const payload = await response.json()
            if (cancelled || seq !== requestSeq) return
            if (payload.sessionId && String(payload.sessionId) !== String(target)) return
            if (requestView.current.sessionId && String(requestView.current.sessionId) !== String(target)) return
            const generation = payload.generation === undefined ? requestView.current.generation : String(payload.generation)
            if (requestView.current.generation !== '0' && generation !== requestView.current.generation) {
              // A server generation change is a reset, not a merge.
              turnWindow.current.reset()
              turnsKey.current = ''
            }
            requestView.current.sessionId = target
            requestView.current.generation = generation
            requestView.current.revision = Number(payload.revision) || 0
            lastFetchError = null
            sessionViewRevision = legacy ? 0 : Number(payload.revision) || 0
            sessionViewStatus = legacy ? 'legacy' : String(payload.status || 'unknown')
            const next = Array.isArray(payload.turns) ? payload.turns : []
            const seen = new Set()
            for (const turn of next) {
              if (!turn || turn.id === undefined || seen.has(turn.id)) throw new Error('duplicate turn in API payload')
              seen.add(turn.id)
            }
            const merged = turnWindow.current.merge(next)
            dataRevision.current = Number(payload.revision) || 0
            for (const turn of merged) {
              dataCache.current.set(Number(turn.turn), { status: 'observed', turn, revision: dataRevision.current })
            }
            const key = merged.map((turn) => turn.id + ':' + turn.steps + ':' + turn.endTime + ':' + turn.primaryFingerprint).join('|')
            if (key !== turnsKey.current) {
              turnsKey.current = key
              applyTurns(merged)
              recoveryEvent.current?.()
            }
            hasMoreRef.current = payload.hasMore === true
            setHasMore(payload.hasMore === true)
          } catch (error) {
            if (!cancelled && seq === requestSeq) {
              lastFetchError = error && error.message ? error.message : String(error)
              // Keep the last successful turn list. A transient fetch failure or
              // a history remount must not blank every already-rendered card.
            }
          }
        }
        load()
        let loadingOlder = false
        const loadOlder = async () => {
          if (loadingOlder || !hasMoreRef.current) return
          const oldest = turnsRef.current[turnsRef.current.length - 1]
          if (!oldest || !Number.isFinite(Number(oldest.turn))) return
          loadingOlder = true
          const target = railSessionId || sessionId
          const epoch = requestView.current.epoch
          const generation = requestView.current.generation
          const revision = requestView.current.revision
          try {
            if (!target) return
            const response = await fetch(apiUrl('/model-fingerprint/api/session-view?id=' + encodeURIComponent(target) + '&limit=200&before=' + encodeURIComponent(String(oldest.turn))), { cache: 'no-store' })
            if (!response.ok) return
            const payload = await response.json()
            if (epoch !== requestView.current.epoch || String(target) !== String(requestView.current.sessionId)) return
            if (payload.sessionId && String(payload.sessionId) !== String(target)) return
            if (generation !== '0' && payload.generation !== undefined && String(payload.generation) !== String(generation)) return
            if (payload.revision !== undefined && Number(payload.revision) < Number(revision)) return
            const next = Array.isArray(payload.turns) ? payload.turns : []
            if (next.length) {
              const merged = turnWindow.current.merge(next)
              for (const turn of next) dataCache.current.set(Number(turn.turn), { status: 'observed', turn, revision: Number(payload.revision) || 0 })
              applyTurns(merged)
            }
            hasMoreRef.current = payload.hasMore === true
            setHasMore(payload.hasMore === true)
          } catch (error) {
            lastFetchError = error && error.message ? error.message : String(error)
          } finally {
            loadingOlder = false
          }
        }
        loadOlderRef.current = loadOlder
        refreshRef.current = () => { turnsKey.current = ''; load() }
        timer = setInterval(load, 4000)
        return () => {
          cancelled = true
          requestSeq += 1
          requestView.current.epoch += 1
          if (controller) controller.abort()
          if (timer) clearInterval(timer)
        }
      }, [sessionId])

      React.useEffect(() => {
        if (!on) return undefined
        refreshRef.current?.()
        const timer = window.setTimeout(() => {
          loadOlderRef.current?.()
        }, 420)
        return () => window.clearTimeout(timer)
      }, [on])

      React.useEffect(() => {
        if (!on) {
          autoPreloadRef.current = false
          return
        }
        if (hasMore && !autoPreloadRef.current) {
          autoPreloadRef.current = true
          loadOlderRef.current?.()
        }
      }, [on, hasMore])

      React.useEffect(() => {
        if (!on) {
          railDebug = { flow: false, flowTurns: 0, turns: 0, cards: 0, reason: 'off' }
          setFlowReady(false)
          return undefined
        }
        let raf = 0
        let rebuildPending = false
        let tick = null
        let disposed = false

        tracker.current = new RailSnapshotTracker({ maxWaitMs: 600 })
        const beginJump = (reason) => {
          const fromSignature = tracker.current ? tracker.current.signature : ''
          jump.current = { pending: true, generation: jump.current.generation + 1, at: performance.now(), reason, fromSignature }
          tracker.current.reset()
          animator.cancelAll(cardRefs.current.values())
          turnQueue.invalidate()
          windowQueue.invalidate()
          noteRecoveryEvent()
        }

        const setStyle = (node, property, value) => {
          if (!node) return
          if (!node.__mfStyles) node.__mfStyles = {}
          if (node.__mfStyles[property] === value) return
          node.__mfStyles[property] = value
          node.style[property] = value
        }
        const setTransition = (node, value) => {
          if (!node || node.__mfTransition === value) return
          node.__mfTransition = value
          node.style.transition = value
        }
        const reducedMotion = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
        let motionEase = 'cubic-bezier(.22,1,.36,1)'
        try {
          const token = window.getComputedStyle(document.documentElement).getPropertyValue('--dsh-motion-ease-out').trim()
          if (token) motionEase = token
        } catch { /* older host: keep the official transform curve */ }
        const spring = reducedMotion ? 'ease-out' : motionEase
        const animator = new SlotAnimator({ eased: spring, reduced: reducedMotion, cardWidth: 176 })
        const scrollScheduler = new ScrollScheduler({
          settleMs: 110,
          onSettle: () => schedule(true, { settle: true }),
        })
        const turnQueue = new TurnRequestQueue({
          fetchTurn: (turn, context) => {
            const target = context && context.sessionId ? context.sessionId : (sessionId || railSessionId)
            if (!target) return null
            return fetch(apiUrl('/model-fingerprint/api/turn-view?id=' + encodeURIComponent(target) + '&turn=' + encodeURIComponent(turn)), { cache: 'no-store' })
              .then((response) => response.ok ? response.json() : null)
              .then((payload) => payload ? { ...payload, requestedTurn: turn } : null)
          },
          onNoData: (payload) => {
            if (disposed) return
            const turn = Number(payload && payload.requestedTurn)
            if (!Number.isFinite(turn)) return
            const status = payload.status === 'no-data' ? 'no-data' : 'missing'
            dataCache.current.set(turn, { status, revision: requestView.current.revision })
            schedule(true)
          },
          onTurn: (turn, payload) => {
            if (disposed || !turn || turn.hasModelData === false) return
            const current = requestView.current
            if (payload && payload.sessionId && current.sessionId && String(payload.sessionId) !== String(current.sessionId)) return
            if (payload && payload.generation !== undefined && String(current.generation) !== '0' && String(payload.generation) !== String(current.generation)) return
            if (payload && Number(payload.revision) < Number(current.revision)) return
            const merged = turnWindow.current.merge([turn])
            dataCache.current.set(Number(turn.turn), { status: 'observed', turn, revision: requestView.current.revision })
            applyTurns(merged)
            noteRecoveryEvent()
            schedule(true)
          },
        })

        const windowQueue = new TurnWindowQueue({
          fetchWindow: (values, context, signal) => {
            const target = context && context.sessionId ? context.sessionId : (sessionId || railSessionId)
            if (!target) return null
            return fetch(apiUrl('/model-fingerprint/api/turn-window?id=' + encodeURIComponent(target) + '&turns=' + encodeURIComponent(values.join(','))), { cache: 'no-store', signal })
          },
          onResult: (payload) => {
            if (disposed) return
            const current = requestView.current
            if (payload.sessionId && current.sessionId && String(payload.sessionId) !== String(current.sessionId)) return
            if (payload.generation !== undefined && String(current.generation) !== '0' && String(payload.generation) !== String(current.generation)) return
            if (Number(payload.revision) < Number(current.revision)) return
            const revision = Number(payload.revision) || 0
            requestView.current.revision = Math.max(Number(requestView.current.revision) || 0, revision)
            sessionViewRevision = requestView.current.revision
            let changed = false
            for (const entry of payload.turns || []) {
              const turn = Number(entry.turn)
              if (!Number.isFinite(turn)) continue
              if (entry.status === 'observed' && entry.data) {
                dataCache.current.set(turn, { status: 'observed', turn: entry.data, revision })
                turnWindow.current.merge([entry.data])
                changed = true
              } else {
                dataCache.current.set(turn, { status: entry.status === 'no-data' ? 'no-data' : 'missing', revision })
              }
            }
            if (changed) applyTurns(turnWindow.current.turns())
            noteRecoveryEvent()
            schedule(true)
          },
          onFallback: (values, context) => {
            batchDisabled.current = true
            turnQueue.request(values, turnsRef.current, 0, context)
          },
          onError: (error) => {
            lastFetchError = error && error.message ? error.message : String(error)
          },
        })

        const noteRecoveryEvent = () => {
          const state = recovery.current
          state.deadline = performance.now() + 600
          state.attempt = 0
          state.reason = null
        }
        recoveryEvent.current = noteRecoveryEvent

        const clearRecovery = () => {
          const state = recovery.current
          if (state.timer) window.clearTimeout(state.timer)
          state.timer = 0
          state.deadline = 0
          state.attempt = 0
          state.reason = null
        }

        const scheduleRecovery = (reason) => {
          const state = recovery.current
          state.reason = reason
          if (state.timer) return
          const now = performance.now()
          if (!state.deadline) state.deadline = now + 600
          if (now >= state.deadline) {
            // Never stop forever: after the budget, do a full flow requery and
            // start another bounded recovery window.
            state.deadline = now + 600
            state.attempt = 0
            mapping.current.flowIdentity = null
          }
          const delay = [0, 100, 250, 500][Math.min(state.attempt, 3)]
          state.attempt += 1
          state.timer = window.setTimeout(() => {
            state.timer = 0
            schedule(true, { recover: true })
          }, delay)
        }

        const retainVisual = (reason) => {
          // Mapping failures keep the last valid visual state. They never
          // create synthetic cards or move an occupant.
          railDebug = {
            ...railDebug,
            flow: Boolean(geometry.current.flowIdentity),
            flowTurns: geometry.current.domTurns ? geometry.current.domTurns.length : 0,
            turns: turnsRef.current.length,
            cards: visual.current.size,
            reason,
            mappingConfidence: mapping.current.confidence,
            offset: mapping.current.offset,
            mappingGeneration: mapping.current.generation,
            jumpGeneration: jump.current.generation,
          }
          scheduleRecovery(reason)
        }

        const adapter = new VisibleTurnAdapter({
          registry: officialTurnRegistry,
          onDirty: () => {
            if (disposed) return
            noteRecoveryEvent()
            schedule(true)
          },
        })

        const zonesFromCommitted = () => {
          const zones = new Map()
          for (const [id, target] of committed.current) zones.set(id, target.zone)
          return zones
        }

        const applyRange = (node, target, cardTop) => {
          const range = node.querySelector ? node.querySelector('[data-mf-range]') : null
          if (!range) return
          const top = Number(target.rangeTop)
          const bottom = Number(target.rangeBottom)
          const visible = target.zone === 'middle' && Number.isFinite(top) && Number.isFinite(bottom) && bottom - top > 6
          if (!visible) {
            range.style.opacity = '0'
            return
          }
          if (bottom - top <= 6) {
            range.style.opacity = '0'
            return
          }
          // The bracket represents the canonical anchor's visible height, not
          // the card's own box, so a long answer keeps one continuous range.
          range.style.opacity = '0.72'
          range.style.top = Math.round(top - cardTop) + 'px'
          range.style.height = Math.round(bottom - top) + 'px'
          if (!range.__mfRangeShown) {
            range.__mfRangeShown = true
            range.style.transform = 'scaleY(0)'
            window.requestAnimationFrame(() => {
              if (range.isConnected) range.style.transform = 'scaleY(1)'
            })
          } else {
            range.style.transform = 'scaleY(1)'
          }
        }

        const updateRenderPool = (targets) => {
          const pool = new Map(renderTurnsRef.current.map((turn) => [turn.id, turn]))
          for (const target of targets.values()) if (target.turn && target.turn.id) pool.set(target.turn.id, target.turn)
          for (const [id, entry] of exiting.current) if (entry.turn) pool.set(id, entry.turn)
          for (const id of [...pool.keys()]) {
            if (targets.has(id) || exiting.current.has(id) || visual.current.has(id)) continue
            pool.delete(id)
          }
          const list = [...pool.values()]
          const before = renderTurnsRef.current.map((turn) => turn.id).join('|')
          const after = list.map((turn) => turn.id).join('|')
          if (before === after) return
          renderTurnsRef.current = list
          setRenderTurns(list)
          window.requestAnimationFrame(() => schedule(false))
        }

        const exitCard = (id, node, previous, rects) => {
          if (!node || exiting.current.has(id)) return
          const turn = renderTurnsRef.current.find((item) => item.id === id) || (previous && previous.turn)
          if (!turn) return
          const rect = rects.get(id) || (node.getBoundingClientRect ? node.getBoundingClientRect() : null)
          const width = node.offsetWidth || (geometry.current.compact ? 56 : 176)
          const fromTop = rect && Number.isFinite(rect.top) ? rect.top : previous.top
          const fromScale = rect && width ? Math.max(0.5, Math.min(1.2, rect.width / width)) : previous.scale
          const fromTransform = 'translate3d(0,' + fromTop + 'px,0) scale(' + fromScale + ')'
          const ejectDistance = Math.max(64, (geometry.current.compact ? 24 : 58) * 1.2)
          let toTop = fromTop
          if (previous.zone === 'top') toTop = Math.max(0, fromTop - ejectDistance)
          else if (previous.zone === 'bottom') toTop = fromTop + ejectDistance
          else toTop = scrollDirection.current > 0 ? geometry.current.clipTop - ejectDistance : geometry.current.clipBottom + ejectDistance
          const toTransform = 'translate3d(0,' + toTop + 'px,0) scale(0.76)'
          setStyle(node, 'pointerEvents', 'none')
          node.__mfOpacity = 0
          exiting.current.set(id, { turn, zone: previous.zone })
          const remove = () => {
            if (disposed) return
            exiting.current.delete(id)
            visual.current.delete(id)
            cardRefs.current.delete(id)
            absent.current.delete(id)
            updateRenderPool(committed.current)
          }
          try {
            const animated = animator.eject(node, {
              fromTransform,
              fromOpacity: Number.isFinite(previous.opacity) ? previous.opacity : 0.5,
              toTransform,
              motionScale: reducedMotion ? 0.45 : 1,
              onDone: remove,
            })
            if (!animated) remove()
          } catch {
            remove()
          }
        }

        const applyTargets = (targets, snapshot) => {
          const previous = committed.current
          committed.current = targets
          const rects = new Map()
          for (const [id, node] of cardRefs.current) {
            if (!node || node.isConnected === false) continue
            const rect = node.getBoundingClientRect()
            if (rect && rect.height) rects.set(id, rect)
          }
          const validSnapshot = Boolean(snapshot && !snapshot.invalid && snapshot.rows && snapshot.rows.length)
          for (const id of targets.keys()) absent.current.delete(id)
          for (const [id, node] of cardRefs.current) {
            if (targets.has(id)) continue
            if (!validSnapshot) continue
            const before = absent.current.get(id) || 0
            const count = before + 1
            absent.current.set(id, count)
            if (count < 2) continue
            const prior = visual.current.get(id)
            if (!prior || !prior.visible) continue
            exitCard(id, node, prior, rects)
          }
          for (const [id, target] of targets) {
            const node = cardRefs.current.get(id)
            const prior = visual.current.get(id) || null
            const targetScale = target.zone === 'middle' ? 1 : 0.88
            const targetOpacity = target.zone === 'middle' ? 1 : 0.5
            const nextVisual = { top: target.top, zone: target.zone, scale: targetScale, opacity: targetOpacity, visible: true, rendered: Boolean(node), turn: target.turn }
            visual.current.set(id, nextVisual)
            if (!node) {
              window.requestAnimationFrame(() => schedule(false))
              continue
            }
            if (exiting.current.has(id)) {
              exiting.current.delete(id)
              absent.current.delete(id)
            }
            setStyle(node, 'zIndex', target.zone === 'top' ? '3' : target.zone === 'bottom' ? '1' : '2')
            setStyle(node, 'pointerEvents', 'auto')
            setStyle(node, 'filter', target.zone === 'middle' ? 'none' : 'grayscale(.45) saturate(.65)')
            setStyle(node, 'boxShadow', target.zone === 'middle' ? '0 4px 12px rgba(16,24,40,.10)' : '0 1px 4px rgba(16,24,40,.06)')
            setStyle(node, 'borderColor', target.zone === 'middle' ? 'var(--dsw-alias-border-l1, rgba(20,30,45,.14))' : 'rgba(20,30,45,.08)')
            // Transform is owned by WAAPI/FLIP. Never write transform transitions:
            // they fight the animation and cause horizontal/vertical bounce.
            setTransition(node, reducedMotion ? 'opacity 60ms linear' : 'opacity 160ms ease-out, filter 160ms ease-out, box-shadow 160ms ease-out, border-color 160ms ease-out, width 220ms cubic-bezier(.22,1,.36,1), padding 220ms cubic-bezier(.22,1,.36,1), border-radius 220ms cubic-bezier(.22,1,.36,1)')
            node.title = (target.zone === 'top' ? '上方 · ' : target.zone === 'bottom' ? '下方 · ' : '') + '第 ' + target.turn.turn + ' 轮 · ' + target.turn.verdictLabel + (target.zone === 'middle' && Number.isFinite(target.rangeTop) ? ' · 右侧细线为最终回复可见区间' : '')
            applyRange(node, target, target.top)
            const rect = rects.get(id) || null
            const changed = Boolean(prior && prior.visible && (Math.abs(prior.top - target.top) > 1 || prior.zone !== target.zone || Math.abs(prior.scale - targetScale) > 0.01))
            if (!prior || !prior.visible || prior.rendered === false) {
              const direction = scrollDirection.current >= 0 ? 1 : -1
              const fromTop = rect ? rect.top : target.top + direction * 8
              setStyle(node, 'opacity', String(targetOpacity))
              try {
                animator.enter(node, {
                  left: 0,
                  fromTop,
                  fromScale: targetScale * 0.96,
                  toTop: target.top,
                  toScale: targetScale,
                  toOpacity: targetOpacity,
                  delay: 0,
                  motionScale: reducedMotion ? 0.45 : 1,
                })
              } catch {
                setStyle(node, 'transform', 'translate3d(0,' + target.top + 'px,0) scale(' + targetScale + ')')
              }
            } else if (changed) {
              const role = prior.zone !== target.zone
                ? (target.zone === 'middle' ? 'pushing' : 'squeeze')
                : 'pushed'
              try {
                animator.flip(node, {
                  fromRect: rect,
                  fromOpacity: prior && Number.isFinite(prior.opacity) ? prior.opacity : targetOpacity,
                  toTop: target.top,
                  toScale: targetScale,
                  toOpacity: targetOpacity,
                  role,
                  motionScale: reducedMotion ? 0.45 : 1,
                })
              } catch {
                setStyle(node, 'transform', 'translate3d(0,' + target.top + 'px,0) scale(' + targetScale + ')')
                setStyle(node, 'opacity', String(targetOpacity))
              }
            } else {
              setStyle(node, 'transform', 'translate3d(0,' + target.top + 'px,0) scale(' + targetScale + ')')
              setStyle(node, 'opacity', String(targetOpacity))
            }
          }
          for (const [id, prior] of visual.current) {
            if (targets.has(id) || exiting.current.has(id)) continue
            if (!validSnapshot) continue
            if ((absent.current.get(id) || 0) < 2) {
              // Keep the current visual state for one valid frame; the second
              // valid snapshot starts the exit. This is not a permanent slot.
              const node = cardRefs.current.get(id)
              if (node && prior.visible) setStyle(node, 'opacity', String(prior.opacity))
            }
          }
          updateRenderPool(committed.current)
        }

        const placeholderTurn = (turn, status) => {
          const session = requestView.current.sessionId || sessionId || railSessionId || 'session'
          const noData = status === 'no-data'
          return {
            id: session + ':turn:' + turn + ':' + (noData ? 'no-data' : 'loading'),
            turn,
            verdict: noData ? 'nodata' : 'loading',
            verdictLabel: noData ? '无模型指纹数据' : '指纹数据加载中',
            primaryShort: noData ? '—' : '…',
            primaryModel: noData ? '该轮没有可识别的模型观测' : '正在取得本轮指纹',
            hasModelData: false,
            placeholder: true,
            placeholderStatus: noData ? 'no-data' : 'loading',
          }
        }

        const visibleCardTurns = (snapshot) => {
          const offset = Number(mapping.current.offset) || 0
          const list = []
          for (const row of snapshot.rows || []) {
            const apiTurn = Number(row.domTurn) - offset
            if (!Number.isFinite(apiTurn)) continue
            const observed = turnByNumber.current.get(apiTurn)
            const cached = dataCache.current.get(apiTurn)
            let turn = observed || null
            if (!turn) {
              const status = cached && cached.status === 'no-data' ? 'no-data' : 'loading'
              turn = placeholderTurn(apiTurn, status)
            }
            list.push({ turn, row })
          }
          return list
        }

        const relevantRows = (snapshot) => {
          const rows = snapshot.rows || []
          const clipTop = geometry.current.clipTop
          const clipBottom = geometry.current.clipBottom
          const overlapping = rows.filter((row) => row.turnBottom > clipTop && row.turnTop < clipBottom)
          let above = null
          let below = null
          for (const row of rows) {
            if (row.turnBottom <= clipTop && (!above || row.turnBottom > above.turnBottom)) above = row
            if (row.turnTop >= clipBottom && (!below || row.turnTop < below.turnTop)) below = row
          }
          const selected = overlapping.slice()
          if (above && !selected.includes(above)) selected.push(above)
          if (below && !selected.includes(below)) selected.push(below)
          selected.sort((left, right) => left.turnTop - right.turnTop)
          return { ...snapshot, rows: selected, domTurns: selected.map((row) => row.domTurn) }
        }

        const buildTargets = (snapshot) => {
          const layout = geometry.current
          const cardH = layout.compact ? 24 : 58
          const topY = layout.clipTop + 8
          const bottomY = layout.clipBottom - cardH - 4
          const laneTop = layout.clipTop + 8
          const laneBottom = layout.clipBottom - 8
          const items = visibleCardTurns(snapshot)
          const turnList = items.map((item) => item.turn)
          const derived = validateRailTargets(deriveRailTargets(snapshot, turnList, mapping.current, layout, zonesFromCommitted()))
          const middleTop = derived.top ? topY + cardH + 6 : laneTop
          const middleBottom = derived.bottom ? bottomY - 6 : laneBottom
          const middleItems = derived.middle.map((entry) => {
            const hasAnchor = entry.hasAnchor && Number.isFinite(entry.anchorTop) && Number.isFinite(entry.anchorBottom)
            const anchorTop = hasAnchor ? entry.anchorTop : entry.top
            const anchorBottom = hasAnchor ? entry.anchorBottom : entry.bottom
            return {
              id: entry.turn.id,
              turn: entry.turn,
              anchorTop,
              anchorBottom,
              hasAnchor,
              center: (anchorTop + anchorBottom) / 2,
            }
          })
          const middleLayout = layoutMiddleCards(middleItems, {
            top: middleTop,
            bottom: middleBottom,
            cardHeight: cardH,
            gap: 4,
          })
          const targets = new Map()
          for (const item of middleLayout.items) {
            targets.set(item.id, {
              top: item.top,
              zone: 'middle',
              turn: item.turn,
              rangeTop: item.hasAnchor && !item.turn.placeholder ? item.anchorTop : undefined,
              rangeBottom: item.hasAnchor && !item.turn.placeholder ? item.anchorBottom : undefined,
            })
          }
          if (derived.top) {
            targets.set(derived.top.turn.id, { top: Math.round(topY), zone: 'top', turn: derived.top.turn })
          }
          if (derived.bottom) {
            targets.set(derived.bottom.turn.id, { top: Math.round(bottomY), zone: 'bottom', turn: derived.bottom.turn })
          }
          return { targets, collapsedIds: middleLayout.collapsedIds }
        }

        const commitSnapshot = (snapshot) => {
          if (!snapshot || snapshot.invalid) {
            tracker.current.reset()
            retainVisual('recovering')
            return
          }
          if (!snapshot.rows.length) {
            retainVisual('waiting-for-dom')
            return
          }
          const tracked = tracker.current.observe(snapshot.signature, performance.now())
          const unchangedAfterJump = jump.current.pending && jump.current.fromSignature && snapshot.signature === jump.current.fromSignature && !tracked.timedOut
          if (jump.current.pending && (!tracked.stable || unchangedAfterJump) && !tracked.timedOut) {
            railDebug = { ...railDebug, reason: 'waiting-for-dom', flowTurns: snapshot.rows.length, jumpGeneration: jump.current.generation }
            window.requestAnimationFrame(() => schedule(false))
            return
          }
          jump.current.pending = false
          const relevant = relevantRows(snapshot)
          const built = buildTargets(relevant)
          const targets = built.targets
          applyTargets(targets, relevant)
          const focusTarget = [...targets.values()].find((target) => target.zone === 'middle') || [...targets.values()][0]
          if (focusTarget && turnWindow.current.pruneAround(focusTarget.turn.turn)) {
            applyTurns(turnWindow.current.turns())
          }
          clearRecovery()
          setCompact((value) => value === geometry.current.compact ? value : geometry.current.compact)
          setClip((value) => Math.abs(value.top - geometry.current.clipTop) < 1 && Math.abs(value.bottom - geometry.current.clipBottom) < 1 ? value : { top: geometry.current.clipTop, bottom: geometry.current.clipBottom })
          setFlowReady(true)
          const atBottom = geometry.current.scrollContainer
            ? geometry.current.scrollContainer.scrollTop + geometry.current.scrollContainer.clientHeight >= geometry.current.scrollContainer.scrollHeight - 8
            : false
          const hasTargets = targets.size > 0
          placeholderPosition.current = {
            right: geometry.current.right || 0,
            top: Math.round((geometry.current.clipTop + geometry.current.clipBottom) / 2 - 22),
            visible: !hasTargets && turnsRef.current.length > 0,
          }
          railDebug = {
            flow: true,
            flowTurns: snapshot.rows.length,
            turns: turnsRef.current.length,
            cards: targets.size,
            cardNodes: cardRefs.current.size,
            windowRows: turnWindow.current.size,
            windowMax: turnWindow.current.maxWindow,
            cardTargets: [...targets.entries()].map(([id, target]) => ({ id, turn: target.turn ? target.turn.turn : null, zone: target.zone, top: Math.round(target.top) })),
            cardAnimations: [...cardRefs.current.entries()].map(([id, node]) => ({ id, role: animator.state(node) ? animator.state(node).id : null })),
            middleCards: [...targets.values()].filter((target) => target.zone === 'middle').length,
            collapsedCards: built.collapsedIds.length,
            collapsedIds: built.collapsedIds.slice(0, 16),
            placeholder: placeholderPosition.current.visible,
            offset: mapping.current.offset,
            batchLastKey: windowQueue.lastKey,
            batchPending: windowQueue.inFlight,
            cacheRows: dataCache.current.size,
            mappingConfidence: mapping.current.confidence,
            mappingGeneration: mapping.current.generation,
            jumpGeneration: jump.current.generation,
            measured: relevant.rows.length,
            domTurns: relevant.rows.map((row) => row.domTurn).slice(0, 12),
            anchors: relevant.rows.slice(0, 12).map((row) => ({ turn: row.domTurn, kind: row.anchorKind, step: row.anchorStep })),
            apiTurns: turnsRef.current.map((turn) => turn.turn).slice(0, 12),
            atBottom,
            reason: 'ok',
            right: Math.round(geometry.current.right),
            left: Math.round(geometry.current.left),
            compact: geometry.current.compact,
            clipTop: Math.round(geometry.current.clipTop),
            clipBottom: Math.round(geometry.current.clipBottom),
            viewport: window.innerWidth,
            canvasOpen,
          }
        }

        const requestVisibleTurns = (snapshot) => {
          const offset = Number(mapping.current.offset) || 0
          const turnNumbers = []
          const seen = new Set()
          for (const row of snapshot.rows || []) {
            const turn = Number(row.domTurn) - offset
            if (!Number.isFinite(turn) || seen.has(turn)) continue
            seen.add(turn)
            const cached = dataCache.current.get(turn)
            if (turnByNumber.current.has(turn)) continue
            if (cached && cached.status === 'no-data' && cached.revision === requestView.current.revision) continue
            if (cached && cached.status === 'missing' && cached.revision === requestView.current.revision) continue
            turnNumbers.push(turn)
          }
          if (!turnNumbers.length) return
          const context = {
            sessionId: requestView.current.sessionId || sessionId || railSessionId,
            revision: requestView.current.revision,
            generation: requestView.current.generation,
          }
          if (batchDisabled.current) {
            turnQueue.request(turnNumbers, turnsRef.current, 0, context)
            return
          }
          windowQueue.request(turnNumbers, context)
        }

        const update = (needsRebuild) => {
          const flow = adapter.getFlow()
          if (!flow) {
            geometry.current = { ...geometry.current, ready: false }
            retainVisual('no-flow')
            setFlowReady(false)
            railDebug = { ...railDebug, flow: false, reason: 'no-flow', turns: turnsRef.current.length, cards: visual.current.size }
            return
          }
          if (mapping.current.flowIdentity && mapping.current.flowIdentity !== flow) {
            mapping.current = { offset: mapping.current.offset, confidence: 0, generation: mapping.current.generation + 1, flowIdentity: flow }
            beginJump('flow')
            adapter.observe(flow)
            schedule(true, { recover: true })
            return
          }
          mapping.current.flowIdentity = flow
          adapter.observe(flow)
          const priorRows = geometry.current.lastRows
          const layout = adapter.measureViewport(flow)
          geometry.current = { ...layout, ready: true, domTurns: geometry.current.domTurns || [] }
          const snapshot = adapter.capture(flow, layout)
          geometry.current.domTurns = snapshot.domTurns || []
          const detected = priorRows && !snapshot.invalid ? railJumpDetected({ rows: priorRows }, snapshot) : null
          if (detected && !jump.current.pending) beginJump(detected)
          if (!snapshot.invalid) {
            geometry.current.lastRows = snapshot.rows.map((row) => ({
              domTurn: row.domTurn,
              top: row.turnTop,
              bottom: row.turnBottom,
              anchorTop: row.anchorTop,
              anchorBottom: row.anchorBottom,
            }))
            const apiTurns = [...turnByNumber.current.keys()]
            const chosen = chooseRailMapping(apiTurns, snapshot.domTurns, mapping.current)
            mapping.current = { ...mapping.current, offset: chosen.offset, confidence: chosen.confidence }
            geometry.current.offset = chosen.offset
            try {
              requestVisibleTurns(relevantRows(snapshot))
            } catch (error) {
              lastFetchError = error && error.message ? error.message : String(error)
            }
          }
          if (mapping.current.confidence <= 0 && snapshot.rows.length) {
            // No overlap does not mean no cards: request the visible DOM turn
            // numbers and render explicit loading placeholders. The DOM value
            // is the durable turn number in current DSH; a non-zero offset is
            // learned later as the API window overlaps.
            mapping.current.offset = 0
            geometry.current.offset = 0
            try { requestVisibleTurns(snapshot) } catch { /* placeholders still render */ }
            commitSnapshot(snapshot)
            return
          }
          commitSnapshot(snapshot)
        }

        const safeUpdate = (needsRebuild) => {
          if (disposed) return
          try {
            update(needsRebuild)
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            lastFetchError = 'rail: ' + message.slice(0, 300)
            railDebug = { ...railDebug, reason: 'update-error', error: message.slice(0, 300) }
          }
        }

        schedule = (needsRebuild, options = {}) => {
          if (needsRebuild) rebuildPending = true
          if (raf) return
          raf = window.requestAnimationFrame(() => {
            raf = 0
            const pending = rebuildPending
            rebuildPending = false
            safeUpdate(pending)
          })
        }
        scheduleRef.current = schedule

        const rebindScheduler = new RebindScheduler({ onRebind: () => schedule(true) })
        let lastScrollAt = 0
        let lastScrollTop = null
        let scrollVelocity = 0
        const onScroll = () => {
          if (disposed) return
          const now = performance.now()
          const scroller = geometry.current.scrollContainer
          const top = scroller ? scroller.scrollTop : window.scrollY
          let jumped = false
          if (lastScrollTop !== null) {
            const dt = Math.max(1, now - lastScrollAt)
            const delta = top - lastScrollTop
            scrollVelocity = Math.abs(delta) / dt
            scrollDirection.current = delta >= 0 ? 1 : -1
            jumped = Math.abs(delta) > 180
          }
          lastScrollTop = top
          lastScrollAt = now
          noteRecoveryEvent()
          scrollScheduler.noteScroll()
          if (jumped) {
            beginJump('scroll')
            rebindScheduler.kick()
          }
          schedule(false)
        }
        const onResize = () => {
          noteRecoveryEvent()
          schedule(true)
        }
        safeUpdate(true)
        window.addEventListener('scroll', onScroll, { capture: true, passive: true })
        window.addEventListener('resize', onResize)
        tick = window.setInterval(() => schedule(false), 1500)
        return () => {
          disposed = true
          if (raf) window.cancelAnimationFrame(raf)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onResize)
          adapter.dispose()
          if (recovery.current.timer) clearTimeout(recovery.current.timer)
          recovery.current.timer = 0
          turnQueue.invalidate()
          windowQueue.invalidate()
          rebindScheduler.dispose()
          scrollScheduler.dispose()
          if (tick) clearInterval(tick)
          scheduleRef.current = null
          recoveryEvent.current = null
          tracker.current = null
        }
      }, [on, sessionId])

      React.useEffect(() => {
        if (!on) return
        scheduleRef.current?.(false)
      }, [turns, on])

      if (!on) return null
      const clipPath = clip.top > 0
        ? 'inset(' + Math.round(clip.top) + 'px 0 0 0)'
        : undefined
      const children = renderTurns.map((turn) => {
        const placeholder = turn.placeholder === true
        const color = placeholder ? 'var(--dsw-alias-label-tertiary, #667085)' : (railColors[turn.verdict] || railColors.first)
        const position = visual.current.get(turn.id) || { right: geometry.current.right || 0, top: -9999, opacity: 0, visible: false }
        const base = {
          key: turn.id,
          'data-mf-card': String(turn.id),
          ref: (node) => {
            if (node) cardRefs.current.set(turn.id, node)
            else cardRefs.current.delete(turn.id)
          },
          onClick: () => setOpen(true),
          style: {
            position: 'absolute',
            left: 'auto',
            right: position.right || geometry.current.right || 0,
            top: 0,
            pointerEvents: position.visible ? 'auto' : 'none',
            cursor: 'pointer',
            transform: 'translate3d(0,' + position.top + 'px,0)',
            opacity: Number.isFinite(position.opacity) ? position.opacity : (position.visible ? 1 : 0),
            transformOrigin: 'right center',
            willChange: 'transform, opacity',
            boxSizing: 'border-box',
            borderRadius: compact ? 999 : 10,
            background: placeholder ? 'var(--dsw-alias-bg-secondary, rgba(248,249,251,.78))' : 'var(--dsw-specific-menu, rgba(255,255,255,.94))',
            border: placeholder ? '1px dashed var(--dsw-alias-border-l1, rgba(20,30,45,.18))' : '1px solid var(--dsw-alias-border-l1, rgba(20,30,45,.14))',
            boxShadow: placeholder ? '0 1px 6px rgba(16,24,40,.05)' : '0 2px 10px rgba(16,24,40,.10)',
            color: 'var(--dsw-alias-label-primary, #1b1f24)',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
            lineHeight: 1.35,
          },
        }
        const rangeEl = h('span', {
          'data-mf-range': '1',
          style: {
            position: 'absolute',
            right: -8,
            top: 0,
            width: 5,
            height: 0,
            opacity: 0,
            pointerEvents: 'none',
            color: 'rgba(91, 117, 145, .76)',
            transform: 'scaleY(1)',
            transformOrigin: 'top center',
            transition: 'opacity 160ms ease, top 140ms ease, height 140ms ease',
          },
        },
          h('span', { key: 'line', style: { position: 'absolute', left: 0, top: 0, width: 1.5, height: '100%', background: 'currentColor', borderRadius: 1 } }),
          h('span', { key: 'top', style: { position: 'absolute', left: 0, top: 0, width: 5, height: 1.5, background: 'currentColor', borderRadius: 1 } }),
          h('span', { key: 'bottom', style: { position: 'absolute', left: 0, bottom: 0, width: 5, height: 1.5, background: 'currentColor', borderRadius: 1 } }),
        )
        if (compact) {
          base.style.width = 56
          base.style.padding = '3px 4px'
          base.style.textAlign = 'center'
          base.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
          base.style.fontSize = 10
          base.style.color = color
          base.title = '第 ' + turn.turn + ' 轮 · ' + turn.verdictLabel
          return h('div', base, rangeEl, placeholder ? (turn.placeholderStatus === 'no-data' ? '—' : '…') : 'FP-' + String(turn.primaryShort || '').slice(0, 4))
        }
        base.style.width = 176
        base.style.padding = '6px 8px 7px'
        base.title = placeholder ? '第 ' + turn.turn + ' 轮 · ' + turn.verdictLabel : '点击打开逐轮检测面板'
        return h('div', base,
          rangeEl,
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5, fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #667085)' } },
            h('span', null, '第 ' + turn.turn + ' 轮'),
            h('span', null, placeholder
              ? (turn.placeholderStatus === 'no-data' ? '无数据' : '加载中')
              : turn.verdict === 'same' ? '一致' : turn.verdict === 'changed' ? '变化' : turn.verdict === 'mixed' ? '多指纹' : turn.verdict === 'generation' ? '代际' : '基线'),
          ),
          h('div', { key: 'body', style: { marginTop: 1, fontFamily: placeholder ? 'inherit' : 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, fontWeight: 750, color } }, placeholder
            ? (turn.placeholderStatus === 'no-data' ? '无模型指纹数据' : '指纹数据加载中')
            : 'FP-' + String(turn.primaryShort || '')),
          h('div', { key: 'model', style: { marginTop: 1, fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #667085)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, String(turn.primaryModel || '')),
        )
      })
      children.push(h('div', {
        key: '__current__',
        ref: placeholderRef,
        onClick: () => setOpen(true),
        style: {
          position: 'absolute',
          left: 'auto',
          right: placeholderPosition.current.right || 0,
          top: 0,
          width: compact ? 56 : 176,
          boxSizing: 'border-box',
          pointerEvents: placeholderPosition.current.visible ? 'auto' : 'none',
          cursor: 'pointer',
          padding: compact ? '3px 4px' : '6px 8px 7px',
          borderRadius: compact ? 999 : 10,
          border: '1px dashed var(--dsw-alias-border-l1, rgba(20,30,45,.18))',
          background: 'var(--dsw-specific-menu, rgba(255,255,255,.94))',
          boxShadow: '0 2px 10px rgba(16,24,40,.08)',
          color: 'var(--dsw-alias-label-tertiary, #667085)',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          lineHeight: 1.35,
          transform: 'translate3d(0,' + placeholderPosition.current.top + 'px,0)',
          opacity: placeholderPosition.current.visible ? 1 : 0,
          transformOrigin: 'right center',
          transition: 'opacity 150ms ease, transform 100ms linear',
          willChange: 'transform, opacity',
        },
        title: '当前消息尚未匹配到模型轮次',
      }, compact
        ? '当前'
        : [
            h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5, fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #667085)' } },
              h('span', null, '当前消息'),
              h('span', null, '无数据'),
            ),
            h('div', { key: 'body', style: { marginTop: 2, fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #667085)' } }, '尚未匹配到本轮模型数据'),
          ]))
      if (!turns.length || !flowReady) {
        children.push(h('div', {
          key: 'status',
          style: {
            position: 'absolute',
            left: Math.max(8, geometry.current.left || 8),
            bottom: 96,
            pointerEvents: 'auto',
            cursor: 'pointer',
            padding: '5px 9px',
            borderRadius: 999,
            background: 'var(--dsw-specific-menu, #fff)',
            border: '1px solid var(--dsw-alias-border-l1, rgba(20,30,45,.14))',
            boxShadow: '0 2px 8px rgba(16,24,40,.12)',
            fontSize: 10,
            color: 'var(--dsw-alias-label-tertiary, #667085)',
          },
          onClick: () => setOpen(true),
          title: '点击打开完整逐轮面板',
        }, sessionId ? '逐轮指纹：定位中…' : '逐轮指纹：已开启，等待会话…'))
      }
      return h('div', {
        ref: railRef,
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 8,
          pointerEvents: 'none',
          overflow: 'hidden',
          clipPath,
          opacity: canvasOpen ? 0 : 1,
          transition: 'opacity 160ms ease',
        },
      }, children)
    }

    class SlotBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        const message = error && error.message ? error.message : String(error)
        lastFetchError = 'render: ' + message.slice(0, 300)
        railDebug = { ...railDebug, reason: 'render-error', error: message.slice(0, 300) }
      }

      render() {
        return this.state.failed ? null : this.props.children
      }
    }
    function ComposerToggle(props) {
      const visible = useRailOn()
      const latest = useLatestTurn()
      const [expanded, setExpanded] = React.useState(false)
      const [narrow, setNarrow] = React.useState(false)
      const rootRef = React.useRef(null)
      React.useEffect(() => {
        const node = rootRef.current
        const parent = node && node.parentElement
        if (!parent) return undefined
        const measure = () => setNarrow(parent.getBoundingClientRect().width > 0 && parent.getBoundingClientRect().width < 140)
        measure()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(parent)
        return () => observer.disconnect()
      }, [])
      React.useEffect(() => {
        if (!props || !props.sessionId) return undefined
        const apply = () => {
          const node = rootRef.current
          if (node && node.getClientRects().length && node.getBoundingClientRect().width > 0) {
            if (railSessionId !== props.sessionId) setRailSession(props.sessionId)
          }
        }
        apply()
        const timer = window.setInterval(apply, 1200)
        return () => clearInterval(timer)
      }, [props && props.sessionId])
      React.useEffect(() => {
        if (!expanded) return undefined
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setExpanded(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setExpanded(false)
        }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [expanded])
      React.useEffect(() => {
        publishRail()
      }, [])
      const verdict = latest && latest.verdict ? latest.verdict : null
      const tone = !latest || latest.hasModelData === false
        ? 'var(--dsw-alias-label-tertiary, #667085)'
        : verdict === 'first'
          ? '#98a2b3'
          : verdict === 'same'
            ? '#0f8a5f'
            : '#dc2626'
      const label = !latest
        ? '等待首轮'
        : latest.hasModelData === false
          ? '无数据'
          : verdict === 'first'
            ? '基线'
            : verdict === 'same'
              ? '一致'
              : '不一致'
      const turnLabel = !narrow && latest && latest.turn !== undefined && latest.turn !== null ? '第 ' + latest.turn + ' 轮 · ' : ''
      return h('div', {
        ref: rootRef,
        style: { ...styles.dock, position: 'relative' },
        'data-mf-native-toggle': '1',
        'data-mf-session-id': (props && props.sessionId) || '',
      },
        h('button', {
          type: 'button',
          style: {
            ...styles.toggle,
            gap: 5,
            maxWidth: '100%',
            border: '1px solid var(--dsw-alias-border-l1, rgba(20,30,45,.12))',
            borderRadius: 999,
            background: 'var(--dsw-specific-menu, rgba(255,255,255,.94))',
            padding: '2px 8px',
            boxShadow: '0 1px 4px rgba(16,24,40,.08)',
            whiteSpace: 'nowrap',
          },
          title: latest
            ? '最新轮次指纹：' + label + '。点击展开开关与面板'
            : '逐轮指纹：等待首轮。点击展开开关与面板',
          'aria-expanded': expanded,
          'aria-haspopup': 'dialog',
          onClick: () => setExpanded((value) => !value),
        },
          h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: tone, flex: '0 0 auto' } }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
          h('span', { style: { color: 'var(--dsw-alias-label-caption, #98a2b3)', fontSize: 9 } }, expanded ? '▾' : '▴'),
        ),
        expanded ? h('div', {
          role: 'dialog',
          'aria-label': '逐轮指纹控制',
          style: {
            position: 'absolute',
            right: 0,
            bottom: 'calc(100% + 8px)',
            width: narrow ? 200 : 224,
            maxWidth: 'calc(100vw - 24px)',
            padding: 10,
            borderRadius: 12,
            border: '1px solid var(--dsw-alias-border-l1, rgba(20,30,45,.14))',
            background: 'var(--dsw-alias-bg-layer-2, #fff)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            boxShadow: '0 12px 32px rgba(16,24,40,.18)',
            color: 'var(--dsw-alias-label-primary, #1b1f24)',
            zIndex: 30,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #667085)' } },
            h('span', null, '最新轮次'),
            latest ? h('span', { style: { color: tone, fontWeight: 600 } }, label) : null,
          ),
          latest
            ? h('div', { style: { marginTop: 4 } },
                h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #475467)' } }, [turnLabel.replace(/ · $/, ''), latest.primaryModel].filter(Boolean).join(' · ')),
                h('div', { style: { marginTop: 2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #667085)' } }, latest.primaryShort ? 'FP-' + latest.primaryShort : '暂无指纹'),
              )
            : h('div', { style: { marginTop: 4, fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #667085)' } }, '还没有可用的轮次数据'),
          h('div', { style: { height: 1, margin: '8px 0', background: 'var(--dsw-alias-border-l1, rgba(20,30,45,.10))' } }),
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } },
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #475467)', lineHeight: 1.45 } }, '在会话消息旁显示指纹情况'),
            h('button', {
              type: 'button',
              style: { ...styles.toggle, padding: '2px 4px' },
              title: visible ? '关闭左侧逐轮指纹' : '显示左侧逐轮指纹',
              'aria-pressed': visible,
              onClick: () => setRailOn(!visible),
            },
              h('span', { style: styles.track(visible) }, h('span', { style: styles.knob(visible) })),
            ),
          ),
          h('button', {
            type: 'button',
            style: { ...styles.panelButton, width: '100%', marginTop: 9, padding: '6px 8px', textAlign: 'center' },
            onClick: () => {
              setExpanded(false)
              setOpen(true)
            },
          }, '打开逐轮指纹面板'),
        ) : null,
      )
    }
    const guard = (Component) => function Guarded(props) {
      return h(SlotBoundary, null, h(Component, props))
    }
    const GuardedTurnRail = guard(TurnRailFast)
    const GuardedOverlay = guard(Overlay)
    const GuardedComposerToggle = guard(ComposerToggle)
    const GuardedTurnProbe = guard(TurnLifecycleProbe)


    return {
      inject: ['slots'],
      apply(ctx) {
        const intervals = []
        try {
          const previous = window.__dshModelFingerprintIntervalIds
          if (Array.isArray(previous)) {
            for (const id of previous) window.clearInterval(id)
          }
        } catch { /* stale HMR state */ }
        window.__dshModelFingerprintIntervalIds = intervals
        const every = (callback, ms) => {
          const id = window.setInterval(callback, ms)
          intervals.push(id)
          return id
        }
        window.__dshModelFingerprintNative = true
        window.__dshModelFingerprintNativeRail = true
        window.__dshModelFingerprintOpen = () => setOpen(true)
        window.__dshModelFingerprintSetRail = (value) => setRailOn(Boolean(value))
        window.__dshModelFingerprintClientDebug = () => ({
          native: true,
          railOn,
          railSessionId,
          canvasOpen,
          sessionViewRevision,
          sessionViewStatus,
          latestTurn: latestTurnSummary,
          canvasProbe: canvasProbe.slice(0, 6),
          open,
          apiBase: apiBase(),
          widget: Boolean(window.__dshModelFingerprintWidget),
          nativeToggle: Boolean(document.querySelector('[data-mf-native-toggle]')),
          toggleSessionId: (() => {
            const toggle = [...document.querySelectorAll('[data-mf-native-toggle]')].find((node) => {
              const box = node.getBoundingClientRect()
              return node.getClientRects().length && box.width > 0 && box.height > 0
            })
            return toggle ? toggle.getAttribute('data-mf-session-id') : null
          })(),
          lastFetchError,
          commandError,
          build: CLIENT_BUILD,
          officialTurns: officialTurnRegistry.turns().sort((left, right) => left - right),
          rail: railDebug,
        })
        const reportClientDebug = () => {
          try {
            const debug = window.__dshModelFingerprintClientDebug()
            const describe = (value) => {
              if (value === null || value === undefined) return null
              if (typeof value !== 'object') return String(value).slice(0, 300)
              const output = {}
              for (const key of Object.keys(value).slice(0, 30)) {
                const item = value[key]
                output[key] = item === null || item === undefined
                  ? null
                  : typeof item === 'object'
                    ? Array.isArray(item) ? 'array:' + item.length : 'object:' + Object.keys(item).slice(0, 8).join(',')
                    : String(item).slice(0, 200)
              }
              return output
            }
            const globalInfo = {}
            for (const key of ['dshDesktopBoot', 'dshDesktop', '__DSH_TRANSPORT__', '__DSH_REMOTE_ACCESS__', '__DSH_BOOT__', 'dshPlatform']) {
              globalInfo[key] = describe(window[key])
            }
            fetch(apiUrl('/model-fingerprint/api/client-debug'), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                ...debug,
                href: window.location.href,
                globals: Object.keys(window).filter((key) => /dsh|desktop|boot|api|host|server|web/i.test(key)).slice(0, 80),
                globalInfo,
              }),
              cache: 'no-store',
            }).catch(() => {})
          } catch (error) {
            commandError = error && error.message ? error.message : String(error)
          }
        }
        reportClientDebug()
        every(reportClientDebug, 5000)
        let commandId = 0
        const pullCommand = () => {
          fetch(apiUrl('/model-fingerprint/api/client-command'), { cache: 'no-store' })
            .then((response) => response.ok ? response.json() : null)
            .then((body) => {
              const command = body && body.command
              if (!command || typeof command.railOn !== 'boolean' || !(command.id > commandId)) return
              commandId = command.id
              setRailOn(command.railOn)
            })
            .catch((error) => { commandError = error && error.message ? error.message : String(error) })
        }
        pullCommand()
        every(pullCommand, 2000)
        // The injected widget may be an older cached copy that only updates its
        // own state/localStorage. Adopt its published state so both switches
        // cannot disagree (the original "switch says 开, rail stays hidden" bug).
        every(() => {
          try {
            const nextCanvasOpen = detectCanvasOpen()
            if (nextCanvasOpen !== canvasOpen) {
              canvasOpen = nextCanvasOpen
              emit()
            }
            if (!window.__dshModelFingerprintNative) return
            const nativeToggle = document.querySelector('[data-mf-native-toggle]')
            if (nativeToggle) {
              const fallback = document.getElementById('mf-dock-fallback')
              if (fallback && fallback.parentNode) fallback.parentNode.removeChild(fallback)
            }
            const visibleToggle = [...document.querySelectorAll('[data-mf-native-toggle]')].find((node) => {
              const box = node.getBoundingClientRect()
              return node.getClientRects().length && box.width > 0 && box.height > 0
            })
            const toggleSessionId = visibleToggle ? visibleToggle.getAttribute('data-mf-session-id') : null
            if (toggleSessionId && toggleSessionId !== railSessionId) setRailSession(toggleSessionId)
            const external = window.__dshModelFingerprintRailState
            if (external && typeof external.on === 'boolean' && external.on !== railOn) {
              setRailOn(external.on)
              return
            }
            try {
              const stored = window.localStorage.getItem('dsh.mf.rail') === '1'
              if (stored !== railOn && (!external || external.on === railOn)) setRailOn(stored)
            } catch { /* private mode */ }
          } catch { /* keep the poller alive */ }
        }, 800)
        publishRail()
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'model-fingerprint-turn-rail',
          order: 190,
        }, GuardedTurnRail))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'model-fingerprint-overlay',
          order: 200,
        }, GuardedOverlay))
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'model-fingerprint-turn-probe',
          order: 20,
        }, GuardedTurnProbe))
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'model-fingerprint-toggle',
          order: -20,
        }, GuardedComposerToggle))
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            for (const id of intervals.splice(0)) {
              try { window.clearInterval(id) } catch { /* already gone */ }
            }
            if (window.__dshModelFingerprintIntervalIds === intervals) window.__dshModelFingerprintIntervalIds = []
          })
        }
      },
    }
  },
})
