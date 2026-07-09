// Curva DiagnosticsPanel: two-tab (Metrics + Logs) diagnostics UI backed by
// bare/observability.js (Hypertrace + hypertrace-prometheus). Reads directly
// from http://localhost:{port}/metrics OR from an IPC-forwarded snapshot when
// the port cannot be reached (Bare renderer sandbox).
//
// Docs consulted:
//   https://prometheus.io/docs/instrumenting/exposition_formats/  (fetched 2026-07-10)
//     text-based exposition format; # HELP / # TYPE / <metric>{labels} <value>
//   https://github.com/holepunchto/hypertrace-prometheus  (fetched 2026-07-10)
//     confirms /metrics endpoint and single "trace_counter" counter with
//     object_classname, id, caller_functionname labels.
//
// Security discipline (matches Chat.js / CommentaryPanel.js / DelegatedInferencePanel.js):
//   - EVERY user- or metric-supplied string set via .textContent, never innerHTML.
//   - No inline event handlers on injected DOM.
//   - Metrics fetch is same-origin loopback only (http://localhost:{port}).
//   - Log message body clipped to 2048 chars before rendering.

const DEFAULT_PROMETHEUS_URL = 'http://localhost:4343/metrics'
const MAX_LOG_LINES = 100
const REFRESH_MS = 5000

/**
 * Feature-flag check for the panel. Follows the same shape as
 * isDelegatedPanelEnabled: probes the bridge with a short timeout.
 */
export async function isDiagnosticsEnabled (curva) {
  const status = curva?.diagnostics?.status
  if (typeof status !== 'function') return false
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    const s = await Promise.race([status(), timeout])
    return !!(s && s.enabled)
  } catch {
    return false
  }
}

/**
 * Parse the Prometheus text exposition format. Very small hand-rolled parser:
 * we do NOT accept arbitrary content since we control the exporter. Returns
 * an array of { name, help, type, samples: [{ labels, value }] }.
 *
 * Regex reference: PROM_LINE matches `metric{labels} value` OR `metric value`.
 * Labels are parsed with a small state machine to handle quoted strings.
 */
export function parsePrometheusText (text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const byName = new Map()
  const lines = text.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (line.startsWith('# HELP ')) {
      const rest = line.slice(7)
      const sp = rest.indexOf(' ')
      if (sp < 0) continue
      const name = rest.slice(0, sp)
      const help = rest.slice(sp + 1)
      const m = ensureMetric(byName, name)
      m.help = help
      continue
    }
    if (line.startsWith('# TYPE ')) {
      const rest = line.slice(7)
      const sp = rest.indexOf(' ')
      if (sp < 0) continue
      const name = rest.slice(0, sp)
      const type = rest.slice(sp + 1)
      const m = ensureMetric(byName, name)
      m.type = type
      continue
    }
    if (line.startsWith('#')) continue
    // Sample line: name{k="v",k2="v2"} 123.4  OR  name 123.4
    const braceIdx = line.indexOf('{')
    let name, labelsBlob, valueBlob
    if (braceIdx >= 0) {
      const closeIdx = line.indexOf('}', braceIdx)
      if (closeIdx < 0) continue
      name = line.slice(0, braceIdx).trim()
      labelsBlob = line.slice(braceIdx + 1, closeIdx)
      valueBlob = line.slice(closeIdx + 1).trim()
    } else {
      const sp = line.indexOf(' ')
      if (sp < 0) continue
      name = line.slice(0, sp).trim()
      labelsBlob = ''
      valueBlob = line.slice(sp + 1).trim()
    }
    if (!name) continue
    const value = Number(valueBlob.split(' ')[0])
    if (!Number.isFinite(value)) continue
    const labels = parseLabels(labelsBlob)
    const m = ensureMetric(byName, name)
    m.samples.push({ labels, value })
  }
  return Array.from(byName.values())
}

function ensureMetric (byName, name) {
  let m = byName.get(name)
  if (!m) {
    m = { name, help: '', type: '', samples: [] }
    byName.set(name, m)
  }
  return m
}

function parseLabels (blob) {
  const out = {}
  if (!blob) return out
  let i = 0
  const len = blob.length
  while (i < len) {
    // Skip whitespace/comma
    while (i < len && (blob[i] === ' ' || blob[i] === ',')) i++
    // Key
    let keyStart = i
    while (i < len && blob[i] !== '=') i++
    if (i >= len) break
    const key = blob.slice(keyStart, i).trim()
    i++ // consume '='
    if (i >= len || blob[i] !== '"') continue
    i++ // consume opening quote
    let val = ''
    while (i < len && blob[i] !== '"') {
      if (blob[i] === '\\' && i + 1 < len) {
        const esc = blob[i + 1]
        val += (esc === 'n' ? '\n' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc)
        i += 2
      } else {
        val += blob[i]
        i++
      }
    }
    i++ // consume closing quote
    if (key.length > 0 && key.length <= 64 && val.length <= 256) out[key] = val
  }
  return out
}

