// Curva observability seam: wraps hypertrace + hypertrace-prometheus so the
// Pears primitives (Hyperswarm, Autobase, Corestore, Blind-Peering) and our
// own room/commentator classes report structured trace counts to a
// Prometheus exporter on http://localhost:4343/metrics.
//
// Docs-verification memo -----------------------------------------------------
//
// URLs consulted:
//   https://github.com/holepunchto/hypertrace                 (README, fetched 2026-07-10)
//   https://github.com/holepunchto/hypertrace-prometheus      (README, fetched 2026-07-10)
//   https://docs.pears.com/reference/building-blocks/         (observability section, fetched 2026-07-10)
//   https://docs.qvac.tether.io/ai-capabilities/text-generation/  (thinkingDelta / captureThinking, fetched 2026-07-10)
//
// Installed API surface (authoritative, versions in pear-app/package.json):
//   hypertrace@1.4.2 (node_modules/hypertrace/index.js:107-121):
//     module.exports = { setTraceFunction, clearTraceFunction, createTracer(ctx, {parent?, props?}) }
//     createTracer returns a Hypertrace instance whose only public methods are
//     .trace(id?, props?) and .setParent(parentTracer). When no trace function
//     is registered globally, createTracer returns a shared no-op instance
//     (near-zero overhead per the README).
//
//   hypertrace-prometheus@1.0.0 (node_modules/hypertrace-prometheus/index.js:6):
//     module.exports = ({ port, register?, allowedProps?, collectDefaults? }) => traceFunction
//     - CALLED AS A FUNCTION, NOT `new`. Some third-party gists show `new
//       HypertracePrometheus(...)` — that is wrong for v1.0.0 (installed).
//     - The returned traceFunction has:
//         .stop()    async, closes HTTP server + removes trace_counter metric
//         .metrics() returns a Promise<string> of the current registry
//     - The server is started synchronously inside the constructor when
//       `port` is set. There is NO separate `await prom.start()` step.
//
// Feature flags (both must be `true` to enable):
//   CURVA_OBSERVABILITY_ENABLED=true   turn on the whole subsystem
//   CURVA_PROMETHEUS_PORT=4343         override the exporter port (default 4343)
//
// Design invariants ---------------------------------------------------------
//   1. Robust to missing packages: if require('hypertrace') throws (e.g. in a
//      minimal Bare bundle), installTracer() returns a no-op tracer and
//      startPrometheus() returns a no-op handle. Nothing throws upward.
//   2. Prometheus start is idempotent: calling startPrometheus() twice with
//      the same options resolves to the same handle.
//   3. Graceful teardown: stop() shuts the HTTP server AND clears the global
//      trace function so subsequent createTracer() calls become no-ops.
//   4. No PII in labels: allowedProps whitelist is explicit (`name` only).
//      Trace IDs are short opaque strings ('registered', 'apply', ...).

const DEFAULT_PROMETHEUS_PORT = 4343

// Sentinel tracer used everywhere the real hypertrace module is not present
// OR when the feature flag is off. Same shape as a real Hypertrace instance so
// callers can .trace() unconditionally.
const NOOP_TRACER = Object.freeze({
  enabled: false,
  className: 'NoopTracer',
  objectId: 0,
  props: null,
  trace () {},
  setParent () {}
})

// Cached lazy load. Wrapped in try/catch so a broken/missing package never
// takes down room boot. We re-throw only for programming errors caught at
// dev time (bad opts shape); anything from require() is swallowed and logged
// via the injected logger.
let _hypertraceMod = null
let _hypertraceLoadError = null
function loadHypertrace () {
  if (_hypertraceMod) return _hypertraceMod
  if (_hypertraceLoadError) return null
  try {
    _hypertraceMod = require('hypertrace')
    return _hypertraceMod
  } catch (err) {
    _hypertraceLoadError = err
    return null
  }
}

let _hypertracePromMod = null
let _hypertracePromLoadError = null
function loadHypertracePrometheus () {
  if (_hypertracePromMod) return _hypertracePromMod
  if (_hypertracePromLoadError) return null
  try {
    _hypertracePromMod = require('hypertrace-prometheus')
    return _hypertracePromMod
  } catch (err) {
    _hypertracePromLoadError = err
    return null
  }
}

/**
 * Read the observability feature flag. Only `"true"` (case-insensitive)
 * enables. Any other value, or an unset env, disables. Never throws.
 */
function observabilityEnabled () {
  try {
    if (typeof process === 'undefined' || !process.env) return false
    return String(process.env.CURVA_OBSERVABILITY_ENABLED || '').toLowerCase() === 'true'
  } catch { return false }
}

/**
 * Read the Prometheus exporter port from env, clamped to a valid TCP range.
 * Returns DEFAULT_PROMETHEUS_PORT (4343) when unset or invalid so misconfigs
 * do not silently bind a random privileged port.
 */
