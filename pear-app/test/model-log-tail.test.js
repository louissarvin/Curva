// Wave 4 F2 addendum: startModelLogTail unit tests.
//
// Verified against installed source (fetched 2026-07-10):
//   node_modules/@qvac/sdk/dist/client/api/logging-stream.d.ts:23
//     loggingStream({id: string}): AsyncGenerator<LoggingStreamResponse>
//   node_modules/@qvac/sdk/dist/schemas/logging-stream.d.ts
//     LoggingStreamResponse = {type:'loggingStream', id, level, namespace, message, timestamp}
//   node_modules/@qvac/sdk/dist/logging/namespaces.d.ts:1
//     SDK_LOG_ID = "__sdk__"
//
// Fake SDK below implements a scriptable async-generator so we can drive
// entries, throws, and cancellation deterministically without touching the
// real @qvac/sdk (which requires a full runtime + models cache).

const test = require('brittle')
const obs = require('../bare/observability.js')
const { startModelLogTail, SDK_LOG_ID } = obs

function tick (n = 1) {
  return new Promise((r) => setTimeout(r, n))
}

// A controllable async-generator producer. Callers push entries or errors;
// the generator drains them as consumers `await` next().
function makeControlledStream ({ throwAfter = null } = {}) {
  const queue = []
  const waiters = []
  let closed = false
  let returnedCount = 0

  function push (item) {
    if (waiters.length > 0) {
      const w = waiters.shift()
      if (item && item.__throw) {
        w.reject(item.error)
      } else {
        w.resolve({ value: item, done: false })
      }
    } else {
      queue.push(item)
    }
  }

  const iter = {
    [Symbol.asyncIterator] () { return iter },
    async next () {
      if (closed) return { value: undefined, done: true }
      if (queue.length > 0) {
        const item = queue.shift()
        if (item && item.__throw) {
          throw item.error
        }
        return { value: item, done: false }
      }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    },
    async return () {
      returnedCount += 1
      closed = true
      while (waiters.length > 0) {
        const w = waiters.shift()
        if (typeof w.resolve === 'function') w.resolve({ value: undefined, done: true })
      }
      return { value: undefined, done: true }
    },
    __closed: () => closed,
    __returnedCount: () => returnedCount
  }

  return {
    iter,
    emit (entry) { push(entry) },
    fail (err) { push({ __throw: true, error: err }) }
  }
}

function makeSdk ({ streams = new Map() } = {}) {
  return {
    loggingStream ({ id }) {
      let stream = streams.get(id)
      if (!stream) {
        stream = makeControlledStream()
        streams.set(id, stream)
      }
      return stream.iter
    }
  }
}

test('SDK_LOG_ID is the __sdk__ reserved constant', (t) => {
  t.is(SDK_LOG_ID, '__sdk__')
})

test('startModelLogTail returns STREAM_UNAVAILABLE when sdk lacks loggingStream', (t) => {
  const logs = []
  const tail = startModelLogTail({}, {
    modelId: 'MODEL_A',
    onLog: (e) => logs.push(e)
  })
  const st = tail.status()
  t.is(st.ok, false)
  t.is(st.code, 'STREAM_UNAVAILABLE')
  t.is(st.modelId, 'MODEL_A')
  // stop() must be a callable noop
  t.execution(() => tail.stop())
  t.is(logs.length, 0)
})

test('startModelLogTail rejects invalid modelId', (t) => {
  const tail = startModelLogTail({ loggingStream: () => ({}) }, {
    modelId: '',
    onLog: () => {}
  })
  const st = tail.status()
  t.is(st.ok, false)
  t.is(st.code, 'INVALID_MODEL_ID')
})

test('startModelLogTail calls sdk.loggingStream with the correct id', async (t) => {
  const calls = []
  const streams = new Map()
  const sdk = {
    loggingStream (params) {
      calls.push(params)
      const s = makeControlledStream()
      streams.set(params.id, s)
      return s.iter
    }
  }
  const received = []
  const tail = startModelLogTail(sdk, {
    modelId: 'QWEN3_600M_INST_Q4',
    onLog: (e) => received.push(e)
  })
  await tick()
  t.is(calls.length, 1)
  t.is(calls[0].id, 'QWEN3_600M_INST_Q4')
  tail.stop()
  obs._resetForTest()
})

