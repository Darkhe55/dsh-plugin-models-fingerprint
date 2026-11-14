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
      const [rightbarOpen, setRightbarOpen] = React.useState(false)
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
      const turnByNumber = React.useRef(new Map())
      const dataCache = React.useRef(new Map())
      const dataRevision = React.useRef(0)
      const batchDisabled = React.useRef(false)
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
      const rightbarOpenRef = React.useRef(false)
      const placeholderPosition = React.useRef({ right: 0, top: -9999, visible: false })

      const applyTurns = (next) => {
        const list = Array.isArray(next) ? next : []
        turnsRef.current = list
        const map = new Map()
        for (const turn of list) {
          const number = Number(turn && turn.turn)
          if (Number.isFinite(number)) map.set(number, turn)
        }
        turnByNumber.current = map
        setTurns(list)
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
          turnWindow.current.reset()
          hasMoreRef.current = false
          setHasMore(false)
          applyTurns([])
          dataCache.current.clear()
          dataRevision.current = 0
          batchDisabled.current = false
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
          rightbarOpenRef.current = false
          setRightbarOpen(false)
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
            dataRevision.current = Number(payload.revision) || 0
            for (const turn of merged) {
              dataCache.current.set(Number(turn.turn), { status: 'observed', turn, revision: dataRevision.current })
            }
            const key = merged.map((turn) => turn.id + ':' + turn.steps + ':' + turn.endTime + ':' + turn.primaryFingerprint).join('|')
            if (key !== turnsKey.current) {
              turnsKey.current = key
              applyTurns(merged)
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
              for (const turn of next) dataCache.current.set(Number(turn.turn), { status: 'observed', turn, revision: Number(payload.revision) || 0 })
              applyTurns(merged)
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
        let tick = null
        let disposed = false

        tracker.current = new RailSnapshotTracker({ maxWaitMs: 600 })
        const beginJump = (reason) => {
          const fromSignature = tracker.current ? tracker.current.signature : ''
          jump.current = { pending: true, generation: jump.current.generation + 1, at: performance.now(), reason, fromSignature }
          tracker.current.reset()
          animator.cancelAll(cardRefs.current.values())
          turnQueue.invalidate()
          windowQueue.invalidate()
          noteRecoveryEvent()
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
        let motionEase = 'cubic-bezier(.22,1,.36,1)'
        try {
          const token = window.getComputedStyle(document.documentElement).getPropertyValue('--dsh-motion-ease-out').trim()
          if (token) motionEase = token
        } catch { /* older host: keep the official transform curve */ }
        const spring = reducedMotion ? 'ease-out' : motionEase
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
              .then((payload) => payload ? { ...payload, requestedTurn: turn } : null)
          },
          onNoData: (payload) => {
            if (disposed) return
            const turn = Number(payload && payload.requestedTurn)
            if (!Number.isFinite(turn)) return
            const status = payload.status === 'no-data' ? 'no-data' : 'missing'
            dataCache.current.set(turn, { status, revision: requestView.current.revision })
            schedule(true)
          },
          onTurn: (turn, payload) => {
            if (disposed || !turn || turn.hasModelData === false) return
            const current = requestView.current
            if (payload && payload.sessionId && current.sessionId && String(payload.sessionId) !== String(current.sessionId)) return
            if (payload && payload.generation !== undefined && String(current.generation) !== '0' && String(payload.generation) !== String(current.generation)) return
            if (payload && Number(payload.revision) < Number(current.revision)) return
            const merged = turnWindow.current.merge([turn])
            dataCache.current.set(Number(turn.turn), { status: 'observed', turn, revision: requestView.current.revision })
            applyTurns(merged)
            noteRecoveryEvent()
            schedule(true)
          },
        })

        const windowQueue = new TurnWindowQueue({
          fetchWindow: (values, context, signal) => {
            const target = context && context.sessionId ? context.sessionId : (sessionId || railSessionId)
            if (!target) return null
            return fetch(apiUrl('/model-fingerprint/api/turn-window?id=' + encodeURIComponent(target) + '&turns=' + encodeURIComponent(values.join(','))), { cache: 'no-store', signal })
          },
          onResult: (payload) => {
            if (disposed) return
            const current = requestView.current
            if (payload.sessionId && current.sessionId && String(payload.sessionId) !== String(current.sessionId)) return
            if (payload.generation !== undefined && String(current.generation) !== '0' && String(payload.generation) !== String(current.generation)) return
            if (Number(payload.revision) < Number(current.revision)) return
            const revision = Number(payload.revision) || 0
            requestView.current.revision = Math.max(Number(requestView.current.revision) || 0, revision)
            sessionViewRevision = requestView.current.revision
            let changed = false
            for (const entry of payload.turns || []) {
              const turn = Number(entry.turn)
              if (!Number.isFinite(turn)) continue
              if (entry.status === 'observed' && entry.data) {
                dataCache.current.set(turn, { status: 'observed', turn: entry.data, revision })
                turnWindow.current.merge([entry.data])
                changed = true
              } else {
                dataCache.current.set(turn, { status: entry.status === 'no-data' ? 'no-data' : 'missing', revision })
              }
            }
            if (changed) applyTurns(turnWindow.current.turns())
            noteRecoveryEvent()
            schedule(true)
          },
          onFallback: (values, context) => {
            batchDisabled.current = true
            turnQueue.request(values, turnsRef.current, 0, context)
          },
          onError: (error) => {
            lastFetchError = error && error.message ? error.message : String(error)
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
            flow: Boolean(geometry.current.flowIdentity),
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

        const adapter = new VisibleTurnAdapter({
          registry: officialTurnRegistry,
          onDirty: () => {
            if (disposed) return
            noteRecoveryEvent()
            schedule(true)
          },
        })

        const zonesFromCommitted = () => {
          const zones = new Map()
          for (const [id, target] of committed.current) zones.set(id, target.zone)
          return zones
        }

        const applyRange = (node, target, cardTop) => {
          const range = node.querySelector ? node.querySelector('[data-mf-range]') : null
          if (!range) return
          const top = Number(target.rangeTop)
          const bottom = Number(target.rangeBottom)
          const visible = target.zone === 'middle' && Number.isFinite(top) && Number.isFinite(bottom) && bottom - top > 6
          if (!visible) {
            range.style.opacity = '0'
            return
          }
          if (bottom - top <= 6) {
            range.style.opacity = '0'
            return
          }
          // The bracket represents the canonical anchor's visible height, not
          // the card's own box, so a long answer keeps one continuous range.
          range.style.opacity = '0.72'
          range.style.top = Math.round(top - cardTop) + 'px'
          range.style.height = Math.round(bottom - top) + 'px'
          if (!range.__mfRangeShown) {
            range.__mfRangeShown = true
            range.style.transform = 'scaleY(0)'
            window.requestAnimationFrame(() => {
              if (range.isConnected) range.style.transform = 'scaleY(1)'
            })
          } else {
            range.style.transform = 'scaleY(1)'
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
          const anchorRight = Math.max(6, Number(geometry.current.right) || 0)
          for (const [id, node] of cardRefs.current) {
            if (!node || node.isConnected === false) continue
            const rect = node.getBoundingClientRect()
            if (rect && rect.height) rects.set(id, rect)
            // The message column can change width without changing compact/
            // full mode (sidebars, window resize, dock transitions). React's
            // style prop is only written on render, so update the right anchor
            // on every measured frame as well.
            setStyle(node, 'right', anchorRight + 'px')
          }
          if (placeholderRef.current) setStyle(placeholderRef.current, 'right', anchorRight + 'px')
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
            setTransition(node, reducedMotion ? 'opacity 60ms linear' : 'opacity 160ms ease-out, filter 160ms ease-out, box-shadow 160ms ease-out, border-color 160ms ease-out, width 220ms cubic-bezier(.22,1,.36,1), padding 220ms cubic-bezier(.22,1,.36,1), border-radius 220ms cubic-bezier(.22,1,.36,1)')
            node.title = (target.zone === 'top' ? '上方 · ' : target.zone === 'bottom' ? '下方 · ' : '') + '第 ' + target.turn.turn + ' 轮 · ' + target.turn.verdictLabel + (target.zone === 'middle' && Number.isFinite(target.rangeTop) ? ' · 右侧细线为最终回复可见区间' : '')
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

        const placeholderTurn = (turn, status) => {
          const session = requestView.current.sessionId || sessionId || railSessionId || 'session'
          const noData = status === 'no-data'
          return {
            id: session + ':turn:' + turn + ':' + (noData ? 'no-data' : 'loading'),
            turn,
            verdict: noData ? 'nodata' : 'loading',
            verdictLabel: noData ? '无模型指纹数据' : '指纹数据加载中',
            primaryShort: noData ? '—' : '…',
            primaryModel: noData ? '该轮没有可识别的模型观测' : '正在取得本轮指纹',
            hasModelData: false,
            placeholder: true,
            placeholderStatus: noData ? 'no-data' : 'loading',
          }
        }

        const visibleCardTurns = (snapshot) => {
          const offset = Number(mapping.current.offset) || 0
          const list = []
          for (const row of snapshot.rows || []) {
            const apiTurn = Number(row.domTurn) - offset
            if (!Number.isFinite(apiTurn)) continue
            const observed = turnByNumber.current.get(apiTurn)
            const cached = dataCache.current.get(apiTurn)
            let turn = observed || null
            if (!turn) {
              const status = cached && cached.status === 'no-data' ? 'no-data' : 'loading'
              turn = placeholderTurn(apiTurn, status)
            }
            list.push({ turn, row })
          }
          return list
        }

        const relevantRows = (snapshot) => {
          const rows = snapshot.rows || []
          const clipTop = geometry.current.clipTop
          const clipBottom = geometry.current.clipBottom
          const overlapping = rows.filter((row) => row.turnBottom > clipTop && row.turnTop < clipBottom)
          let above = null
          let below = null
          for (const row of rows) {
            if (row.turnBottom <= clipTop && (!above || row.turnBottom > above.turnBottom)) above = row
            if (row.turnTop >= clipBottom && (!below || row.turnTop < below.turnTop)) below = row
          }
          const selected = overlapping.slice()
          if (above && !selected.includes(above)) selected.push(above)
          if (below && !selected.includes(below)) selected.push(below)
          selected.sort((left, right) => left.turnTop - right.turnTop)
          return { ...snapshot, rows: selected, domTurns: selected.map((row) => row.domTurn) }
        }

        const buildTargets = (snapshot) => {
          const layout = geometry.current
          const cardH = layout.compact ? 24 : 58
          const topY = layout.clipTop + 8
          const bottomY = layout.clipBottom - cardH - 4
          const laneTop = layout.clipTop + 8
          const laneBottom = layout.clipBottom - 8
          const items = visibleCardTurns(snapshot)
          const turnList = items.map((item) => item.turn)
          const derived = validateRailTargets(deriveRailTargets(snapshot, turnList, mapping.current, layout, zonesFromCommitted()))
          const middleTop = derived.top ? topY + cardH + 6 : laneTop
          const middleBottom = derived.bottom ? bottomY - 6 : laneBottom
          const middleItems = derived.middle.map((entry) => {
            const hasAnchor = entry.hasAnchor && Number.isFinite(entry.anchorTop) && Number.isFinite(entry.anchorBottom)
            const anchorTop = hasAnchor ? entry.anchorTop : entry.top
            const anchorBottom = hasAnchor ? entry.anchorBottom : entry.bottom
            return {
              id: entry.turn.id,
              turn: entry.turn,
              anchorTop,
              anchorBottom,
              hasAnchor,
              center: (anchorTop + anchorBottom) / 2,
            }
          })
          const middleLayout = layoutMiddleCards(middleItems, {
            top: middleTop,
            bottom: middleBottom,
            cardHeight: cardH,
            gap: 4,
          })
          const targets = new Map()
          for (const item of middleLayout.items) {
            targets.set(item.id, {
              top: item.top,
              zone: 'middle',
              turn: item.turn,
              rangeTop: item.hasAnchor && !item.turn.placeholder ? item.anchorTop : undefined,
              rangeBottom: item.hasAnchor && !item.turn.placeholder ? item.anchorBottom : undefined,
            })
          }
          if (derived.top) {
            targets.set(derived.top.turn.id, { top: Math.round(topY), zone: 'top', turn: derived.top.turn })
          }
          if (derived.bottom) {
            targets.set(derived.bottom.turn.id, { top: Math.round(bottomY), zone: 'bottom', turn: derived.bottom.turn })
          }
          return { targets, collapsedIds: middleLayout.collapsedIds }
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
          const relevant = relevantRows(snapshot)
          const built = buildTargets(relevant)
          const targets = built.targets
          applyTargets(targets, relevant)
          const focusTarget = [...targets.values()].find((target) => target.zone === 'middle') || [...targets.values()][0]
          if (focusTarget && turnWindow.current.pruneAround(focusTarget.turn.turn)) {
            applyTurns(turnWindow.current.turns())
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
            collapsedCards: built.collapsedIds.length,
            collapsedIds: built.collapsedIds.slice(0, 16),
            placeholder: placeholderPosition.current.visible,
            offset: mapping.current.offset,
            batchLastKey: windowQueue.lastKey,
            batchPending: windowQueue.inFlight,
            cacheRows: dataCache.current.size,
            mappingConfidence: mapping.current.confidence,
            mappingGeneration: mapping.current.generation,
            jumpGeneration: jump.current.generation,
            measured: relevant.rows.length,
            domTurns: relevant.rows.map((row) => row.domTurn).slice(0, 12),
            anchors: relevant.rows.slice(0, 12).map((row) => ({ turn: row.domTurn, kind: row.anchorKind, step: row.anchorStep })),
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
            rightbarOpen: rightbarOpenRef.current,
          }
        }

        const syncRightbar = () => {
          const open = readRightbarExpanded()
          const previous = rightbarOpenRef.current
          if (open !== previous) {
            rightbarOpenRef.current = open
            railDebug = { ...railDebug, rightbarOpen: open }
            setRightbarOpen(open)
            if (!open) schedule(true)
          }
          return open
        }

        const requestVisibleTurns = (snapshot) => {
          const offset = Number(mapping.current.offset) || 0
          const turnNumbers = []
          const seen = new Set()
          for (const row of snapshot.rows || []) {
            const turn = Number(row.domTurn) - offset
            if (!Number.isFinite(turn) || seen.has(turn)) continue
            seen.add(turn)
            const cached = dataCache.current.get(turn)
            if (turnByNumber.current.has(turn)) continue
            if (cached && cached.status === 'no-data' && cached.revision === requestView.current.revision) continue
            if (cached && cached.status === 'missing' && cached.revision === requestView.current.revision) continue
            turnNumbers.push(turn)
          }
          if (!turnNumbers.length) return
          const context = {
            sessionId: requestView.current.sessionId || sessionId || railSessionId,
            revision: requestView.current.revision,
            generation: requestView.current.generation,
          }
          if (batchDisabled.current) {
            turnQueue.request(turnNumbers, turnsRef.current, 0, context)
            return
          }
          windowQueue.request(turnNumbers, context)
        }

        const update = (needsRebuild) => {
          syncRightbar()
          const flow = adapter.getFlow()
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
            adapter.observe(flow)
            schedule(true, { recover: true })
            return
          }
          mapping.current.flowIdentity = flow
          adapter.observe(flow)
          const priorRows = geometry.current.lastRows
          const layout = adapter.measureViewport(flow)
          geometry.current = { ...layout, ready: true, domTurns: geometry.current.domTurns || [] }
          const snapshot = adapter.capture(flow, layout)
          geometry.current.domTurns = snapshot.domTurns || []
          const detected = priorRows && !snapshot.invalid ? railJumpDetected({ rows: priorRows }, snapshot) : null
          if (detected && !jump.current.pending) beginJump(detected)
          if (!snapshot.invalid) {
            geometry.current.lastRows = snapshot.rows.map((row) => ({
              domTurn: row.domTurn,
              top: row.turnTop,
              bottom: row.turnBottom,
              anchorTop: row.anchorTop,
              anchorBottom: row.anchorBottom,
            }))
            const apiTurns = [...turnByNumber.current.keys()]
            const chosen = chooseRailMapping(apiTurns, snapshot.domTurns, mapping.current)
            mapping.current = { ...mapping.current, offset: chosen.offset, confidence: chosen.confidence }
            geometry.current.offset = chosen.offset
            try {
              requestVisibleTurns(relevantRows(snapshot))
            } catch (error) {
              lastFetchError = error && error.message ? error.message : String(error)
            }
          }
          if (mapping.current.confidence <= 0 && snapshot.rows.length) {
            // No overlap does not mean no cards: request the visible DOM turn
            // numbers and render explicit loading placeholders. The DOM value
            // is the durable turn number in current DSH; a non-zero offset is
            // learned later as the API window overlaps.
            mapping.current.offset = 0
            geometry.current.offset = 0
            try { requestVisibleTurns(snapshot) } catch { /* placeholders still render */ }
            commitSnapshot(snapshot)
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
        const rightbarTimer = window.setInterval(syncRightbar, 200)
        const layoutTimer = window.setInterval(() => {
          if (disposed) return
          const flow = adapter.getFlow()
          if (!flow) return
          const next = adapter.measureViewport(flow)
          const current = geometry.current
          if (!current.ready
            || Math.abs((next.right || 0) - (current.right || 0)) > 0.5
            || Math.abs((next.clipTop || 0) - (current.clipTop || 0)) > 0.5
            || Math.abs((next.clipBottom || 0) - (current.clipBottom || 0)) > 0.5
            || next.compact !== current.compact) {
            schedule(true)
          }
        }, 300)
        return () => {
          disposed = true
          if (raf) window.cancelAnimationFrame(raf)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onResize)
          adapter.dispose()
          if (recovery.current.timer) clearTimeout(recovery.current.timer)
          recovery.current.timer = 0
          turnQueue.invalidate()
          windowQueue.invalidate()
          rebindScheduler.dispose()
          scrollScheduler.dispose()
          if (tick) clearInterval(tick)
          if (rightbarTimer) clearInterval(rightbarTimer)
          if (layoutTimer) clearInterval(layoutTimer)
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
        const placeholder = turn.placeholder === true
        const color = placeholder ? 'var(--dsw-alias-label-tertiary, #667085)' : (railColors[turn.verdict] || railColors.first)
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
            background: placeholder ? 'var(--dsw-alias-bg-secondary, rgba(248,249,251,.78))' : 'var(--dsw-specific-menu, rgba(255,255,255,.94))',
            border: placeholder ? '1px dashed var(--dsw-alias-border-l1, rgba(20,30,45,.18))' : '1px solid var(--dsw-alias-border-l1, rgba(20,30,45,.14))',
            boxShadow: placeholder ? '0 1px 6px rgba(16,24,40,.05)' : '0 2px 10px rgba(16,24,40,.10)',
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
            height: 0,
            opacity: 0,
            pointerEvents: 'none',
            color: 'rgba(91, 117, 145, .76)',
            transform: 'scaleY(1)',
            transformOrigin: 'top center',
            transition: 'opacity 160ms ease, top 140ms ease, height 140ms ease',
          },
        },
          h('span', { key: 'line', style: { position: 'absolute', left: 0, top: 0, width: 1.5, height: '100%', background: 'currentColor', borderRadius: 1 } }),
          h('span', { key: 'top', style: { position: 'absolute', left: 0, top: 0, width: 5, height: 1.5, background: 'currentColor', borderRadius: 1 } }),
          h('span', { key: 'bottom', style: { position: 'absolute', left: 0, bottom: 0, width: 5, height: 1.5, background: 'currentColor', borderRadius: 1 } }),
        )
        if (compact) {
          base.style.width = 56
          base.style.padding = '3px 4px'
          base.style.textAlign = 'center'
          base.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
          base.style.fontSize = 10
          base.style.color = color
          base.title = '第 ' + turn.turn + ' 轮 · ' + turn.verdictLabel
          return h('div', base, rangeEl, placeholder ? (turn.placeholderStatus === 'no-data' ? '—' : '…') : 'FP-' + String(turn.primaryShort || '').slice(0, 4))
        }
        base.style.width = 176
        base.style.padding = '6px 8px 7px'
        base.title = placeholder ? '第 ' + turn.turn + ' 轮 · ' + turn.verdictLabel : '点击打开逐轮检测面板'
        return h('div', base,
          rangeEl,
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5, fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #667085)' } },
            h('span', null, '第 ' + turn.turn + ' 轮'),
            h('span', null, placeholder
              ? (turn.placeholderStatus === 'no-data' ? '无数据' : '加载中')
              : turn.verdict === 'same' ? '一致' : turn.verdict === 'changed' ? '变化' : turn.verdict === 'mixed' ? '多指纹' : turn.verdict === 'generation' ? '代际' : '基线'),
          ),
          h('div', { key: 'body', style: { marginTop: 1, fontFamily: placeholder ? 'inherit' : 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, fontWeight: 750, color } }, placeholder
            ? (turn.placeholderStatus === 'no-data' ? '无模型指纹数据' : '指纹数据加载中')
            : 'FP-' + String(turn.primaryShort || '')),
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
          opacity: canvasOpen || rightbarOpen ? 0 : 1,
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
