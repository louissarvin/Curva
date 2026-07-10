// Curva observability seam: wraps hypertrace + hypertrace-prometheus so the
// Pears primitives (Hyperswarm, Autobase, Corestore, Blind-Peering) and our
// own room/commentator classes report structured trace counts to a
// Prometheus exporter on http://localhost:4343/metrics.
//
// Wave 3 deepening (F1): adds gauge families sourced from hypercore-stats,
// hyperswarm-stats, and hyperdht-stats. These packages read counters that
// live INSIDE the primitives (replicator rx/tx, DHT punches, swarm connect
// attempts) and expose them via a `.registerPrometheusMetrics(promClient)`
// method that installs `new promClient.Gauge({ collect() {...} })` on the
// DEFAULT prom-client registry. To keep everything on one /metrics
// response, we pass `register: promClient.register` to the
// hypertrace-prometheus factory so trace_counter also lands on the default
// registry — otherwise the stats gauges and trace_counter would live in two
// disjoint Registry instances and /metrics would show only one.
//
// Docs-verification memo -----------------------------------------------------
//
// URLs consulted:
//   https://github.com/holepunchto/hypertrace                 (README, fetched 2026-07-10)
//   https://github.com/holepunchto/hypertrace-prometheus      (README, fetched 2026-07-10)
//   https://github.com/holepunchto/hypercore-stats            (README, fetched 2026-07-10)
//   https://github.com/holepunchto/hyperswarm-stats           (README, fetched 2026-07-10)
//   https://github.com/holepunchto/hyperdht-stats             (README, fetched 2026-07-10)
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
//   hypercore-stats (node_modules/hypercore-stats/index.js:492-507, 253-489):
//     HypercoreStats.fromCorestore(store) → HypercoreStats
//     hs.registerPrometheusMetrics(promClient) → installs hypercore_* gauges
//     Uses PassiveWatcher(store) so it does not hold strong refs — safe to
//     leave running for the process lifetime. Emits `internal-error` on the
//     stats instance if a watched core fails to open; we listen and log at
//     debug level.
//
//   hyperdht-stats (node_modules/hyperdht-stats/index.js:1-575):
//     new HyperDhtStats(dht).registerPrometheusMetrics(promClient) installs
//     dht_*, udx_* gauges.
//
//   hyperswarm-stats (node_modules/hyperswarm-stats/index.js:1-289):
//     new HyperswarmStats(swarm).registerPrometheusMetrics(promClient)
//     ALSO registers the underlying HyperDhtStats — so registering both
//     Swarm+Dht separately would double-register dht_* gauges and prom-client
//     throws. We guard against this by tracking which gauges are already
//     installed on the shared prom-client register.
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

// prom-client is a peer dep of hypertrace-prometheus. We load it directly so
// stats packages (hypercore-stats, hyperswarm-stats, hyperdht-stats) can
// install their gauges on the SAME default registry that hypertrace-prometheus
// scrapes. If prom-client is missing the whole subsystem degrades to no-op.
let _promClientMod = null
let _promClientLoadError = null
function loadPromClient () {
  if (_promClientMod) return _promClientMod
  if (_promClientLoadError) return null
  try {
    _promClientMod = require('prom-client')
    return _promClientMod
  } catch (err) {
    _promClientLoadError = err
    return null
  }
}

