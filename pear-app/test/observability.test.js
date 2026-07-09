// Curva observability tests. We do NOT open a real HTTP port. Instead the
// hypertrace-prometheus require is stubbed via require.cache so the module
// resolves to a fake that records calls.
//
// Verified against:
//   node_modules/hypertrace/index.js:107 (createTracer/setTraceFunction exports)
//   node_modules/hypertrace-prometheus/index.js:6 (called as fn, returns
//   traceFunction with .stop/.metrics)

const test = require('brittle')
const path = require('path')

const HYPERTRACE_PATH = require.resolve('hypertrace')
const HYPERTRACE_PROM_PATH = require.resolve('hypertrace-prometheus')
const OBSERVABILITY_PATH = require.resolve('../bare/observability.js')

function loadFreshObservability ({ hypertrace, hypertracePrometheus, env = {} } = {}) {
  // Reset module caches so each test gets a fresh observability module with
  // whatever fake modules the test wants injected via require.cache.
  delete require.cache[OBSERVABILITY_PATH]
  if (hypertrace) {
    require.cache[HYPERTRACE_PATH] = {
      id: HYPERTRACE_PATH,
      filename: HYPERTRACE_PATH,
      loaded: true,
      exports: hypertrace
    }
  } else {
    delete require.cache[HYPERTRACE_PATH]
  }
  if (hypertracePrometheus) {
    require.cache[HYPERTRACE_PROM_PATH] = {
      id: HYPERTRACE_PROM_PATH,
      filename: HYPERTRACE_PROM_PATH,
      loaded: true,
      exports: hypertracePrometheus
    }
  } else {
    delete require.cache[HYPERTRACE_PROM_PATH]
  }
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
      // Reload the real modules for other test files that share this process.
      require(HYPERTRACE_PATH)
      require(HYPERTRACE_PROM_PATH)
    }
  }
}

function fakeHypertrace () {
  const state = { globalTraceFn: null, tracers: [] }
  return {
    state,
    exports: {
      setTraceFunction (fn) { state.globalTraceFn = fn },
      clearTraceFunction () { state.globalTraceFn = null },
      createTracer (ctx, opts) {
        const traces = []
        const t = {
          enabled: true,
          ctx,
          className: ctx?.constructor?.name || 'Anon',
          props: opts?.props || null,
          traces,
          trace (id, props) { traces.push({ id, props }) },
          setParent () {}
        }
        state.tracers.push(t)
        return t
      }
    }
  }
}

function fakeHypertracePrometheus () {
  const state = { built: [], stopped: false }
  const factory = (opts) => {
    const traceFn = ({ id, object }) => { state.built[state.built.length - 1].calls.push({ id, className: object?.className }) }
    traceFn.stop = async () => { state.stopped = true }
    traceFn.metrics = async () => 'trace_counter{object_classname="BlindPeering"} 3\n'
    state.built.push({ opts, calls: [] })
    return traceFn
  }
  factory._state = state
  return factory
}

test('observability is a no-op when flag off', async (t) => {
  const ht = fakeHypertrace()
  const hp = fakeHypertracePrometheus()
  const { mod, restore } = loadFreshObservability({
    hypertrace: ht.exports,
    hypertracePrometheus: hp,
    env: { CURVA_OBSERVABILITY_ENABLED: 'false' }
  })
  try {
    const target = { constructor: { name: 'BlindPeering' } }
    const tracer = mod.installTracer(target, { name: 'BlindPeering' })
    t.is(tracer, mod.NOOP_TRACER, 'installTracer returns the no-op sentinel')
    t.is(typeof tracer.trace, 'function', 'no-op tracer has .trace()')
    tracer.trace('should-be-swallowed', { peer: 'abc' })
    t.is(ht.state.tracers.length, 0, 'no real tracer was created')

    const handle = await mod.startPrometheus({})
    t.is(handle.started, false, 'Prometheus handle marks itself not-started')
    t.is(handle.port, null, 'no port when disabled')
    t.is(handle.reason, 'flag-off', 'reason surfaces to caller')
    t.is(hp._state.built.length, 0, 'the prometheus factory was never invoked')
    await handle.stop()
  } finally {
    restore()
  }
})

test('installTracer returns a working tracer that records .trace calls', async (t) => {
  const ht = fakeHypertrace()
  const hp = fakeHypertracePrometheus()
  const { mod, restore } = loadFreshObservability({
    hypertrace: ht.exports,
    hypertracePrometheus: hp,
    env: { CURVA_OBSERVABILITY_ENABLED: 'true' }
  })
  try {
    class BlindPeering {}
    const target = new BlindPeering()
    const tracer = mod.installTracer(target, { name: 'BlindPeering', props: { room: 'ita-fra' } })
    t.is(typeof tracer.trace, 'function', 'trace exists')
    tracer.trace('autobase-registered', { discoveryKey: 'deadbeef' })
    tracer.trace('rate-limited')
    t.is(ht.state.tracers.length, 1, 'exactly one hypertrace instance created')
    t.is(ht.state.tracers[0].traces.length, 2, 'both traces recorded on the tracer')
    t.is(ht.state.tracers[0].traces[0].id, 'autobase-registered', 'id passthrough')
    t.is(ht.state.tracers[0].props.name, 'BlindPeering', 'name prop applied')
    t.is(ht.state.tracers[0].props.room, 'ita-fra', 'extra props whitelisted')
  } finally {
    restore()
  }
})

