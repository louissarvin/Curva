// Brittle tests for the sdk.cancel integration in voiceCoach + askTheFrame.
//
// Ground truth:
//   pear-app/node_modules/@qvac/sdk/dist/client/api/cancel.d.ts:6-15
//     cancel({requestId}) is primary. Races-with-begin case is retroactively
//     applied by the SDK when the begin arrives. Our factories are stricter
//     — we no-op the client-side cancel when we do not yet have a requestId
//     because the SDK schema requires a non-empty string.
//   pear-app/node_modules/@qvac/sdk/dist/schemas/completion-event.d.ts:217
//     CompletionRun.requestId is synchronously available on the returned run.

'use strict'

const test = require('brittle')
const { createVoiceCoach } = require('../bare/voiceCoach.js')
const { createAskTheFrame } = require('../bare/askTheFrame.js')

// --- Shared fakes ---------------------------------------------------------

function fakeChat () {
  return {
    async send () { return { ok: true } },
    async sendSystem () { return { ok: true } }
  }
}

function fakeSttSdk ({ events = [], cancelImpl = null } = {}) {
  const cancelled = []
  const session = {
    write () {}, end () {}, destroy () {},
    [Symbol.asyncIterator] () {
      let i = 0
      return {
        async next () {
          if (i >= events.length) return { value: undefined, done: true }
          return { value: events[i++], done: false }
        }
      }
    }
  }
  const sdk = {
    async transcribeStream () { return session },
    async cancel (args) {
      cancelled.push(args)
      if (cancelImpl) return cancelImpl(args)
    }
  }
  return { sdk, cancelled }
}

/**
 * Build a CompletionRun whose events async-iterator can be externally
 * controlled: push events with `push(event)` and finalize with `end()`.
 * Exposes `requestId` synchronously per completion-event.d.ts:217.
 */
function controllableCompletionRun ({ requestId = 'req-fake-1' } = {}) {
  const queue = []
  const waiters = []
  let done = false

  function push (event) {
    if (waiters.length > 0) {
      const w = waiters.shift()
      w({ value: event, done: false })
    } else {
      queue.push(event)
    }
  }
  function end () {
    done = true
    while (waiters.length > 0) {
      const w = waiters.shift()
      w({ value: undefined, done: true })
    }
  }
  const iterable = {
    [Symbol.asyncIterator] () {
      return {
        next () {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false })
          }
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => { waiters.push(resolve) })
        }
      }
    }
  }
  return {
    requestId,
    events: iterable,
    final: new Promise((resolve) => resolve({ contentText: '' })),
    push,
    end
  }
}

function fakeLlmControllable ({ requestId = 'req-fake-1' } = {}) {
  const run = controllableCompletionRun({ requestId })
  return {
    modelId: 'qwen-fake',
    completion () { return run },
    _run: run
  }
}

function collectEmits () {
  const events = []
  const emit = (e, p) => events.push({ e, p })
  return { events, emit }
}

// --- voiceCoach: cancelInFlight ------------------------------------------

test('voiceCoach.cancelInFlight is a no-op when nothing is streaming', async (t) => {
  const { sdk, cancelled } = fakeSttSdk()
  const { emit, events } = collectEmits()
  const coach = createVoiceCoach({
    chat: fakeChat(),
    sdk,
    sharedLlmHandle: fakeLlmControllable(),
    emit
  })
  const res = await coach.cancelInFlight()
  t.absent(res.ok, 'no-inflight returns ok:false')
  t.is(res.code, 'NO_INFLIGHT')
  t.is(cancelled.length, 0, 'sdk.cancel NOT called')
  t.absent(events.some((e) => e.e === 'voice:cancelled'), 'no voice:cancelled event')
})

test('voiceCoach cancel-races-begin is a client-side no-op (best-effort)', async (t) => {
  const { sdk, cancelled } = fakeSttSdk()
  const llm = fakeLlmControllable({ requestId: 'req-A' })
  const { emit } = collectEmits()
  const coach = createVoiceCoach({
    chat: fakeChat(),
    sdk,
    sharedLlmHandle: llm,
    emit
  })
  // Cancel BEFORE completion() has been called and requestId assigned.
  const res = await coach.cancelInFlight()
  t.absent(res.ok, 'cancel before begin is a no-op')
  t.is(cancelled.length, 0, 'sdk.cancel not called when no requestId tracked')
})

