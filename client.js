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
        const base = role === 'squeeze' ? 380 : role === 'incoming' ? 260 : 340
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
        const top = Number(row.top)
        const bottom = Number(row.bottom)
        if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) continue
        seen.add(turn.id)
        const priorZone = previous.get(turn.id) || null
        let zone = 'middle'
        if (priorZone === 'top') {
          if (bottom <= clipTop + RAIL_TOP_LEAVE) zone = 'top'
        } else if (bottom <= clipTop - RAIL_TOP_ENTER) {
          zone = 'top'
        }
        if (zone === 'middle') {
          if (priorZone === 'bottom') {
            if (top >= clipBottom - RAIL_BOTTOM_LEAVE) zone = 'bottom'
          } else if (top >= clipBottom + RAIL_BOTTOM_ENTER) {
            zone = 'bottom'
          }
        }
        if (zone === 'middle' && !(bottom > clipTop && top < clipBottom)) continue
        candidates.push({ turn, row, top, bottom, zone })
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
      const candidates = new Set([0, oldOffset])
      for (const domTurn of dom.slice(0, 24)) {
        for (const apiTurn of api.slice(0, 24)) candidates.add(domTurn - apiTurn)
      }
      let bestOffset = oldOffset
      let bestScore = oldScore
      let tie = false
      for (const candidate of candidates) {
        const score = matchCount(candidate)
        if (score > bestScore) {
          bestOffset = candidate
          bestScore = score
          tie = false
        } else if (score === bestScore && candidate !== bestOffset) {
          tie = true
        }
      }
      if (bestScore < 2) return { offset: oldOffset, confidence: oldScore > 0 ? (previous.confidence || 0.6) : 0, score: oldScore, tie }
      // A tied candidate set is ambiguous. Keep the previous offset rather
      // than selecting whichever candidate happened to be enumerated first.
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
      constructor({ fetchTurn, onTurn, limit = 4 } = {}) {
        this.fetchTurn = fetchTurn
        this.onTurn = onTurn
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
              if (!payload || !payload.turn) return
              if (context.sessionId && payload.sessionId && String(payload.sessionId) !== String(context.sessionId)) return
              const revision = Number(payload.revision)
              if (Number.isFinite(revision) && Number.isFinite(Number(context.revision)) && revision < Number(context.revision)) return
              const generation = payload.generation === undefined ? context.generation : payload.generation
              const expected = context.generation === undefined ? '' : String(context.generation)
              if (expected && expected !== '0' && generation !== undefined && String(generation) !== expected) return
              this.onTurn(payload.turn, payload)
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
    const CLIENT_BUILD = '2026-11-14-3'
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
          turnsRef.current = []
          turnWindow.current.reset()
          hasMoreRef.current = false
          setHasMore(false)
          setTurns([])
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
            const key = JSON.stringify(merged)
            if (key !== turnsKey.current) {
              turnsKey.current = key
              turnsRef.current = merged
              setTurns(merged)
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
              turnsRef.current = merged
              setTurns(merged)
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
        let resizeObserver = null
        let flowObserver = null
        let observedFlow = null
        let observedResizeFlow = null
        let mutationTimer = 0
        let tick = null
        let disposed = false

        tracker.current = new RailSnapshotTracker({ maxWaitMs: 600 })
        const beginJump = (reason) => {
          const fromSignature = tracker.current ? tracker.current.signature : ''
          jump.current = { pending: true, generation: jump.current.generation + 1, at: performance.now(), reason, fromSignature }
          tracker.current.reset()
          animator.cancelAll(cardRefs.current.values())
          turnQueue.invalidate()
          noteRecoveryEvent()
        }

        const findFlow = () => {
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
        const spring = reducedMotion ? 'ease-out' : 'cubic-bezier(.22,1,.36,1)'
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
          },
          onTurn: (turn, payload) => {
            if (disposed || !turn || turn.hasModelData === false) return
            const current = requestView.current
            if (payload && payload.sessionId && current.sessionId && String(payload.sessionId) !== String(current.sessionId)) return
            if (payload && payload.generation !== undefined && String(current.generation) !== '0' && String(payload.generation) !== String(current.generation)) return
            if (payload && Number(payload.revision) < Number(current.revision)) return
            const merged = turnWindow.current.merge([turn])
            turnsRef.current = merged
            setTurns(merged)
            noteRecoveryEvent()
            schedule(true)
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
            flow: Boolean(observedFlow),
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

        const measureLayout = (flow) => {
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
          const nextCompact = gap < cardWidth + 24 || (sidebarRight === 0 && flowRect.left < cardWidth * 2)
          const anchorRight = TurnGeometry.anchorRight(flowRect, sidebarRight, safeLeft, cardWidth)
          const right = Math.max(6, window.innerWidth - anchorRight)
          return {
            ready: true,
            left: anchorRight,
            right,
            anchorRight,
            offset: mapping.current.offset,
            clipTop,
            clipBottom,
            composerTop,
            scrollContainer,
            compact: nextCompact,
            sidebarRight,
            flowLeft: flowRect.left,
            flowWidth: flowRect.width,
            flowIdentity: flow,
          }
        }

        const captureSnapshot = (flow) => {
          const raw = []
          let invalid = false
          for (const node of flow.querySelectorAll('[data-chat-turn]')) {
            const value = node.getAttribute('data-chat-turn')
            const domTurn = Number(value)
            if (!Number.isFinite(domTurn)) continue
            if (node.getAttribute('data-chat-turn') !== value) invalid = true
            raw.push({ node, domTurn, value })
          }
          if (invalid) return { invalid: true, flow, rows: [], domTurns: [], signature: '' }
          const groups = new Map()
          for (const row of raw) {
            if (!groups.has(row.domTurn)) groups.set(row.domTurn, [])
            groups.get(row.domTurn).push(row)
          }
          const rows = []
          for (const [domTurn, group] of groups) {
            for (const entry of group) {
              if (entry.node.getAttribute('data-chat-turn') !== entry.value) {
                invalid = true
                break
              }
            }
            if (invalid) break
            const nodes = TurnGeometry.responseNodes(group.map((entry) => entry.node))
            const box = TurnGeometry.measureNormalized(nodes, geometry.current.clipTop, geometry.current.clipBottom)
            for (const entry of group) {
              if (entry.node.getAttribute('data-chat-turn') !== entry.value) {
                invalid = true
                break
              }
            }
            if (invalid) break
            if (!box) continue
            rows.push({
              domTurn,
              top: box.top,
              bottom: box.bottom,
              anchorTop: box.anchor ? box.anchor.visibleTop : null,
              anchorBottom: box.anchor ? box.anchor.visibleBottom : null,
              segments: box.segments || [],
            })
          }
          if (invalid) return { invalid: true, flow, rows: [], domTurns: [...groups.keys()], signature: '' }
          rows.sort((left, right) => left.top - right.top)
          const domTurns = rows.map((row) => row.domTurn)
          const signature = rows.map((row) => row.domTurn + ':' + Math.round(row.top) + ':' + Math.round(row.bottom)).join('|')
          return { flow, rows, domTurns, signature, time: performance.now() }
        }

        const zonesFromCommitted = () => {
          const zones = new Map()
          for (const [id, target] of committed.current) zones.set(id, target.zone)
          return zones
        }

        const applyRange = (node, target, cardTop) => {
          const range = node.querySelector ? node.querySelector('[data-mf-range]') : null
          if (!range) return
          const segments = Array.isArray(target.segments) ? target.segments.slice(0, 3) : []
          range.style.opacity = segments.length ? '0.72' : '0'
          const segmentEls = [...range.querySelectorAll('[data-mf-range-segment]')]
          for (let index = 0; index < segmentEls.length; index += 1) {
            const segmentEl = segmentEls[index]
            const segment = segments[index]
            if (segment && segment.bottom - segment.top > 12) {
              segmentEl.style.opacity = '1'
              segmentEl.style.top = Math.round(segment.top - cardTop) + 'px'
              segmentEl.style.height = Math.round(segment.bottom - segment.top) + 'px'
              if (!segmentEl.__mfRangeShown) {
                segmentEl.__mfRangeShown = true
                segmentEl.style.transform = 'scaleY(0)'
                window.requestAnimationFrame(() => {
                  if (segmentEl.isConnected) segmentEl.style.transform = 'scaleY(1)'
                })
              } else {
                segmentEl.style.transform = 'scaleY(1)'
              }
            } else {
              segmentEl.style.opacity = '0'
              segmentEl.style.transform = 'scaleY(0)'
              segmentEl.__mfRangeShown = false
            }
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
            setTransition(node, reducedMotion ? 'opacity 60ms linear' : 'opacity 220ms ease, filter 180ms ease, box-shadow 180ms ease, border-color 180ms ease, width 240ms cubic-bezier(.22,1,.36,1), padding 240ms cubic-bezier(.22,1,.36,1), border-radius 240ms cubic-bezier(.22,1,.36,1)')
            node.title = (target.zone === 'top' ? '上方 · ' : target.zone === 'bottom' ? '下方 · ' : '') + '第 ' + target.turn.turn + ' 轮 · ' + target.turn.verdictLabel + (target.zone === 'middle' && target.segments && target.segments.length ? ' · 右侧细线为可见区间' : '')
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

        const buildTargets = (snapshot) => {
          const layout = geometry.current
          const cardH = layout.compact ? 24 : 58
          const topY = layout.clipTop + 8
          const bottomY = layout.clipBottom - cardH - 4
          const laneTop = layout.clipTop + 8
          const laneBottom = layout.clipBottom - 8
          const laneMax = Math.max(laneTop, laneBottom - cardH)
          const derived = validateRailTargets(deriveRailTargets(snapshot, turnsRef.current, mapping.current, layout, zonesFromCommitted()))
          const middleTop = derived.top ? topY + cardH + 6 : laneTop
          const middleBottom = derived.bottom ? bottomY - 6 : laneBottom
          const middleMax = Math.max(middleTop, middleBottom - cardH)
          const targets = new Map()
          let lastBottom = middleTop
          const middle = derived.middle.slice().sort((left, right) => left.top - right.top)
          for (const entry of middle) {
            const visibleTop = Math.max(entry.top, layout.clipTop + 4)
            const visibleBottom = Math.min(entry.bottom, layout.clipBottom - 4)
            if (visibleBottom <= visibleTop) continue
            const segments = entry.row.segments || []
            const lineTop = segments.length ? Math.min(...segments.map((segment) => segment.top)) : visibleTop
            const lineBottom = segments.length ? Math.max(...segments.map((segment) => segment.bottom)) : visibleBottom
            const center = (lineTop + lineBottom) / 2
            let y = center - cardH / 2
            const prior = visual.current.get(entry.turn.id)
            if (prior && prior.visible && prior.zone === 'middle') {
              const topEdge = prior.top
              const bottomEdge = prior.top + cardH
              if (center > bottomEdge) y = center - cardH
              else if (center < topEdge) y = center
              else y = prior.top
            }
            y = Math.min(Math.max(y, middleTop), middleMax)
            y = Math.min(Math.max(y, lastBottom + 4), middleMax)
            targets.set(entry.turn.id, {
              top: Math.round(y),
              zone: 'middle',
              turn: entry.turn,
              segments: segments.slice(0, 3),
              rangeTop: lineTop,
              rangeBottom: lineBottom,
            })
            lastBottom = y + cardH + 4
          }
          if (derived.top) {
            targets.set(derived.top.turn.id, { top: Math.round(topY), zone: 'top', turn: derived.top.turn })
          }
          if (derived.bottom) {
            targets.set(derived.bottom.turn.id, { top: Math.round(bottomY), zone: 'bottom', turn: derived.bottom.turn })
          }
          return targets
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
          const targets = buildTargets(snapshot)
          applyTargets(targets, snapshot)
          const focusTarget = [...targets.values()].find((target) => target.zone === 'middle') || [...targets.values()][0]
          if (focusTarget && turnWindow.current.pruneAround(focusTarget.turn.turn)) {
            const pruned = turnWindow.current.turns()
            turnsRef.current = pruned
            setTurns(pruned)
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
            placeholder: placeholderPosition.current.visible,
            offset: mapping.current.offset,
            mappingConfidence: mapping.current.confidence,
            mappingGeneration: mapping.current.generation,
            jumpGeneration: jump.current.generation,
            measured: snapshot.rows.length,
            domTurns: snapshot.rows.map((row) => row.domTurn).slice(0, 12),
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

        const update = (needsRebuild) => {
          const flow = findFlow()
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
            schedule(true, { recover: true })
            return
          }
          mapping.current.flowIdentity = flow
          const priorRows = geometry.current.lastRows
          if (typeof MutationObserver === 'function' && !flowObserver) {
            flowObserver = new MutationObserver(() => {
              if (mutationTimer) return
              mutationTimer = window.setTimeout(() => {
                mutationTimer = 0
                noteRecoveryEvent()
                schedule(true)
              }, 40)
            })
          }
          if (flowObserver && observedFlow !== flow) {
            flowObserver.disconnect()
            flowObserver.observe(flow, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-chat-turn'] })
            observedFlow = flow
          }
          if (typeof ResizeObserver === 'function' && observedResizeFlow !== flow) {
            if (!resizeObserver) resizeObserver = new ResizeObserver(() => { noteRecoveryEvent(); schedule(true) })
            else resizeObserver.disconnect()
            resizeObserver.observe(flow)
            observedResizeFlow = flow
          }
          const layout = measureLayout(flow)
          geometry.current = { ...layout, ready: true, domTurns: geometry.current.domTurns || [] }
          const snapshot = captureSnapshot(flow)
          geometry.current.domTurns = snapshot.domTurns || []
          const detected = priorRows && !snapshot.invalid ? railJumpDetected({ rows: priorRows }, snapshot) : null
          if (detected && !jump.current.pending) beginJump(detected)
          if (!snapshot.invalid) geometry.current.lastRows = snapshot.rows.map((row) => ({ domTurn: row.domTurn, top: row.top, bottom: row.bottom }))
          if (!snapshot.invalid) {
            const apiTurns = turnsRef.current.map((turn) => Number(turn.turn)).filter(Number.isFinite)
            const chosen = chooseRailMapping(apiTurns, snapshot.domTurns, mapping.current)
            mapping.current = { ...mapping.current, offset: chosen.offset, confidence: chosen.confidence }
            geometry.current.offset = chosen.offset
            try {
              turnQueue.request(snapshot.domTurns, turnsRef.current, chosen.offset, {
                sessionId: requestView.current.sessionId || sessionId || railSessionId,
                revision: requestView.current.revision,
                generation: requestView.current.generation,
              })
            } catch { /* request failures never remove cards */ }
          }
          if (mapping.current.confidence <= 0 && snapshot.rows.length) {
            retainVisual('mapping-pending')
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
          if (top < 320 && hasMoreRef.current) loadOlderRef.current?.()
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
          if (resizeObserver) resizeObserver.disconnect()
          if (flowObserver) flowObserver.disconnect()
          if (mutationTimer) clearTimeout(mutationTimer)
          if (recovery.current.timer) clearTimeout(recovery.current.timer)
          recovery.current.timer = 0
          turnQueue.invalidate()
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
        const color = railColors[turn.verdict] || railColors.first
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
            background: 'var(--dsw-specific-menu, rgba(255,255,255,.94))',
            border: '1px solid var(--dsw-alias-border-l1, rgba(20,30,45,.14))',
            boxShadow: '0 2px 10px rgba(16,24,40,.10)',
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
            height: '100%',
            opacity: 0,
            pointerEvents: 'none',
            color: 'rgba(91, 117, 145, .76)',
            transition: 'opacity 180ms ease',
          },
        },
          [0, 1, 2].map((index) => h('span', {
            key: 'segment-' + index,
            'data-mf-range-segment': String(index),
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              width: 5,
              height: 0,
              opacity: 0,
              transform: 'scaleY(0)',
              transformOrigin: 'top center',
              transition: 'opacity 180ms ease, transform 620ms cubic-bezier(.22,1,.36,1)',
            },
          },
            h('span', { key: 'line', style: { position: 'absolute', left: 0, top: 0, width: 1.5, height: '100%', background: 'currentColor', borderRadius: 1 } }),
            h('span', { key: 'top', style: { position: 'absolute', left: 0, top: 0, width: 5, height: 1.5, background: 'currentColor', borderRadius: 1 } }),
            h('span', { key: 'bottom', style: { position: 'absolute', left: 0, bottom: 0, width: 5, height: 1.5, background: 'currentColor', borderRadius: 1 } }),
          )),
        )
        if (compact) {
          base.style.width = 56
          base.style.padding = '3px 4px'
          base.style.textAlign = 'center'
          base.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
          base.style.fontSize = 10
          base.style.color = color
          base.title = '第 ' + turn.turn + ' 轮 · ' + turn.verdictLabel
          return h('div', base, rangeEl, 'FP-' + String(turn.primaryShort || '').slice(0, 4))
        }
        base.style.width = 176
        base.style.padding = '6px 8px 7px'
        base.title = '点击打开逐轮检测面板'
        return h('div', base,
          rangeEl,
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5, fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #667085)' } },
            h('span', null, '第 ' + turn.turn + ' 轮'),
            h('span', null, turn.verdict === 'same' ? '一致' : turn.verdict === 'changed' ? '变化' : turn.verdict === 'mixed' ? '多指纹' : turn.verdict === 'generation' ? '代际' : '基线'),
          ),
          h('div', { key: 'body', style: { marginTop: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, fontWeight: 750, color } }, 'FP-' + String(turn.primaryShort || '')),
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