/**
 * Fetch metrics from the loopback exporter. Falls back to
 * curva.diagnostics.metrics() when direct HTTP is unreachable (Bare sandbox).
 * Never throws — always returns { ok: boolean, text: string, source: string }.
 */
export async function fetchMetrics (curva, { url = DEFAULT_PROMETHEUS_URL, timeoutMs = 3000 } = {}) {
  if (typeof fetch === 'function') {
    try {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
      const resp = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      if (timer) clearTimeout(timer)
      if (resp && resp.ok) {
        const text = await resp.text()
        return { ok: true, text, source: 'http' }
      }
    } catch { /* fall through to IPC */ }
  }
  const bridge = curva?.diagnostics?.metrics
  if (typeof bridge === 'function') {
    try {
      const text = await bridge()
      return { ok: typeof text === 'string' && text.length > 0, text: typeof text === 'string' ? text : '', source: 'ipc' }
    } catch { /* fall through */ }
  }
  return { ok: false, text: '', source: 'none' }
}

/**
 * Mount the DiagnosticsPanel into `container`. Returns a destroy() function
 * so callers (app.js) can tear it down when the sidebar switches away.
 *
 * @param {{
 *   container: HTMLElement,
 *   curva: object,
 *   prometheusUrl?: string,
 *   refreshMs?: number,
 *   fetchImpl?: typeof fetchMetrics
 * }} opts
 */