function loadStatsPackage (name) {
  try { return require(name) } catch { return null }
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
 *   corestore?: object,   // optional: enables hypercore_* gauges
 *   swarm?: object,       // optional: enables hyperswarm_* + dht_* gauges
 *   dht?: object,         // optional: enables dht_* gauges (skip if swarm is passed)
 *   logger?: {info?:Function, warn?:Function, error?:Function}
 * }} [opts]
 * @returns {{
 *   started: boolean,
 *   port: number|null,
 *   reason?: string,
 *   metrics?: () => Promise<string>,
 *   statsRegistered?: { hypercore: boolean, swarm: boolean, dht: boolean },
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
  //
  // F1 Wave 3: we also pass an explicit `register` so it matches the default
  // prom-client register that the stats packages use. Without this,
  // trace_counter would land on a fresh Registry while hypercore/swarm/dht
  // gauges land on prom-client.register — and only one set would appear on
  // /metrics. Falls back to a new Registry if prom-client is not installed.
  const promClient = loadPromClient()
  const sharedRegister = promClient ? promClient.register : null
  let traceFn
  try {
    traceFn = hp({
      // Deliberately omit port so hp does not open a socket.
      register: sharedRegister || undefined,
      allowedProps: Array.isArray(opts.allowedProps) && opts.allowedProps.length > 0
        ? opts.allowedProps
        : ['name'],
      collectDefaults: opts.collectDefaults !== false
    })
  } catch (err) {
    log.error('Prometheus exporter factory failed', { message: err?.message || String(err) })
    return makeNoopPrometheusHandle('start-failed:' + (err?.message || 'unknown'))
  }

  // F1 Wave 3: register hypercore/swarm/dht stats gauges on the shared
  // default registry so they show up in the same /metrics response. Only
  // attempts registration when the caller passed the primitive AND
  // prom-client is available. Any single package missing or failing does not
  // block the exporter from coming up.
  const statsRegistered = { hypercore: false, swarm: false, dht: false }
  if (promClient) {
    if (opts.corestore) {
      try {
        const HypercoreStats = loadStatsPackage('hypercore-stats')
        if (HypercoreStats && typeof HypercoreStats.fromCorestore === 'function') {
          const hs = HypercoreStats.fromCorestore(opts.corestore)
          // Debug channel for oncoreopen errors — do not throw upward.
          try { hs.on('internal-error', (e) => log.warn('hypercore-stats internal-error', { message: e?.message })) } catch {}
          hs.registerPrometheusMetrics(promClient)
          statsRegistered.hypercore = true
        }
      } catch (err) {
        log.warn('hypercore-stats registration failed', { message: err?.message || String(err) })
      }
    }
    if (opts.swarm) {
      try {
        const HyperswarmStats = loadStatsPackage('hyperswarm-stats')
        if (HyperswarmStats) {
          const ss = new HyperswarmStats(opts.swarm)
          ss.registerPrometheusMetrics(promClient)
          statsRegistered.swarm = true
          // HyperswarmStats internally registers HyperDhtStats too. Skip the
          // separate dht registration below to avoid the prom-client
          // "already registered" throw on dht_* gauges.
          statsRegistered.dht = true
        }
      } catch (err) {
        log.warn('hyperswarm-stats registration failed', { message: err?.message || String(err) })
      }
    }
    if (opts.dht && !statsRegistered.dht) {
      try {
        const HyperDhtStats = loadStatsPackage('hyperdht-stats')
        if (HyperDhtStats) {
          const ds = new HyperDhtStats(opts.dht)
          ds.registerPrometheusMetrics(promClient)
          statsRegistered.dht = true
        }
      } catch (err) {
        log.warn('hyperdht-stats registration failed', { message: err?.message || String(err) })
      }
    }
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
    statsRegistered,
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

// -----------------------------------------------------------------------------
// F1 Wave 3: standalone stats registration helpers.
//
// These are exposed for callers that already have a running Prometheus
// exporter and just want to attach one more stats family (e.g. tests, or a
// boot path where the corestore is created after startPrometheus was called).
// All three are no-ops when:
//   - the observability flag is off
//   - prom-client is not installed
//   - the specific stats package is not installed
//   - the target primitive is missing or already registered on the shared
//     registry (prom-client throws on duplicate metric name)
// -----------------------------------------------------------------------------

function _statsAlreadyRegistered (promClient, probeName) {
  try {
    // getSingleMetric throws for unknown metrics on older prom-client; catch
    // any surprise and treat as "not yet registered".
    return typeof promClient.register.getSingleMetric === 'function' &&
      promClient.register.getSingleMetric(probeName) !== undefined
  } catch { return false }
}

/**
 * Attach hypercore_* gauges to the default prom-client registry. Safe to
 * call multiple times per process — returns `{registered:false, reason}` if
 * a previous call already installed the gauges.
 * @param {object} corestore
 * @param {{logger?:object}} [opts]
 */
function registerHypercoreStats (corestore, opts = {}) {
  const log = normalizeLogger(opts.logger)
  if (!observabilityEnabled()) return { registered: false, reason: 'flag-off' }
  const promClient = loadPromClient()
  if (!promClient) return { registered: false, reason: 'prom-client-missing' }
  if (!corestore || typeof corestore !== 'object') return { registered: false, reason: 'no-corestore' }
  if (_statsAlreadyRegistered(promClient, 'hypercore_total_cores')) {
    return { registered: false, reason: 'already-registered' }
  }
  const HypercoreStats = loadStatsPackage('hypercore-stats')
  if (!HypercoreStats || typeof HypercoreStats.fromCorestore !== 'function') {
    return { registered: false, reason: 'hypercore-stats-missing' }
  }
  try {
    const hs = HypercoreStats.fromCorestore(corestore)
    try { hs.on('internal-error', (e) => log.warn('hypercore-stats internal-error', { message: e?.message })) } catch {}
    hs.registerPrometheusMetrics(promClient)
    return { registered: true, stats: hs }
  } catch (err) {
    log.warn('registerHypercoreStats failed', { message: err?.message || String(err) })
    return { registered: false, reason: 'threw:' + (err?.message || 'unknown') }
  }
}

/**
 * Attach hyperswarm_* AND dht_* AND udx_* gauges to the default prom-client
 * registry. HyperswarmStats internally instantiates HyperDhtStats, so this
 * covers the DHT surface too — do not also call `registerHyperdhtStats` on
 * the same swarm.dht or prom-client will throw on duplicate metric names.
 * @param {object} swarm
 * @param {{logger?:object}} [opts]
 */
function registerHyperswarmStats (swarm, opts = {}) {
  const log = normalizeLogger(opts.logger)
  if (!observabilityEnabled()) return { registered: false, reason: 'flag-off' }
  const promClient = loadPromClient()
  if (!promClient) return { registered: false, reason: 'prom-client-missing' }
  if (!swarm || typeof swarm !== 'object') return { registered: false, reason: 'no-swarm' }
  if (_statsAlreadyRegistered(promClient, 'hyperswarm_nr_peers')) {
    return { registered: false, reason: 'already-registered' }
  }
  const HyperswarmStats = loadStatsPackage('hyperswarm-stats')
  if (!HyperswarmStats) return { registered: false, reason: 'hyperswarm-stats-missing' }
  try {
    const ss = new HyperswarmStats(swarm)
    ss.registerPrometheusMetrics(promClient)
    return { registered: true, stats: ss }
  } catch (err) {
    log.warn('registerHyperswarmStats failed', { message: err?.message || String(err) })
    return { registered: false, reason: 'threw:' + (err?.message || 'unknown') }
  }
}

/**
 * Attach dht_* + udx_* gauges to the default prom-client registry.
 * Do NOT call after `registerHyperswarmStats(swarm)` where swarm.dht === dht —
 * the swarm registration already installs the DHT gauges.
 * @param {object} dht
 * @param {{logger?:object}} [opts]
 */
function registerHyperdhtStats (dht, opts = {}) {
  const log = normalizeLogger(opts.logger)
  if (!observabilityEnabled()) return { registered: false, reason: 'flag-off' }
  const promClient = loadPromClient()
  if (!promClient) return { registered: false, reason: 'prom-client-missing' }
  if (!dht || typeof dht !== 'object') return { registered: false, reason: 'no-dht' }
  if (_statsAlreadyRegistered(promClient, 'dht_consistent_punches')) {
    return { registered: false, reason: 'already-registered' }
  }
  const HyperDhtStats = loadStatsPackage('hyperdht-stats')
  if (!HyperDhtStats) return { registered: false, reason: 'hyperdht-stats-missing' }
  try {
    const ds = new HyperDhtStats(dht)
    ds.registerPrometheusMetrics(promClient)
    return { registered: true, stats: ds }
  } catch (err) {
    log.warn('registerHyperdhtStats failed', { message: err?.message || String(err) })
    return { registered: false, reason: 'threw:' + (err?.message || 'unknown') }
  }
}

// -----------------------------------------------------------------------------
// Wave 4 F2: Live Models panel helpers.
//
// The DiagnosticsPanel Models tab needs two things:
//   1. A snapshot of every known model (catalog + loaded) with cache/size/type
//      info so the tab can render a table.
//   2. A rolling log ring keyed by model id so the panel can show the last N
//      log lines emitted by each addon (llama.cpp stderr, whisper, etc.).
//
// Verified against installed .d.ts:
//   node_modules/@qvac/sdk/dist/client/api/get-model-info.d.ts:10-42
//     getModelInfo({name}) => Promise<{name, modelId, expectedSize,
//     sha256Checksum, addon, isCached, isLoaded, cacheFiles[], loadedInstances?}>
//   node_modules/@qvac/sdk/dist/client/api/get-loaded-model-info.d.ts:24
//     getLoadedModelInfo({modelId}) => Promise<LoadedModelInfo>
//     (throws ModelNotFoundError for unknown ids)
//   node_modules/@qvac/sdk/dist/client/api/subscribe-logs.d.ts:27
//     subscribeServerLogs(handler) => () => void   (unsubscribe)
//     handler receives {level, id, namespace, message}. `id` is either the
//     SDK_LOG_ID sentinel, a model id, or a RAG workspace key.
//
// Both helpers are no-ops when sdk lacks the required APIs so they can be
// wired into boot paths that may or may not have the qvac SDK available.
// -----------------------------------------------------------------------------

const DEFAULT_MODEL_LOG_RING_SIZE = 100

/**
 * Take a snapshot of every model the SDK knows about, enriched with the
 * loaded-instance info for the ones currently in memory.
 *
 * Never throws. Returns `[]` when the SDK cannot answer. Individual
 * per-model errors are logged into the entry as `.error` so the panel can
 * render "unavailable" without dropping the row.
 *
 * @param {object} sdk    an object exposing `getModelInfo` / `getLoadedModelInfo`
 * @param {{
 *   allNames?: string[],       // catalog names to query — required, no auto-discovery
 *   logger?: object
 * }} [opts]
 * @returns {Promise<Array<object>>}
 */
async function getModelSnapshot (sdk, opts = {}) {
  const log = normalizeLogger(opts.logger)
  if (!sdk || typeof sdk.getModelInfo !== 'function') return []
  const names = Array.isArray(opts.allNames) ? opts.allNames.filter((n) => typeof n === 'string' && n.length > 0 && n.length < 128) : []
  if (names.length === 0) return []
  const out = []
  for (const name of names) {
    let info
    try {
      info = await sdk.getModelInfo({ name })
    } catch (err) {
      log.warn('getModelInfo failed', { name, message: err?.message || String(err) })
      out.push({ name, error: err?.message || 'unknown', isCached: false, isLoaded: false, cacheFiles: [] })
      continue
    }
    if (!info || typeof info !== 'object') {
      out.push({ name, error: 'no-info', isCached: false, isLoaded: false, cacheFiles: [] })
      continue
    }
    // Merge in loaded-instance metadata only when the model is actually loaded
    // AND the SDK exposes getLoadedModelInfo. This surfaces isDelegated and
    // handlers[] on the row so the panel can show "delegated" badges.
    let loaded = null
    if (info.isLoaded && typeof sdk.getLoadedModelInfo === 'function' && info.modelId) {
      try {
        loaded = await sdk.getLoadedModelInfo({ modelId: info.modelId })
      } catch (err) {
        // ModelNotFoundError is expected if the model was unloaded between
        // the two RPCs — treat as "not loaded" rather than a hard error.
        log.warn('getLoadedModelInfo failed', { modelId: info.modelId, message: err?.message || String(err) })
        loaded = null
      }
    }
    out.push(mergeSnapshotEntry(info, loaded))
  }
  return out
}

function mergeSnapshotEntry (info, loaded) {
  // Sum cache file sizes for the "size on disk" column. Prefer actualSize when
  // present; fall back to expectedSize.
  let sizeBytes = 0
  const cacheFiles = Array.isArray(info.cacheFiles) ? info.cacheFiles : []
  for (const cf of cacheFiles) {
    if (!cf) continue
    if (Number.isFinite(cf.actualSize)) sizeBytes += cf.actualSize
    else if (Number.isFinite(cf.expectedSize)) sizeBytes += cf.expectedSize
  }
  return {
    name: info.name,
    modelId: info.modelId,
    addon: info.addon,
    isCached: !!info.isCached,
    isLoaded: !!info.isLoaded,
    sizeBytes,
    expectedSize: Number.isFinite(info.expectedSize) ? info.expectedSize : null,
    actualSize: Number.isFinite(info.actualSize) ? info.actualSize : null,
    cachedAt: info.cachedAt || null,
    cacheFiles: cacheFiles.map((cf) => ({
      filename: cf?.filename || '',
      isCached: !!cf?.isCached,
      expectedSize: Number.isFinite(cf?.expectedSize) ? cf.expectedSize : null,
      actualSize: Number.isFinite(cf?.actualSize) ? cf.actualSize : null
    })),
    loadedInstances: Array.isArray(info.loadedInstances) ? info.loadedInstances.length : 0,
    // From getLoadedModelInfo (only present when loaded)
    handlers: loaded?.handlers && Array.isArray(loaded.handlers) ? loaded.handlers.slice(0, 32) : [],
    isDelegated: !!loaded?.isDelegated,
    providerPubkey: loaded?.providerInfo?.publicKey || loaded?.providerInfo?.pubkey || null
  }
}

/**
 * Start a per-model log ring buffer backed by `subscribeServerLogs`. Keeps up
 * to `maxPerId` log entries per `log.id` so the Models panel can render the
 * last N lines for a selected model.
 *
 * @param {object} sdk                              qvac sdk-shaped module
 * @param {{
 *   maxPerId?: number,
 *   onLog?: (entry: object) => void
 * }} [opts]
 * @returns {{
 *   get: (id: string) => Array<object>,
 *   all: () => Object<string, Array<object>>,
 *   unsubscribe: () => void
 * }}
 */
function startModelLogRing (sdk, opts = {}) {
  const maxPerId = Number.isFinite(opts.maxPerId) && opts.maxPerId > 0
    ? Math.floor(opts.maxPerId)
    : DEFAULT_MODEL_LOG_RING_SIZE
  const buffers = new Map() // id -> array
  let unsub = () => {}
  if (!sdk || typeof sdk.subscribeServerLogs !== 'function') {
    return {
      get: () => [],
      all: () => ({}),
      unsubscribe: () => {}
    }
  }
  try {
    const ret = sdk.subscribeServerLogs((log) => {
      try {
        const entry = normalizeModelLogEntry(log)
        if (!entry) return
        const id = entry.id || '__unknown__'
        let arr = buffers.get(id)
        if (!arr) {
          arr = []
          buffers.set(id, arr)
        }
        arr.push(entry)
        // Ring: drop oldest once we exceed cap.
        while (arr.length > maxPerId) arr.shift()
        if (typeof opts.onLog === 'function') {
          try { opts.onLog(entry) } catch { /* swallow — must not break the stream */ }
        }
      } catch { /* one bad log line must not break the whole stream */ }
    })
    if (typeof ret === 'function') unsub = ret
  } catch {
    // subscribe failed at construction — return an inert ring
    return {
      get: () => [],
      all: () => ({}),
      unsubscribe: () => {}
    }
  }
  let stopped = false
  return {
    get (id) {
      const arr = buffers.get(id)
      return arr ? arr.slice() : []
    },
    all () {
      const out = {}
      for (const [id, arr] of buffers.entries()) out[id] = arr.slice()
      return out
    },
    unsubscribe () {
      if (stopped) return
      stopped = true
      try { unsub() } catch { /* noop */ }
      buffers.clear()
    }
  }
}

/**
 * Normalize a server-log entry from the SDK stream into the shape the
 * DiagnosticsPanel expects. Rejects entries with no `id` (cannot key the ring)
 * and clips oversized messages to 2 KB so a runaway model addon cannot
 * exhaust renderer memory via the ring buffer.
 */
function normalizeModelLogEntry (log) {
  if (!log || typeof log !== 'object') return null
  const id = typeof log.id === 'string' ? log.id.slice(0, 128) : null
  if (!id) return null
  const message = typeof log.message === 'string' ? log.message
    : typeof log.text === 'string' ? log.text
      : typeof log.msg === 'string' ? log.msg : ''
  if (!message) return null
  return {
    ts: Number.isFinite(log.ts) ? log.ts : Date.now(),
    id,
    level: typeof log.level === 'string' ? log.level.slice(0, 16) : 'info',
    namespace: typeof log.namespace === 'string' ? log.namespace.slice(0, 64) : '',
    message: message.slice(0, 2048)
  }
}

function makeNoopPrometheusHandle (reason) {
  return {
    started: false,
    stopped: true,
    port: null,
    reason,
    statsRegistered: { hypercore: false, swarm: false, dht: false },
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
  registerHypercoreStats,
  registerHyperswarmStats,
  registerHyperdhtStats,
  // Wave 4 F2 exports
  getModelSnapshot,
  startModelLogRing,
  DEFAULT_MODEL_LOG_RING_SIZE,
  _internal: { normalizeModelLogEntry, mergeSnapshotEntry },
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
    _promClientMod = null
    _promClientLoadError = null
    // Clear the shared prom-client default registry so the stats packages can
    // be re-registered by the next test without prom-client throwing on
    // duplicate metric names. Guarded — if prom-client is not installed this
    // is a no-op.
    try {
      const promClient = require('prom-client')
      promClient.register.clear()
    } catch { /* ignore */ }
  }
}
