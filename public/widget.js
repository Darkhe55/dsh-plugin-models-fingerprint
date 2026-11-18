(function () {
  'use strict'
  if (window.__dshModelFingerprintWidget) return
  window.__dshModelFingerprintWidget = true

  function apiBase() {
    try {
      var injected = String(window.__dshModelFingerprintApiBase || '').replace(/\/+$/, '')
      if (injected) return injected
      var transport = window.__DSH_TRANSPORT__
      return transport && typeof transport.streamBaseUrl === 'string' ? transport.streamBaseUrl.replace(/\/+$/, '') : ''
    } catch (err) { return '' }
  }
  function apiUrl(path) { return apiBase() + path }
  var API = apiUrl('/model-fingerprint/api/status?limit=20')
  var PANEL = apiUrl('/model-fingerprint')
  var failures = 0
  var timer = null
  var composerTimer = null
  var data = null
  var root = null
  var modal = null
  var full = null
  var railLayer = null
  var railTurns = []
  var railOn = true
  var railSessionId = null
  var railLoading = false
  var railFrame = null
  var panelOpen = false

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text != null) node.textContent = String(text)
    return node
  }

  function short(id) {
    return String(id || '').replace(/^fp_/, '').slice(0, 8).toUpperCase()
  }

  function rel(time) {
    if (!time) return ''
    var diff = Date.now() - time
    if (diff < 60e3) return Math.max(0, Math.round(diff / 1000)) + 's'
    if (diff < 3600e3) return Math.round(diff / 60e3) + 'm'
    if (diff < 86400e3) return Math.round(diff / 3600e3) + 'h'
    return Math.round(diff / 86400e3) + 'd'
  }

  function tone(verdict) {
    if (verdict === 'consistent') return 'good'
    if (verdict === 'changed' || verdict === 'label-mismatch' || verdict === 'behavior-drift') return 'bad'
    return 'warn'
  }

  function style() {
    var css = [
      '.mf-root{position:fixed;left:14px;bottom:14px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1b1f24;line-height:1.45;-webkit-font-smoothing:antialiased}',
      '.mf-badge{display:flex;align-items:center;gap:8px;max-width:min(420px,calc(100vw - 28px));padding:8px 12px;border-radius:999px;background:rgba(255,255,255,.92);border:1px solid rgba(20,30,45,.14);box-shadow:0 6px 24px rgba(16,24,40,.18);backdrop-filter:blur(10px);cursor:pointer;user-select:none;transition:transform .15s ease,box-shadow .15s ease}',
      '.mf-badge:hover{transform:translateY(-1px);box-shadow:0 8px 28px rgba(16,24,40,.24)}',
      '.mf-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#98a2b3}',
      '.mf-dot.good{background:#0f8a5f}.mf-dot.warn{background:#d97706}.mf-dot.bad{background:#dc2626}',
      '.mf-title{font-size:11px;color:#667085;white-space:nowrap}',
      '.mf-model{font-size:12px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px}',
      '.mf-fp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:700;color:#2f6fed;background:#eef3ff;border-radius:6px;padding:2px 6px;white-space:nowrap}',
      '.mf-count{font-size:10px;color:#98a2b3;white-space:nowrap}',
      '.mf-modal-mask{position:fixed;inset:0;z-index:2147483001;background:rgba(10,15,25,.36);backdrop-filter:blur(2px);display:flex;align-items:flex-end;justify-content:flex-start;padding:16px}',
      '.mf-modal{width:min(520px,calc(100vw - 32px));max-height:min(78vh,680px);overflow:auto;background:#fff;border:1px solid rgba(20,30,45,.14);border-radius:16px;box-shadow:0 20px 60px rgba(16,24,40,.3);padding:16px 16px 14px}',
      '.mf-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}',
      '.mf-h1{font-size:15px;font-weight:750;letter-spacing:-.02em;margin:0}',
      '.mf-sub{font-size:11px;color:#667085;margin-top:2px}',
      '.mf-x{appearance:none;border:0;background:#f2f4f7;color:#667085;border-radius:8px;width:28px;height:28px;cursor:pointer;font-size:16px;line-height:1}',
      '.mf-verdict{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:650;margin-bottom:10px}',
      '.mf-verdict.good{background:#e7f7f0;color:#0f8a5f}.mf-verdict.warn{background:#fff3e0;color:#b25e09}.mf-verdict.bad{background:#fdecec;color:#c43232}',
      '.mf-row{display:grid;grid-template-columns:76px minmax(0,1fr);gap:6px 10px;font-size:12px;margin-top:8px}',
      '.mf-k{color:#667085}.mf-v{min-width:0;overflow-wrap:anywhere}',
      '.mf-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}',
      '.mf-reasons{font-size:11px;color:#667085;margin-top:9px;line-height:1.55}',
      '.mf-alerts{display:grid;gap:6px;margin-top:12px}',
      '.mf-alert{padding:7px 9px;border-radius:9px;background:#f7f8fa;border:1px solid #eceff3;font-size:11px}',
      '.mf-alert.high{border-color:#f4c7c7;background:#fff6f6}.mf-alert.warn{border-color:#f2dfbf;background:#fffaf1}',
      '.mf-alert b{display:block;font-size:11px;font-weight:650;color:#344054;margin-bottom:2px}',
      '.mf-alert span{color:#667085}',
      '.mf-actions{display:flex;gap:8px;margin-top:14px}',
      '.mf-action{appearance:none;border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:9px;padding:7px 10px;font-size:12px;cursor:pointer}',
      '.mf-action.primary{background:#2f6fed;border-color:#2f6fed;color:#fff}',
      '.mf-action:hover{filter:brightness(.97)}',
      '.mf-empty{color:#667085;font-size:12px;padding:14px 2px}',
      '.mf-full-mask{position:fixed;inset:0;z-index:2147483002;background:rgba(10,15,25,.42);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:22px}',
      '.mf-full{width:min(1240px,96vw);height:min(88vh,900px);display:flex;flex-direction:column;background:#fff;border:1px solid rgba(20,30,45,.16);border-radius:18px;box-shadow:0 24px 80px rgba(16,24,40,.36);overflow:hidden}',
      '.mf-full-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;border-bottom:1px solid #e9edf2;background:#fff}',
      '.mf-full-title{display:flex;align-items:center;gap:9px;min-width:0}',
      '.mf-full-title b{font-size:13px;letter-spacing:-.01em}.mf-full-title span{font-size:11px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.mf-full-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}',
      '.mf-frame{width:100%;height:100%;border:0;background:#f5f6f8;flex:1 1 auto}',
      '.mf-frame-wrap{position:relative;flex:1 1 auto;min-height:0;background:#f5f6f8}',
      '.mf-loading{position:absolute;inset:0;display:grid;place-items:center;background:#f5f6f8;color:#667085;font-size:12px;z-index:1}',
      '.mf-spinner{width:20px;height:20px;border:2px solid #d9e0ea;border-top-color:#2f6fed;border-radius:50%;animation:mf-spin .8s linear infinite;margin:0 auto 9px}',
      '@keyframes mf-spin{to{transform:rotate(360deg)}}',
      '.mf-full-mask .mf-x{background:#f2f4f7}',
      '.mf-dock{display:flex;justify-content:flex-end;align-items:center;gap:2px;padding:0 2px;pointer-events:auto}',
      '.mf-dock-btn{appearance:none;border:0;background:transparent;color:#667085;display:inline-flex;align-items:center;gap:6px;padding:3px 5px;font-size:11px;line-height:18px;cursor:pointer;border-radius:6px;font-family:inherit}',
      '.mf-dock-btn:hover{background:rgba(47,111,237,.08);color:#2f6fed}',
      '.mf-dock-track{width:26px;height:14px;border-radius:999px;background:#d0d5dd;position:relative;transition:background .15s ease;flex:0 0 auto}',
      '.mf-dock-track.on{background:#2f6fed}',
      '.mf-dock-knob{position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:#fff;transition:left .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.25)}',
      '.mf-dock-track.on .mf-dock-knob{left:14px}',
      '.mf-rail-layer{position:fixed;inset:0;z-index:40;pointer-events:none;overflow:hidden}',
      '.mf-rail-card{position:absolute;width:176px;box-sizing:border-box;pointer-events:auto;cursor:pointer;background:rgba(255,255,255,.94);border:1px solid rgba(20,30,45,.14);border-radius:10px;padding:6px 8px 7px;box-shadow:0 4px 16px rgba(16,24,40,.12);backdrop-filter:blur(8px);color:#1b1f24;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.35;transition:transform .12s ease,box-shadow .12s ease}',
      '.mf-rail-card:hover{transform:translateY(-1px);box-shadow:0 7px 22px rgba(16,24,40,.2)}',
      '.mf-rail-head{display:flex;align-items:center;justify-content:space-between;gap:5px;font-size:10px;color:#667085}',
      '.mf-rail-fp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:750;letter-spacing:-.01em;line-height:1.25;margin-top:1px}',
      '.mf-rail-model{font-size:10px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}',
      '.mf-rail-card.same .mf-rail-fp{color:#0f8a5f}',
      '.mf-rail-card.changed .mf-rail-fp{color:#dc2626}',
      '.mf-rail-card.mixed .mf-rail-fp{color:#b25e09}',
      '.mf-rail-card.generation .mf-rail-fp{color:#2f6fed}',
      '.mf-rail-card.first .mf-rail-fp{color:#667085}',
      '.mf-rail-compact{position:absolute;pointer-events:auto;cursor:pointer;padding:3px 4px;width:56px;box-sizing:border-box;text-align:center;border-radius:999px;background:rgba(255,255,255,.94);border:1px solid rgba(20,30,45,.14);font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#2f6fed;box-shadow:0 2px 8px rgba(16,24,40,.12)}',
      '.mf-rail-status{position:absolute;left:8px;bottom:96px;pointer-events:auto;cursor:pointer;padding:5px 9px;border-radius:999px;background:rgba(255,255,255,.94);border:1px solid rgba(20,30,45,.14);font-size:10px;color:#667085;box-shadow:0 2px 8px rgba(16,24,40,.12)}',
      '@media (prefers-color-scheme: dark){.mf-rail-card{background:rgba(23,27,34,.94);border-color:rgba(255,255,255,.14);color:#e8edf4}.mf-rail-head,.mf-rail-model{color:#9aa6b6}.mf-rail-card.same .mf-rail-fp{color:#53d3a4}.mf-rail-card.changed .mf-rail-fp{color:#ff8e8e}.mf-rail-card.mixed .mf-rail-fp{color:#f2b35d}.mf-rail-card.generation .mf-rail-fp{color:#7aa7ff}.mf-rail-card.first .mf-rail-fp{color:#9aa6b6}.mf-rail-compact{background:rgba(23,27,34,.94);border-color:rgba(255,255,255,.14);color:#7aa7ff}}',
      '@media (prefers-color-scheme: dark){.mf-dock-btn{color:#9aa6b6}.mf-dock-track{background:#354052}.mf-dock-track.on{background:#5b8def}}',
      '@media (prefers-color-scheme: dark){.mf-full{background:#171b22;border-color:#2a3340}.mf-full-head{background:#171b22;border-color:#2a3340}.mf-full-title span{color:#9aa6b6}.mf-frame,.mf-frame-wrap,.mf-loading{background:#101318}.mf-full-mask .mf-x{background:#242b35}}',
      '@media (max-width:700px){.mf-full-mask{padding:0}.mf-full{width:100vw;height:100vh;border-radius:0;border:0}.mf-full-title span{display:none}}',
      '@media (prefers-color-scheme: dark){.mf-badge{background:rgba(23,27,34,.94);border-color:rgba(255,255,255,.14);color:#e8edf4}.mf-title,.mf-sub,.mf-k,.mf-reasons{color:#9aa6b6}.mf-fp{background:#1d2b4a;color:#7aa7ff}.mf-modal{background:#171b22;border-color:#2a3340;color:#e8edf4}.mf-x{background:#242b35;color:#9aa6b6}.mf-alert{background:#1e242d;border-color:#2a3340}.mf-alert b{color:#d0d8e4}.mf-alert span{color:#9aa6b6}.mf-action{background:#1e242d;border-color:#354052;color:#d0d8e4}.mf-action.primary{background:#3b6fd4;border-color:#3b6fd4;color:#fff}}',
      '@media (max-width:520px){.mf-model{max-width:118px}.mf-title{display:none}.mf-modal-mask{padding:10px}.mf-modal{width:100%;max-height:82vh}}',
    ].join('')
    var node = document.createElement('style')
    node.setAttribute('data-dsh-model-fingerprint', '')
    node.textContent = css
    document.head.appendChild(node)
  }

  function ensureRoot() {
    if (root && document.documentElement.contains(root)) return root
    root = el('div', 'mf-root')
    document.body.appendChild(root)
    return root
  }

  function renderBadge() {
    var host = ensureRoot()
    host.replaceChildren()
    var badge = el('div', 'mf-badge')
    badge.title = '打开模型指纹监控'
    var dot = el('span', 'mf-dot')
    var title = el('span', 'mf-title', '模型指纹')
    var model = el('span', 'mf-model', '扫描中…')
    var fp = el('span', 'mf-fp', '…')
    var count = el('span', 'mf-count', '')
    if (data && data.latest) {
      var latest = data.latest
      var obs = latest.observation || {}
      var assessment = latest.assessment || {}
      var fingerprint = latest.fingerprint || {}
      dot.className = 'mf-dot ' + tone(assessment.verdict)
      model.textContent = (obs.provider || '?') + ' / ' + (obs.model || '?')
      fp.textContent = 'FP-' + short(fingerprint.id)
      count.textContent = (fingerprint.observations || 0) + ' obs' + (data.alerts && data.alerts.length ? ' · ' + data.alerts.length + ' 提示' : '')
      badge.title = (assessment.verdictLabel || '模型指纹') + ' · ' + (obs.routeKey || '') + ' · 点击查看证据'
    } else if (data) {
      dot.className = 'mf-dot warn'
      model.textContent = '等待模型响应'
      fp.textContent = data.stats && data.stats.observations ? 'FP-?' : '…'
      count.textContent = data.scan && data.scan.scanning ? '扫描中' : ''
    }
    badge.append(dot, title, model, fp, count)
    badge.addEventListener('click', openModal)
    host.appendChild(badge)
  }

  function alertNode(alert) {
    var box = el('div', 'mf-alert ' + (alert.severity || 'info'))
    box.appendChild(el('b', '', alert.title || '提示'))
    box.appendChild(el('span', '', (alert.detail || '') + ' · ' + rel(alert.time)))
    return box
  }

  function openFullPanel() {
    if (typeof window.__dshModelFingerprintOpen === 'function') {
      window.__dshModelFingerprintOpen()
      closeModal()
      scheduleRail()
      return
    }
    closeFullPanel()
    var mask = el('div', 'mf-full-mask')
    var panel = el('div', 'mf-full')
    var head = el('div', 'mf-full-head')
    var titles = el('div', 'mf-full-title')
    titles.appendChild(el('b', '', '逐轮模型指纹'))
    titles.appendChild(el('span', '', '每次会话每一轮单独检测 · 对比上一轮'))
    var actions = el('div', 'mf-full-actions')
    var open = el('button', 'mf-action', '新标签打开')
    open.addEventListener('click', function () { window.open(PANEL, '_blank', 'noopener') })
    var close = el('button', 'mf-x', '×')
    close.title = '关闭'
    close.addEventListener('click', closeFullPanel)
    actions.append(open, close)
    head.append(titles, actions)
    var wrap = el('div', 'mf-frame-wrap')
    var loading = el('div', 'mf-loading')
    loading.appendChild(el('div', 'mf-spinner'))
    loading.appendChild(el('div', '', '正在载入逐轮面板…'))
    var frame = document.createElement('iframe')
    frame.className = 'mf-frame'
    frame.title = '逐轮模型指纹检测'
    frame.src = apiUrl('/model-fingerprint?embed=1&tab=turns')
    frame.addEventListener('load', function () {
      if (loading.parentNode) loading.parentNode.removeChild(loading)
    })
    wrap.append(loading, frame)
    panel.append(head, wrap)
    mask.appendChild(panel)
    mask.addEventListener('click', function (event) { if (event.target === mask) closeFullPanel() })
    document.body.appendChild(mask)
    full = mask
    scheduleRail()
    document.addEventListener('keydown', onFullKey)
  }

  function closeFullPanel() {
    if (full && full.parentNode) full.parentNode.removeChild(full)
    full = null
    document.removeEventListener('keydown', onFullKey)
    scheduleRail()
  }

  function onFullKey(event) {
    if (event.key === 'Escape') closeFullPanel()
  }

  function openModal() {
    closeModal()
    var mask = el('div', 'mf-modal-mask')
    var panel = el('div', 'mf-modal')
    var head = el('div', 'mf-head')
    var titles = el('div')
    titles.appendChild(el('h1', 'mf-h1', '模型指纹监控'))
    titles.appendChild(el('div', 'mf-sub', '名称只是声明；这里看协议签名与历史行为'))
    var close = el('button', 'mf-x', '×')
    close.title = '关闭'
    close.addEventListener('click', closeModal)
    head.append(titles, close)
    panel.appendChild(head)

    if (!data) {
      panel.appendChild(el('div', 'mf-empty', '正在读取状态…'))
    } else {
      var latest = data.latest
      if (latest) {
        var obs = latest.observation || {}
        var assessment = latest.assessment || {}
        var fingerprint = latest.fingerprint || {}
        var row = el('div', 'mf-verdict ' + tone(assessment.verdict), assessment.verdictLabel || assessment.verdict)
        panel.appendChild(row)
        var model = el('div', '', (obs.provider || '?') + ' / ' + (obs.model || '?'))
        model.style.fontSize = '16px'
        model.style.fontWeight = '750'
        model.style.letterSpacing = '-.02em'
        panel.appendChild(model)
        var meta = el('div', 'mf-sub', '会话 ' + (obs.sessionId || '—') + ' · ' + rel(obs.time) + '前 · 证据强度 ' + Math.round((assessment.confidence || 0) * 100) + '%')
        panel.appendChild(meta)

        var rows = el('div', 'mf-row')
        var add = function (key, value, mono) {
          rows.appendChild(el('div', 'mf-k', key))
          var v = el('div', 'mf-v' + (mono ? ' mf-mono' : ''), value)
          rows.appendChild(v)
        }
        add('指纹', 'FP-' + short(fingerprint.id) + ' · ' + (fingerprint.observations || 0) + ' 条历史 / ' + (fingerprint.names ? fingerprint.names.length : 0) + ' 个声称名称')
        add('协议', (obs.protocolDetail && obs.protocolDetail.api || '-') + ' · ' + (obs.protocolDetail && obs.protocolDetail.adapter || '-') + ' · id ' + (obs.protocolDetail && obs.protocolDetail.responseIdShape || 'none'), true)
        add('工具', ((obs.protocolDetail && obs.protocolDetail.toolIdShapes || []).join(' + ') || '未调用工具'), true)
        add('行为', behavior(obs.behavior))
        add('Token', 'in ' + (obs.tokens ? obs.tokens.input : '—') + ' / out ' + (obs.tokens ? obs.tokens.output : '—'))
        panel.appendChild(rows)
        if (assessment.reasons && assessment.reasons.length) panel.appendChild(el('div', 'mf-reasons', assessment.reasons.join('；')))
      } else {
        panel.appendChild(el('div', 'mf-empty', '还没有解析到模型响应。历史扫描在后台进行。'))
      }

      if (data.alerts && data.alerts.length) {
        var list = el('div', 'mf-alerts')
        data.alerts.slice(0, 5).forEach(function (alert) { list.appendChild(alertNode(alert)) })
        panel.appendChild(list)
      }
    }

    var actions = el('div', 'mf-actions')
    var open = el('button', 'mf-action primary', '打开逐轮面板')
    open.addEventListener('click', function () { openFullPanel() })
    var refresh = el('button', 'mf-action', '刷新')
    refresh.addEventListener('click', function () { load().then(function () { closeModal(); openModal() }) })
    actions.append(open, refresh)
    panel.appendChild(actions)
    mask.appendChild(panel)
    mask.addEventListener('click', function (event) { if (event.target === mask) closeModal() })
    document.body.appendChild(mask)
    modal = mask
    document.addEventListener('keydown', onKey)
  }

  function closeModal() {
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal)
    modal = null
    document.removeEventListener('keydown', onKey)
  }

  function onKey(event) {
    if (event.key === 'Escape') closeModal()
  }

  function behavior(value) {
    if (!value) return '—'
    var bits = []
    if (value.tokensPerChar != null) bits.push(value.tokensPerChar.toFixed(2) + ' tok/字')
    if (value.charsPerChunk != null) bits.push(value.charsPerChunk.toFixed(1) + ' 字/块')
    if (value.reasoningRatio != null && value.reasoningRatio > 0.01) bits.push('推理 ' + Math.round(value.reasoningRatio * 100) + '%')
    if (value.ttftMs != null) bits.push('首 token ' + Math.round(value.ttftMs) + 'ms')
    return bits.join(' · ') || '—'
  }

  var dockObserver = null

  function removeFallbackDock() {
    var existing = document.getElementById('mf-dock-fallback')
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
  }

  function injectDockFallback() {
    if (window.__dshModelFingerprintNative) {
      removeFallbackDock()
      return
    }
    if (document.getElementById('mf-dock-fallback')) return
    var dock = document.querySelector('[data-composer-dock]')
    if (!dock) return
    var wrap = el('div', 'mf-dock')
    wrap.id = 'mf-dock-fallback'
    var toggle = el('button', 'mf-dock-btn')
    toggle.type = 'button'
    var track = el('span', 'mf-dock-track')
    track.appendChild(el('span', 'mf-dock-knob'))
    var label = el('span', '', '逐轮指纹')
    var stateLabel = el('span', '', '开')
    toggle.append(track, label, stateLabel)
    var update = function () {
      track.classList.toggle('on', railOn)
      stateLabel.textContent = railOn ? '开' : '关'
      toggle.setAttribute('aria-pressed', railOn ? 'true' : 'false')
      toggle.title = railOn ? '关闭左侧逐轮指纹' : '在对话左侧显示逐轮指纹'
    }
    toggle.addEventListener('click', function () {
      setRailOn(!railOn)
      update()
    })
    var panel = el('button', 'mf-dock-btn', '面板')
    panel.type = 'button'
    panel.title = '打开逐轮检测面板'
    panel.addEventListener('click', openFullPanel)
    update()
    wrap.append(toggle, panel)
    dock.appendChild(wrap)
  }

  function watchComposer() {
    if (window.__dshModelFingerprintNative) {
      window.removeEventListener('scroll', onWidgetScroll, true)
      if (timer) { clearInterval(timer); timer = null }
      if (composerTimer) { clearInterval(composerTimer); composerTimer = null }
      if (dockObserver) { dockObserver.disconnect(); dockObserver = null }
      removeFallbackDock()
      return
    }
    injectDockFallback()
    if (dockObserver) return
    dockObserver = new MutationObserver(function (mutations) {
      var relevant = false
      for (var i = 0; i < mutations.length; i += 1) {
        var node = mutations[i].target
        while (node) {
          if (node === railLayer) break
          node = node.parentNode
        }
        if (node === railLayer) continue
        relevant = true
        break
      }
      if (!relevant) return
      injectDockFallback()
      scheduleRail()
    })
    dockObserver.observe(document.body, { childList: true, subtree: true })
  }

  function railTone(verdict) {
    if (verdict === 'same') return 'same'
    if (verdict === 'changed') return 'changed'
    if (verdict === 'mixed') return 'mixed'
    if (verdict === 'generation') return 'generation'
    return 'first'
  }

  function ensureRailLayer() {
    if (railLayer && document.documentElement.contains(railLayer)) return railLayer
    railLayer = el('div', 'mf-rail-layer')
    document.body.appendChild(railLayer)
    return railLayer
  }

  function scheduleRail() {
    if (window.__dshModelFingerprintNativeRail) return
    if (railFrame) return
    railFrame = window.requestAnimationFrame(function () {
      railFrame = null
      renderRail()
    })
  }

  function renderRail() {
    var layer = ensureRailLayer()
    if (window.__dshModelFingerprintNativeRail) {
      layer.style.display = 'none'
      return
    }
    if (!railOn || full || panelOpen || document.hidden) {
      layer.style.display = 'none'
      return
    }
    layer.style.display = 'block'
    layer.replaceChildren()
    var candidates = document.querySelectorAll('[data-slot="conversation.chat.flow"], [data-chat-flow]')
    var flow = null
    var bestCount = 0
    var bestWidth = Infinity
    for (var f = 0; f < candidates.length; f += 1) {
      var candidateBox = candidates[f].getBoundingClientRect()
      if (candidateBox.width < 320 || candidateBox.height < 120) continue
      if (candidates[f].closest('aside, nav, [data-slot*="sidebar"], [class*="sidebar"], [class*="workspace"]')) continue
      var count = candidates[f].querySelectorAll('[data-chat-turn]').length
      var width = candidateBox.width
      if (count > bestCount || (count === bestCount && count > 0 && width < bestWidth)) {
        bestCount = count
        bestWidth = width
        flow = candidates[f]
      }
    }
    if (!flow || bestCount === 0) {
      var cursor = document.querySelector('[data-chat-turn]')
      while (cursor && cursor !== document.body) {
        if (!cursor.closest('aside, nav, [data-slot*="sidebar"], [class*="sidebar"], [class*="workspace"]') && cursor.querySelectorAll('[data-chat-turn]').length) {
          flow = cursor
          break
        }
        cursor = cursor.parentElement
      }
    }
    if (!flow || !railTurns.length) {
      // No chat flow or no observed turns: keep the whole rail hidden on
      // plugin, automation, settings and other non-conversation pages.
      layer.style.display = 'none'
      return
    }
    var domTurns = []
    var domNodes = flow.querySelectorAll('[data-chat-turn]')
    for (var d = 0; d < domNodes.length; d += 1) {
      var value = domNodes[d].getAttribute('data-chat-turn')
      if (value !== null && domTurns.indexOf(value) === -1) domTurns.push(value)
    }
    var turnOffset = 0
    var apiTurns = railTurns.map(function (item) { return Number(item.turn) }).filter(function (item) { return Number.isFinite(item) })
    var domNumeric = domTurns.map(function (item) { return Number(item) }).filter(function (item) { return Number.isFinite(item) })
    if (apiTurns.length && domNumeric.length) {
      var candidateOffset = Math.min.apply(null, domNumeric) - Math.min.apply(null, apiTurns)
      var offsetWorks = railTurns.every(function (item) { return domTurns.indexOf(String(Number(item.turn) + candidateOffset)) !== -1 })
      if (offsetWorks) turnOffset = candidateOffset
    }
    var flowRect = flow.getBoundingClientRect()
    if (flowRect.width < 120) return
    var sidebarRight = 0
    var sidebarNodes = document.querySelectorAll('aside, nav, [data-slot*="sidebar"], [class*="sidebar"]')
    for (var s = 0; s < sidebarNodes.length; s += 1) {
      var sideBox = sidebarNodes[s].getBoundingClientRect()
      if (sideBox.width >= 150 && sideBox.height >= 280 && sideBox.height <= window.innerHeight + 4 && sideBox.right <= flowRect.left + 2) {
        sidebarRight = Math.max(sidebarRight, sideBox.right)
      }
    }
    var safeLeft = sidebarRight > 0 ? sidebarRight + 2 : Math.max(8, flowRect.left - 64)
    var gap = flowRect.left - sidebarRight
    var cardWidth = 176
    var compact = gap < cardWidth + 24 || (sidebarRight === 0 && flowRect.left < cardWidth * 2)
    var left = compact ? Math.max(safeLeft, flowRect.left - 62) : Math.max(safeLeft, flowRect.left - cardWidth - 10)
    var entries = []
    for (var i = 0; i < railTurns.length; i += 1) {
      var turn = railTurns[i]
      var nodes = flow.querySelectorAll('[data-chat-turn="' + String(Number(turn.turn) + turnOffset) + '"]')
      var top = Infinity
      var bottom = -Infinity
      for (var j = 0; j < nodes.length; j += 1) {
        var node = nodes[j]
        if (!node.getClientRects().length) continue
        var box = node.getBoundingClientRect()
        if (!box.height) continue
        top = Math.min(top, box.top)
        bottom = Math.max(bottom, box.bottom)
      }
      if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue
      if (bottom < -20 || top > window.innerHeight + 20) continue
      entries.push({ turn: turn, top: top, bottom: bottom })
    }
    entries.sort(function (a, b) { return a.top - b.top })
    var lastBottom = 8
    for (var k = 0; k < entries.length; k += 1) {
      var entry = entries[k]
      var tone = railTone(entry.turn.verdict)
      var cardTop = Math.max(entry.top, lastBottom + 4, 8)
      if (cardTop > window.innerHeight - 38) continue
      lastBottom = cardTop + 45
      if (compact) {
        var pill = el('div', 'mf-rail-compact', 'FP-' + String(entry.turn.primaryShort || '').slice(0, 4))
        pill.style.left = left + 'px'
        pill.style.top = cardTop + 'px'
        pill.title = '第 ' + entry.turn.turn + ' 轮 · ' + entry.turn.verdictLabel + ' · 点击打开逐轮面板'
        pill.addEventListener('click', openFullPanel)
        layer.appendChild(pill)
        continue
      }
      var card = el('div', 'mf-rail-card ' + tone)
      card.style.left = left + 'px'
      card.style.top = cardTop + 'px'
      card.title = '点击打开逐轮检测面板'
      var head = el('div', 'mf-rail-head')
      head.appendChild(el('span', '', '第 ' + entry.turn.turn + ' 轮'))
      head.appendChild(el('span', '', entry.turn.verdict === 'same' ? '一致' : entry.turn.verdict === 'changed' ? '变化' : entry.turn.verdict === 'mixed' ? '多指纹' : entry.turn.verdict === 'generation' ? '代际' : '基线'))
      var fp = el('div', 'mf-rail-fp', 'FP-' + String(entry.turn.primaryShort || ''))
      var model = el('div', 'mf-rail-model', String(entry.turn.primaryModel || ''))
      card.append(head, fp, model)
      card.addEventListener('click', openFullPanel)
      layer.appendChild(card)
    }
  }

  function loadRail() {
    if (!railOn) return
    if (!railSessionId) {
      if (data && data.latest && data.latest.session && data.latest.session.id) railSessionId = data.latest.session.id
      if (!railSessionId) return
    }
    if (railLoading) return
    railLoading = true
    fetch(apiUrl('/model-fingerprint/api/session?id=' + encodeURIComponent(railSessionId) + '&limit=200'), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (payload) {
        railTurns = payload.turns || []
        scheduleRail()
      })
      .catch(function () {
        railTurns = []
        scheduleRail()
      })
      .finally(function () {
        railLoading = false
      })
  }

  function setRailOn(value) {
    var next = Boolean(value)
    if (typeof window.__dshModelFingerprintSetRail === 'function') {
      window.__dshModelFingerprintSetRail(next)
      return
    }
    railOn = next
    try { window.localStorage.setItem('dsh.mf.rail', railOn ? '1' : '0') } catch (err) { /* private mode */ }
    window.__dshModelFingerprintRailState = { on: railOn, sessionId: railSessionId }
    if (railOn) loadRail()
    scheduleRail()
  }

  function load() {
    return fetch(API, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    }).then(function (value) {
      failures = 0
      data = value
      renderBadge()
      if (!railSessionId && value.latest && value.latest.session && value.latest.session.id) {
        railSessionId = value.latest.session.id
      }
      if (railOn) loadRail()
      scheduleRail()
    }).catch(function () {
      failures += 1
      if (failures >= 3 && root) root.style.display = 'none'
    })
  }

  function start() {
    if (!document.body) { setTimeout(start, 100); return }
    if (window.__dshModelFingerprintNative) { removeFallbackDock(); return }
    style()
    try { railOn = window.localStorage.getItem('dsh.mf.rail') === '1' } catch (err) { /* private mode */ }
    if (window.__dshModelFingerprintRailState) {
      railOn = window.__dshModelFingerprintRailState.on === true
      railSessionId = window.__dshModelFingerprintRailState.sessionId || null
    }
    panelOpen = Boolean(window.__dshModelFingerprintPanelOpen)
    ensureRoot()
    ensureRailLayer()
    if (window.__dshModelFingerprintNative) removeFallbackDock()
    renderBadge()
    watchComposer()
    window.addEventListener('dsh-mf-rail', function (event) {
      railOn = Boolean(event.detail && event.detail.on)
      if (event.detail && event.detail.sessionId) railSessionId = event.detail.sessionId
      if (window.__dshModelFingerprintNative) removeFallbackDock()
      if (railOn) loadRail()
      scheduleRail()
    })
    window.addEventListener('dsh-mf-session', function (event) {
      if (!event.detail || !event.detail.sessionId) return
      railSessionId = event.detail.sessionId
      railTurns = []
      if (railOn) loadRail()
      scheduleRail()
    })
    window.addEventListener('dsh-mf-panel', function (event) {
      panelOpen = Boolean(event.detail && event.detail.open)
      scheduleRail()
    })
    function onWidgetScroll() {
      if (window.__dshModelFingerprintNativeRail) return
      scheduleRail()
    }
    window.addEventListener('scroll', onWidgetScroll, true)
    window.addEventListener('resize', scheduleRail)
    load()
    if (railOn) loadRail()
    timer = setInterval(function () {
      if (!document.hidden) {
        load()
        if (railOn) loadRail()
      }
    }, 6000)
    composerTimer = setInterval(watchComposer, 3000)
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        load()
        if (railOn) loadRail()
      }
    })
  }

  window.__dshModelFingerprintRailDebug = function () {
    var flowNodes = document.querySelectorAll('[data-chat-turn]')
    var flow = document.querySelector('[data-slot="conversation.chat.flow"]')
    var rect = flow ? flow.getBoundingClientRect() : null
    var domTurns = []
    for (var i = 0; i < flowNodes.length; i += 1) {
      var value = flowNodes[i].getAttribute('data-chat-turn')
      if (value !== null && domTurns.indexOf(value) === -1) domTurns.push(value)
    }
    return {
      railOn: railOn,
      railSessionId: railSessionId,
      railTurns: railTurns.length,
      panelOpen: panelOpen,
      native: Boolean(window.__dshModelFingerprintNative),
      flow: Boolean(flow),
      flowLeft: rect ? Math.round(rect.left) : null,
      flowWidth: rect ? Math.round(rect.width) : null,
      flowTurns: flow ? flow.querySelectorAll('[data-chat-turn]').length : 0,
      documentTurns: flowNodes.length,
      domTurns: domTurns.slice(0, 20),
      cards: document.querySelectorAll('.mf-rail-card').length,
      status: document.querySelectorAll('.mf-rail-status').length,
      layerDisplay: railLayer ? railLayer.style.display : null,
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
