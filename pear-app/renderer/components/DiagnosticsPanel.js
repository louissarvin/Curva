// Curva DiagnosticsPanel: three-tab (Metrics + Logs + Models) diagnostics UI
// backed by bare/observability.js (Hypertrace + hypertrace-prometheus) and
// the @qvac/sdk model-info surface. Reads metrics directly from
// http://localhost:{port}/metrics OR from an IPC-forwarded snapshot when the
// port cannot be reached (Bare renderer sandbox).
//
// Docs consulted:
//   https://prometheus.io/docs/instrumenting/exposition_formats/  (fetched 2026-07-10)
//     text-based exposition format; # HELP / # TYPE / <metric>{labels} <value>
//   https://github.com/holepunchto/hypertrace-prometheus  (fetched 2026-07-10)
//     confirms /metrics endpoint and single "trace_counter" counter with
//     object_classname, id, caller_functionname labels.
//   node_modules/@qvac/sdk/dist/client/api/get-model-info.d.ts:10-42 (0.14.0)
//     shape of the model snapshot rows rendered by the Models tab.
//   node_modules/@qvac/sdk/dist/client/api/get-loaded-model-info.d.ts:24
//     handlers[] + isDelegated + providerInfo fields shown on the row.
//
// Security discipline (matches Chat.js / CommentaryPanel.js / DelegatedInferencePanel.js):
//   - EVERY user- or metric-supplied string set via .textContent, never innerHTML.
//   - No inline event handlers on injected DOM.
//   - Metrics fetch is same-origin loopback only (http://localhost:{port}).
//   - Log message body clipped to 2048 chars before rendering.
//   - Model ids and provider pubkeys are hex-only-validated before render
//     and shortened to prevent layout attacks or log injection.

const DEFAULT_PROMETHEUS_URL = 'http://localhost:4343/metrics'
const MAX_LOG_LINES = 100
const REFRESH_MS = 5000
const MODEL_REFRESH_MS = 5000

// Validation helpers for anything a model or provider returns before we let it
// hit the DOM. Model ids should be short opaque strings; provider pubkeys are
// hex. Reject anything else outright.
const SAFE_ID_RE = /^[A-Za-z0-9_\-.]+$/
const HEX_RE = /^[a-fA-F0-9]+$/

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
 * Sanitize+shorten a model id for display. Returns null when the id doesn't
 * match our allowlist so the render path can show "invalid" instead of
 * leaking arbitrary bytes into the DOM.
 */
export function safeModelId (id) {
  if (typeof id !== 'string') return null
  if (id.length === 0 || id.length > 128) return null
  if (!SAFE_ID_RE.test(id)) return null
  return id
}

/**
 * Shorten a hex pubkey for display: first-8 + '…' + last-6. Returns null
 * when the input is not valid hex.
 */
export function shortHex (hex) {
  if (typeof hex !== 'string') return null
  if (!HEX_RE.test(hex)) return null
  if (hex.length <= 16) return hex
  return hex.slice(0, 8) + '…' + hex.slice(-6)
}

/**
 * Format a byte count as MB with 1 decimal. Returns '—' for missing values.
 */
