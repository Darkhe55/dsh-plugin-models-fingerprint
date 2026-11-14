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
