    const apiBase = () => {
      try {
        const injected = String(window.__dshModelFingerprintApiBase || '').replace(/\/+$/, '')
        if (injected) return injected
        const transport = window.__DSH_TRANSPORT__
        return transport && typeof transport.streamBaseUrl === 'string' ? transport.streamBaseUrl.replace(/\/+$/, '') : ''
      } catch { return '' }
    }
    const apiUrl = (path) => apiBase() + path