test('voiceCoach.cancelInFlight aborts a streaming completion', async (t) => {
  const { sdk, cancelled } = fakeSttSdk({
    events: [
      { type: 'text', text: 'should I sub the striker' },
      { type: 'endOfTurn', source: 'whisper' }
    ]
  })
  const llm = fakeLlmControllable({ requestId: 'req-B' })
  const { emit, events } = collectEmits()
  const coach = createVoiceCoach({
    chat: fakeChat(),
    sdk,
    sharedLlmHandle: llm,
    emit
  })
  await coach.startTurn()
  // Wait for STT loop to see the endOfTurn and kick off runCoachPipeline.
  await new Promise((r) => setTimeout(r, 10))
  llm._run.push({ type: 'contentDelta', text: 'Yes ' })
  // Give the coach a tick to capture the requestId from run.
  await new Promise((r) => setTimeout(r, 10))
  t.is(coach.status().inFlightRequestId, 'req-B', 'requestId captured from run')
  const res = await coach.cancelInFlight()
  t.ok(res.ok, 'cancel ok')
  t.is(res.requestId, 'req-B')
  t.is(cancelled.length, 1, 'sdk.cancel called exactly once')
  t.is(cancelled[0].requestId, 'req-B')
  t.ok(events.some((e) => e.e === 'voice:cancelled' && e.p.requestId === 'req-B'), 'voice:cancelled emitted')
  // Finish so the streaming loop exits cleanly.
  llm._run.push({ type: 'completionDone', stopReason: 'cancel' })
  llm._run.end()
})

test('voiceCoach.close() cancels a still-streaming completion before teardown', async (t) => {
  const { sdk, cancelled } = fakeSttSdk({
    events: [
      { type: 'text', text: 'tell me about pressing' },
      { type: 'endOfTurn', source: 'whisper' }
    ]
  })
  const llm = fakeLlmControllable({ requestId: 'req-CLOSE' })
  const { emit } = collectEmits()
  const coach = createVoiceCoach({
    chat: fakeChat(),
    sdk,
    sharedLlmHandle: llm,
    emit
  })
  await coach.startTurn()
  await new Promise((r) => setTimeout(r, 10))
  llm._run.push({ type: 'contentDelta', text: 'partial ' })
  await new Promise((r) => setTimeout(r, 10))
  t.is(coach.status().inFlightRequestId, 'req-CLOSE', 'in-flight tracked')
  await coach.close()
  t.is(cancelled.length, 1, 'close() called cancel')
  t.is(cancelled[0].requestId, 'req-CLOSE')
  // Drain the pipeline so we don't leak the async task after test finish.
  llm._run.end()
})

test('voiceCoach.startTurn auto-cancels the previous in-flight (barge-in)', async (t) => {
  const { sdk, cancelled } = fakeSttSdk({
    events: [
      { type: 'text', text: 'should I sub the striker' },
      { type: 'endOfTurn', source: 'whisper' }
    ]
  })
  const llm = fakeLlmControllable({ requestId: 'req-OLD' })
  const { emit } = collectEmits()
  const coach = createVoiceCoach({
    chat: fakeChat(),
    sdk,
    sharedLlmHandle: llm,
    emit
  })
  await coach.startTurn()
  await new Promise((r) => setTimeout(r, 10))
  llm._run.push({ type: 'contentDelta', text: 'ongoing ' })
  await new Promise((r) => setTimeout(r, 10))
  t.is(coach.status().inFlightRequestId, 'req-OLD', 'first turn in-flight')

  // End turn so turnActive resets — this is required because startTurn is
  // a no-op while turnActive. In production the user's PTT-release triggers
  // this before the next PTT-hold; here we simulate the same order.
  // NOTE: the completion is still streaming, which is what makes barge-in
  // meaningful.
  await coach.endTurn().catch(() => {}) // pipeline already running; this is idempotent
  // Refresh the swappable run to give the second turn a new requestId.
  const nextRun = controllableCompletionRun({ requestId: 'req-NEW' })
  llm.completion = () => nextRun
  llm._run = nextRun
  await coach.startTurn()
  // The barge-in cancel of the previous turn should have fired.
  t.ok(cancelled.length >= 1, 'sdk.cancel called at least once during barge-in')
  t.is(cancelled[0].requestId, 'req-OLD', 'first cancel targeted the old turn')
  await coach.close()
  nextRun.end()
})

