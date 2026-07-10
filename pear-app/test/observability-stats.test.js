// F1 Wave 3 observability-stats tests.
//
// We do NOT open a real HTTP port; we do NOT build a real corestore/DHT/swarm.
// Instead, hypercore-stats, hyperswarm-stats, hyperdht-stats, prom-client, and
// hypertrace-prometheus are all replaced via require.cache with lightweight
// fakes that record how our observability module invokes them.
//
// The intent is behavioural: does our seam call `.registerPrometheusMetrics`
// on the right module for the right primitive, is the shared prom-client
// registry actually shared, and are the "already registered" and
// "package missing" branches correctly no-op'd?
//
// Verified against installed source at
//   node_modules/hypercore-stats/index.js:492-507 (fromCorestore)
//   node_modules/hyperswarm-stats/index.js:1-30  (constructor)
//   node_modules/hyperdht-stats/index.js:1-20    (constructor)
//   node_modules/hypertrace-prometheus/index.js:6-47 (factory + register opt)

const test = require('brittle')

const HYPERTRACE_PATH = require.resolve('hypertrace')
const HYPERTRACE_PROM_PATH = require.resolve('hypertrace-prometheus')
const HYPERCORE_STATS_PATH = require.resolve('hypercore-stats')
const HYPERSWARM_STATS_PATH = require.resolve('hyperswarm-stats')
const HYPERDHT_STATS_PATH = require.resolve('hyperdht-stats')
const PROM_CLIENT_PATH = require.resolve('prom-client')
const OBSERVABILITY_PATH = require.resolve('../bare/observability.js')

// --- fakes ---------------------------------------------------------------

function fakePromClient () {
  const state = { registered: new Set(), gauges: [] }
  const register = {
    getSingleMetric (name) { return state.registered.has(name) ? { name } : undefined },
    clear () { state.registered.clear(); state.gauges = [] },
    registerMetric (m) { state.registered.add(m.name) },
    metrics: async () => Array.from(state.registered).map(n => n + ' 0').join('\n'),
    contentType: 'text/plain'
  }
  class Gauge {
    constructor (opts) {
      this.name = opts.name
      state.registered.add(opts.name)
      state.gauges.push(opts)
    }
    set (v) { this._v = v }
    labels () { return this }
  }
  class Counter {
    constructor (opts) {
      this.name = opts.name
      state.registered.add(opts.name)
    }
    inc () {}
  }
  const promClient = {
    register,
    Gauge,
    Counter,
    Registry: function () { return register },
    collectDefaultMetrics () {}
  }
  promClient._state = state
  return promClient
}

function fakeHypertrace () {
  const state = { globalTraceFn: null }
  return {
    state,
    exports: {
      setTraceFunction (fn) { state.globalTraceFn = fn },
      clearTraceFunction () { state.globalTraceFn = null },
      createTracer () { return { trace () {}, setParent () {} } }
    }
  }
}

function fakeHypertracePrometheus () {
  const state = { built: [] }
  const factory = (opts) => {
    state.built.push({ opts })
    const fn = () => {}
    fn.stop = async () => {}
    // If a register was passed, use it so the shared-registry contract is
    // exercised; otherwise fall back to an empty string.
    fn.metrics = async () => opts?.register ? await opts.register.metrics() : ''
    return fn
  }
  factory._state = state
  return factory
}

// hypercore-stats has a `fromCorestore` static method.
function fakeHypercoreStats () {
  const state = { registerCalls: 0, corestores: [], gauges: [] }
  class Stats {
    on () { return this }
    registerPrometheusMetrics (promClient) {
      state.registerCalls++
      // Register a single gauge to prove we reached the shared register.
      new promClient.Gauge({ name: 'hypercore_total_cores', help: 'test', collect () {} })
    }
  }
  Stats.fromCorestore = (store) => { state.corestores.push(store); return new Stats() }
  Stats._state = state
  return Stats
}

function fakeHyperswarmStats () {
  const state = { registerCalls: 0, swarms: [] }
  class Stats {
    constructor (swarm) { state.swarms.push(swarm) }
    registerPrometheusMetrics (promClient) {
      state.registerCalls++
      // Swarm also owns the DHT gauges per the real hyperswarm-stats impl.
      new promClient.Gauge({ name: 'hyperswarm_nr_peers', help: 'test', collect () {} })
      new promClient.Gauge({ name: 'dht_consistent_punches', help: 'test', collect () {} })
    }
  }
  Stats._state = state
  return Stats
}

function fakeHyperdhtStats () {
  const state = { registerCalls: 0, dhts: [] }
  class Stats {
    constructor (dht) { state.dhts.push(dht) }
    registerPrometheusMetrics (promClient) {
      state.registerCalls++
      new promClient.Gauge({ name: 'dht_consistent_punches', help: 'test', collect () {} })
    }
  }
  Stats._state = state
  return Stats
}