function prometheusPort () {
  try {
    const raw = (typeof process !== 'undefined' && process.env && process.env.CURVA_PROMETHEUS_PORT) || ''
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 1 || n > 65535) return DEFAULT_PROMETHEUS_PORT
    return Math.floor(n)
  } catch { return DEFAULT_PROMETHEUS_PORT }
}

/**
 * Install a tracer on `target`. Returns a tracer with `.trace(id, props)`.
 * When observability is disabled or hypertrace is not installed, returns
 * NOOP_TRACER whose .trace() is a fast no-op.
 *
 * @param {object} target                     the instance being instrumented
 * @param {{ name?: string, parent?: object, props?: object }} [opts]
 * @returns {{ trace: Function, setParent?: Function, enabled?: boolean }}
 */
function installTracer (target, opts = {}) {
  if (!target || typeof target !== 'object') return NOOP_TRACER
  if (!observabilityEnabled()) return NOOP_TRACER
  const mod = loadHypertrace()
  if (!mod || typeof mod.createTracer !== 'function') return NOOP_TRACER

  const props = {}
  if (typeof opts.name === 'string' && opts.name.length > 0) {
    // Trim to keep label cardinality bounded; Prometheus labels should never
    // carry arbitrary user input.
    props.name = opts.name.slice(0, 64)
  }
  if (opts.props && typeof opts.props === 'object') {
    for (const [k, v] of Object.entries(opts.props)) {
      if (typeof k !== 'string' || k.length === 0 || k.length > 32) continue
      if (typeof v === 'string' && v.length <= 64) props[k] = v
      else if (typeof v === 'number' && Number.isFinite(v)) props[k] = v
    }
  }

  try {
    const t = mod.createTracer(target, {
      parent: opts.parent && opts.parent.enabled !== false ? opts.parent : undefined,
      props: Object.keys(props).length > 0 ? props : undefined
    })
    return t || NOOP_TRACER
  } catch {
    return NOOP_TRACER
  }
}

// Idempotency: cache the prometheus handle keyed by port so a second call
// from a second boot path (rare, but possible in the room-init retry loop)
// reuses the running server instead of colliding on EADDRINUSE.
const _prometheusHandles = new Map() // port -> handle

/**
 * Start the Prometheus exporter and wire it as the global hypertrace trace
 * function. Idempotent: subsequent calls with the same port return the same
 * handle without restarting.
 *
 * @param {{
 *   port?: number,
 *   allowedProps?: string[],
 *   collectDefaults?: boolean,
 *   logger?: {info?:Function, warn?:Function, error?:Function}
 * }} [opts]
 * @returns {{
 *   started: boolean,
 *   port: number|null,
 *   reason?: string,
 *   metrics?: () => Promise<string>,
 *   stop: () => Promise<void>
 * }}
 */
async function startPrometheus (opts = {}) {
  const log = normalizeLogger(opts.logger)

  if (!observabilityEnabled()) {
    log.info('observability disabled (flag off); Prometheus exporter not started')
    return makeNoopPrometheusHandle('flag-off')
  }
  const hp = loadHypertracePrometheus()
  const ht = loadHypertrace()
  if (!hp || !ht) {
    log.warn('hypertrace(-prometheus) not installed; Prometheus exporter no-op')
    return makeNoopPrometheusHandle('module-missing')
  }

  const port = Number.isFinite(opts.port) ? Math.floor(opts.port) : prometheusPort()
  const cached = _prometheusHandles.get(port)
  if (cached && !cached.stopped) return cached

  // Security audit fix (C1): hypertrace-prometheus at ^1.0.0 binds server via
  // http.createServer(...).listen(port) with no host argument, which defaults
  // to 0.0.0.0 in Node/Bare — that exposes /metrics to the entire LAN. We
  // instead call the factory WITHOUT `port` (skip its listen()), then start
  // our own http server explicitly bound to 127.0.0.1 that serves the same
  // metrics via traceFn.metrics(). Verified against installed source at
  // node_modules/hypertrace-prometheus/index.js:37-47.
  let traceFn
  try {
    traceFn = hp({
      // Deliberately omit port so hp does not open a socket.
      allowedProps: Array.isArray(opts.allowedProps) && opts.allowedProps.length > 0
        ? opts.allowedProps
        : ['name'],
      collectDefaults: opts.collectDefaults !== false
    })
  } catch (err) {
    log.error('Prometheus exporter factory failed', { message: err?.message || String(err) })
    return makeNoopPrometheusHandle('start-failed:' + (err?.message || 'unknown'))
  }

  // Start a loopback-only HTTP server. This mirrors the upstream server's
  // behavior (200 on GET /metrics with register.contentType, empty end on
  // anything else) but binds to 127.0.0.1 so LAN peers cannot scrape the
  // exporter. Callers can pass skipListen:true to skip the actual bind — used
  // by unit tests so they don't grab a real port.
  let localServer = null
  if (opts.skipListen !== true) {
    try {
      const http = require('http')
      localServer = http.createServer(async (req, res) => {
        try {
          if (req.method !== 'GET' || req.url !== '/metrics') {
            res.statusCode = 404
            return res.end()
          }
          const body = await traceFn.metrics()
          res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
          res.end(body)
        } catch (err) {
          try { res.statusCode = 500; res.end() } catch {}
        }
      })
      await new Promise((resolve, reject) => {
        const onErr = (err) => reject(err)
        localServer.once('error', onErr)
        localServer.listen(port, '127.0.0.1', () => {
          localServer.off('error', onErr)
          resolve()
        })
      })
    } catch (err) {
      log.error('Prometheus loopback HTTP server failed to listen', { port, message: err?.message || String(err) })
      try { localServer && localServer.close() } catch {}
      return makeNoopPrometheusHandle('listen-failed:' + (err?.message || 'unknown'))
    }
  }

  try {
    ht.setTraceFunction(traceFn)
  } catch (err) {
    log.warn('setTraceFunction threw', { message: err?.message })
  }

  log.info('Prometheus exporter listening on loopback', { url: 'http://127.0.0.1:' + port + '/metrics' })

  const handle = {
    started: true,
    stopped: false,
    port,
    metrics: () => {
      try { return traceFn.metrics() } catch { return Promise.resolve('') }
    },
    async stop () {
      if (handle.stopped) return
      handle.stopped = true
      try {
        if (typeof ht.clearTraceFunction === 'function') ht.clearTraceFunction()
      } catch {}
      if (localServer) {
        try { await new Promise((r) => localServer.close(() => r())) } catch {}
      }
      try {
        if (typeof traceFn.stop === 'function') await traceFn.stop()
      } catch (err) {
        log.warn('Prometheus stop threw', { message: err?.message })
      }
      _prometheusHandles.delete(port)
    }
  }
  _prometheusHandles.set(port, handle)
  return handle
}

