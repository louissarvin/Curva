// Wave 4 F1 brittle tests: composeApply() middleware chain.
//
// Verified against docs.pears.com/reference/building-blocks/autobase/ (fetched
// 2026-07-10) and the installed autobase apply contract at
// node_modules/autobase/index.js: apply(nodes, view, host).
//
// These tests exercise the reducer contract:
//   - middlewares run in the order they were passed (first = outermost)
//   - `next` must be called exactly once (throws otherwise)
//   - middleware options are honoured (audit sampleRate, chaos dropRate,
//     systemGuard allowedTypes)
//   - two peers applying the same node stream through the same middleware
//     chain reach identical view state (determinism preserved)
//   - chaos middleware drops the SAME nodes on every peer for the same input

const test = require('brittle')

const {
  composeApply,
  auditLogMiddleware,
  chaosMiddleware,
  systemGuardMiddleware,
  replayRecorderMiddleware,
  terminalMiddleware,
  MiddlewareMustCallNext,
  InvalidMiddleware,
  _internal: { fnv1a32, stableStringify }
} = require('../bare/lib/applyMiddleware.js')

function makeNode (value, fromHex = 'aa'.repeat(32)) {
  return {
    value,
    from: { key: Buffer.from(fromHex, 'hex') }
  }
}

// A view stand-in that mimics the reducer contract: a mutable object the
// real chat apply would fill with put()/del() calls. The reducer here just
// pushes the observed values into `view.records` — pure with respect to
// (nodes, view).
function makeView () { return { records: [] } }

const realApply = async (nodes, view /* , host */) => {
  for (const n of nodes) view.records.push(n.value)
}

test('composeApply requires an array of functions', async (t) => {
  t.exception(() => composeApply(null), InvalidMiddleware)
  t.exception(() => composeApply([123]), InvalidMiddleware)
})

test('middlewares run in the passed order (first outermost)', async (t) => {
  const trace = []
  const mkTrace = (label) => async (nodes, view, host, next) => {
    trace.push('pre:' + label)
    await next()
    trace.push('post:' + label)
  }

  const compose = composeApply([
    mkTrace('A'),
    mkTrace('B'),
    mkTrace('C')
  ])

  await compose([], {}, {})
  t.alike(trace, [
    'pre:A', 'pre:B', 'pre:C', 'post:C', 'post:B', 'post:A'
  ], 'onion order preserved')
})

test('composed apply reaches the terminal reducer', async (t) => {
  const view = makeView()
  const nodes = [
    makeNode({ type: 'chat', text: 'hi' }),
    makeNode({ type: 'chat', text: 'yo' })
  ]

  const compose = composeApply([
    auditLogMiddleware({ sampleRate: 0 }),
    terminalMiddleware(realApply)
  ])

  await compose(nodes, view, {})
  t.is(view.records.length, 2, 'both nodes reach reducer')
  t.is(view.records[0].text, 'hi')
})

test('next() must be called exactly once — missing invocation throws', async (t) => {
  const forgotten = async (nodes, view, host /* no next */) => {}
  const compose = composeApply([forgotten, terminalMiddleware(realApply)])
  await t.exception(compose([], makeView(), {}), MiddlewareMustCallNext)
})

test('next() must be called exactly once — double invocation throws', async (t) => {
  const doubled = async (nodes, view, host, next) => {
    await next()
    await next()
  }
  const compose = composeApply([doubled, terminalMiddleware(realApply)])
  await t.exception(compose([], makeView(), {}), MiddlewareMustCallNext)
})

test('auditLog middleware respects sampleRate=0 (skip all)', async (t) => {
  const collected = []
  const audit = auditLogMiddleware({
    sink: (evt) => collected.push(evt),
    sampleRate: 0
  })
  const compose = composeApply([audit, terminalMiddleware(realApply)])
  const nodes = [makeNode({ type: 'chat', text: 'x' })]
  await compose(nodes, makeView(), {})
  t.is(collected.length, 0, 'no events sampled at rate 0')
})

test('auditLog middleware honours sampleRate=1 (sample all)', async (t) => {
  const collected = []
  const audit = auditLogMiddleware({
    sink: (evt) => collected.push(evt),
    sampleRate: 1
  })
  const compose = composeApply([audit, terminalMiddleware(realApply)])
  const nodes = [
    makeNode({ type: 'chat', text: 'x' }),
    makeNode({ type: 'chat', text: 'y' })
  ]
  await compose(nodes, makeView(), {})
  t.is(collected.length, 2, 'all events sampled at rate 1')
  t.is(collected[0].type, 'chat', 'event carries type')
  t.is(collected[0].at, 0, 'no wall-clock inside reducer path')
})

test('auditLog sink failures do NOT break the reducer', async (t) => {
  const audit = auditLogMiddleware({
    sink: () => { throw new Error('sink failure') },
    sampleRate: 1
  })
  const view = makeView()
  const compose = composeApply([audit, terminalMiddleware(realApply)])
  await compose([makeNode({ type: 'chat', text: 'ok' })], view, {})
  t.is(view.records.length, 1, 'reducer still ran despite sink throw')
})

test('chaos middleware is no-op when flag is off', async (t) => {
  const view = makeView()
  const chaos = chaosMiddleware({
    dropRate: 1,
    env: { CURVA_CHAOS_ENABLED: '' }
  })
  const compose = composeApply([chaos, terminalMiddleware(realApply)])
  const nodes = [
    makeNode({ type: 'chat', text: 'a' }),
    makeNode({ type: 'chat', text: 'b' })
  ]
  await compose(nodes, view, {})
  t.is(view.records.length, 2, 'no drops when flag off')
})