// --- loader --------------------------------------------------------------

function inject (path, exports) {
  if (exports === undefined) {
    delete require.cache[path]
    return
  }
  require.cache[path] = { id: path, filename: path, loaded: true, exports }
}

function loadFreshObservability (opts = {}) {
  const {
    hypertrace, hypertracePrometheus, promClient,
    hypercoreStats, hyperswarmStats, hyperdhtStats,
    env = {}
  } = opts

  delete require.cache[OBSERVABILITY_PATH]
  inject(HYPERTRACE_PATH, hypertrace)
  inject(HYPERTRACE_PROM_PATH, hypertracePrometheus)
  inject(PROM_CLIENT_PATH, promClient)
  inject(HYPERCORE_STATS_PATH, hypercoreStats)
  inject(HYPERSWARM_STATS_PATH, hyperswarmStats)
  inject(HYPERDHT_STATS_PATH, hyperdhtStats)

  const prevEnv = {}
  for (const k of Object.keys(env)) {
    prevEnv[k] = process.env[k]
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }

  const mod = require(OBSERVABILITY_PATH)
  return {
    mod,
    restore () {
      for (const k of Object.keys(prevEnv)) {
        if (prevEnv[k] === undefined) delete process.env[k]
        else process.env[k] = prevEnv[k]
      }
      delete require.cache[OBSERVABILITY_PATH]
      delete require.cache[HYPERTRACE_PATH]
      delete require.cache[HYPERTRACE_PROM_PATH]
      delete require.cache[PROM_CLIENT_PATH]
      delete require.cache[HYPERCORE_STATS_PATH]
      delete require.cache[HYPERSWARM_STATS_PATH]
      delete require.cache[HYPERDHT_STATS_PATH]
      // Re-require the real modules for downstream tests
      try { require(HYPERTRACE_PATH) } catch {}
      try { require(HYPERTRACE_PROM_PATH) } catch {}
      try { require(PROM_CLIENT_PATH).register.clear() } catch {}
    }
  }
}

// --- tests --------------------------------------------------------------

test('startPrometheus wires stats registrations when primitives are passed', async (t) => {
  const promClient = fakePromClient()
  const hs = fakeHypercoreStats()
  const ss = fakeHyperswarmStats()
  const { mod, restore } = loadFreshObservability({
    hypertrace: fakeHypertrace().exports,
    hypertracePrometheus: fakeHypertracePrometheus(),
    promClient,
    hypercoreStats: hs,
    hyperswarmStats: ss,
    env: { CURVA_OBSERVABILITY_ENABLED: 'true' }
  })
  try {
    const corestore = { fake: 'corestore' }
    const swarm = { fake: 'swarm', dht: { fake: 'dht' } }
    const handle = await mod.startPrometheus({ skipListen: true, corestore, swarm })
    t.is(handle.started, true)
    t.ok(handle.statsRegistered, 'handle exposes statsRegistered')
    t.is(handle.statsRegistered.hypercore, true, 'hypercore stats registered')
    t.is(handle.statsRegistered.swarm, true, 'swarm stats registered')
    t.is(handle.statsRegistered.dht, true, 'swarm registration covers dht gauges (no double-register)')
    t.is(hs._state.registerCalls, 1, 'hypercore-stats.registerPrometheusMetrics called exactly once')
    t.is(ss._state.registerCalls, 1, 'hyperswarm-stats.registerPrometheusMetrics called exactly once')
    // The dht_consistent_punches gauge came from the swarm registration, not
    // a separate call — hyperdht-stats was never invoked as a standalone.
    t.ok(promClient._state.registered.has('dht_consistent_punches'), 'dht_* gauge present via swarm')
    await handle.stop()
  } finally { restore() }
})

test('startPrometheus does not double-register dht when both swarm and dht are provided', async (t) => {
  const promClient = fakePromClient()
  const ss = fakeHyperswarmStats()
  const ds = fakeHyperdhtStats()
  const { mod, restore } = loadFreshObservability({
    hypertrace: fakeHypertrace().exports,
    hypertracePrometheus: fakeHypertracePrometheus(),
    promClient,
    hyperswarmStats: ss,
    hyperdhtStats: ds,
    env: { CURVA_OBSERVABILITY_ENABLED: 'true' }
  })
  try {
    const swarm = { fake: 'swarm', dht: {} }
    const dht = { fake: 'dht' }
    const handle = await mod.startPrometheus({ skipListen: true, swarm, dht })
    t.is(handle.statsRegistered.swarm, true, 'swarm registered')
    t.is(handle.statsRegistered.dht, true, 'dht flag set to true')
    t.is(ss._state.registerCalls, 1, 'swarm stats registered exactly once')
    t.is(ds._state.registerCalls, 0, 'hyperdht-stats NOT invoked separately (swarm covers dht)')
    await handle.stop()
  } finally { restore() }
})

