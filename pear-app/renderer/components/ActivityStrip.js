// Curva ActivityStrip: single-line horizontal ticker at the top of the app.
// Subscribes to /activity/stream via EventSource and appends a rolling line
// for each `facilitator.submitted` event.
//
// Docs verified: MDN EventSource lifecycle (constructor, open/message/error
// events, readyState, close(), auto-reconnect). We layer our own exponential
// backoff on top because MDN behavior varies per browser.
//
// Security discipline:
//   - textContent only. Every backend field is treated as untrusted string.
//   - Links go through curva.openExternal, which enforces an https allowlist
//     on BOTH sides (preload + electron main).
//   - We tolerate arbitrary payload shapes (fields missing, extra fields,
//     wrong types). Nothing throws.

const MAX_LINES = 12
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30_000

export function mountActivityStrip({ container, backendUrl, curva } = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva is required')
  if (typeof backendUrl !== 'string' || backendUrl.length === 0) {
    throw new RangeError('backendUrl required')
  }

  container.textContent = ''
  container.classList.add('curva-strip')

  const badge = document.createElement('span')
  badge.className = 'curva-strip__badge'
  badge.textContent = 'LIVE TIPS'
  container.appendChild(badge)

  const ticker = document.createElement('div')
  ticker.className = 'curva-strip__ticker'
  container.appendChild(ticker)

  let source = null
  let disposed = false
  let attempt = 0
  let reconnectTimer = null

  function scheduleReconnect() {
    if (disposed) return
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * Math.pow(2, attempt++))
    reconnectTimer = setTimeout(connect, backoff)
  }

  function connect() {
    if (disposed) return
    try {
      // Trailing slash guard.
      const base = backendUrl.replace(/\/+$/, '')
      source = new EventSource(base + '/activity/stream')
    } catch (err) {
      // Backend unavailable: hide the strip and keep retrying quietly.
      container.classList.add('curva-strip--hidden')
      scheduleReconnect()
      return
    }
    source.addEventListener('open', () => {
      attempt = 0
      container.classList.remove('curva-strip--hidden')
    })
    source.addEventListener('error', () => {
      // EventSource auto-retries in most browsers, but Electron's chromium
      // can drop the connection for reasons that never trigger a fresh
      // reconnect. We close and re-open on our own schedule.
      try { source?.close() } catch { /* noop */ }
      source = null
      container.classList.add('curva-strip--hidden')
      scheduleReconnect()
    })
    source.addEventListener('message', (evt) => {
      let payload
      try { payload = JSON.parse(evt.data) } catch { return }
      handleEvent(payload)
    })
  }

  function handleEvent(payload) {
    if (!payload || typeof payload !== 'object') return
    const kind = payload.type || payload.event
    if (kind !== 'facilitator.submitted') return
    const line = renderLine(payload)
    if (!line) return
    ticker.insertBefore(line, ticker.firstChild)
    while (ticker.children.length > MAX_LINES) {
      ticker.removeChild(ticker.lastChild)
    }
  }

  function safeStr(v, fallback = '?') {
    if (typeof v !== 'string') return fallback
    if (v.length === 0 || v.length > 128) return fallback
    return v
  }

  function shortAddr(v) {
    if (typeof v !== 'string') return '?'
    if (v.length >= 10 && v.startsWith('0x')) return v.slice(0, 6) + '..' + v.slice(-4)
    return v.slice(0, 12)
  }

  function formatAmount(v) {
    if (v === null || v === undefined) return '?'
    const s = String(v)
    if (!/^[0-9]+$/.test(s)) return s.slice(0, 32)
    try {
      const whole = Number(BigInt(s)) / 1_000_000
      return whole.toFixed(2)
    } catch { return s.slice(0, 32) }
  }

  function renderLine(p) {
    const li = document.createElement('div')
    li.className = 'curva-strip__line'

    const flag = document.createElement('span')
    flag.className = 'curva-strip__flag'
    flag.textContent = 'TIP'
    li.appendChild(flag)

    const body = document.createElement('span')
    body.className = 'curva-strip__body'
    const fromShort = shortAddr(p.fromAddress)
    const toShort = shortAddr(p.toAddress)
    const amount = formatAmount(p.amount)
    // textContent for every peer/backend string.
    body.textContent = 'Peer ' + fromShort + ' tipped ' + amount + ' USDT to ' + toShort + '  '
    li.appendChild(body)

    const explorer = safeStr(p.explorerUrl, null)
    if (explorer && /^https:\/\//.test(explorer)) {
      const link = document.createElement('a')
      link.className = 'curva-strip__link'
      link.textContent = 'view on Sepolia'
      link.href = '#'
      link.addEventListener('click', (e) => {
        e.preventDefault()
        if (typeof curva.openExternal === 'function') {
          curva.openExternal(explorer).catch(() => { /* noop */ })
        }
      })
      li.appendChild(link)
    }

    const meta = document.createElement('span')
    meta.className = 'curva-strip__meta'
    const chain = safeStr(String(p.chainId ?? ''), '')
    if (chain) meta.textContent = ' [chain ' + chain + ']'
    li.appendChild(meta)

    return li
  }

  connect()

  function destroy() {
    disposed = true
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    if (source) { try { source.close() } catch { /* noop */ } source = null }
    container.textContent = ''
  }

  return { destroy }
}
