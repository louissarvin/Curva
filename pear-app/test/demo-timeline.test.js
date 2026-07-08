// Curva demo automation timeline tests.
//
// The timeline factory is deliberately dependency-injected so we can run the
// whole state machine against pure stub subsystems (no Corestore, no wallet,
// no swarm). All timing checks pass a scaled-down timeline (millisecond
// offsets instead of the canonical minute-scale plan) so the suite runs in
// well under a second.

'use strict'

const test = require('brittle')
const {
  createDemoTimeline,
  timelineFlagEnabled,
  buildTimeline
} = require('../bare/demoTimeline.js')

// -- flag helpers ---------------------------------------------------------

function setFlag(v) {
  if (v === undefined) delete process.env.CURVA_DEMO_AUTOMATION_ENABLED
  else process.env.CURVA_DEMO_AUTOMATION_ENABLED = String(v)
}

// -- stub subsystems ------------------------------------------------------

function makeStubs() {
  const calls = {
    chatSend: [],
    chatGoal: [],
    tipPropose: [],
    predsOpen: [],
    predsSettle: [],
    playheadSet: [],
    announcerSpeak: [],
    commentatorGoal: [],
    logs: [],
    emits: []
  }
  const chat = {
    async send(args) { calls.chatSend.push(args); return args },
    async appendGoal(args) { calls.chatGoal.push(args); return args }
  }
  const tip = {
    async proposeTip(args) { calls.tipPropose.push(args); return { ok: true } }
  }
  const predictions = {
    async openPool(args) {
      calls.predsOpen.push(args)
      return { poolId: 'pool-test-1' }
    },
    async publishSettlement(args) {
      calls.predsSettle.push(args)
      return { poolId: args.poolId, winners: 1, losers: 1, txHash: '' }
    }
  }
  const playhead = {
    async setState(args) { calls.playheadSet.push(args) }
  }
  const announcer = {
    async speak(args) { calls.announcerSpeak.push(args); return null }
  }
  const commentator = {
    async onGoalCluster(args) { calls.commentatorGoal.push(args); return true }
  }
  const log = (level, msg, extra) => { calls.logs.push({ level, msg, extra }) }
  const emit = (event, payload) => { calls.emits.push({ event, payload }) }
  return { chat, tip, predictions, playhead, announcer, commentator, log, emit, calls }
}

// A fast, scaled-down plan used by most tests. Kinds are the same the module
// dispatches on, but the `at` timeline collapses to ~50ms boundaries so tests
// finish instantly.
function fastTimeline() {
  return [
    { at: 0,   kind: 'log', note: 'start' },
    { at: 20,  kind: 'chat.send', note: 'hello',
      args: { text: 'welcome', lang: 'en' } },
    { at: 40,  kind: 'chat.goal', note: 'goal',
      args: { minute: 34, scorer: 'MESSI', team: 'home',
              matchId: 'wc2026-sf2', score: { home: 1, away: 0 } } },
    { at: 60,  kind: 'emit',
      args: { event: 'badge:score-update', payload: { home: 1, away: 0 } } },
    { at: 80,  kind: 'commentator.goal',
      args: { minute: 34, scorer: 'MESSI', team: 'home', matchId: 'wc2026-sf2' } },
    { at: 100, kind: 'announcer.speak',
      args: { matchId: 'wc2026-sf2', minute: 34, scorer: 'MESSI', team: 'home',
              score: { home: 1, away: 0 }, targetLocale: 'id' } },
    { at: 120, kind: 'playhead.set',
      args: { type: 'play', match_time_ms: 0 } },
    { at: 140, kind: 'tip.propose',
      args: { amount: '1000000' } },
    { at: 160, kind: 'predictions.open',
      args: { mode: 'winner-only', entryStakeAtomic: '1000000', matchId: 'wc2026-sf2' } },
    { at: 180, kind: 'predictions.settle',
      args: { matchId: 'wc2026-sf2' } },
    { at: 200, kind: 'log', note: 'end' }
  ]
}

// Wait until predicate() is true or we hit `timeoutMs`. Polls at 5ms so we
// pick up the state right after the setTimeout callback runs.
async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return false
}

// -- tests ----------------------------------------------------------------

