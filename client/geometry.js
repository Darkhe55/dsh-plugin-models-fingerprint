    class TurnGeometry {
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
      static measure(nodes, clipTop, clipBottom) {
        const union = TurnGeometry.box(nodes)
        if (!union) return null
        const visibleNodes = []
        for (const node of nodes || []) {
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
