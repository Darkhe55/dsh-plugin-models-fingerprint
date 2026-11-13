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
    const CLIENT_BUILD = '2026-11-13-66'
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
      railOn = Boolean(value)
      try { window.localStorage.setItem('dsh.mf.rail', railOn ? '1' : '0') } catch { /* private mode */ }
      publishRail()
      emit()
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
      try {
        const nodes = document.querySelectorAll('.dshcv-root, .dshcv-head')
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

    function TurnRail() {
      const on = useRailOn()
      const sessionId = useRailSession()
      const [turns, setTurns] = React.useState([])
      const [layout, setLayout] = React.useState([])
      const [viewport, setViewport] = React.useState({ top: 0, bottom: 0 })
      const viewportRef = React.useRef({ top: 0, bottom: 0 })
      const lastSignature = React.useRef('')
      const railRef = React.useRef(null)

      React.useEffect(() => {
        if (!on) {
          setTurns([])
          return undefined
        }
        let cancelled = false
        let timer = null
        const load = async () => {
          let target = sessionId
          if (!target) {
            try {
              const response = await fetch(apiUrl('/model-fingerprint/api/status?limit=1'), { cache: 'no-store' })
              if (response.ok) {
                const status = await response.json()
                target = status && status.latest && status.latest.session ? status.latest.session.id : null
                if (target) setRailSession(target)
              }
            } catch { /* status is best effort */ }
          }
          if (!target || cancelled) return
          try {
            const response = await fetch(apiUrl('/model-fingerprint/api/session?id=' + encodeURIComponent(target) + '&limit=200'), { cache: 'no-store' })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const payload = await response.json()
            if (!cancelled) {
              lastFetchError = null
              setTurns(payload.turns || [])
            }
          } catch (error) {
            if (!cancelled) {
              lastFetchError = error && error.message ? error.message : String(error)
              setTurns([])
            }
          }
        }
        load()
        timer = setInterval(load, 6000)
        return () => {
          cancelled = true
          if (timer) clearInterval(timer)
        }
      }, [on, sessionId])

      React.useEffect(() => {
        if (!on) {
          railDebug = { flow: false, flowTurns: 0, turns: 0, cards: 0, reason: 'off' }
          setLayout([])
          return undefined
        }
        const measure = () => {          const candidates = [...document.querySelectorAll('[data-slot="conversation.chat.flow"], [data-chat-flow]')]
          const usable = (node) => {
            if (!node || !node.getBoundingClientRect) return false
            const box = node.getBoundingClientRect()
            if (box.width < 320 || box.height < 120) return false
            if (node.closest('aside, nav, [data-slot*="sidebar"], [class*="sidebar"], [class*="workspace"]')) return false
            return node.querySelectorAll('[data-chat-turn]').length > 0
          }
          let flow = candidates.find((node) => node.matches('[data-slot="conversation.chat.flow"]') && usable(node)) || null
          let bestCount = flow ? flow.querySelectorAll('[data-chat-turn]').length : 0
          let bestWidth = flow ? flow.getBoundingClientRect().width : Infinity
          if (!flow) {
            for (const candidate of candidates) {
              if (!usable(candidate)) continue
              const count = candidate.querySelectorAll('[data-chat-turn]').length
              const width = candidate.getBoundingClientRect().width
              if (count > bestCount || (count === bestCount && width < bestWidth)) {
                bestCount = count
                bestWidth = width
                flow = candidate
              }
            }
          }
          if (!flow) {
            let cursor = document.querySelector('[data-slot="conversation.chat.flow"] [data-chat-turn], main [data-chat-turn], [data-chat-turn]')
            while (cursor && cursor !== document.body) {
              if (!cursor.closest('aside, nav, [data-slot*="sidebar"], [class*="sidebar"], [class*="workspace"]') && cursor.querySelectorAll('[data-chat-turn]').length) {
                flow = cursor
                break
              }
              cursor = cursor.parentElement
            }
          }
          if (!flow || !turns.length) {
            railDebug = { flow: Boolean(flow), flowTurns: flow ? flow.querySelectorAll('[data-chat-turn]').length : 0, turns: turns.length, cards: 0, reason: flow ? 'no-turns' : 'no-flow' }
            setLayout([])
            return
          }
          const flowRect = flow.getBoundingClientRect()
          if (flowRect.width < 120) {
            railDebug = { flow: true, flowTurns: flow.querySelectorAll('[data-chat-turn]').length, turns: turns.length, cards: 0, reason: 'narrow-flow' }
            setLayout([])
            return
          }
          let clipTop = 0
          let clipBottom = window.innerHeight
          let container = flow.parentElement
          while (container && container !== document.body) {
            const style = window.getComputedStyle(container)
            const box = container.getBoundingClientRect()
            if (/(auto|scroll)/.test(style.overflowY) && box.height > 180) {
              clipTop = Math.max(0, box.top)
              clipBottom = Math.min(window.innerHeight, box.bottom)
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
          if (Math.abs(viewportRef.current.top - clipTop) > 1 || Math.abs(viewportRef.current.bottom - clipBottom) > 1) {
            viewportRef.current = { top: clipTop, bottom: clipBottom }
            setViewport({ top: clipTop, bottom: clipBottom })
          }
          const domTurns = []
          for (const node of flow.querySelectorAll('[data-chat-turn]')) {
            const value = node.getAttribute('data-chat-turn')
            if (value !== null && !domTurns.includes(value)) domTurns.push(value)
          }
          const apiTurns = turns.map((item) => Number(item.turn)).filter((value) => Number.isFinite(value))
          const domNumeric = domTurns.map((value) => Number(value)).filter((value) => Number.isFinite(value))
          let offset = 0
          if (apiTurns.length && domNumeric.length) {
            const candidate = Math.min(...domNumeric) - Math.min(...apiTurns)
            if (turns.every((item) => domTurns.includes(String(Number(item.turn) + candidate)))) offset = candidate
          }
          let sidebarRight = 0
          for (const node of document.querySelectorAll('aside, nav, [data-slot*="sidebar"], [class*="sidebar"]')) {
            const box = node.getBoundingClientRect()
            if (box.width >= 150 && box.height >= 280 && box.height <= window.innerHeight + 4 && box.right <= flowRect.left + 2) {
              sidebarRight = Math.max(sidebarRight, box.right)
            }
          }
          const safeLeft = sidebarRight > 0 ? sidebarRight + 2 : Math.max(8, flowRect.left - 64)
          const gap = flowRect.left - sidebarRight
          const cardWidth = 176
          const compact = gap < cardWidth + 24 || (sidebarRight === 0 && flowRect.left < cardWidth * 2)
          const left = compact
            ? Math.max(safeLeft, flowRect.left - 62)
            : Math.max(safeLeft, flowRect.left - cardWidth - 10)
          const entries = []
          for (const turn of turns) {
            const nodes = flow.querySelectorAll('[data-chat-turn="' + String(Number(turn.turn) + offset) + '"]')
            let top = Infinity
            let bottom = -Infinity
            for (const node of nodes) {
              if (!node.getClientRects().length) continue
              const box = node.getBoundingClientRect()
              if (!box.height) continue
              top = Math.min(top, box.top)
              bottom = Math.max(bottom, box.bottom)
            }
            if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue
            if (bottom < clipTop - 20 || top > clipBottom + 20) continue
            entries.push({ turn, top, bottom })
          }
          entries.sort((leftItem, rightItem) => leftItem.top - rightItem.top)
          const result = []
          let lastBottom = clipTop + 8
          for (const entry of entries) {
            const cardTop = Math.max(entry.top, lastBottom + 4, clipTop + 8)
            if (cardTop > clipBottom - 38) continue
            lastBottom = cardTop + 45
            result.push({
              id: entry.turn.id,
              turn: entry.turn.turn,
              verdict: entry.turn.verdict,
              verdictLabel: entry.turn.verdictLabel,
              tone: entry.turn.verdict || 'first',
              compact,
              left,
              cardTop,
              short: entry.turn.primaryShort,
              model: entry.turn.primaryModel,
            })
          }
          const signature = result.map((item) => item.id + ':' + item.left + ':' + item.cardTop + ':' + item.compact).join('|') + '@' + Math.round(clipTop) + ',' + Math.round(clipBottom)
          if (signature !== lastSignature.current) {
            lastSignature.current = signature
            setLayout(result)
          }
          railDebug = {
            flow: true,
            flowTurns: domTurns.length,
            turns: turns.length,
            cards: result.length,
            reason: result.length ? 'ok' : 'no-visible-turns',
            flowLeft: Math.round(flowRect.left),
            flowWidth: Math.round(flowRect.width),
            sidebarRight: Math.round(sidebarRight),
            left: Math.round(left),
            compact,
            clipTop: Math.round(clipTop),
            clipBottom: Math.round(clipBottom),
            viewport: window.innerWidth,
          }
        }
        let timer = 0
        const schedule = () => {
          if (timer) return
          timer = window.setTimeout(() => {
            timer = 0
            measure()
          }, 60)
        }
        measure()
        window.addEventListener('scroll', schedule, { capture: true, passive: true })
        window.addEventListener('resize', schedule)
        const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
        const observedFlow = document.querySelector('[data-slot="conversation.chat.flow"]') || document.querySelector('[data-chat-flow]')
        if (resizeObserver && observedFlow) resizeObserver.observe(observedFlow)
        const tick = window.setInterval(schedule, 1500)
        return () => {
          if (timer) window.clearTimeout(timer)
          window.removeEventListener('scroll', schedule, true)
          window.removeEventListener('resize', schedule)
          if (resizeObserver) resizeObserver.disconnect()
          window.clearInterval(tick)
        }
      }, [on, turns, sessionId])

      if (!on) return null
      const children = layout.map((item) => {
        const color = railColors[item.tone] || railColors.first
        const card = item.compact
          ? h('div', {
              key: item.id + ':card',
              style: {
                position: 'absolute',
                left: item.left,
                top: item.cardTop,
                pointerEvents: 'auto',
                cursor: 'pointer',
                padding: '3px 4px',
                width: 56,
                boxSizing: 'border-box',
                textAlign: 'center',
                borderRadius: 999,
                background: 'var(--dsw-specific-menu, #fff)',
                border: '1px solid var(--dsw-alias-border-l1, rgba(20,30,45,.14))',
                boxShadow: '0 2px 8px rgba(16,24,40,.12)',
                color,
                fontSize: 10,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              },
              onClick: () => setOpen(true),
              title: '第 ' + item.turn + ' 轮 · ' + item.verdictLabel,
            }, 'FP-' + String(item.short || '').slice(0, 4))
          : h('div', {
              key: item.id + ':card',
              style: {
                position: 'absolute',
                left: item.left,
                top: item.cardTop,
                width: 176,
                boxSizing: 'border-box',
                pointerEvents: 'auto',
                cursor: 'pointer',
                padding: '6px 8px 7px',
                borderRadius: 10,
                border: '1px solid var(--dsw-alias-border-l1, rgba(20,30,45,.14))',
                background: 'var(--dsw-specific-menu, rgba(255,255,255,.94))',
                boxShadow: '0 4px 16px rgba(16,24,40,.12)',
                color: 'var(--dsw-alias-label-primary, #1b1f24)',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
                lineHeight: 1.35,
              },
              onClick: () => setOpen(true),
              title: '点击打开逐轮检测面板',
            },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5, fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #667085)' } },
                h('span', null, '第 ' + item.turn + ' 轮'),
                h('span', null, item.verdict === 'same' ? '一致' : item.verdict === 'changed' ? '变化' : item.verdict === 'mixed' ? '多指纹' : item.verdict === 'generation' ? '代际' : '基线'),
              ),
              h('div', { style: { marginTop: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, fontWeight: 750, color } }, 'FP-' + String(item.short || '')),
              h('div', { style: { marginTop: 1, fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #667085)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, String(item.model || '')),
            )
        return card
      })
      if (!layout.length) {
        children.push(h('div', {
          key: 'status',
          style: {
            position: 'absolute',
            left: 8,
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
      const clipPath = viewport.bottom > viewport.top
        ? 'inset(' + Math.round(viewport.top) + 'px 0 ' + Math.max(0, Math.round(window.innerHeight - viewport.bottom)) + 'px 0)'
        : undefined
      return h('div', {
        ref: railRef,
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 8,
          pointerEvents: 'none',
          overflow: 'hidden',
          clipPath,
        },
      }, children)
    }

    function TurnRailFast() {
      const on = useRailOn()
      const sessionId = useRailSession()
      const canvasOpen = useCanvasOpen()
      const [turns, setTurns] = React.useState([])
      const [hasMore, setHasMore] = React.useState(false)
      const [renderIds, setRenderIds] = React.useState(new Set())
      const [compact, setCompact] = React.useState(false)
      const [clip, setClip] = React.useState({ top: 0, bottom: 0 })
      const [flowReady, setFlowReady] = React.useState(true)
      const railRef = React.useRef(null)
      const cardRefs = React.useRef(new Map())
      const positions = React.useRef(new Map())
      const lastKnownCard = React.useRef(null)
      const loadedSessionRef = React.useRef(null)
      const turnsKey = React.useRef('')
      const geometry = React.useRef({ ready: false, left: 0, turnNodes: new Map(), offset: 0, clipTop: 0, clipBottom: 0 })
      const exitHoldRef = React.useRef(new Map())
      const initialFadeRef = React.useRef(true)
      const initialFadeAtRef = React.useRef(0)
      const turnsRef = React.useRef([])
      const hasMoreRef = React.useRef(false)
      const renderIdsRef = React.useRef(new Set())
      const autoPreloadRef = React.useRef(false)
      const loadOlderRef = React.useRef(null)
      const refreshRef = React.useRef(null)
      const mergeTurns = (current, incoming) => {
        const map = new Map()
        for (const turn of current || []) map.set(turn.id, turn)
        for (const turn of incoming || []) map.set(turn.id, turn)
        return [...map.values()].sort((left, right) => Number(right.turn) - Number(left.turn))
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
          turnsRef.current = []
          hasMoreRef.current = false
          setHasMore(false)
          renderIdsRef.current = new Set()
          setRenderIds(new Set())
          setTurns([])
          positions.current.clear()
          lastKnownCard.current = null
          exitHoldRef.current.clear()
          initialFadeRef.current = true
          initialFadeAtRef.current = 0
          geometry.current = { ready: false, left: 0, turnNodes: new Map(), offset: 0, clipTop: 0, clipBottom: 0 }
          sessionViewRevision = 0
          sessionViewStatus = 'loading'
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
            lastFetchError = null
            sessionViewRevision = legacy ? 0 : Number(payload.revision) || 0
            sessionViewStatus = legacy ? 'legacy' : String(payload.status || 'unknown')
            const next = Array.isArray(payload.turns) ? payload.turns : []
            const merged = mergeTurns(turnsRef.current, next)
            const key = JSON.stringify(merged)
            if (key !== turnsKey.current) {
              turnsKey.current = key
              turnsRef.current = merged
              setTurns(merged)
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
          try {
            const target = railSessionId || sessionId
            if (!target) return
            const response = await fetch(apiUrl('/model-fingerprint/api/session-view?id=' + encodeURIComponent(target) + '&limit=200&before=' + encodeURIComponent(String(oldest.turn))), { cache: 'no-store' })
            if (!response.ok) return
            const payload = await response.json()
            const next = Array.isArray(payload.turns) ? payload.turns : []
            if (next.length) {
              const merged = mergeTurns(turnsRef.current, next)
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
          if (controller) controller.abort()
          if (timer) clearInterval(timer)
        }
      }, [sessionId])

      React.useEffect(() => {
        const refresh = () => refreshRef.current?.()
        const preload = () => loadOlderRef.current?.()
        window.addEventListener('dsh-mf-refresh', refresh)
        window.addEventListener('dsh-mf-preload', preload)
        return () => {
          window.removeEventListener('dsh-mf-refresh', refresh)
          window.removeEventListener('dsh-mf-preload', preload)
        }
      }, [])

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
        let mutationTimer = 0
        let jumpTimer = 0
        let tick = null

        const hideAll = () => {
          for (const node of cardRefs.current.values()) {
            node.style.opacity = '0'
            node.style.scale = '0.86'
            node.style.pointerEvents = 'none'
          }
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

        const rebuild = () => {
          const flow = findFlow()
          if (!flow) {
            geometry.current = { ready: false, left: 0, turnNodes: new Map(), offset: 0, clipTop: 0, clipBottom: 0 }
            hideAll()
            setFlowReady(false)
            railDebug = { flow: false, flowTurns: 0, turns: turns.length, cards: 0, reason: 'no-flow' }
            return
          }
          const flowRect = flow.getBoundingClientRect()
          const domTurns = []
          const domNodeMap = new Map()
          for (const node of flow.querySelectorAll('[data-chat-turn]')) {
            const value = node.getAttribute('data-chat-turn')
            if (value === null) continue
            if (!domTurns.includes(value)) domTurns.push(value)
            if (!domNodeMap.has(value)) domNodeMap.set(value, [])
            domNodeMap.get(value).push(node)
          }
          const apiTurns = turns.map((item) => Number(item.turn)).filter((value) => Number.isFinite(value))
          const domNumeric = domTurns.map((value) => Number(value)).filter((value) => Number.isFinite(value))
          const domSet = new Set(domTurns)
          const matchCount = (delta) => {
            let matches = 0
            for (const value of apiTurns) {
              if (domSet.has(String(value + delta))) matches += 1
            }
            return matches
          }
          let offset = 0
          const previousOffset = Number(geometry.current.offset) || 0
          const previousScore = previousOffset ? matchCount(previousOffset) : 0
          const directScore = matchCount(0)
          if (previousScore > 0 && previousScore >= directScore) {
            offset = previousOffset
          } else if (directScore > 0) {
            offset = 0
          } else if (apiTurns.length && domNumeric.length) {
            const candidates = new Set([
              Math.min(...domNumeric) - Math.min(...apiTurns),
              Math.max(...domNumeric) - Math.max(...apiTurns),
            ])
            const domSample = domNumeric.slice(0, 20)
            const apiSample = apiTurns.slice(0, 20)
            for (const dom of domSample) {
              for (const api of apiSample) candidates.add(dom - api)
            }
            let best = 0
            let bestScore = 0
            for (const candidate of candidates) {
              const score = matchCount(candidate)
              if (score > bestScore) {
                best = candidate
                bestScore = score
              }
            }
            if (bestScore >= 2) offset = best
          }
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
          const activeWidth = nextCompact ? 56 : cardWidth
          const maxLeft = Math.max(safeLeft, flowRect.right - activeWidth - 6)
          const left = Math.min(maxLeft, nextCompact ? Math.max(safeLeft, flowRect.left - 62) : Math.max(safeLeft, flowRect.left - cardWidth - 10))
          const turnNodes = new Map()
          const renderedTurns = []
          const domRows = []
          for (const [value, nodes] of domNodeMap) {
            let top = Infinity
            let bottom = -Infinity
            for (const node of nodes) {
              const box = node.getBoundingClientRect()
              if (!box.height) continue
              top = Math.min(top, box.top)
              bottom = Math.max(bottom, box.bottom)
            }
            if (Number.isFinite(top) && Number.isFinite(bottom)) domRows.push({ value, top: Math.round(top), bottom: Math.round(bottom) })
          }
          for (const turn of turns) {
            const key = String(Number(turn.turn) + offset)
            const nodes = domNodeMap.get(key) || []
            turnNodes.set(key, nodes)
            if (nodes.length) renderedTurns.push({ turn, nodes })
          }
          geometry.current = { ready: true, left, turnNodes, renderedTurns, offset, clipTop, clipBottom, composerTop, scrollContainer, flowTurns: domTurns.length, domTurns, apiTurns, domRows, compact: nextCompact, sidebarRight, flowLeft: flowRect.left, flowWidth: flowRect.width }
          setCompact((value) => value === nextCompact ? value : nextCompact)
          setClip((value) => Math.abs(value.top - clipTop) < 1 && Math.abs(value.bottom - clipBottom) < 1 ? value : { top: clipTop, bottom: clipBottom })
          setFlowReady(true)
          if (typeof MutationObserver === 'function' && !flowObserver) {
            flowObserver = new MutationObserver(() => {
              if (mutationTimer) return
              mutationTimer = window.setTimeout(() => {
                mutationTimer = 0
                schedule(true)
              }, 160)
            })
          }
          if (flowObserver && observedFlow !== flow) {
            flowObserver.disconnect()
            flowObserver.observe(flow, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] })
            observedFlow = flow
          }
          if (resizeObserver) {
            resizeObserver.disconnect()
            resizeObserver.observe(flow)
          } else if (typeof ResizeObserver === 'function') {
            resizeObserver = new ResizeObserver(() => schedule(true))
            resizeObserver.observe(flow)
          }
        }

        let lastScrollAt = 0
        let lastScrollTop = null
        let scrollVelocity = 0
        let lastActiveIds = new Set()
        const reducedMotion = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
        const motionEase = reducedMotion ? 'ease-out' : 'cubic-bezier(.22,1.4,.36,1)'
        const spring = motionEase
        const transitionFor = (withTransform) => (withTransform ? 'transform 380ms ' + spring + ', ' : '') + 'opacity 280ms ease, scale 360ms ' + spring + ', filter 200ms ease, box-shadow 200ms ease, border-color 200ms ease, width 320ms cubic-bezier(.22,1,.36,1), padding 320ms cubic-bezier(.22,1,.36,1), border-radius 320ms cubic-bezier(.22,1,.36,1)'

        const update = (needsRebuild) => {
          if (needsRebuild || !geometry.current.ready) rebuild()
          const geo = geometry.current
          if (!geo.ready) {
            hideAll()
            return
          }
          const measured = []
          const now = performance.now()
          const holdMap = exitHoldRef.current
          for (const item of geo.renderedTurns) {
            const turn = item.turn
            const nodes = item.nodes
            let top = Infinity
            let bottom = -Infinity
            const visibleNodes = []
            for (const node of nodes) {
              if (!node.getClientRects().length) continue
              const box = node.getBoundingClientRect()
              if (!box.height) continue
              top = Math.min(top, box.top)
              bottom = Math.max(bottom, box.bottom)
              const visibleTop = Math.max(box.top, geo.clipTop + 4)
              const visibleBottom = Math.min(box.bottom, geo.clipBottom - 4)
              const area = Math.max(0, visibleBottom - visibleTop)
              if (area <= 0) continue
              const kind = node.getAttribute('data-chat-flow-kind') || ''
              visibleNodes.push({ visibleTop, visibleBottom, area, preferred: kind === 'assistant' || kind === 'assistant-step' || kind === 'message' })
            }
            if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue
            const preferredNodes = visibleNodes.filter((entry) => entry.preferred)
            const anchor = (preferredNodes.length ? preferredNodes : visibleNodes).sort((left, right) => right.area - left.area)[0] || null
            const segments = (preferredNodes.length ? preferredNodes : visibleNodes)
              .slice()
              .sort((left, right) => left.visibleTop - right.visibleTop)
              .slice(0, 3)
              .map((entry) => ({ top: entry.visibleTop, bottom: entry.visibleBottom }))
            const previousZone = positions.current.get(turn.id)?.zone
            const aboveRaw = previousZone === 'top' ? bottom < geo.clipTop + 8 : bottom < geo.clipTop - 2
            const belowRaw = previousZone === 'bottom' ? top > geo.clipBottom - 8 : top > geo.clipBottom + 2
            const contactDir = aboveRaw ? 'top' : belowRaw ? 'bottom' : top <= geo.clipTop + 18 ? 'top' : bottom >= geo.clipBottom - 18 ? 'bottom' : null
            let hold = holdMap.get(turn.id)
            if (contactDir) {
              if (!hold || hold.dir !== contactDir) {
                hold = { at: now, dir: contactDir }
                holdMap.set(turn.id, hold)
              }
            } else if (!aboveRaw && !belowRaw) {
              holdMap.delete(turn.id)
              hold = null
            }
            const wasContext = previousZone === 'top' || previousZone === 'bottom'
            if (!wasContext && (aboveRaw || belowRaw) && (!hold || !hold.exiting)) {
              hold = { at: now, dir: aboveRaw ? 'top' : 'bottom', exiting: true }
              holdMap.set(turn.id, hold)
            }
            const held = false
            const above = aboveRaw
            const below = belowRaw
            measured.push({ turn, top, bottom, anchorTop: anchor ? anchor.visibleTop : null, anchorBottom: anchor ? anchor.visibleBottom : null, segments, above, below, held, heldDir: held ? contactDir : null })
          }
          const above = measured
            .filter((entry) => entry.above)
            .sort((left, right) => right.bottom - left.bottom)
          const below = measured
            .filter((entry) => entry.below)
            .sort((left, right) => left.top - right.top)
          const middle = measured
            .filter((entry) => !entry.above && !entry.below)
            .sort((left, right) => left.top - right.top || Number(left.turn.turn) - Number(right.turn.turn))
          const topTurn = above[0] || null
          let bottomTurn = below[0] || null
          const domWithoutMapping = measured.length === 0 && Array.isArray(geo.domTurns) && geo.domTurns.length > 0
          const latestTurn = [...turns]
            .filter((turn) => Number.isFinite(Number(turn.turn)))
            .sort((left, right) => Number(right.turn) - Number(left.turn))[0] || null
          const atBottom = geo.scrollContainer
            ? geo.scrollContainer.scrollTop + geo.scrollContainer.clientHeight >= geo.scrollContainer.scrollHeight - 8
            : false
          if (atBottom) {
            bottomTurn = null
            if (!domWithoutMapping && latestTurn && !middle.some((entry) => entry.turn.id === latestTurn.id) && !measured.some((entry) => entry.turn.id === latestTurn.id)) {
              middle.push({ turn: latestTurn, top: geo.clipTop, bottom: geo.clipBottom, synthetic: true })
            }
          }
          if (!atBottom && !bottomTurn && measured.length) {
            const measuredNumbers = measured.map((entry) => Number(entry.turn.turn)).filter((value) => Number.isFinite(value))
            if (measuredNumbers.length) {
              const maximum = Math.max(...measuredNumbers)
              const next = [...turns]
                .filter((turn) => Number.isFinite(Number(turn.turn)) && Number(turn.turn) > maximum)
                .sort((left, right) => Number(left.turn) - Number(right.turn))[0]
              if (next) bottomTurn = { turn: next }
            }
          }
          const lastMeasuredBottom = measured.length ? Math.max(...measured.map((entry) => entry.bottom)) : null
          const estimatedLatestTop = lastMeasuredBottom === null ? null : lastMeasuredBottom + 16
          const latestLikelyVisible = atBottom || (estimatedLatestTop !== null && estimatedLatestTop >= geo.clipTop - 120 && estimatedLatestTop < geo.clipBottom - 20)
          if (!atBottom && !bottomTurn && latestLikelyVisible && latestTurn && middle.length === 0 && !domWithoutMapping && !measured.some((entry) => entry.turn.id === latestTurn.id)) {
            middle.push({ turn: latestTurn, top: geo.clipTop, bottom: geo.clipBottom, synthetic: true })
          }
          if (middle.length === 0 && !topTurn && !bottomTurn && !domWithoutMapping) {
            const known = lastKnownCard.current
            if (known && known.id) {
              middle.push({ turn: known, top: geo.clipTop, bottom: geo.clipBottom, synthetic: true, lastKnown: true })
            }
          }
          const placeholderNeeded = middle.length === 0 && !topTurn && !bottomTurn && turns.length > 0
          const cardH = compact ? 24 : 58
          const topY = geo.clipTop + 8
          const bottomY = geo.clipBottom - cardH - 4
          const laneTop = topTurn ? topY + cardH + 6 : geo.clipTop + 8
          const laneBottom = bottomTurn ? bottomY - 6 : geo.clipBottom - 8
          const laneMax = Math.max(laneTop, laneBottom - cardH)
          const targets = new Map()
          let entryOrdinal = 0
          if (initialFadeRef.current && !initialFadeAtRef.current) initialFadeAtRef.current = now
          const initialFade = initialFadeRef.current && now - (initialFadeAtRef.current || now) < 900
          const transitionRoles = []
          let lastBottom = laneTop
          for (const entry of middle) {
            if (entry.held) {
              const heldTop = entry.heldDir === 'bottom' ? laneMax : laneTop
              targets.set(entry.turn.id, {
                top: heldTop,
                zone: 'middle',
                turn: entry.turn,
                synthetic: Boolean(entry.synthetic),
                lastKnown: Boolean(entry.lastKnown),
                held: true,
              })
              lastBottom = Math.max(lastBottom, heldTop + cardH + 4)
              continue
            }
            const visibleTop = Math.max(entry.top, geo.clipTop + 4)
            const visibleBottom = Math.min(entry.bottom, geo.clipBottom - 4)
            if (visibleBottom <= visibleTop) continue
            const lineTop = entry.segments && entry.segments.length
              ? Math.min(...entry.segments.map((segment) => segment.top))
              : visibleTop
            const lineBottom = entry.segments && entry.segments.length
              ? Math.max(...entry.segments.map((segment) => segment.bottom))
              : visibleBottom
            const center = (lineTop + lineBottom) / 2
            const prior = positions.current.get(entry.turn.id)
            let y
            if (prior && prior.visible && prior.zone === 'middle') {
              const topEdge = prior.top
              const bottomEdge = prior.top + cardH
              if (center > bottomEdge) y = center - cardH
              else if (center < topEdge) y = center
              else y = prior.top
            } else {
              y = center - cardH / 2
            }
            y = Math.min(Math.max(y, laneTop), laneMax)
            y = Math.min(Math.max(y, lastBottom + 4), laneMax)
            const target = { top: y, zone: 'middle', turn: entry.turn, synthetic: Boolean(entry.synthetic), lastKnown: Boolean(entry.lastKnown) }
            if (!entry.synthetic) {
              target.rangeTop = lineTop
              target.rangeBottom = lineBottom
              target.segments = entry.segments || []
            }
            targets.set(entry.turn.id, target)
            lastBottom = y + cardH + 4
          }
          if (placeholderNeeded) {
            const center = (geo.clipTop + geo.clipBottom) / 2
            targets.set('__current__', {
              top: Math.round(center - 22),
              zone: 'middle',
              turn: { id: '__current__', turn: '?', verdict: 'nodata', verdictLabel: '当前消息尚未匹配到模型轮次', primaryShort: '—', primaryModel: '该消息没有可识别的模型轮次' },
            })
          }
          if (topTurn) targets.set(topTurn.turn.id, { top: topY, zone: 'top', turn: topTurn.turn })
          if (bottomTurn) targets.set(bottomTurn.turn.id, { top: bottomY, zone: 'bottom', turn: bottomTurn.turn })
          for (const target of targets.values()) {
            if (target.turn && target.turn.id !== '__current__' && target.turn.primaryShort) lastKnownCard.current = target.turn
          }
          const scrolling = performance.now() - lastScrollAt < 90
          const activeVelocity = scrolling ? Math.abs(scrollVelocity) : 0
          const motionScale = reducedMotion ? 0.45 : activeVelocity > 6 ? 0.42 : activeVelocity > 2 ? 0.7 : 1
          const animationDuration = (base) => Math.max(120, Math.round(base * motionScale))
          let layoutChanged = lastActiveIds.size !== targets.size
          if (!layoutChanged) {
            for (const id of targets.keys()) {
              if (!lastActiveIds.has(id)) {
                layoutChanged = true
                break
              }
            }
          }
          const previousActiveIds = lastActiveIds
          lastActiveIds = new Set(targets.keys())
          const nextRenderIds = new Set(lastActiveIds)
          for (const id of previousActiveIds) nextRenderIds.add(id)
          let renderChanged = nextRenderIds.size !== renderIdsRef.current.size
          if (!renderChanged) {
            for (const id of nextRenderIds) {
              if (!renderIdsRef.current.has(id)) {
                renderChanged = true
                break
              }
            }
          }
          if (renderChanged) {
            renderIdsRef.current = nextRenderIds
            setRenderIds(nextRenderIds)
            window.setTimeout(() => schedule(false), 0)
          }
          for (const [id, target] of targets) {
            const previous = positions.current.get(id)
            const node = cardRefs.current.get(id)
            const targetScale = target.zone === 'middle' ? 1 : 0.88
            positions.current.set(id, { left: geo.left, top: target.top, visible: true, zone: target.zone, scale: targetScale })
            if (!node) continue
            const reentryRect = previous && !previous.visible && node.getAnimations().some((animation) => animation.id === 'mf-eject')
              ? node.getBoundingClientRect()
              : null
            for (const animation of node.getAnimations()) {
              if (animation.id === 'mf-eject' || animation.id === 'mf-enter') animation.cancel()
            }
            const zoneChanged = Boolean(previous && previous.zone && previous.zone !== target.zone)
            const moved = Boolean(previous && Math.abs(previous.top - target.top) > 2)
            const role = !previous || !previous.visible
              ? 'incoming'
              : zoneChanged && target.zone !== 'middle'
                ? 'squeeze'
                : zoneChanged
                  ? 'pushing'
                  : moved
                    ? 'pushed'
                    : 'stable'
            if (role !== 'stable') transitionRoles.push({ id, role, from: previous ? previous.zone : null, to: target.zone })
            const previousScale = previous && Number.isFinite(previous.scale) ? previous.scale : targetScale
            const scaleChanged = Math.abs(previousScale - targetScale) > 0.01
            const activeShift = node.getAnimations().some((animation) => animation.id === 'mf-shift')
            let fromTop = previous ? previous.top : target.top
            if (activeShift) {
              const box = node.getBoundingClientRect()
              if (box.height) fromTop = box.top
            }
            const animateTransform = Boolean(previous && previous.visible && (moved || scaleChanged) && (zoneChanged || !scrolling || layoutChanged))
            node.style.zIndex = target.zone === 'top' ? '3' : target.zone === 'bottom' ? '1' : '2'
            const targetOpacity = target.zone === 'middle' ? '1' : '0.5'
            const context = target.zone !== 'middle'
            node.style.transition = scrolling ? 'none' : transitionFor(false)
            node.style.pointerEvents = 'auto'
            node.style.scale = '1'
            node.style.transform = 'translate3d(' + geo.left + 'px,' + target.top + 'px,0) scale(' + targetScale + ')'
            node.style.filter = context ? 'grayscale(.45) saturate(.65)' : 'none'
            node.style.boxShadow = context ? '0 1px 4px rgba(16,24,40,.06)' : '0 4px 12px rgba(16,24,40,.10)'
            node.style.borderColor = context ? 'rgba(20,30,45,.08)' : 'var(--dsw-alias-border-l1, rgba(20,30,45,.14))'
            node.title = (target.zone === 'top' ? '上方 · ' : target.zone === 'bottom' ? '下方 · ' : '') + '第 ' + target.turn.turn + ' 轮 · ' + target.turn.verdictLabel + (target.lastKnown ? ' · 最后匹配轮次' : '') + (target.zone === 'middle' && Number.isFinite(target.rangeTop) ? ' · 右侧细线为可见区间' : '')
            const rangeEl = node.querySelector('[data-mf-range]')
            if (rangeEl) {
              const segments = target.zone === 'middle'
                ? (Array.isArray(target.segments) ? target.segments : (Number.isFinite(target.rangeTop) && Number.isFinite(target.rangeBottom) ? [{ top: target.rangeTop, bottom: target.rangeBottom }] : [])).slice(0, 3)
                : []
              rangeEl.style.opacity = segments.length ? '0.72' : '0'
              const segmentEls = rangeEl.querySelectorAll('[data-mf-range-segment]')
              for (let index = 0; index < segmentEls.length; index += 1) {
                const segmentEl = segmentEls[index]
                const segment = segments[index]
                if (segment && segment.bottom - segment.top > 12) {
                  segmentEl.style.opacity = '1'
                  segmentEl.style.top = Math.round(segment.top - target.top) + 'px'
                  segmentEl.style.height = Math.round(segment.bottom - segment.top) + 'px'
                  if (!segmentEl._mfRangeShown) {
                    segmentEl._mfRangeShown = true
                    segmentEl.style.transform = 'scaleY(0)'
                    window.requestAnimationFrame(() => {
                      if (!segmentEl.isConnected) return
                      segmentEl.style.transform = 'scaleY(1)'
                    })
                  } else {
                    segmentEl.style.transform = 'scaleY(1)'
                  }
                } else {
                  segmentEl.style.opacity = '0'
                  segmentEl.style.transform = 'scaleY(0)'
                  segmentEl._mfRangeShown = false
                }
              }
            }
            if (animateTransform && typeof node.animate === 'function') {
              try {
                for (const animation of node.getAnimations()) {
                  if (animation.id === 'mf-shift') animation.cancel()
                }
                node.animate(
                  [
                    { transform: 'translate3d(' + geo.left + 'px,' + fromTop + 'px,0) scale(' + previousScale + ')' },
                    { transform: 'translate3d(' + geo.left + 'px,' + target.top + 'px,0) scale(' + targetScale + ')' },
                  ],
                  { duration: animationDuration(role === 'squeeze' ? 380 : 340), easing: spring, id: 'mf-shift' },
                )
              } catch { /* older engine: settle immediately */ }
            }
            if (role === 'incoming') {
              const delay = reentryRect ? 0 : initialFade ? Math.min(140, entryOrdinal * 35) : 0
              entryOrdinal += 1
              node.style.transition = 'none'
              node.style.opacity = targetOpacity
              const fromY = reentryRect ? reentryRect.top : initialFade ? target.top : target.top + (target.zone === 'top' ? -6 : 6)
              const fromScale = reentryRect ? targetScale : initialFade ? targetScale : targetScale * 0.96
              try {
                node.animate(
                  [
                    { transform: 'translate3d(' + geo.left + 'px,' + fromY + 'px,0) scale(' + fromScale + ')', opacity: 0 },
                    { transform: 'translate3d(' + geo.left + 'px,' + target.top + 'px,0) scale(' + targetScale + ')', opacity: targetOpacity },
                  ],
                  { duration: animationDuration(260), easing: spring, delay, fill: 'backwards', id: 'mf-enter' },
                )
              } catch {
                node.style.opacity = targetOpacity
              }
            } else {
              node.style.transitionDelay = '0ms'
              node.style.opacity = targetOpacity
            }
          }
          for (const [id, node] of cardRefs.current) {
            if (targets.has(id)) continue
            const previous = positions.current.get(id)
            if (previous && previous.visible) {
              transitionRoles.push({ id, role: 'ejecting', from: previous.zone })
              const ejectDistance = Math.max(64, cardH * 1.2)
              const fromTransform = node.style.transform || 'translate3d(' + geo.left + 'px,' + previous.top + 'px,0) scale(0.88)'
              const fromOpacity = Number(window.getComputedStyle(node).opacity) || 0.5
              let toTransform = fromTransform
              if (previous.zone === 'top') toTransform = 'translate3d(' + geo.left + 'px,' + Math.max(0, previous.top - ejectDistance) + 'px,0) scale(0.76)'
              else if (previous.zone === 'bottom') toTransform = 'translate3d(' + geo.left + 'px,' + (previous.top + ejectDistance) + 'px,0) scale(0.76)'
              else if (previous.zone === 'middle') {
                const direction = previous.top < (geo.clipTop + geo.clipBottom) / 2 ? -1 : 1
                const outgoing = direction < 0 ? Math.max(0, geo.clipTop - ejectDistance) : geo.clipBottom + ejectDistance
                toTransform = 'translate3d(' + geo.left + 'px,' + outgoing + 'px,0) scale(0.76)'
              }
              node.style.transition = 'none'
              node.style.pointerEvents = 'none'
              try {
                for (const animation of node.getAnimations()) {
                  if (animation.id === 'mf-eject') animation.cancel()
                }
                node.animate(
                  [
                    { transform: fromTransform, opacity: fromOpacity },
                    { transform: toTransform, opacity: 0 },
                  ],
                  { duration: animationDuration(340), easing: spring, fill: 'forwards', id: 'mf-eject' },
                )
              } catch {
                node.style.opacity = '0'
                node.style.transform = toTransform
              }
            }
            positions.current.set(id, { left: geo.left, top: previous ? previous.top : -9999, visible: false, zone: previous ? previous.zone : 'hidden' })
          }
          railDebug = {
            flow: true,
            flowTurns: geo.flowTurns,
            turns: turns.length,
            cards: targets.size,
            transitionRoles: transitionRoles.slice(0, 12),
            cardTargets: [...targets.entries()].map(([id, target]) => ({
              id,
              turn: target.turn ? target.turn.turn : null,
              zone: target.zone,
              top: Math.round(target.top),
            })),
            middleCards: middle.length,
            placeholder: placeholderNeeded,
            lastKnownTurn: lastKnownCard.current ? lastKnownCard.current.turn : null,
            offset: geo.offset,
            measured: measured.length,
            measuredTurns: measured.slice(0, 6).map((entry) => ({ turn: entry.turn.turn, top: Math.round(entry.top), bottom: Math.round(entry.bottom), above: entry.above, below: entry.below })),
            atBottom: geo.scrollContainer ? geo.scrollContainer.scrollTop + geo.scrollContainer.clientHeight >= geo.scrollContainer.scrollHeight - 8 : false,
            domTurns: geo.flowTurns,
            domTurnValues: geo.domTurns ? geo.domTurns.slice(0, 8) : [],
            apiTurns: geo.apiTurns ? geo.apiTurns.slice(0, 8) : [],
            domRows: geo.domRows ? geo.domRows.slice(0, 10) : [],
            reason: targets.size ? 'ok' : 'no-visible-turns',
            topTurn: topTurn ? topTurn.turn.turn : null,
            bottomTurn: bottomTurn ? bottomTurn.turn.turn : null,
            flowLeft: Math.round(geo.flowLeft),
            flowWidth: Math.round(geo.flowWidth),
            sidebarRight: Math.round(geo.sidebarRight),
            left: Math.round(geo.left),
            compact: geo.compact,
            clipTop: Math.round(geo.clipTop),
            clipBottom: Math.round(geo.clipBottom),
            composerTop: Number.isFinite(geo.composerTop) ? Math.round(geo.composerTop) : null,
            composerZ: (() => {
              try {
                const seat = document.querySelector('[data-composer-seat]')
                return seat ? window.getComputedStyle(seat).zIndex : null
              } catch { return null }
            })(),
            canvasOpen,
            canvasProbe: canvasProbe.slice(0, 6),
            latestTurn: latestTurnSummary ? { turn: latestTurnSummary.turn, verdict: latestTurnSummary.verdict, label: latestTurnSummary.verdictLabel } : null,
            railOpacity: railRef.current ? window.getComputedStyle(railRef.current).opacity : null,
            viewport: window.innerWidth,
          }
        }

        const safeUpdate = (needsRebuild) => {
          try {
            update(needsRebuild)
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            lastFetchError = 'rail: ' + message.slice(0, 300)
            railDebug = { ...railDebug, reason: 'update-error', error: message.slice(0, 300) }
          }
        }

        const schedule = (needsRebuild) => {
          if (needsRebuild) rebuildPending = true
          if (raf) return
          raf = window.requestAnimationFrame(() => {
            raf = 0
            const pending = rebuildPending
            rebuildPending = false
            safeUpdate(pending)
          })
        }

        safeUpdate(true)
        const onScroll = () => {
          const now = performance.now()
          const scroller = geometry.current.scrollContainer
          const top = scroller ? scroller.scrollTop : window.scrollY
          let jumped = false
          if (lastScrollTop !== null) {
            const dt = Math.max(1, now - lastScrollAt)
            scrollVelocity = Math.abs(top - lastScrollTop) / dt
            jumped = Math.abs(top - lastScrollTop) > 180
          }
          lastScrollTop = top
          lastScrollAt = now
          if (top < 320 && hasMoreRef.current) loadOlderRef.current?.()
          // Timeline ticks on the right jump the virtualized list. Rebuild the
          // node map immediately, then once more after layout settles.
          schedule(jumped)
          if (jumped) {
            if (jumpTimer) window.clearTimeout(jumpTimer)
            jumpTimer = window.setTimeout(() => {
              jumpTimer = 0
              schedule(true)
            }, 90)
          }
        }
        const onResize = () => schedule(true)
        window.addEventListener('scroll', onScroll, { capture: true, passive: true })
        window.addEventListener('resize', onResize)
        tick = window.setInterval(() => schedule(true), 1500)
        return () => {
          if (raf) window.cancelAnimationFrame(raf)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onResize)
          if (resizeObserver) resizeObserver.disconnect()
          if (flowObserver) flowObserver.disconnect()
          if (mutationTimer) clearTimeout(mutationTimer)
          if (jumpTimer) clearTimeout(jumpTimer)
          if (tick) clearInterval(tick)
        }
      }, [on, turns, sessionId])

      if (!on) return null
      const clipPath = clip.top > 0
        ? 'inset(' + Math.round(clip.top) + 'px 0 0 0)'
        : undefined
      const children = turns.filter((turn) => renderIds.has(turn.id)).map((turn) => {
        const color = railColors[turn.verdict] || railColors.first
        const position = positions.current.get(turn.id) || { left: geometry.current.left || 0, top: -9999 }
        const base = {
          key: turn.id,
          ref: (node) => {
            if (node) cardRefs.current.set(turn.id, node)
            else cardRefs.current.delete(turn.id)
          },
          onClick: () => setOpen(true),
          style: {
            position: 'absolute',
            left: 0,
            top: 0,
            pointerEvents: 'auto',
            cursor: 'pointer',
            transform: 'translate3d(' + position.left + 'px,' + position.top + 'px,0)',
            opacity: position.visible ? 1 : 0,
            scale: position.visible ? '1' : '0.86',
            translate: '0 0',
            transformOrigin: 'left center',
            pointerEvents: position.visible ? 'auto' : 'none',
            willChange: 'transform, opacity, scale, translate',
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
            h('span', { style: { position: 'absolute', left: 0, top: 0, width: 1.5, height: '100%', background: 'currentColor', borderRadius: 1 } }),
            h('span', { style: { position: 'absolute', left: 0, top: 0, width: 5, height: 1.5, background: 'currentColor', borderRadius: 1 } }),
            h('span', { style: { position: 'absolute', left: 0, bottom: 0, width: 5, height: 1.5, background: 'currentColor', borderRadius: 1 } }),
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
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5, fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #667085)' } },
            h('span', null, '第 ' + turn.turn + ' 轮'),
            h('span', null, turn.verdict === 'same' ? '一致' : turn.verdict === 'changed' ? '变化' : turn.verdict === 'mixed' ? '多指纹' : turn.verdict === 'generation' ? '代际' : '基线'),
          ),
          h('div', { style: { marginTop: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, fontWeight: 750, color } }, 'FP-' + String(turn.primaryShort || '')),
          h('div', { style: { marginTop: 1, fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #667085)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, String(turn.primaryModel || '')),
        )
      })
      const placeholderPosition = positions.current.get('__current__') || { left: geometry.current.left || 0, top: -9999, visible: false }
      children.push(h('div', {
        key: '__current__',
        ref: (node) => {
          if (node) cardRefs.current.set('__current__', node)
          else cardRefs.current.delete('__current__')
        },
        onClick: () => setOpen(true),
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: compact ? 56 : 176,
          boxSizing: 'border-box',
          pointerEvents: placeholderPosition.visible ? 'auto' : 'none',
          cursor: 'pointer',
          padding: compact ? '3px 4px' : '6px 8px 7px',
          borderRadius: compact ? 999 : 10,
          border: '1px dashed var(--dsw-alias-border-l1, rgba(20,30,45,.18))',
          background: 'var(--dsw-specific-menu, rgba(255,255,255,.94))',
          boxShadow: '0 2px 10px rgba(16,24,40,.08)',
          color: 'var(--dsw-alias-label-tertiary, #667085)',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          lineHeight: 1.35,
          transform: 'translate3d(' + placeholderPosition.left + 'px,' + placeholderPosition.top + 'px,0)',
          opacity: placeholderPosition.visible ? 1 : 0,
          scale: placeholderPosition.visible ? '1' : '0.86',
          transformOrigin: 'left center',
          transition: 'opacity 150ms ease, scale 360ms cubic-bezier(.22,1.4,.36,1), transform 100ms linear',
          willChange: 'transform, opacity, scale',
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

    const guard = (Component) => function Guarded(props) {
      return h(SlotBoundary, null, h(Component, props))
    }
    const GuardedTurnRail = guard(TurnRailFast)
    const GuardedOverlay = guard(Overlay)
    const GuardedComposerToggle = guard(ComposerToggle)

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
          visible ? h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
            h('button', {
              type: 'button',
              style: { ...styles.panelButton, flex: 1, padding: '5px 6px', textAlign: 'center' },
              onClick: () => window.dispatchEvent(new CustomEvent('dsh-mf-refresh')),
            }, '刷新'),
            h('button', {
              type: 'button',
              style: { ...styles.panelButton, flex: 1, padding: '5px 6px', textAlign: 'center' },
              onClick: () => window.dispatchEvent(new CustomEvent('dsh-mf-preload')),
            }, '预加载'),
          ) : null,
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
          ...railDebug,
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