test('startPrometheus with only dht (no swarm) does register hyperdht-stats', async (t) => {
  const promClient = fakePromClient()
  const ds = fakeHyperdhtStats()
  const { mod, restore } = loadFreshObservability({
    hypertrace: fakeHypertrace().exports,
    hypertracePrometheus: fakeHypertracePrometheus(),
    promClient,
    hyperdhtStats: ds,
    env: { CURVA_OBSERVABILITY_ENABLED: 'true' }
  })
  try {
    const dht = { fake: 'dht' }
    const handle = await mod.startPrometheus({ skipListen: true, dht })
    t.is(handle.statsRegistered.dht, true, 'dht registered')
    t.is(handle.statsRegistered.swarm, false, 'swarm not registered when only dht passed')
    t.is(ds._state.registerCalls, 1, 'hyperdht-stats invoked once')
    await handle.stop()
  } finally { restore() }
})

test('registerHypercoreStats is a no-op when flag is off', async (t) => {
  const { mod, restore } = loadFreshObservability({
    hypertrace: fakeHypertrace().exports,
    hypertracePrometheus: fakeHypertracePrometheus(),
    promClient: fakePromClient(),
    hypercoreStats: fakeHypercoreStats(),
    env: { CURVA_OBSERVABILITY_ENABLED: 'false' }
  })
  try {
    const res = mod.registerHypercoreStats({ fake: 'corestore' })
    t.is(res.registered, false)
    t.is(res.reason, 'flag-off')
  } finally { restore() }
})

test('registerHypercoreStats reports package-missing when hypercore-stats not installed', async (t) => {
  // Inject a bad path resolver for hypercore-stats by pointing require.cache
  // to a throwing exports. The loadStatsPackage helper wraps require() in
  // try/catch and returns null on failure.
  const promClient = fakePromClient()
  const { mod, restore } = loadFreshObservability({
    hypertrace: fakeHypertrace().exports,
    hypertracePrometheus: fakeHypertracePrometheus(),
    promClient,
    // No hypercoreStats fake — require goes to real module. That's fine, real
    // hypercore-stats IS installed. To simulate missing, we shadow the export.
    hypercoreStats: { fromCorestore: undefined },
    env: { CURVA_OBSERVABILITY_ENABLED: 'true' }
  })
  try {
    const res = mod.registerHypercoreStats({ fake: 'corestore' })
    t.is(res.registered, false)
    t.is(res.reason, 'hypercore-stats-missing', 'reports package-missing when fromCorestore is not a function')
  } finally { restore() }
})

test('registerHyperswarmStats short-circuits when gauges already registered', async (t) => {
  const promClient = fakePromClient()
  const ss = fakeHyperswarmStats()
  const { mod, restore } = loadFreshObservability({
    hypertrace: fakeHypertrace().exports,
    hypertracePrometheus: fakeHypertracePrometheus(),
    promClient,
    hyperswarmStats: ss,
    env: { CURVA_OBSERVABILITY_ENABLED: 'true' }
  })
  try {
    const swarm = { fake: 'swarm', dht: {} }
    const first = mod.registerHyperswarmStats(swarm)
    t.is(first.registered, true, 'first registration succeeds')
    const second = mod.registerHyperswarmStats(swarm)
    t.is(second.registered, false, 'second call detects existing gauges')
    t.is(second.reason, 'already-registered')
    t.is(ss._state.registerCalls, 1, 'stats.registerPrometheusMetrics called exactly once across both attempts')
  } finally { restore() }
})

test('trace_counter and stats share the SAME prom-client register', async (t) => {
  // This is the core "one /metrics response" contract. We assert that
  // hypertrace-prometheus receives our shared register AND the same register
  // gets the stats gauges installed. If we ever regress and hypertrace-prom
  // creates its own Registry, this test fails.
  const promClient = fakePromClient()
  const hp = fakeHypertracePrometheus()
  const hs = fakeHypercoreStats()
  const { mod, restore } = loadFreshObservability({
    hypertrace: fakeHypertrace().exports,
    hypertracePrometheus: hp,
    promClient,
    hypercoreStats: hs,
    env: { CURVA_OBSERVABILITY_ENABLED: 'true' }
  })
  try {
    const corestore = { fake: 'corestore' }
    const handle = await mod.startPrometheus({ skipListen: true, corestore })
    t.is(handle.started, true)
    t.is(hp._state.built.length, 1, 'hp factory invoked once')
    t.is(hp._state.built[0].opts.register, promClient.register,
      'hypertrace-prometheus received our shared prom-client.register')
    // And the shared register has the hypercore gauge, proving both live on
    // the same registry.
    const metricsBody = await handle.metrics()
    t.ok(metricsBody.includes('hypercore_total_cores'), 'shared register exports the hypercore gauge')
    await handle.stop()
  } finally { restore() }
})
