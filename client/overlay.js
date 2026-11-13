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

