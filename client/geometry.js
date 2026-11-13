    class TurnGeometry {
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
        const nodes = TurnGeometry.responseNodes(rawNodes)
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
