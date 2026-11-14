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