test('createDemoTimeline constructs and returns an idle status', (t) => {
  const stubs = makeStubs()
  const tl = createDemoTimeline({ ...stubs, timeline: fastTimeline() })
  const s = tl.status()
  t.is(s.state, 'idle', 'starts idle')
  t.is(s.currentStep, 0, 'currentStep 0')
  t.is(s.totalSteps, 11, 'total steps match fast plan length')
  t.is(s.elapsedMs, 0, 'elapsed 0 pre-start')
})

test('canonical timeline plan has the expected event kinds', (t) => {
  const plan = buildTimeline()
  const kinds = plan.map((e) => e.kind)
  t.ok(kinds.includes('log'), 'log events present')
  t.ok(kinds.includes('chat.send'), 'chat.send events present')
  t.ok(kinds.includes('chat.goal'), 'goal event present')
  t.ok(kinds.includes('playhead.set'), 'playhead.set present')
  t.ok(kinds.includes('emit'), 'emit event present')
  t.ok(kinds.includes('commentator.goal'), 'commentator trigger present')
  t.ok(kinds.includes('announcer.speak'), 'announcer trigger present')
  t.ok(kinds.includes('tip.propose'), 'tip trigger present')
  t.ok(kinds.includes('predictions.open'), 'predictions open present')
  t.ok(kinds.includes('predictions.settle'), 'predictions settle present')
  t.ok(plan.length >= 12, 'at least 12 events for the 3-minute plan')
})

test('start() refuses when flag is off and logs a warn', (t) => {
  setFlag(undefined)
  t.is(timelineFlagEnabled(), false, 'flag off by default')
  const stubs = makeStubs()
  const tl = createDemoTimeline({ ...stubs, timeline: fastTimeline() })
  const res = tl.start()
  t.is(res, null, 'start returns null when flag off')
  const warns = stubs.calls.logs.filter((l) => l.level === 'warn')
  t.ok(warns.length >= 1, 'warn logged')
  t.ok(
    warns.some((l) => String(l.msg).includes('flag off')),
    'warn mentions the flag'
  )
})

test('start() runs full timeline and fires each downstream method exactly once', async (t) => {
  setFlag('true')
  const stubs = makeStubs()
  const tl = createDemoTimeline({ ...stubs, timeline: fastTimeline() })
  const initial = tl.start()
  t.is(initial.state, 'running', 'start returns running state')
  t.is(initial.totalSteps, 11, 'totalSteps carried through')

  const done = await waitFor(() => tl.status().state === 'finished', 2000)
  t.ok(done, 'timeline reaches finished within timeout')

  t.is(stubs.calls.chatSend.length, 1, 'chat.send called once')
  t.is(stubs.calls.chatSend[0].text, 'welcome', 'chat text propagated')
  t.is(stubs.calls.chatSend[0].source_lang, 'en', 'chat lang propagated')
  t.is(stubs.calls.chatGoal.length, 1, 'chat.appendGoal called once')
  t.is(stubs.calls.chatGoal[0].minute, 34, 'goal minute propagated')
  t.is(stubs.calls.chatGoal[0].scorer, 'MESSI', 'goal scorer propagated')
  t.is(stubs.calls.commentatorGoal.length, 1, 'commentator.onGoalCluster called once')
  t.is(stubs.calls.announcerSpeak.length, 1, 'announcer.speak called once')
  t.is(stubs.calls.announcerSpeak[0].targetLocale, 'id', 'announcer locale propagated')
  t.is(stubs.calls.playheadSet.length, 1, 'playhead.setState called once')
  t.is(stubs.calls.playheadSet[0].type, 'play', 'playhead type propagated')
  t.is(stubs.calls.tipPropose.length, 1, 'tip.proposeTip called once')
  t.is(stubs.calls.tipPropose[0].amount, '1000000', 'tip amount propagated')
  t.is(stubs.calls.predsOpen.length, 1, 'predictions.openPool called once')
  t.is(stubs.calls.predsSettle.length, 1, 'predictions.publishSettlement called once')
  t.is(stubs.calls.predsSettle[0].poolId, 'pool-test-1', 'poolId threaded from open -> settle')

  // Ticks emit at every step boundary. We should see one per step plus the
  // initial armed tick and the final finished tick.
  const ticks = stubs.calls.emits.filter((e) => e.event === 'demo:tick')
  t.ok(ticks.length >= 11, 'at least one tick per event fired')
})

