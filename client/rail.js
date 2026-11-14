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
      const slotOccupants = React.useRef(new Map())
      const pendingTargets = React.useRef(new Map())
      const lastKnownCard = React.useRef(null)
      const loadedSessionRef = React.useRef(null)
      const turnsKey = React.useRef('')
      const geometry = React.useRef({ ready: false, left: 0, turnNodes: new Map(), offset: 0, clipTop: 0, clipBottom: 0 })
      const exitHoldRef = React.useRef(new Map())
      const initialFadeRef = React.useRef(true)
      const initialFadeAtRef = React.useRef(0)
      const turnsRef = React.useRef([])
      const turnWindow = React.useRef(new TurnWindowStore())
      const hasMoreRef = React.useRef(false)
      const renderIdsRef = React.useRef(new Set())
      const autoPreloadRef = React.useRef(false)
      const loadOlderRef = React.useRef(null)
      const refreshRef = React.useRef(null)

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
          turnWindow.current.reset()
          hasMoreRef.current = false
          setHasMore(false)
          renderIdsRef.current = new Set()
          setRenderIds(new Set())
          setTurns([])
          positions.current.clear()
          slotOccupants.current.clear()
          pendingTargets.current.clear()
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
            const merged = turnWindow.current.merge(next)
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
              const merged = turnWindow.current.merge(next)
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
        if (!on) return undefined
        // Opening the switch must not show a stale cached card. Refresh the
        // latest page, then pull one older page once the new revision lands.
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
        let resizeObserver = null
        let flowObserver = null
        let observedFlow = null
        let mutationTimer = 0
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
          const anchorRight = TurnGeometry.anchorRight(flowRect, sidebarRight, safeLeft, cardWidth)
          const right = Math.max(6, window.innerWidth - anchorRight)
          const turnNodes = new Map()
          const renderedTurns = []
          const domRows = []
          for (const [value, rawNodes] of domNodeMap) {
            const nodes = TurnGeometry.responseNodes(rawNodes)
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
            const nodes = TurnGeometry.responseNodes(domNodeMap.get(key) || [])
            turnNodes.set(key, nodes)
            if (nodes.length) renderedTurns.push({ turn, nodes })
          }
          geometry.current = { ready: true, left: anchorRight, right, anchorRight, turnNodes, renderedTurns, offset, clipTop, clipBottom, composerTop, scrollContainer, flowTurns: domTurns.length, domTurns, apiTurns, domRows, compact: nextCompact, sidebarRight, flowLeft: flowRect.left, flowWidth: flowRect.width }
          fetchVisibleTurns(domTurns)
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
            flowObserver.observe(flow, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-chat-turn'] })
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
        let settlePending = false
        let lastActiveIds = new Set()
        let mappingRetryTimer = 0
        let mappingRetries = 0
        const turnQueue = new TurnRequestQueue({
          fetchTurn: (turn) => {
            const target = sessionId || railSessionId
            if (!target) return null
            return fetch(apiUrl('/model-fingerprint/api/turn-view?id=' + encodeURIComponent(target) + '&turn=' + encodeURIComponent(turn)), { cache: 'no-store' })
              .then((response) => response.ok ? response.json() : null)
          },
          onTurn: (turn) => {
            if (cancelled || !turn || turn.hasModelData === false) return
            const merged = turnWindow.current.merge([turn])
            turnsRef.current = merged
            setTurns(merged)
            schedule(true)
          },
        })
        const fetchVisibleTurns = (domTurns) => {
          turnQueue.request(domTurns, turnsRef.current, geometry.current.offset || 0)
        }
        const rangeParts = (node) => {
          if (!node) return { range: null, segments: [] }
          const cached = node.__mfRangeParts
          if (cached && cached.range && cached.range.isConnected) return cached
          const range = node.querySelector('[data-mf-range]')
          const segments = range ? [...range.querySelectorAll('[data-mf-range-segment]')] : []
          const next = { range, segments }
          node.__mfRangeParts = next
          return next
        }
        const setTransition = (node, value) => {
          if (!node || node.__mfTransition === value) return
          node.__mfTransition = value
          node.style.transition = value
        }
        const setStyle = (node, property, value) => {
          if (!node) return
          if (!node.__mfStyles) node.__mfStyles = {}
          if (node.__mfStyles[property] === value) return
          node.__mfStyles[property] = value
          node.style[property] = value
        }
        const reducedMotion = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
        const motionEase = reducedMotion ? 'ease-out' : 'cubic-bezier(.22,1.4,.36,1)'
        const spring = motionEase
        const transitionFor = (withTransform) => (withTransform ? 'transform 380ms ' + spring + ', ' : '') + 'opacity 280ms ease, scale 360ms ' + spring + ', filter 200ms ease, box-shadow 200ms ease, border-color 200ms ease, width 320ms cubic-bezier(.22,1,.36,1), padding 320ms cubic-bezier(.22,1,.36,1), border-radius 320ms cubic-bezier(.22,1,.36,1)'
        const animator = new SlotAnimator({ eased: spring, reduced: reducedMotion, cardWidth: 176 })
        const scrollScheduler = new ScrollScheduler({
          settleMs: 110,
          onSettle: () => schedule(true, { settle: true }),
        })

        const update = (needsRebuild, settle = false) => {
          if (needsRebuild || !geometry.current.ready) rebuild()
          const geo = geometry.current
          if (!geo.ready) {
            hideAll()
            return
          }
          const measured = []
          const now = performance.now()
          const scrolling = scrollScheduler.scrolling && !settle
          const holdMap = exitHoldRef.current
          for (const item of geo.renderedTurns) {
            const turn = item.turn
            const nodes = item.nodes
            const geometryBox = TurnGeometry.measureNormalized(nodes, geo.clipTop, geo.clipBottom)
            if (!geometryBox) continue
            const { top, bottom, anchor, segments } = geometryBox
            const previousZone = positions.current.get(turn.id)?.zone
            const { aboveRaw, belowRaw } = TurnGeometry.classify(geometryBox, geo.clipTop, geo.clipBottom, previousZone)
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
            if (!scrolling && (aboveRaw || belowRaw)) {
              holdMap.delete(turn.id)
              hold = null
            }
            const held = Boolean(scrolling && hold && hold.exiting)
            const above = held ? false : aboveRaw
            const below = held ? false : belowRaw
            measured.push({ turn, top, bottom, anchorTop: anchor ? anchor.visibleTop : null, anchorBottom: anchor ? anchor.visibleBottom : null, segments, above, below, held, heldDir: held ? contactDir : null })
          }
          if (measured.length === 0 && geo.domTurns.length > 0 && positions.current.size > 0) {
            fetchVisibleTurns(geo.domTurns)
            if (!mappingRetryTimer && mappingRetries < 3) {
              mappingRetries += 1
              mappingRetryTimer = window.setTimeout(() => {
                mappingRetryTimer = 0
                schedule(true)
              }, 70)
            }
            railDebug = { ...railDebug, reason: 'mapping-pending', domTurns: geo.domTurns.length, cards: positions.current.size }
            return
          }
          mappingRetries = 0
          const above = measured
            .filter((entry) => entry.above)
            .sort((left, right) => right.bottom - left.bottom)
          const below = measured
            .filter((entry) => entry.below)
            .sort((left, right) => left.top - right.top)
          const middle = measured
            .filter((entry) => !entry.above && !entry.below)
            .sort((left, right) => left.top - right.top || Number(left.turn.turn) - Number(right.turn.turn))
          const measuredTopTurn = above[0] || null
          let measuredBottomTurn = below[0] || null
          const storedTop = slotOccupants.current.get('top') || null
          const storedBottom = slotOccupants.current.get('bottom') || null
          const topTurn = scrolling && storedTop ? { turn: storedTop } : measuredTopTurn
          let bottomTurn = scrolling && storedBottom ? { turn: storedBottom } : measuredBottomTurn
          const domWithoutMapping = measured.length === 0 && Array.isArray(geo.domTurns) && geo.domTurns.length > 0
          const latestTurn = [...turns]
            .filter((turn) => Number.isFinite(Number(turn.turn)))
            .sort((left, right) => Number(right.turn) - Number(left.turn))[0] || null
          const atBottom = geo.scrollContainer
            ? geo.scrollContainer.scrollTop + geo.scrollContainer.clientHeight >= geo.scrollContainer.scrollHeight - 8
            : false
          if (atBottom) {
            if (!scrolling) bottomTurn = null
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
            if (scrolling && prior && prior.visible && prior.zone !== 'middle') {
              pendingTargets.current.set(entry.turn.id, { top: center, zone: 'middle', turn: entry.turn })
              continue
            }
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
          if (scrolling) {
            pendingTargets.current = new Map(targets)
          } else {
            pendingTargets.current.clear()
            if (measuredTopTurn) slotOccupants.current.set('top', measuredTopTurn.turn)
            else slotOccupants.current.delete('top')
            if (measuredBottomTurn) slotOccupants.current.set('bottom', measuredBottomTurn.turn)
            else slotOccupants.current.delete('bottom')
          }
          const focusTurn = middle.length ? middle[0].turn.turn : latestTurn && latestTurn.turn
          if (turnWindow.current.pruneAround(focusTurn)) {
            const pruned = turnWindow.current.turns()
            turnsRef.current = pruned
            setTurns(pruned)
          }
          for (const target of targets.values()) {
            if (target.turn && target.turn.id !== '__current__' && target.turn.primaryShort) lastKnownCard.current = target.turn
          }
          const activeVelocity = scrolling ? Math.abs(scrollVelocity) : 0
          const motionScale = reducedMotion ? 0.45 : activeVelocity > 6 ? 0.42 : activeVelocity > 2 ? 0.7 : 1
          const previousActiveIds = lastActiveIds
          lastActiveIds = new Set(targets.keys())
          const CARD_POOL_LIMIT = 9
          const nextRenderIds = new Set(targets.keys())
          for (const id of previousActiveIds) {
            if (nextRenderIds.size >= CARD_POOL_LIMIT) break
            nextRenderIds.add(id)
          }
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
          const visualRects = new Map()
          const visualOpacity = new Map()
          for (const [id, node] of cardRefs.current) {
            if (!node || node.isConnected === false) continue
            const box = node.getBoundingClientRect()
            if (box.height) visualRects.set(id, box)
            visualOpacity.set(id, Number.isFinite(node.__mfOpacity) ? node.__mfOpacity : 1)
          }
          for (const [id, target] of targets) {
            const previous = positions.current.get(id)
            const node = cardRefs.current.get(id)
            const targetScale = target.zone === 'middle' ? 1 : 0.88
            positions.current.set(id, { right: geo.right, top: target.top, visible: true, zone: target.zone, scale: targetScale })
            if (!node) continue
            const previousRect = visualRects.get(id) || null
            const ejectAnimation = animator.animation(node, 'mf-eject')
            const reentryRect = previous && !previous.visible && ejectAnimation ? previousRect : null
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
            const activeShift = animator.animation(node, 'mf-shift')
            const enterActive = Boolean(animator.animation(node, 'mf-enter'))
            let fromTop = previous ? previous.top : target.top
            if (activeShift && previousRect) fromTop = previousRect.top
            const animateTransform = Boolean(previous && previous.visible && (moved || scaleChanged) && !scrolling && !enterActive)
            setStyle(node, 'zIndex', target.zone === 'top' ? '3' : target.zone === 'bottom' ? '1' : '2')
            const targetOpacity = target.zone === 'middle' ? '1' : '0.5'
            const context = target.zone !== 'middle'
            setTransition(node, scrolling ? 'none' : transitionFor(false))
            setStyle(node, 'pointerEvents', 'auto')
            setStyle(node, 'scale', '1')
            node.style.transform = 'translate3d(0,' + target.top + 'px,0) scale(' + targetScale + ')'
            node.__mfOpacity = Number(targetOpacity)
            setStyle(node, 'filter', context ? 'grayscale(.45) saturate(.65)' : 'none')
            setStyle(node, 'boxShadow', context ? '0 1px 4px rgba(16,24,40,.06)' : '0 4px 12px rgba(16,24,40,.10)')
            setStyle(node, 'borderColor', context ? 'rgba(20,30,45,.08)' : 'var(--dsw-alias-border-l1, rgba(20,30,45,.14))')
            node.title = (target.zone === 'top' ? '上方 · ' : target.zone === 'bottom' ? '下方 · ' : '') + '第 ' + target.turn.turn + ' 轮 · ' + target.turn.verdictLabel + (target.lastKnown ? ' · 最后匹配轮次' : '') + (target.zone === 'middle' && Number.isFinite(target.rangeTop) ? ' · 右侧细线为可见区间' : '')
            const { range: rangeEl, segments: segmentEls } = rangeParts(node)
            if (rangeEl) {
              const segments = target.zone === 'middle'
                ? (Array.isArray(target.segments) ? target.segments : (Number.isFinite(target.rangeTop) && Number.isFinite(target.rangeBottom) ? [{ top: target.rangeTop, bottom: target.rangeBottom }] : [])).slice(0, 3)
                : []
              rangeEl.style.opacity = segments.length ? '0.72' : '0'
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
            if (animateTransform) {
              try {
                animator.shift(node, {
                  left: 0,
                  fromTop,
                  fromScale: previousScale,
                  toTop: target.top,
                  toScale: targetScale,
                  role,
                  motionScale,
                })
              } catch { /* older engine: settle immediately */ }
            }
            if (role === 'incoming') {
              node.style.opacity = targetOpacity
              const existingEnter = animator.animation(node, 'mf-enter')
              if (!existingEnter) {
                const delay = reentryRect ? 0 : initialFade ? Math.min(140, entryOrdinal * 35) : 0
                entryOrdinal += 1
                setTransition(node, 'none')
                const fromY = reentryRect ? reentryRect.top : initialFade ? target.top : target.top + (target.zone === 'top' ? -6 : 6)
                const fromScale = reentryRect ? targetScale : initialFade ? targetScale : targetScale * 0.96
                try {
                  animator.enter(node, {
                    left: 0,
                    fromTop: fromY,
                    fromScale,
                    toTop: target.top,
                    toScale: targetScale,
                    toOpacity: targetOpacity,
                    delay,
                    motionScale,
                  })
                } catch {
                  node.style.opacity = targetOpacity
                }
              }
            } else {
              node.style.transitionDelay = '0ms'
              node.style.opacity = targetOpacity
            }
          }
          for (const [id, node] of cardRefs.current) {
            if (targets.has(id)) continue
            const previous = positions.current.get(id)
            if (previous && previous.visible && !scrolling) {
              transitionRoles.push({ id, role: 'ejecting', from: previous.zone })
              const ejectDistance = Math.max(64, cardH * 1.2)
              const fromTransform = node.style.transform || 'translate3d(0,' + previous.top + 'px,0) scale(0.88)'
              const fromOpacity = visualOpacity.has(id) ? visualOpacity.get(id) : 0.5
              let toTransform = fromTransform
              if (previous.zone === 'top') toTransform = 'translate3d(0,' + Math.max(0, previous.top - ejectDistance) + 'px,0) scale(0.76)'
              else if (previous.zone === 'bottom') toTransform = 'translate3d(0,' + (previous.top + ejectDistance) + 'px,0) scale(0.76)'
              else if (previous.zone === 'middle') {
                const direction = previous.top < (geo.clipTop + geo.clipBottom) / 2 ? -1 : 1
                const outgoing = direction < 0 ? Math.max(0, geo.clipTop - ejectDistance) : geo.clipBottom + ejectDistance
                toTransform = 'translate3d(0,' + outgoing + 'px,0) scale(0.76)'
              }
              node.style.transition = 'none'
              node.style.pointerEvents = 'none'
              try {
                const animated = animator.eject(node, {
                  fromTransform,
                  fromOpacity,
                  toTransform,
                  motionScale,
                })
                if (!animated) throw new Error('animate unavailable')
              } catch {
                node.style.opacity = '0'
                node.style.transform = toTransform
              }
            }
            positions.current.set(id, { right: geo.right, top: previous ? previous.top : -9999, visible: false, zone: previous ? previous.zone : 'hidden' })
          }
          railDebug = {
            flow: true,
            flowTurns: geo.flowTurns,
            turns: turns.length,
            cards: targets.size,
            cardNodes: cardRefs.current.size,
            windowRows: turnWindow.current.size,
            windowMax: turnWindow.current.maxWindow,
            transitionRoles: transitionRoles.slice(0, 12),
            cardTargets: [...targets.entries()].map(([id, target]) => ({
              id,
              turn: target.turn ? target.turn.turn : null,
              zone: target.zone,
              top: Math.round(target.top),
            })),
            cardAnimations: [...cardRefs.current.entries()].map(([id, node]) => ({ id, role: animator.state(node) ? animator.state(node).id : null })),
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

        const safeUpdate = (needsRebuild, settle = false) => {
          try {
            update(needsRebuild, settle)
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            lastFetchError = 'rail: ' + message.slice(0, 300)
            railDebug = { ...railDebug, reason: 'update-error', error: message.slice(0, 300) }
          }
        }

        const schedule = (needsRebuild, options = {}) => {
          if (needsRebuild) rebuildPending = true
          if (options.settle) settlePending = true
          if (raf) return
          raf = window.requestAnimationFrame(() => {
            raf = 0
            const pending = rebuildPending
            const doSettle = settlePending
            rebuildPending = false
            settlePending = false
            safeUpdate(pending, doSettle)
          })
        }
        const rebindScheduler = new RebindScheduler({ onRebind: () => schedule(true) })

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
          settlePending = false
          scrollScheduler.noteScroll()
          if (top < 320 && hasMoreRef.current) loadOlderRef.current?.()
          // Light follow while the wheel moves; one semantic settle after it stops.
          if (jumped) rebindScheduler.kick()
          else schedule(false)
        }
        const onResize = () => schedule(true)
        window.addEventListener('scroll', onScroll, { capture: true, passive: true })
        window.addEventListener('resize', onResize)
        tick = window.setInterval(() => schedule(false), 1500)
        return () => {
          if (raf) window.cancelAnimationFrame(raf)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onResize)
          if (resizeObserver) resizeObserver.disconnect()
          if (flowObserver) flowObserver.disconnect()
          if (mutationTimer) clearTimeout(mutationTimer)
          if (mappingRetryTimer) clearTimeout(mappingRetryTimer)
          rebindScheduler.dispose()
          scrollScheduler.dispose()
          if (tick) clearInterval(tick)
        }
      }, [on, turns, sessionId])

      if (!on) return null
      const clipPath = clip.top > 0
        ? 'inset(' + Math.round(clip.top) + 'px 0 0 0)'
        : undefined
      const children = turns.filter((turn) => renderIds.has(turn.id)).map((turn) => {
        const color = railColors[turn.verdict] || railColors.first
        const position = positions.current.get(turn.id) || { right: geometry.current.right || 0, top: -9999 }
        const base = {
          key: turn.id,
          ref: (node) => {
            if (node) cardRefs.current.set(turn.id, node)
            else cardRefs.current.delete(turn.id)
          },
          onClick: () => setOpen(true),
          style: {
            position: 'absolute',
            left: 'auto',
            right: position.right || 0,
            top: 0,
            pointerEvents: 'auto',
            cursor: 'pointer',
            transform: 'translate3d(0,' + position.top + 'px,0)',
            opacity: position.visible ? 1 : 0,
            scale: position.visible ? '1' : '0.86',
            translate: '0 0',
            transformOrigin: 'right center',
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
      const placeholderPosition = positions.current.get('__current__') || { right: geometry.current.right || 0, top: -9999, visible: false }
      children.push(h('div', {
        key: '__current__',
        ref: (node) => {
          if (node) cardRefs.current.set('__current__', node)
          else cardRefs.current.delete('__current__')
        },
        onClick: () => setOpen(true),
        style: {
          position: 'absolute',
          left: 'auto',
          right: placeholderPosition.right || 0,
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
          transform: 'translate3d(0,' + placeholderPosition.top + 'px,0)',
          opacity: placeholderPosition.visible ? 1 : 0,
          scale: placeholderPosition.visible ? '1' : '0.86',
          transformOrigin: 'right center',
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

