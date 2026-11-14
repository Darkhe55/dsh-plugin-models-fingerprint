    /**
     * Official lifecycle hints from `conversation.chat.turnTail`. This is not a
     * visible-turn source: the slot only mounts completed Turn tails. It is a
     * stable mount/unmount signal and a turn-number authority, used to wake the
     * rail adapter without trusting recycled DOM attributes.
     */
    class OfficialTurnRegistry {
      constructor() {
        this.entries = new Map()
        this.listeners = new Set()
        this.version = 0
      }
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }
      emit() {
        this.version += 1
        for (const listener of this.listeners) {
          try { listener(this.version) } catch { /* one listener must not break lifecycle tracking */ }
        }
      }
      add(turn, entry) {
        const number = Number(turn)
        if (!Number.isFinite(number)) return () => {}
        const token = { turn: number, ...entry }
        this.entries.set(number, token)
        this.emit()
        return () => {
          if (this.entries.get(number) === token) {
            this.entries.delete(number)
            this.emit()
          }
        }
      }
      get(turn) {
        return this.entries.get(Number(turn)) || null
      }
      turns() {
        return [...this.entries.keys()]
      }
      dispose() {
        this.entries.clear()
        this.listeners.clear()
      }
    }

    const officialTurnRegistry = new OfficialTurnRegistry()

    /**
     * Zero-layout probe mounted by the official Turn-tail slot. The parent
     * `[data-chat-turn]` is observed, never cached as a geometry source.
     */
    function TurnLifecycleProbe(props) {
      const markerRef = React.useRef(null)
      const turnNumber = Number(props && props.turn && props.turn.turn)
      const seq = Number(props && props.seq) || 0
      React.useEffect(() => {
        const marker = markerRef.current
        if (!marker || !Number.isFinite(turnNumber)) return undefined
        // No DOM node is retained: the official slot is only a mount/unmount
        // and turn-number signal. Geometry is always taken from the current
        // adapter snapshot.
        return officialTurnRegistry.add(turnNumber, { seq })
      }, [turnNumber, seq])
      return h('span', {
        ref: markerRef,
        'data-mf-turn-probe': Number.isFinite(turnNumber) ? String(turnNumber) : '',
        'aria-hidden': 'true',
        style: { display: 'contents' },
      })
    }