test('stop() transitions running to idle and blocks further events', async (t) => {
  setFlag('true')
  const stubs = makeStubs()
  const tl = createDemoTimeline({ ...stubs, timeline: fastTimeline() })
  tl.start()
  t.is(tl.status().state, 'running', 'running after start')
  const preStopChat = stubs.calls.chatSend.length
  tl.stop()
  t.is(tl.status().state, 'idle', 'idle after stop')
  t.is(tl.status().currentStep, 0, 'currentStep reset to 0')
  await new Promise((r) => setTimeout(r, 350))
  // Allow other events (log-only) to record but assert nothing new hit
  // the downstream methods after stop was called.
  t.is(stubs.calls.chatSend.length, preStopChat, 'no chat sends after stop')
  t.is(stubs.calls.tipPropose.length, 0, 'no tip after stop')
  t.is(stubs.calls.predsOpen.length, 0, 'no pool open after stop')
})

test('status() returns running shape while executing', async (t) => {
  setFlag('true')
  const stubs = makeStubs()
  const tl = createDemoTimeline({ ...stubs, timeline: fastTimeline() })
  tl.start()
  // Wait until at least one step has been consumed.
  const stepped = await waitFor(() => tl.status().currentStep >= 1, 1000)
  t.ok(stepped, 'step counter advances')
  const mid = tl.status()
  t.is(mid.state, 'running', 'state running mid-flight')
  t.ok(mid.elapsedMs >= 0, 'elapsedMs non-negative')
  t.is(mid.totalSteps, 11, 'totalSteps stable')
  tl.stop()
})

test('drift correction: skipped clock still fires missed events immediately', async (t) => {
  setFlag('true')
  // We build a fake clock that jumps 500ms mid-run so multiple "past-due"
  // events must fire without being silently dropped. The scheduler recomputes
  // delay as `max(0, at - elapsed)`; when the jump lands us past the next
  // event, delay is 0 and the event fires on the immediate tick.
  let base = 1_000_000
  const clock = () => base
  const stubs = makeStubs()
  const tl = createDemoTimeline({
    ...stubs,
    now: clock,
    timeline: fastTimeline()
  })
  tl.start()
  // Let the first (log at 0) event dispatch, then jump the clock forward
  // past the chat.send + chat.goal + emit + commentator + announcer events.
  await new Promise((r) => setTimeout(r, 30))
  base += 500 // wall-clock jump
  const done = await waitFor(() => tl.status().state === 'finished', 2000)
  t.ok(done, 'timeline reaches finished after clock jump')
  // All downstream methods still hit exactly once, no missed events.
  t.is(stubs.calls.chatSend.length, 1, 'chat.send still fires after skip')
  t.is(stubs.calls.chatGoal.length, 1, 'goal still fires after skip')
  t.is(stubs.calls.announcerSpeak.length, 1, 'announcer still fires after skip')
  t.is(stubs.calls.playheadSet.length, 1, 'playhead still fires after skip')
  t.is(stubs.calls.tipPropose.length, 1, 'tip still fires after skip')
  t.is(stubs.calls.predsOpen.length, 1, 'pool open still fires after skip')
  t.is(stubs.calls.predsSettle.length, 1, 'settle still fires after skip')
})

test('individual event failures do not abort the timeline', async (t) => {
  setFlag('true')
  const stubs = makeStubs()
  // Break chat.send so its call throws. Every other step should still run.
  stubs.chat.send = async () => { throw new Error('chat down') }
  const tl = createDemoTimeline({ ...stubs, timeline: fastTimeline() })
  tl.start()
  const done = await waitFor(() => tl.status().state === 'finished', 2000)
  t.ok(done, 'timeline still finishes when chat.send throws')
  t.is(stubs.calls.chatGoal.length, 1, 'goal event still fired after chat failure')
  t.is(stubs.calls.predsSettle.length, 1, 'settle still fired after chat failure')
  const warns = stubs.calls.logs.filter((l) =>
    l.level === 'warn' && String(l.msg).includes('step failed'))
  t.ok(warns.length >= 1, 'warn logged for the failing step')
})

test('start() while already running is a no-op that returns current status', async (t) => {
  setFlag('true')
  const stubs = makeStubs()
  const tl = createDemoTimeline({ ...stubs, timeline: fastTimeline() })
  tl.start()
  const second = tl.start()
  t.is(second.state, 'running', 'second start reports running')
  t.is(stubs.calls.chatSend.length, 0, 'no duplicate side-effects fired synchronously')
  tl.stop()
})

test('cleanup', (t) => {
  setFlag(undefined)
  t.pass('reset env')
})
