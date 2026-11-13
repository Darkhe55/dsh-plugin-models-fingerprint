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