test('voiceCoach.cancelInFlight swallows SDK cancel errors', async (t) => {
  const { sdk } = fakeSttSdk({
    events: [
      { type: 'text', text: 'tell me about counter attack' },
      { type: 'endOfTurn', source: 'whisper' }
    ],
    cancelImpl: () => { throw new Error('sdk boom') }
  })
  const llm = fakeLlmControllable({ requestId: 'req-BOOM' })
  const { emit } = collectEmits()
  const coach = createVoiceCoach({
    chat: fakeChat(),
    sdk,
    sharedLlmHandle: llm,
    emit
  })
  await coach.startTurn()
  await new Promise((r) => setTimeout(r, 10))
  llm._run.push({ type: 'contentDelta', text: 'x' })
  await new Promise((r) => setTimeout(r, 10))
  const res = await coach.cancelInFlight()
  t.absent(res.ok, 'ok:false when sdk throws')
  t.is(res.code, 'CANCEL_FAILED')
  llm._run.end()
})

// --- askTheFrame: cancel --------------------------------------------------

function fakeVlm ({ caption = 'A player runs.' } = {}) {
  return { async caption () { return { ok: true, caption } } }
}

test('askTheFrame.cancel is no-op when nothing in flight', async (t) => {
  const { sdk } = fakeSttSdk()
  const af = createAskTheFrame({
    vlm: fakeVlm(),
    sharedLlmHandle: fakeLlmControllable(),
    sdk
  })
  const res = await af.cancel()
  t.absent(res.ok, 'no-inflight returns ok:false')
  t.is(res.code, 'NO_INFLIGHT')
})

test('askTheFrame.cancel aborts a streaming ask', async (t) => {
  const { sdk, cancelled } = fakeSttSdk()
  const llm = fakeLlmControllable({ requestId: 'ask-req-1' })
  const { emit, events } = collectEmits()
  const af = createAskTheFrame({
    vlm: fakeVlm(),
    sharedLlmHandle: llm,
    sdk,
    emit
  })
  // Kick off ask() without awaiting so we can cancel mid-stream.
  const askP = af.ask({ image: 'data:image/png;base64,AAAA', question: 'what is happening' })
  await new Promise((r) => setTimeout(r, 20))
  llm._run.push({ type: 'contentDelta', text: 'A player ' })
  await new Promise((r) => setTimeout(r, 20))
  t.is(af.status().inFlightRequestId, 'ask-req-1', 'requestId captured on ask')
  const cRes = await af.cancel()
  t.ok(cRes.ok, 'cancel ok')
  t.is(cancelled[0].requestId, 'ask-req-1')
  t.ok(events.some((e) => e.e === 'askframe:cancelled'), 'askframe:cancelled emitted')
  // Drain the ask.
  llm._run.push({ type: 'completionDone', stopReason: 'cancel' })
  llm._run.end()
  await askP.catch(() => {})
})

test('askTheFrame.close() cancels an in-flight ask before teardown', async (t) => {
  const { sdk, cancelled } = fakeSttSdk()
  const llm = fakeLlmControllable({ requestId: 'ask-req-2' })
  const { emit } = collectEmits()
  const af = createAskTheFrame({
    vlm: fakeVlm(),
    sharedLlmHandle: llm,
    sdk,
    emit
  })
  const askP = af.ask({ image: 'data:image/png;base64,AAAA', question: 'q?' })
  await new Promise((r) => setTimeout(r, 20))
  llm._run.push({ type: 'contentDelta', text: 'partial ' })
  await new Promise((r) => setTimeout(r, 20))
  await af.close()
  t.is(cancelled.length, 1, 'close called cancel')
  t.is(cancelled[0].requestId, 'ask-req-2')
  llm._run.end()
  await askP.catch(() => {})
})

test('askTheFrame.status exposes hasCancel + inFlightRequestId', async (t) => {
  const { sdk } = fakeSttSdk()
  const af = createAskTheFrame({
    vlm: fakeVlm(),
    sharedLlmHandle: fakeLlmControllable(),
    sdk
  })
  const st = af.status()
  t.ok(st.hasCancel, 'sdk.cancel present -> hasCancel true')
  t.is(st.inFlightRequestId, null, 'no in-flight at rest')
})

// Sanity check: the compiled voiceCoach public surface has cancelInFlight.
test('voiceCoach public surface includes cancelInFlight', async (t) => {
  const { sdk } = fakeSttSdk()
  const coach = createVoiceCoach({
    chat: fakeChat(),
    sdk,
    sharedLlmHandle: fakeLlmControllable()
  })
  t.is(typeof coach.cancelInFlight, 'function')
  t.is(typeof coach.close, 'function')
})

test('askTheFrame public surface includes cancel', async (t) => {
  const { sdk } = fakeSttSdk()
  const af = createAskTheFrame({
    vlm: fakeVlm(),
    sharedLlmHandle: fakeLlmControllable(),
    sdk
  })
  t.is(typeof af.cancel, 'function')
  t.is(typeof af.close, 'function')
})
