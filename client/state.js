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
    const CLIENT_BUILD = '2026-11-13-72'
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