export function mountDiagnosticsPanel (opts = {}) {
  const {
    container,
    curva,
    prometheusUrl = DEFAULT_PROMETHEUS_URL,
    refreshMs = REFRESH_MS,
    fetchImpl = fetchMetrics
  } = opts
  if (!container) throw new TypeError('container required')

  container.textContent = ''
  container.classList.add('curva-diagnostics')

  // -- Header -------------------------------------------------------------
  const header = document.createElement('div')
  header.className = 'curva-diagnostics-header'
  const title = document.createElement('h3')
  title.textContent = 'Diagnostics'
  header.appendChild(title)
  const status = document.createElement('span')
  status.className = 'curva-diagnostics-status'
  status.textContent = 'idle'
  header.appendChild(status)
  container.appendChild(header)

  // -- Tab bar ------------------------------------------------------------
  const tabbar = document.createElement('div')
  tabbar.className = 'curva-diagnostics-tabs'
  const metricsTab = tabButton('Metrics')
  const logsTab = tabButton('Logs')
  tabbar.appendChild(metricsTab)
  tabbar.appendChild(logsTab)
  container.appendChild(tabbar)

  // -- Panels -------------------------------------------------------------
  const metricsPanel = document.createElement('div')
  metricsPanel.className = 'curva-diagnostics-panel curva-diagnostics-metrics'
  const metricsToolbar = document.createElement('div')
  metricsToolbar.className = 'curva-diagnostics-toolbar'
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.textContent = 'Copy metrics'
  metricsToolbar.appendChild(copyBtn)
  const source = document.createElement('span')
  source.className = 'curva-diagnostics-source'
  source.textContent = ''
  metricsToolbar.appendChild(source)
  metricsPanel.appendChild(metricsToolbar)
  const metricsTable = document.createElement('table')
  metricsTable.className = 'curva-diagnostics-table'
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const h of ['Metric', 'Type', 'Labels', 'Value']) {
    const th = document.createElement('th')
    th.textContent = h
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  metricsTable.appendChild(thead)
  const tbody = document.createElement('tbody')
  metricsTable.appendChild(tbody)
  metricsPanel.appendChild(metricsTable)
  const metricsEmpty = document.createElement('div')
  metricsEmpty.className = 'curva-diagnostics-empty'
  metricsEmpty.textContent = 'No metrics yet. Ensure CURVA_OBSERVABILITY_ENABLED=true.'
  metricsPanel.appendChild(metricsEmpty)
  container.appendChild(metricsPanel)

  const logsPanel = document.createElement('div')
  logsPanel.className = 'curva-diagnostics-panel curva-diagnostics-logs'
  const logsList = document.createElement('ol')
  logsList.className = 'curva-diagnostics-loglist'
  logsPanel.appendChild(logsList)
  const logsEmpty = document.createElement('div')
  logsEmpty.className = 'curva-diagnostics-empty'
  logsEmpty.textContent = 'No server logs yet.'
  logsPanel.appendChild(logsEmpty)
  container.appendChild(logsPanel)

  // -- State --------------------------------------------------------------
  const state = {
    tab: 'metrics',
    logs: [],
    unsubLogs: null,
    timer: null,
    destroyed: false,
    inFlight: false,
    lastMetricsText: ''
  }

  function tabButton (label) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'curva-diagnostics-tab'
    b.textContent = label
    return b
  }

  function selectTab (name) {
    state.tab = name
    metricsPanel.hidden = name !== 'metrics'
    logsPanel.hidden = name !== 'logs'
    metricsTab.classList.toggle('is-active', name === 'metrics')
    logsTab.classList.toggle('is-active', name === 'logs')
    // Restart polling loop so we only poll while the active tab is metrics.
    stopPolling()
    if (name === 'metrics' && !state.destroyed) startPolling()
  }
  metricsTab.addEventListener('click', () => selectTab('metrics'))
  logsTab.addEventListener('click', () => selectTab('logs'))

  async function refresh () {
    if (state.destroyed || state.inFlight) return
    state.inFlight = true
    status.textContent = 'refreshing…'
    try {
      const res = await fetchImpl(curva, { url: prometheusUrl })
      state.lastMetricsText = res.text || ''
      source.textContent = res.source === 'http' ? 'source: http' : res.source === 'ipc' ? 'source: ipc' : 'source: none'
      renderMetrics(parsePrometheusText(res.text || ''))
      status.textContent = res.ok ? 'ok' : 'unreachable'
    } catch (err) {
      status.textContent = 'error: ' + safeMessage(err)
    } finally {
      state.inFlight = false
    }
  }

  function renderMetrics (metrics) {
    tbody.textContent = ''
    if (!Array.isArray(metrics) || metrics.length === 0) {
      metricsEmpty.hidden = false
      metricsTable.hidden = true
      return
    }
    metricsEmpty.hidden = true
    metricsTable.hidden = false
    for (const m of metrics) {
      // Roll up all samples for a single metric so the table stays readable.
      for (const s of m.samples) {
        const tr = document.createElement('tr')
        const tdName = document.createElement('td'); tdName.textContent = m.name
        const tdType = document.createElement('td'); tdType.textContent = m.type || ''
        const tdLabels = document.createElement('td')
        tdLabels.textContent = formatLabels(s.labels)
        const tdVal = document.createElement('td'); tdVal.textContent = String(s.value)
        tr.appendChild(tdName); tr.appendChild(tdType); tr.appendChild(tdLabels); tr.appendChild(tdVal)
        tbody.appendChild(tr)
      }
    }
  }

  function appendLogLine (entry) {
    if (!entry || typeof entry !== 'object') return
    state.logs.push(entry)
    while (state.logs.length > MAX_LOG_LINES) state.logs.shift()
    renderLogs()
  }

  function renderLogs () {
    logsList.textContent = ''
    if (state.logs.length === 0) {
      logsEmpty.hidden = false
      logsList.hidden = true
      return
    }
    logsEmpty.hidden = true
    logsList.hidden = false
    for (const entry of state.logs) {
      const li = document.createElement('li')
      li.className = 'curva-diagnostics-log-' + (entry.level || 'info').replace(/[^a-z0-9-]/gi, '')
      const ts = document.createElement('span'); ts.className = 'curva-log-ts'
      ts.textContent = new Date(entry.ts).toISOString()
      const lv = document.createElement('span'); lv.className = 'curva-log-level'
      lv.textContent = entry.level || 'info'
      const msg = document.createElement('span'); msg.className = 'curva-log-msg'
      msg.textContent = String(entry.message || '').slice(0, 2048)
      li.appendChild(ts); li.appendChild(lv); li.appendChild(msg)
      logsList.appendChild(li)
    }
  }

  function startPolling () {
    if (state.timer) return
    refresh()
    state.timer = setInterval(refresh, refreshMs)
  }
  function stopPolling () {
    if (state.timer) { clearInterval(state.timer); state.timer = null }
  }

  copyBtn.addEventListener('click', async () => {
    const text = state.lastMetricsText || ''
    if (!text) return
    try {
      if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text)
      status.textContent = 'copied ' + text.length + ' bytes'
    } catch {
      status.textContent = 'clipboard blocked'
    }
  })

  // Subscribe to log stream once the bridge is available.
  if (typeof curva?.diagnostics?.onLog === 'function') {
    try {
      const ret = curva.diagnostics.onLog(appendLogLine)
      if (typeof ret === 'function') state.unsubLogs = ret
    } catch { /* ignore */ }
  }

  selectTab('metrics')

  return {
    refresh,
    selectTab,
    getState () { return { tab: state.tab, logs: state.logs.slice(), lastMetricsText: state.lastMetricsText } },
    appendLogLine, // exported for tests
    destroy () {
      if (state.destroyed) return
      state.destroyed = true
      stopPolling()
      if (state.unsubLogs) { try { state.unsubLogs() } catch {} }
      container.textContent = ''
      container.classList.remove('curva-diagnostics')
    }
  }
}

function formatLabels (labels) {
  if (!labels) return ''
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ''
  return keys.map((k) => k + '=' + JSON.stringify(labels[k])).join(', ')
}

function safeMessage (err) {
  if (!err) return 'unknown'
  const m = typeof err === 'string' ? err : (err.message || String(err))
  return m.slice(0, 128)
}