test('chaos middleware drops deterministically across peers', async (t) => {
  // Same nodes, same chaos config -> two independent invocations drop the
  // identical subset. This is the property we ship for.
  const env = { CURVA_CHAOS_ENABLED: 'true' }
  const nodes = Array.from({ length: 40 }, (_, i) =>
    makeNode({ type: 'chat', text: 'msg-' + i }))

  const runPeer = async () => {
    const view = makeView()
    const chaos = chaosMiddleware({ dropRate: 0.5, env, seedSalt: 'test' })
    const compose = composeApply([chaos, terminalMiddleware(realApply)])
    await compose(nodes, view, {})
    return view.records.map((r) => r.text)
  }

  const peerA = await runPeer()
  const peerB = await runPeer()
  t.alike(peerA, peerB, 'both peers drop identical subset')
  t.ok(peerA.length > 0 && peerA.length < 40, 'some dropped, some kept')
})

test('chaos middleware dropRate=0 keeps every node even when enabled', async (t) => {
  const view = makeView()
  const chaos = chaosMiddleware({
    dropRate: 0,
    env: { CURVA_CHAOS_ENABLED: '1' }
  })
  const compose = composeApply([chaos, terminalMiddleware(realApply)])
  const nodes = [makeNode({ type: 'chat', text: 'a' })]
  await compose(nodes, view, {})
  t.is(view.records.length, 1, 'nothing dropped at rate 0')
})

test('systemGuard drops malformed nodes and unknown types', async (t) => {
  const view = makeView()
  const guard = systemGuardMiddleware({
    allowedTypes: ['chat', 'system:goal-card']
  })
  const compose = composeApply([guard, terminalMiddleware(realApply)])
  const nodes = [
    makeNode({ type: 'chat', text: 'ok' }),
    makeNode({ type: 'evil', text: 'nope' }),
    makeNode(null),
    makeNode('string-payload'),
    makeNode({ type: 'system:goal-card', minute: 34 }),
    makeNode({ addWriter: 'ff'.repeat(32) }) // control block always allowed
  ]
  await compose(nodes, view, {})
  const kinds = view.records.map((r) => r && (r.type || (r.addWriter ? 'control' : 'other')))
  t.alike(kinds, ['chat', 'system:goal-card', 'control'], 'only allowed types + controls pass')
})

test('systemGuard maxNodeBytes rejects oversized payloads', async (t) => {
  const view = makeView()
  const guard = systemGuardMiddleware({
    allowedTypes: null,
    maxNodeBytes: 40
  })
  const compose = composeApply([guard, terminalMiddleware(realApply)])
  const nodes = [
    makeNode({ type: 'chat', text: 'ok' }),
    makeNode({ type: 'chat', text: 'x'.repeat(1000) })
  ]
  await compose(nodes, view, {})
  t.is(view.records.length, 1, 'oversized node dropped')
})

test('replayRecorder captures node stream with bounded ring size', async (t) => {
  const captured = []
  const recorder = replayRecorderMiddleware({
    sink: (entry) => captured.push(entry),
    maxSize: 3
  })
  const compose = composeApply([recorder, terminalMiddleware(realApply)])
  const nodes = Array.from({ length: 10 }, (_, i) =>
    makeNode({ type: 'chat', text: 'n' + i }))
  await compose(nodes, makeView(), {})
  t.is(captured.length, 3, 'ring bounded at maxSize')
  t.is(captured[0].valueType, 'chat')
})

test('two peers reach identical view state — determinism preserved', async (t) => {
  // Full realistic stack.
  const env = { CURVA_CHAOS_ENABLED: 'true' }
  const nodes = [
    makeNode({ type: 'chat', text: 'hello' }),
    makeNode({ type: 'chat', text: 'world' }),
    makeNode({ type: 'system:goal-card', minute: 34, scorer: 'Kean', team: 'Italy' }),
    makeNode({ type: 'evil' }), // dropped by guard
    makeNode({ addWriter: 'aa'.repeat(32) })
  ]

  const runPeer = async () => {
    const audits = []
    const view = makeView()
    const compose = composeApply([
      auditLogMiddleware({ sink: (e) => audits.push(e), sampleRate: 1 }),
      systemGuardMiddleware({ allowedTypes: ['chat', 'system:goal-card'] }),
      chaosMiddleware({ dropRate: 0.2, env, seedSalt: 'wave4' }),
      terminalMiddleware(realApply)
    ])
    await compose(nodes, view, {})
    return { view, audits }
  }

  const peerA = await runPeer()
  const peerB = await runPeer()
  t.alike(peerA.view.records, peerB.view.records, 'reducer view converges')
  t.alike(peerA.audits.map((e) => e.hash), peerB.audits.map((e) => e.hash),
    'audit hashes deterministic across peers')
})

test('stableStringify is order-independent for object keys', async (t) => {
  const a = { b: 1, a: 2, c: { z: 1, y: 2 } }
  const b = { c: { y: 2, z: 1 }, a: 2, b: 1 }
  t.is(stableStringify(a), stableStringify(b), 'canonical order removes divergence')
})

test('fnv1a32 is a pure function of its input', async (t) => {
  const v = { type: 'chat', text: 'hello' }
  t.is(fnv1a32(v), fnv1a32(v), 'same input yields same hash')
  t.not(fnv1a32(v), fnv1a32({ type: 'chat', text: 'hell0' }), 'differs on payload change')
})