test('startModelLogTail forwards normalized entries with schema shape', async (t) => {
  const streams = new Map()
  const sdk = makeSdk({ streams })
  const received = []
  const tail = startModelLogTail(sdk, {
    modelId: 'M1',
    onLog: (e) => received.push(e)
  })
  await tick()
  const stream = streams.get('M1')
  stream.emit({
    type: 'loggingStream',
    id: 'M1',
    level: 'info',
    namespace: 'llama',
    message: 'model loaded',
    timestamp: 12345
  })
  stream.emit({
    type: 'loggingStream',
    id: 'M1',
    level: 'warn',
    namespace: 'llama',
    message: 'slow generation',
    timestamp: 12346
  })
  await tick()
  t.is(received.length, 2)
  t.is(received[0].type, 'loggingStream')
  t.is(received[0].id, 'M1')
  t.is(received[0].level, 'info')
  t.is(received[0].namespace, 'llama')
  t.is(received[0].message, 'model loaded')
  t.is(received[0].timestamp, 12345)
  t.is(received[1].level, 'warn')
  t.is(received[1].message, 'slow generation')
  tail.stop()
  obs._resetForTest()
})

test('startModelLogTail clips oversized messages to 2 KB', async (t) => {
  const streams = new Map()
  const sdk = makeSdk({ streams })
  const received = []
  const tail = startModelLogTail(sdk, {
    modelId: 'BIG',
    onLog: (e) => received.push(e)
  })
  await tick()
  const long = 'x'.repeat(5000)
  streams.get('BIG').emit({
    type: 'loggingStream',
    id: 'BIG',
    level: 'info',
    namespace: 'ns',
    message: long,
    timestamp: 1
  })
  await tick()
  t.is(received.length, 1)
  t.is(received[0].message.length, 2048)
  tail.stop()
  obs._resetForTest()
})

test('startModelLogTail auto-stops at maxLines cap', async (t) => {
  const streams = new Map()
  const sdk = makeSdk({ streams })
  const received = []
  const tail = startModelLogTail(sdk, {
    modelId: 'CAP',
    onLog: (e) => received.push(e),
    maxLines: 3
  })
  await tick()
  const s = streams.get('CAP')
  for (let i = 0; i < 10; i++) {
    s.emit({
      type: 'loggingStream',
      id: 'CAP',
      level: 'info',
      namespace: 'ns',
      message: 'line ' + i,
      timestamp: i
    })
  }
  await tick()
  await tick()
  t.is(received.length, 3, 'received exactly the cap')
  const st = tail.status()
  t.is(st.ok, false)
  t.is(st.code, 'STOPPED')
  t.is(st.delivered, 3)
  obs._resetForTest()
})

test('startModelLogTail stop() breaks the for-await within one tick', async (t) => {
  const streams = new Map()
  const sdk = makeSdk({ streams })
  const received = []
  const tail = startModelLogTail(sdk, {
    modelId: 'STOP_ME',
    onLog: (e) => received.push(e)
  })
  await tick()
  const s = streams.get('STOP_ME')
  s.emit({ type: 'loggingStream', id: 'STOP_ME', level: 'info', namespace: 'x', message: 'a', timestamp: 1 })
  await tick()
  t.is(received.length, 1)
  tail.stop()
  await tick()
  // Underlying async iterator must have been returned by stop() -> .return().
  t.ok(s.iter.__closed(), 'upstream iterator closed after stop()')
  t.ok(s.iter.__returnedCount() >= 1, 'return() called at least once')
  // Further pushes should not arrive at the callback.
  s.emit({ type: 'loggingStream', id: 'STOP_ME', level: 'info', namespace: 'x', message: 'b', timestamp: 2 })
  await tick()
  t.is(received.length, 1, 'no entries delivered after stop')
  obs._resetForTest()
})

test('startModelLogTail catches async-generator throw and emits error entry', async (t) => {
  const streams = new Map()
  const sdk = makeSdk({ streams })
  const received = []
  const tail = startModelLogTail(sdk, {
    modelId: 'BOOM',
    onLog: (e) => received.push(e)
  })
  await tick()
  const s = streams.get('BOOM')
  s.emit({
    type: 'loggingStream',
    id: 'BOOM',
    level: 'info',
    namespace: 'ns',
    message: 'still fine',
    timestamp: 1
  })
  await tick()
  s.fail(new Error('upstream exploded'))
  await tick()
  await tick()
  t.is(received.length, 2)
  t.is(received[1].level, 'error')
  t.is(received[1].namespace, 'observability.modelLogTail')
  t.ok(received[1].message.includes('upstream exploded'))
  const st = tail.status()
  t.is(st.delivered, 2)
  obs._resetForTest()
})

