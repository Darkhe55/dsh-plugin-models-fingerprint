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