test('installTracer clamps label size and rejects garbage prop values', async (t) => {
  const ht = fakeHypertrace()
  const hp = fakeHypertracePrometheus()
  const { mod, restore } = loadFreshObservability({
    hypertrace: ht.exports,
    hypertracePrometheus: hp,
    env: { CURVA_OBSERVABILITY_ENABLED: 'true' }
  })
  try {
    class Room {}
    const longName = 'x'.repeat(200)
    const tracer = mod.installTracer(new Room(), {
      name: longName,
      props: {
        ok: 'short',
        junk: { nested: 'not-allowed' },
        big: 'y'.repeat(500),
        empty: '',
        // eslint-disable-next-line no-undef
        // key too long:
        supercalifragilisticexpialidociousreallylong: 'v'
      }
    })
    t.is(typeof tracer.trace, 'function', 'still returns a tracer')
    const p = ht.state.tracers[0].props
    t.is(p.name.length, 64, 'name clamped to 64 chars')
    t.is(p.ok, 'short', 'short string prop kept')
    t.absent(p.junk, 'object props dropped')
    t.absent(p.big, 'oversized string dropped')
    t.absent(p.supercalifragilisticexpialidociousreallylong, 'oversized key dropped')
  } finally {
    restore()
  }
})

test('startPrometheus registers the trace function and is idempotent', async (t) => {
  const ht = fakeHypertrace()
  const hp = fakeHypertracePrometheus()
  const { mod, restore } = loadFreshObservability({
    hypertrace: ht.exports,
    hypertracePrometheus: hp,
    env: { CURVA_OBSERVABILITY_ENABLED: 'true', CURVA_PROMETHEUS_PORT: '4343' }
  })
  try {
    const h1 = await mod.startPrometheus({ skipListen: true })
    t.is(h1.started, true, 'first start returns started=true')
    t.is(h1.port, 4343, 'defaults to 4343')
    t.is(hp._state.built.length, 1, 'prometheus factory called once')
    t.ok(typeof ht.state.globalTraceFn === 'function', 'trace function was registered globally')

    const h2 = await mod.startPrometheus({ skipListen: true })
    t.is(h2, h1, 'second call returns the same handle (idempotent)')
    t.is(hp._state.built.length, 1, 'prometheus factory NOT called twice')

    // metrics() proxies to the underlying trace function's metrics().
    const m = await h1.metrics()
    t.ok(m.includes('trace_counter'), 'metrics contain the counter')

    await h1.stop()
    t.is(hp._state.stopped, true, 'underlying stop was called')
    t.is(ht.state.globalTraceFn, null, 'global trace function cleared on stop')
  } finally {
    restore()
  }
})

test('startPrometheus is resilient to a missing hypertrace-prometheus package', async (t) => {
  const ht = fakeHypertrace()
  // Simulate a broken require by injecting a throwing factory.
  const throwingFactory = () => { throw new Error('EACCES: port 4343 in use') }
  const { mod, restore } = loadFreshObservability({
    hypertrace: ht.exports,
    hypertracePrometheus: throwingFactory,
    env: { CURVA_OBSERVABILITY_ENABLED: 'true' }
  })
  try {
    const handle = await mod.startPrometheus({ port: 4343, logger: { warn () {}, info () {}, error () {} } })
    t.is(handle.started, false, 'no-op handle when factory throws')
    t.ok(String(handle.reason || '').startsWith('start-failed:'), 'reason carries error message')
    await handle.stop()
  } finally {
    restore()
  }
})

test('subscribeToServerLogs bridges SDK log stream and rejects malformed lines', (t) => {
  const { mod, restore } = loadFreshObservability({
    hypertrace: fakeHypertrace().exports,
    hypertracePrometheus: fakeHypertracePrometheus(),
    env: { CURVA_OBSERVABILITY_ENABLED: 'true' }
  })
  try {
    const captured = []
    let subscriberCb = null
    const fakeSdk = {
      subscribeServerLogs (cb) { subscriberCb = cb; return () => { subscriberCb = null } }
    }
    const unsub = mod.subscribeToServerLogs(fakeSdk, (entry) => captured.push(entry))
    t.is(typeof unsub, 'function', 'returns unsubscribe function')
    // Feed structured log
    subscriberCb({ level: 'warn', message: 'model reload' })
    // Feed a plain string
    subscriberCb('bare string line')
    // Feed garbage (should be dropped, not thrown)
    subscriberCb(null)
    subscriberCb({})
    t.is(captured.length, 2, 'only well-formed entries reach the sink')
    t.is(captured[0].level, 'warn')
    t.is(captured[0].message, 'model reload')
    t.is(captured[1].level, 'info', 'string log defaults to info level')

    // Unsubscribe is idempotent
    unsub()
    unsub()
    t.is(subscriberCb, null, 'unsubscribe releases the callback')

    // Missing sdkImpl is a no-op
    const noop = mod.subscribeToServerLogs(null, () => {})
    t.is(typeof noop, 'function', 'still returns fn when sdk missing')
    noop() // must not throw
  } finally {
    restore()
  }
})

test('missing hypertrace package returns no-op tracer without throwing', (t) => {
  // Simulate require('hypertrace') failure by injecting an exports object that
  // is missing createTracer entirely.
  const badHypertrace = { setTraceFunction () {}, clearTraceFunction () {} }
  const { mod, restore } = loadFreshObservability({
    hypertrace: badHypertrace,
    hypertracePrometheus: fakeHypertracePrometheus(),
    env: { CURVA_OBSERVABILITY_ENABLED: 'true' }
  })
  try {
    const tracer = mod.installTracer({ constructor: { name: 'X' } }, { name: 'X' })
    t.is(tracer, mod.NOOP_TRACER, 'falls back to no-op tracer')
    t.execution(() => tracer.trace('anything'), 'no-op trace does not throw')
  } finally {
    restore()
  }
})