/**
 * Bridge @qvac/sdk server-log stream into the diagnostics tab. QVAC SDK
 * exposes `subscribeServerLogs(cb)` which fires for every server-side log
 * line (llama.cpp stderr, model-load progress, etc.). Wave 14 already wired
 * this into translate.js; this helper exposes the same seam so the
 * DiagnosticsPanel can render a unified log tail.
 *
 * @param {object} sdkImpl      any object with .subscribeServerLogs(fn)
 * @param {(entry: {ts:number, level:string, message:string}) => void} onLine
 * @returns {() => void}        unsubscribe (idempotent no-op if unavailable)
 */
function subscribeToServerLogs (sdkImpl, onLine) {
  if (!sdkImpl || typeof sdkImpl.subscribeServerLogs !== 'function') return () => {}
  if (typeof onLine !== 'function') return () => {}
  let unsub = null
  try {
    const ret = sdkImpl.subscribeServerLogs((log) => {
      try {
        const entry = normalizeServerLogEntry(log)
        if (entry) onLine(entry)
      } catch { /* per-line failures are swallowed; the stream keeps flowing */ }
    })
    if (typeof ret === 'function') unsub = ret
  } catch {
    return () => {}
  }
  return () => {
    if (unsub) {
      try { unsub() } catch { /* ignore */ }
      unsub = null
    }
  }
}

function normalizeServerLogEntry (log) {
  if (!log) return null
  if (typeof log === 'string') return { ts: Date.now(), level: 'info', message: log.slice(0, 2048) }
  if (typeof log !== 'object') return null
  const message = typeof log.message === 'string' ? log.message
    : typeof log.text === 'string' ? log.text
      : typeof log.msg === 'string' ? log.msg : ''
  if (!message) return null
  const level = typeof log.level === 'string' ? log.level.slice(0, 16) : 'info'
  const ts = Number.isFinite(log.ts) ? log.ts
    : Number.isFinite(log.timestamp) ? log.timestamp
      : Date.now()
  return { ts, level, message: message.slice(0, 2048) }
}

function makeNoopPrometheusHandle (reason) {
  return {
    started: false,
    stopped: true,
    port: null,
    reason,
    metrics: () => Promise.resolve(''),
    async stop () {}
  }
}

function normalizeLogger (logger) {
  const noop = () => {}
  if (!logger) return { info: noop, warn: noop, error: noop }
  return {
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : noop,
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : noop,
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : noop
  }
}

module.exports = {
  installTracer,
  startPrometheus,
  subscribeToServerLogs,
  observabilityEnabled,
  prometheusPort,
  NOOP_TRACER,
  DEFAULT_PROMETHEUS_PORT,
  // Test-only reset. Clears cached modules + handle map so unit tests can
  // swap require caches or re-run startPrometheus without leaking state.
  _resetForTest () {
    for (const h of _prometheusHandles.values()) {
      try { h.stop() } catch {}
    }
    _prometheusHandles.clear()
    _hypertraceMod = null
    _hypertracePromMod = null
    _hypertraceLoadError = null
    _hypertracePromLoadError = null
  }
}