export function formatMB (bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
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
  const modelsTab = tabButton('Models')
  const reportTab = tabButton('Report')
  tabbar.appendChild(metricsTab)
  tabbar.appendChild(logsTab)
  tabbar.appendChild(modelsTab)
  tabbar.appendChild(reportTab)
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

  // -- Models panel (Wave 4 F2) ------------------------------------------
  const modelsPanel = document.createElement('div')
  modelsPanel.className = 'curva-diagnostics-panel curva-diagnostics-models'
  const modelsToolbar = document.createElement('div')
  modelsToolbar.className = 'curva-diagnostics-toolbar'
  const modelsRefreshBtn = document.createElement('button')
  modelsRefreshBtn.type = 'button'
  modelsRefreshBtn.textContent = 'Refresh'
  modelsToolbar.appendChild(modelsRefreshBtn)
  const modelsSource = document.createElement('span')
  modelsSource.className = 'curva-diagnostics-source'
  modelsSource.textContent = ''
  modelsToolbar.appendChild(modelsSource)
  modelsPanel.appendChild(modelsToolbar)
  const modelsTable = document.createElement('table')
  modelsTable.className = 'curva-diagnostics-table curva-diagnostics-models-table'
  const modelsThead = document.createElement('thead')
  const modelsHeadRow = document.createElement('tr')
  for (const h of ['Model', 'Addon', 'Loaded', 'Cached', 'Size', 'Handlers', 'Delegated', 'Last log', 'Actions']) {
    const th = document.createElement('th')
    th.textContent = h
    modelsHeadRow.appendChild(th)
  }
  modelsThead.appendChild(modelsHeadRow)
  modelsTable.appendChild(modelsThead)
  const modelsTbody = document.createElement('tbody')
  modelsTable.appendChild(modelsTbody)
  modelsPanel.appendChild(modelsTable)
  const modelsEmpty = document.createElement('div')
  modelsEmpty.className = 'curva-diagnostics-empty'
  modelsEmpty.textContent = 'No models loaded yet.'
  modelsPanel.appendChild(modelsEmpty)
  container.appendChild(modelsPanel)

  // -- Report panel (wave-final QVAC depth F2) ---------------------------
  // Full peer-side diagnostic snapshot from @qvac/diagnostics: app info,
  // environment, hardware, addon status, Curva extension section (roomSlug,
  // isHost, active AI capabilities). XSS discipline: every rendered string
  // goes through textContent — the report JSON is dumped into a <pre>.
  const reportPanel = document.createElement('div')
  reportPanel.className = 'curva-diagnostics-panel curva-diagnostics-report'
  const reportToolbar = document.createElement('div')
  reportToolbar.className = 'curva-diagnostics-toolbar'
  const genReportBtn = document.createElement('button')
  genReportBtn.type = 'button'
  genReportBtn.textContent = 'Generate report'
  reportToolbar.appendChild(genReportBtn)
  const copyReportBtn = document.createElement('button')
  copyReportBtn.type = 'button'
  copyReportBtn.textContent = 'Copy to clipboard'
  copyReportBtn.disabled = true
  reportToolbar.appendChild(copyReportBtn)
  const reportSource = document.createElement('span')
  reportSource.className = 'curva-diagnostics-source'
  reportSource.textContent = ''
  reportToolbar.appendChild(reportSource)
  reportPanel.appendChild(reportToolbar)
  const reportPre = document.createElement('pre')
  reportPre.className = 'curva-diagnostics-report-json'
  reportPre.textContent = ''
  reportPanel.appendChild(reportPre)
  const reportEmpty = document.createElement('div')
  reportEmpty.className = 'curva-diagnostics-empty'
  reportEmpty.textContent = 'Click "Generate report" to capture a snapshot.'
  reportPanel.appendChild(reportEmpty)
  container.appendChild(reportPanel)

  // -- State --------------------------------------------------------------
  const state = {
    tab: 'metrics',
    logs: [],
    unsubLogs: null,
    timer: null,
    modelsTimer: null,
    modelsInFlight: false,
    lastLogPerModel: new Map(), // model-id -> last log entry
    destroyed: false,
    inFlight: false,
    lastMetricsText: '',
    // wave-final QVAC depth F2: last generated report JSON. Held so the
    // Copy button has something to write to the clipboard without re-fetching.
    lastReportJson: '',
    reportInFlight: false,
    // Wave 4 F2 addendum: single-drawer state for the per-model log tail. Only
    // one drawer may be open at a time — opening a second drawer closes the
    // first (both server-side stream and DOM). See models:tail-logs IPC.
    tail: {
      modelId: null,        // model id currently being tailed (null if closed)
      drawer: null,         // drawer DOM element
      logList: null,        // <ul> element inside the drawer
      buffer: [],           // log entries in insertion order (cap MAX_TAIL_LINES)
      counters: {},         // { info: n, warn: n, error: n, debug: n, off: n }
      levelFilter: 'all',   // 'all' | 'error' | 'warn' | 'info' | 'debug'
      counterLabel: null,   // <span> for header level counters
      unsubLog: null,       // curva.models.onTailLog unsub
      unsubStopped: null    // curva.models.onTailStopped unsub
    }
  }
  // Cap of log lines held in the drawer buffer. Per spec: drop oldest on
  // overflow. Kept below the wrapper's default maxLines (500) so the drawer
  // usually renders every line the server delivers before the tail auto-stops.
  const MAX_TAIL_LINES = 200

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
    modelsPanel.hidden = name !== 'models'
    reportPanel.hidden = name !== 'report'
    metricsTab.classList.toggle('is-active', name === 'metrics')
    logsTab.classList.toggle('is-active', name === 'logs')
    modelsTab.classList.toggle('is-active', name === 'models')
    reportTab.classList.toggle('is-active', name === 'report')
    // Restart polling loops so we only poll while their tab is active. The
    // Report tab is a manual snapshot — deliberately no auto-refresh.
    stopPolling()
    stopModelsPolling()
    // Wave 4 F2 addendum: switching away from Models auto-closes any open
    // per-model log tail. This mirrors how startPolling / stopModelsPolling
    // are gated on the active tab.
    if (name !== 'models' && state.tail.modelId) {
      closeTailDrawer({ silent: true })
    }
    if (state.destroyed) return
    if (name === 'metrics') startPolling()
    if (name === 'models') startModelsPolling()
  }
  metricsTab.addEventListener('click', () => selectTab('metrics'))
  logsTab.addEventListener('click', () => selectTab('logs'))
  modelsTab.addEventListener('click', () => selectTab('models'))
  reportTab.addEventListener('click', () => selectTab('report'))

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
    // F2: capture the most recent log per model id so the Models tab can show
    // it inline. `entry.id` is set by the SDK subscribeServerLogs stream
    // (subscribe-logs.d.ts:5-7). Validate before storing.
    const modelId = safeModelId(entry.id)
    if (modelId) {
      state.lastLogPerModel.set(modelId, {
        ts: entry.ts,
        level: entry.level,
        message: entry.message,
        namespace: entry.namespace
      })
    }
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

  // -- Models tab (Wave 4 F2) --------------------------------------------

  async function refreshModels () {
    if (state.destroyed || state.modelsInFlight) return
    state.modelsInFlight = true
    try {
      const bridge = curva?.models?.list
      if (typeof bridge !== 'function') {
        modelsSource.textContent = 'source: unavailable'
        renderModels([])
        return
      }
      let list
      try {
        list = await bridge()
      } catch (err) {
        modelsSource.textContent = 'error: ' + safeMessage(err)
        renderModels([])
        return
      }
      modelsSource.textContent = 'source: ipc'
      renderModels(Array.isArray(list) ? list : [])
    } finally {
      state.modelsInFlight = false
    }
  }

  function renderModels (rows) {
    modelsTbody.textContent = ''
    if (!Array.isArray(rows) || rows.length === 0) {
      modelsEmpty.hidden = false
      modelsTable.hidden = true
      return
    }
    modelsEmpty.hidden = true
    modelsTable.hidden = false
    for (const row of rows) {
      const tr = document.createElement('tr')

      // Name column: display name + short model id
      const tdName = document.createElement('td')
      const nameEl = document.createElement('div')
      nameEl.className = 'curva-model-name'
      nameEl.textContent = typeof row.name === 'string' ? row.name.slice(0, 96) : '(unnamed)'
      tdName.appendChild(nameEl)
      const idSafe = safeModelId(row.modelId)
      if (idSafe) {
        const idEl = document.createElement('div')
        idEl.className = 'curva-model-id'
        idEl.textContent = idSafe.length > 24 ? idSafe.slice(0, 12) + '…' + idSafe.slice(-6) : idSafe
        tdName.appendChild(idEl)
      }
      tr.appendChild(tdName)

      // Addon column
      const tdAddon = document.createElement('td')
      tdAddon.textContent = typeof row.addon === 'string' ? row.addon : '—'
      tr.appendChild(tdAddon)

      // Loaded column
      const tdLoaded = document.createElement('td')
      tdLoaded.textContent = row.isLoaded ? 'yes' : 'no'
      tr.appendChild(tdLoaded)

      // Cached column
      const tdCached = document.createElement('td')
      tdCached.textContent = row.isCached ? 'yes' : 'no'
      tr.appendChild(tdCached)

      // Size column
      const tdSize = document.createElement('td')
      tdSize.textContent = formatMB(row.sizeBytes)
      tr.appendChild(tdSize)

      // Handlers column
      const tdHandlers = document.createElement('td')
      tdHandlers.textContent = Array.isArray(row.handlers) && row.handlers.length > 0
        ? row.handlers.slice(0, 6).join(', ')
        : '—'
      tr.appendChild(tdHandlers)

      // Delegated column
      const tdDelegated = document.createElement('td')
      if (row.isDelegated) {
        const short = shortHex(row.providerPubkey)
        tdDelegated.textContent = short ? 'yes (' + short + ')' : 'yes'
      } else {
        tdDelegated.textContent = 'no'
      }
      tr.appendChild(tdDelegated)

      // Last log column
      const tdLog = document.createElement('td')
      const last = idSafe ? state.lastLogPerModel.get(idSafe) : null
      if (last && typeof last.message === 'string') {
        tdLog.className = 'curva-model-lastlog'
        tdLog.textContent = String(last.message).slice(0, 240)
        tdLog.title = String(last.level || 'info') + ': ' + String(last.message || '').slice(0, 512)
      } else {
        tdLog.textContent = '—'
      }
      tr.appendChild(tdLog)

      // Actions column: [Unload] [Tail logs] — Unload only for loaded local
      // models; Tail logs for any row with a valid model id (delegated or
      // local, loaded or not). The Bare worker enforces its own guards.
      const tdActions = document.createElement('td')
      tdActions.className = 'curva-model-actions'
      if (row.isLoaded && !row.isDelegated && idSafe) {
        const unloadBtn = document.createElement('button')
        unloadBtn.type = 'button'
        unloadBtn.className = 'curva-model-unload'
        unloadBtn.textContent = 'Unload'
        unloadBtn.addEventListener('click', async () => {
          // Confirmation step — unload can be expensive (must reload later).
          const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm('Unload ' + (row.name || idSafe) + '? It will be reloaded on next use.')
            : true
          if (!confirmed) return
          const bridge = curva?.models?.unload
          if (typeof bridge !== 'function') {
            status.textContent = 'unload bridge unavailable'
            return
          }
          unloadBtn.disabled = true
          unloadBtn.textContent = 'Unloading…'
          try {
            await bridge(idSafe)
            status.textContent = 'unloaded ' + (row.name || idSafe)
            refreshModels()
          } catch (err) {
            status.textContent = 'unload error: ' + safeMessage(err)
            unloadBtn.disabled = false
            unloadBtn.textContent = 'Unload'
          }
        })
        tdActions.appendChild(unloadBtn)
      }
      if (idSafe && typeof curva?.models?.tailLogs === 'function') {
        const tailBtn = document.createElement('button')
        tailBtn.type = 'button'
        tailBtn.className = 'curva-model-tail'
        const isActive = state.tail.modelId === idSafe
        tailBtn.textContent = isActive ? 'Tailing…' : 'Tail logs'
        tailBtn.disabled = isActive
        tailBtn.addEventListener('click', () => {
          openTailDrawer(idSafe, row.name || idSafe, tr)
        })
        tdActions.appendChild(tailBtn)
      }
      tr.appendChild(tdActions)

      modelsTbody.appendChild(tr)

      // Re-attach the drawer to its owning row when a refresh replaces the DOM.
      if (state.tail.modelId === idSafe && state.tail.drawer) {
        // The tbody was cleared above; re-insert the drawer directly under the
        // row so the drilldown stays visually anchored across refreshes.
        const drawerRow = document.createElement('tr')
        drawerRow.className = 'curva-model-tail-drawer-row'
        const drawerCell = document.createElement('td')
        drawerCell.colSpan = 9
        drawerCell.appendChild(state.tail.drawer)
        drawerRow.appendChild(drawerCell)
        modelsTbody.appendChild(drawerRow)
      }
    }
  }

  // ---- Wave 4 F2 addendum: per-model log tail drawer -------------------
  // Only ONE drawer open at a time. Opening a second drawer closes the first
  // (both server stream and DOM). textContent-only for every log field so a
  // hostile addon cannot inject HTML via the log message body.

  function openTailDrawer (modelId, displayName, ownerRow) {
    if (state.destroyed) return
    // Guard: if the tail bridge disappeared between render and click, no-op.
    if (typeof curva?.models?.tailLogs !== 'function' ||
        typeof curva?.models?.stopTail !== 'function' ||
        typeof curva?.models?.onTailLog !== 'function') {
      status.textContent = 'model log tail bridge unavailable'
      return
    }
    // If a previous drawer is open, close it first so we do not leak the
    // upstream stream. The Bare worker's ALREADY_TAILING guard also protects
    // against a race, but closing first keeps the UX predictable.
    if (state.tail.modelId && state.tail.modelId !== modelId) {
      closeTailDrawer({ silent: true })
    } else if (state.tail.modelId === modelId) {
      // Same model already tailed — treat click as a no-op.
      return
    }

    const drawer = document.createElement('div')
    drawer.className = 'curva-diagnostics-tail-drawer'

    const header = document.createElement('div')
    header.className = 'curva-diagnostics-tail-header'
    const title = document.createElement('span')
    title.className = 'curva-diagnostics-tail-title'
    const shortId = modelId.length > 24 ? modelId.slice(0, 12) + '…' + modelId.slice(-6) : modelId
    title.textContent = 'Tailing ' + shortId
    header.appendChild(title)
    const counterLabel = document.createElement('span')
    counterLabel.className = 'curva-diagnostics-tail-counters'
    counterLabel.textContent = ''
    header.appendChild(counterLabel)
    const stopBtn = document.createElement('button')
    stopBtn.type = 'button'
    stopBtn.className = 'curva-diagnostics-tail-stop'
    stopBtn.textContent = 'Stop tail'
    stopBtn.addEventListener('click', () => closeTailDrawer())
    header.appendChild(stopBtn)
    drawer.appendChild(header)

    const filterBar = document.createElement('div')
    filterBar.className = 'curva-diagnostics-tail-filters'
    for (const lvl of ['all', 'error', 'warn', 'info', 'debug']) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'curva-diagnostics-tail-filter'
      b.textContent = lvl
      if (lvl === 'all') b.classList.add('is-active')
      b.addEventListener('click', () => {
        state.tail.levelFilter = lvl
        for (const other of filterBar.querySelectorAll('.curva-diagnostics-tail-filter')) {
          other.classList.toggle('is-active', other.textContent === lvl)
        }
        rerenderTailBuffer()
      })
      filterBar.appendChild(b)
    }
    drawer.appendChild(filterBar)

    const logList = document.createElement('ul')
    logList.className = 'curva-diagnostics-tail-log'
    drawer.appendChild(logList)

    state.tail.modelId = modelId
    state.tail.drawer = drawer
    state.tail.logList = logList
    state.tail.counterLabel = counterLabel
    state.tail.buffer = []
    state.tail.counters = { error: 0, warn: 0, info: 0, debug: 0, off: 0 }
    state.tail.levelFilter = 'all'

    // Subscribe to log events BEFORE calling tailLogs so we do not miss the
    // first entry the worker fires.
    try {
      const ret = curva.models.onTailLog((payload) => {
        if (!payload || typeof payload !== 'object') return
        if (payload.modelId !== state.tail.modelId) return
        const entry = payload.entry
        if (!entry || typeof entry !== 'object') return
        appendTailEntry(entry)
      })
      if (typeof ret === 'function') state.tail.unsubLog = ret
    } catch { /* ignore */ }
    if (typeof curva.models.onTailStopped === 'function') {
      try {
        const ret = curva.models.onTailStopped((payload) => {
          if (!payload || typeof payload !== 'object') return
          if (payload.modelId !== state.tail.modelId) return
          // Server-side confirmed stop — tear down the DOM if we did not
          // initiate. Idempotent with the local close below.
          if (state.tail.modelId) closeTailDrawer({ silent: true })
        })
        if (typeof ret === 'function') state.tail.unsubStopped = ret
      } catch { /* ignore */ }
    }

    // Insert the drawer row directly under its owner in the table.
    const drawerRow = document.createElement('tr')
    drawerRow.className = 'curva-model-tail-drawer-row'
    const drawerCell = document.createElement('td')
    drawerCell.colSpan = 9
    drawerCell.appendChild(drawer)
    drawerRow.appendChild(drawerCell)
    if (ownerRow && ownerRow.parentNode === modelsTbody) {
      ownerRow.parentNode.insertBefore(drawerRow, ownerRow.nextSibling)
    } else {
      modelsTbody.appendChild(drawerRow)
    }

    // Start the tail on the Bare worker side.
    try {
      const p = curva.models.tailLogs(modelId)
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          status.textContent = 'tail error: ' + safeMessage(err)
          // Server refused (SDK_UNAVAILABLE / ALREADY_TAILING / STREAM_UNAVAILABLE)
          closeTailDrawer({ silent: true })
        })
      }
    } catch (err) {
      status.textContent = 'tail error: ' + safeMessage(err)
      closeTailDrawer({ silent: true })
    }
  }

  function closeTailDrawer (opts = {}) {
    const modelId = state.tail.modelId
    if (!modelId) return
    // Best-effort stop on the Bare side. Fire-and-forget; the goodbye() handler
    // also stops every tail at shutdown.
    try {
      if (typeof curva?.models?.stopTail === 'function') {
        const p = curva.models.stopTail(modelId)
        if (p && typeof p.catch === 'function') p.catch(() => { /* noop */ })
      }
    } catch { /* noop */ }
    try { if (typeof state.tail.unsubLog === 'function') state.tail.unsubLog() } catch { /* noop */ }
    try { if (typeof state.tail.unsubStopped === 'function') state.tail.unsubStopped() } catch { /* noop */ }
    const drawer = state.tail.drawer
    if (drawer && drawer.parentNode) {
      // The drawer sits inside a <tr>. Remove the row.
      const row = drawer.parentNode.parentNode
      if (row && row.parentNode) row.parentNode.removeChild(row)
    }
    state.tail.modelId = null
    state.tail.drawer = null
    state.tail.logList = null
    state.tail.counterLabel = null
    state.tail.buffer = []
    state.tail.counters = {}
    state.tail.unsubLog = null
    state.tail.unsubStopped = null
    if (!opts.silent) status.textContent = 'tail stopped ' + modelId
  }

  function appendTailEntry (entry) {
    if (!entry || typeof entry !== 'object') return
    const level = typeof entry.level === 'string' ? entry.level.slice(0, 16) : 'info'
    const message = typeof entry.message === 'string' ? entry.message.slice(0, 2048) : ''
    const namespace = typeof entry.namespace === 'string' ? entry.namespace.slice(0, 64) : ''
    const timestamp = Number.isFinite(entry.timestamp) ? entry.timestamp
      : Number.isFinite(entry.ts) ? entry.ts
        : Date.now()
    const norm = { level, message, namespace, timestamp }
    state.tail.buffer.push(norm)
    while (state.tail.buffer.length > MAX_TAIL_LINES) state.tail.buffer.shift()
    if (!Number.isFinite(state.tail.counters[level])) state.tail.counters[level] = 0
    state.tail.counters[level] += 1
    updateCounterLabel()
    // Only append to the DOM when the entry passes the current filter — a
    // filter change re-renders the whole buffer.
    if (state.tail.levelFilter === 'all' || state.tail.levelFilter === level) {
      appendTailLi(norm)
      trimDomToBufferCap()
    }
  }

  function appendTailLi (entry) {
    if (!state.tail.logList) return
    const li = document.createElement('li')
    li.className = 'curva-diagnostics-tail-item curva-diagnostics-tail-item-' + entry.level.replace(/[^a-z0-9-]/gi, '')
    const ts = document.createElement('span'); ts.className = 'curva-tail-ts'
    ts.textContent = formatHms(entry.timestamp)
    const lv = document.createElement('span'); lv.className = 'curva-tail-level'
    lv.textContent = '[' + entry.level + ']'
    const ns = document.createElement('span'); ns.className = 'curva-tail-ns'
    ns.textContent = entry.namespace + ':'
    const msg = document.createElement('span'); msg.className = 'curva-tail-msg'
    // XSS discipline: peer model log messages are untrusted — textContent only.
    msg.textContent = entry.message
    li.appendChild(ts); li.appendChild(lv); li.appendChild(ns); li.appendChild(msg)
    state.tail.logList.appendChild(li)
  }

  function trimDomToBufferCap () {
    if (!state.tail.logList) return
    while (state.tail.logList.childElementCount > MAX_TAIL_LINES) {
      state.tail.logList.removeChild(state.tail.logList.firstElementChild)
    }
  }

  function rerenderTailBuffer () {
    if (!state.tail.logList) return
    state.tail.logList.textContent = ''
    for (const entry of state.tail.buffer) {
      if (state.tail.levelFilter === 'all' || state.tail.levelFilter === entry.level) {
        appendTailLi(entry)
      }
    }
  }

  function updateCounterLabel () {
    if (!state.tail.counterLabel) return
    const c = state.tail.counters
    const parts = []
    for (const lvl of ['error', 'warn', 'info', 'debug']) {
      if (c[lvl]) parts.push(lvl + ':' + c[lvl])
    }
    state.tail.counterLabel.textContent = parts.length > 0 ? parts.join(' · ') : ''
  }

  function formatHms (ts) {
    const d = new Date(ts)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    const ms = String(d.getMilliseconds()).padStart(3, '0')
    return hh + ':' + mm + ':' + ss + '.' + ms
  }

  function startModelsPolling () {
    if (state.modelsTimer) return
    refreshModels()
    state.modelsTimer = setInterval(refreshModels, MODEL_REFRESH_MS)
  }
  function stopModelsPolling () {
    if (state.modelsTimer) { clearInterval(state.modelsTimer); state.modelsTimer = null }
  }
  modelsRefreshBtn.addEventListener('click', () => refreshModels())

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

  // -- Report tab handlers (wave-final QVAC depth F2) --------------------
  async function generateReport () {
    if (state.destroyed || state.reportInFlight) return
    const bridge = curva?.diagnostics?.generateReport
    if (typeof bridge !== 'function') {
      reportSource.textContent = 'source: unavailable'
      reportEmpty.hidden = false
      reportEmpty.textContent = 'diagnostics report bridge not wired'
      reportPre.hidden = true
      return
    }
    state.reportInFlight = true
    genReportBtn.disabled = true
    genReportBtn.textContent = 'Generating...'
    reportSource.textContent = ''
    try {
      const json = await bridge()
      if (state.destroyed) return
      if (typeof json === 'string' && json.length > 0) {
        state.lastReportJson = json
        // XSS-safe: textContent only. The JSON body is a serialized report
        // and never rendered as HTML.
        reportPre.textContent = json
        reportPre.hidden = false
        reportEmpty.hidden = true
        copyReportBtn.disabled = false
        reportSource.textContent = 'source: @qvac/diagnostics'
      } else {
        state.lastReportJson = ''
        reportPre.textContent = ''
        reportPre.hidden = true
        reportEmpty.hidden = false
        reportEmpty.textContent = 'report unavailable (missing @qvac/diagnostics or feature disabled)'
        copyReportBtn.disabled = true
      }
    } catch (err) {
      reportSource.textContent = 'error: ' + safeMessage(err)
      reportEmpty.hidden = false
      reportEmpty.textContent = 'error: ' + safeMessage(err)
      reportPre.hidden = true
      copyReportBtn.disabled = true
    } finally {
      state.reportInFlight = false
      genReportBtn.disabled = false
      genReportBtn.textContent = 'Generate report'
    }
  }
  genReportBtn.addEventListener('click', () => generateReport())
  copyReportBtn.addEventListener('click', async () => {
    const text = state.lastReportJson || ''
    if (!text) return
    try {
      if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text)
      status.textContent = 'report copied ' + text.length + ' bytes'
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
    refreshModels,
    generateReport,
    selectTab,
    getState () {
      return {
        tab: state.tab,
        logs: state.logs.slice(),
        lastMetricsText: state.lastMetricsText,
        lastReportJson: state.lastReportJson,
        lastLogPerModel: Object.fromEntries(state.lastLogPerModel)
      }
    },
    appendLogLine, // exported for tests
    renderModels,  // exported for tests
    destroy () {
      if (state.destroyed) return
      state.destroyed = true
      stopPolling()
      stopModelsPolling()
      if (state.tail.modelId) {
        try { closeTailDrawer({ silent: true }) } catch { /* noop */ }
      }
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
