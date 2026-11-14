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
        this.resizeNodes = []
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
        const fullCardWidth = 176
        const compact = gap < fullCardWidth + 24 || (sidebarRight === 0 && flowRect.left < fullCardWidth * 2)
        // The compact pill is only 56px wide. Reserving 176px for it leaves a
        // dead band between the sidebar and the card, so the card stops moving
        // outward even when real space remains.
        const cardWidth = compact ? 56 : fullCardWidth
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
          this.resizeNodes = [flow, flow.parentElement, document.documentElement].filter(Boolean)
          for (const node of this.resizeNodes) this.resizeObserver.observe(node)
        }
      }
      disconnectObservers() {
        if (this.observer) this.observer.disconnect()
        if (this.resizeObserver) this.resizeObserver.disconnect()
        this.observer = null
        this.resizeObserver = null
        this.resizeNodes = []
        this.observedFlow = null
      }
      dispose() {
        this.disconnectObservers()
        if (this.unsubscribeRegistry) this.unsubscribeRegistry()
        this.unsubscribeRegistry = null
        this.listeners.clear()
      }
    }
