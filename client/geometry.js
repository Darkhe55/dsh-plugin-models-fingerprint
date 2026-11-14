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