test('concurrent tails on different modelIds run independently', async (t) => {
  const streams = new Map()
  const sdk = makeSdk({ streams })
  const rxA = []
  const rxB = []
  const tailA = startModelLogTail(sdk, {
    modelId: 'A',
    onLog: (e) => rxA.push(e),
    maxLines: 10
  })
  const tailB = startModelLogTail(sdk, {
    modelId: 'B',
    onLog: (e) => rxB.push(e),
    maxLines: 10
  })
  await tick()
  const sa = streams.get('A')
  const sb = streams.get('B')
  sa.emit({ type: 'loggingStream', id: 'A', level: 'info', namespace: 'a', message: 'a1', timestamp: 1 })
  sb.emit({ type: 'loggingStream', id: 'B', level: 'info', namespace: 'b', message: 'b1', timestamp: 2 })
  sa.emit({ type: 'loggingStream', id: 'A', level: 'info', namespace: 'a', message: 'a2', timestamp: 3 })
  await tick()
  t.is(rxA.length, 2)
  t.is(rxB.length, 1)
  t.is(rxA[0].message, 'a1')
  t.is(rxA[1].message, 'a2')
  t.is(rxB[0].message, 'b1')
  // Stop A: should NOT close B's stream.
  tailA.stop()
  await tick()
  t.ok(sa.iter.__closed(), 'A closed')
  t.absent(sb.iter.__closed(), 'B still open')
  sb.emit({ type: 'loggingStream', id: 'B', level: 'info', namespace: 'b', message: 'b2', timestamp: 4 })
  await tick()
  t.is(rxB.length, 2)
  tailB.stop()
  await tick()
  t.ok(sb.iter.__closed(), 'B closed after its own stop')
  obs._resetForTest()
})

test('multiplex: two tails on same modelId share one upstream iterator', async (t) => {
  const calls = []
  const stream = makeControlledStream()
  const sdk = {
    loggingStream (params) {
      calls.push(params)
      return stream.iter
    }
  }
  const rx1 = []
  const rx2 = []
  const tail1 = startModelLogTail(sdk, { modelId: 'SHARED', onLog: (e) => rx1.push(e) })
  const tail2 = startModelLogTail(sdk, { modelId: 'SHARED', onLog: (e) => rx2.push(e) })
  await tick()
  t.is(calls.length, 1, 'sdk.loggingStream called only once for the shared id')
  stream.emit({ type: 'loggingStream', id: 'SHARED', level: 'info', namespace: 's', message: 'hi', timestamp: 1 })
  await tick()
  t.is(rx1.length, 1)
  t.is(rx2.length, 1)
  // First caller stops — second must keep receiving.
  tail1.stop()
  await tick()
  t.absent(stream.iter.__closed(), 'upstream still open because tail2 is alive')
  stream.emit({ type: 'loggingStream', id: 'SHARED', level: 'info', namespace: 's', message: 'again', timestamp: 2 })
  await tick()
  t.is(rx1.length, 1, 'stopped caller no longer receives')
  t.is(rx2.length, 2)
  tail2.stop()
  await tick()
  t.ok(stream.iter.__closed(), 'upstream closed once last caller stops')
  obs._resetForTest()
})

test('onLog throwing does not break the tail', async (t) => {
  const streams = new Map()
  const sdk = makeSdk({ streams })
  let count = 0
  const tail = startModelLogTail(sdk, {
    modelId: 'BAD_CB',
    onLog: () => { count++; throw new Error('cb boom') }
  })
  await tick()
  const s = streams.get('BAD_CB')
  s.emit({ type: 'loggingStream', id: 'BAD_CB', level: 'info', namespace: 'x', message: '1', timestamp: 1 })
  s.emit({ type: 'loggingStream', id: 'BAD_CB', level: 'info', namespace: 'x', message: '2', timestamp: 2 })
  await tick()
  t.is(count, 2, 'callback invoked for each entry despite throwing')
  tail.stop()
  obs._resetForTest()
})
