// Curva demo automation timeline.
//
// A single-button "run the whole 3 minute demo" driver. Every action here is
// a passthrough into an ALREADY-SHIPPED code path (chat.send, chat.appendGoal,
// tip.proposeTip, predictions.openPool/publishSettlement, playhead.setState,
// announcer.speak, commentator.onGoalCluster). No new tip flows, no new
// prediction methods, no new chat types are introduced. This module is a
// stage-safety net so the presenter does not need to hit 20 different buttons
// under pressure at the July 15 Cup Final pitch.
//
// Feature-flagged by CURVA_DEMO_AUTOMATION_ENABLED. Production default is
// false. When the flag is off, start() returns null and logs a warn line.
//
// Drift correction. setTimeout on Node/Bare can drift by hundreds of ms over
// a 3-minute run (event-loop pressure, model loads, GC). We recompute the
// delay for the next event on every tick using a monotonic clock (opts.now
// or Date.now) so the schedule stays anchored to wall-clock offsets from
// t=0. If an event misses its slot (elapsedMs already past its `at`), we
// fire it immediately rather than skipping. Missed events are forbidden.

'use strict'

const DEMO_MATCH_ID = 'wc2026-sf2'

function timelineFlagEnabled() {
  try {
    const v = (typeof process !== 'undefined' && process.env
      && process.env.CURVA_DEMO_AUTOMATION_ENABLED) || ''
    return String(v).toLowerCase() === 'true'
  } catch { return false }
}

/**
 * Build the ordered event list. Times are in ms from t=0. Kept in a builder
 * so callers can inspect the plan (tests + status()) without running it.
 *
 * @param {object} ctx  context for label interpolation only. All method
 *                      invocations happen at play time.
 */
function buildTimeline() {
  return [
    { at: 0,        kind: 'log',            note: 'demo:timeline start' },
    { at: 3_000,    kind: 'chat.send',      note: 'welcome-message',
      args: { text: 'Curva Nord Jakarta welcomes Curva Sud Torino', lang: 'en' } },
    { at: 8_000,    kind: 'chat.send',      note: 'kickoff-notice',
      args: { text: 'SF2 kicks off in 15 minutes', lang: 'en' } },
    { at: 15_000,   kind: 'playhead.set',   note: 'kickoff-play',
      args: { type: 'play', match_time_ms: 0 } },
    { at: 45_000,   kind: 'chat.goal',      note: 'goal-34',
      args: { minute: 34, scorer: 'MESSI', team: 'home', matchId: DEMO_MATCH_ID,
              score: { home: 1, away: 0 }, goalId: 'demo-msg-34' } },
    { at: 48_000,   kind: 'emit',           note: 'badge-score',
      args: { event: 'badge:score-update', payload: { home: 1, away: 0 } } },
    { at: 50_000,   kind: 'emit',           note: 'badge-flash',
      args: { event: 'badge:goal-flash', payload: {} } },
    { at: 55_000,   kind: 'commentator.goal', note: 'commentator-trigger',
      args: { minute: 34, scorer: 'MESSI', team: 'home', matchId: DEMO_MATCH_ID } },
    { at: 80_000,   kind: 'chat.send',      note: 'peer-id-msg',
      args: { text: 'GOOOL untuk semua Nusantara!', lang: 'id' } },
    { at: 88_000,   kind: 'announcer.speak', note: 'tts-id',
      args: { matchId: DEMO_MATCH_ID, minute: 34, scorer: 'MESSI', team: 'home',
              score: { home: 1, away: 0 }, targetLocale: 'id' } },
    { at: 105_000,  kind: 'tip.propose',    note: 'cross-pillar-tip',
      args: { amount: '1000000' } }, // 1 USDT in base units
    { at: 120_000,  kind: 'predictions.open', note: 'pool-open',
      args: { mode: 'winner-only', entryStakeAtomic: '1000000',
              matchId: DEMO_MATCH_ID } },
    { at: 140_000,  kind: 'predictions.settle', note: 'pool-settle',
      args: { matchId: DEMO_MATCH_ID } },
    { at: 155_000,  kind: 'chat.send',      note: 'mcp-agent-msg',
      args: { text: 'via MCP: curva-mcp agent joined', lang: 'en' } },
    { at: 175_000,  kind: 'log',            note: 'demo:timeline end' }
  ]
}

/**
 * Factory. Returns a small state-machine object with start/stop/status.
 *
 * @param {object} deps
 * @param {object} deps.room        room handle (used only for isHost gate)
 * @param {object} deps.chat        must expose send + appendGoal
 * @param {object} [deps.tip]       optional; proposeTip is invoked when present
 * @param {object} [deps.predictions]  optional; openPool + publishSettlement
 * @param {object} [deps.attendance]   optional; used only for logging today
 * @param {object} [deps.announcer]    optional; speak is invoked when present
 * @param {object} [deps.commentator]  optional; onGoalCluster is invoked
 * @param {object} deps.playhead    must expose setState
 * @param {(level:string,msg:string,extra?:object)=>void} [deps.log]
 * @param {(event:string,payload:object)=>void} [deps.emit]
 * @param {()=>number} [deps.now]   injectable clock for tests + drift math
 * @param {Array} [deps.timeline]  test-only override; when omitted the
 *                                 canonical 15-event 3-minute plan is used.
 */
function createDemoTimeline(deps = {}) {
  const {
    room = null,
    chat = null,
    tip = null,
    predictions = null,
    attendance = null,
    announcer = null,
    commentator = null,
    playhead = null,
    log = () => {},
    emit = () => {},
    now = () => Date.now(),
    timeline: timelineOverride = null
  } = deps

  if (attendance) { /* referenced for future extension; keep lint quiet */ }
  if (room) { /* room is passed for isHost, never mutated */ }

  const timeline = Array.isArray(timelineOverride) && timelineOverride.length > 0
    ? timelineOverride
    : buildTimeline()
  const totalSteps = timeline.length

  const state = {
    phase: 'idle',            // 'idle' | 'running' | 'finished'
    startedAtMs: 0,
    currentStep: 0,
    timer: null,
    aborted: false,
    lastOpenedPoolId: null,   // captured from predictions.open for settle
    // Sticky record of what the last emitted tick looked like so callers can
    // ping status() without racing the setTimeout callback.
    lastTickAt: 0
  }

  function safeLog(level, msg, extra) {
    try { log(level, msg, extra) } catch { /* ignore logger faults */ }
  }

  function safeEmit(event, payload) {
    try { emit(event, payload) } catch { /* ignore emit faults */ }
  }

  function elapsedMs() {
    if (state.phase === 'idle') return 0
    return Math.max(0, now() - state.startedAtMs)
  }

  function emitStatusTick() {
    state.lastTickAt = now()
    safeEmit('demo:tick', {
      state: state.phase,
      elapsedMs: elapsedMs(),
      currentStep: state.currentStep,
      totalSteps
    })
  }

  async function runOne(event) {
    // Every branch below is try/catched. A single failure logs a warn and the
    // outer scheduler proceeds to the next event. The presenter must NEVER
    // see a dead run because tips are misconfigured or the announcer flag
    // is off.
    try {
      switch (event.kind) {
        case 'log':
          safeLog('info', event.note)
          return

        case 'chat.send': {
          if (!chat || typeof chat.send !== 'function') return
          await chat.send({
            text: event.args.text,
            match_time_ms: Math.floor(elapsedMs()),
            source_lang: event.args.lang,
            lang: event.args.lang
          })
          return
        }

        case 'chat.goal': {
          if (!chat || typeof chat.appendGoal !== 'function') return
          await chat.appendGoal({
            matchId: event.args.matchId,
            minute: event.args.minute,
            scorer: event.args.scorer,
            team: event.args.team,
            score: event.args.score,
            goalId: event.args.goalId
          })
          return
        }

        case 'emit':
          safeEmit(event.args.event, event.args.payload || {})
          return

        case 'commentator.goal': {
          if (!commentator || typeof commentator.onGoalCluster !== 'function') return
          await commentator.onGoalCluster({
            minute: event.args.minute,
            scorer: event.args.scorer,
            team: event.args.team,
            matchId: event.args.matchId
          })
          return
        }

        case 'announcer.speak': {
          if (!announcer || typeof announcer.speak !== 'function') return
          await announcer.speak(event.args)
          return
        }

        case 'playhead.set': {
          if (!playhead || typeof playhead.setState !== 'function') return
          await playhead.setState({
            type: event.args.type,
            match_time_ms: event.args.match_time_ms
          })
          return
        }

        case 'tip.propose': {
          if (!tip || typeof tip.proposeTip !== 'function') return
          await tip.proposeTip({ amount: event.args.amount })
          return
        }

        case 'predictions.open': {
          if (!predictions || typeof predictions.openPool !== 'function') return
          // deadlineMs must be at least 60s in future per predictions.js gate.
          const opened = await predictions.openPool({
            matchId: event.args.matchId,
            mode: event.args.mode,
            entryStakeAtomic: event.args.entryStakeAtomic,
            deadlineMs: now() + 20 * 60_000
          })
          state.lastOpenedPoolId = opened?.poolId || null
          return
        }

        case 'predictions.settle': {
          if (!predictions || typeof predictions.publishSettlement !== 'function') return
          if (!state.lastOpenedPoolId) {
            safeLog('warn', 'demo:timeline settle skipped, no poolId')
            return
          }
          await predictions.publishSettlement({
            poolId: state.lastOpenedPoolId,
            matchId: event.args.matchId,
            winners: [{ handle: 'jakarta' }],
            losers: [{ handle: 'torino' }],
            tx: ''
          })
          return
        }

        default:
          safeLog('warn', 'demo:timeline unknown event kind', { kind: event.kind })
      }
    } catch (err) {
      safeLog('warn', 'demo:timeline step failed', {
        step: state.currentStep,
        kind: event.kind,
        note: event.note,
        message: err && err.message
      })
    }
  }

  function scheduleNext() {
    if (state.aborted) return
    if (state.currentStep >= totalSteps) {
      state.phase = 'finished'
      emitStatusTick()
      safeLog('info', 'demo:timeline complete', { totalSteps })
      return
    }
    const nextEvent = timeline[state.currentStep]
    const elapsed = elapsedMs()
    // Drift correction: compute delay relative to the anchored start time.
    // If elapsed already exceeds the target `at`, fire immediately (delay 0).
    const delay = Math.max(0, nextEvent.at - elapsed)
    state.timer = setTimeout(async () => {
      if (state.aborted) return
      const current = timeline[state.currentStep]
      state.currentStep += 1
      emitStatusTick()
      await runOne(current)
      if (!state.aborted) scheduleNext()
    }, delay)
  }

  function start() {
    if (!timelineFlagEnabled()) {
      safeLog('warn', 'demo:timeline start refused, flag off')
      return null
    }
    if (state.phase === 'running') {
      safeLog('warn', 'demo:timeline start ignored, already running')
      return { state: 'running', elapsedMs: elapsedMs(), currentStep: state.currentStep, totalSteps }
    }
    // Idempotent reset. Allows a "finished" run to be started again for a
    // second take (host may retry after a hiccup).
    state.aborted = false
    state.currentStep = 0
    state.startedAtMs = now()
    state.phase = 'running'
    state.lastOpenedPoolId = null
    safeLog('info', 'demo:timeline armed', { totalSteps })
    emitStatusTick()
    scheduleNext()
    return { state: state.phase, elapsedMs: 0, currentStep: 0, totalSteps }
  }

  function stop() {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    state.aborted = true
    state.phase = 'idle'
    state.currentStep = 0
    state.startedAtMs = 0
    state.lastOpenedPoolId = null
    safeLog('info', 'demo:timeline stopped')
    emitStatusTick()
    return { state: 'idle', elapsedMs: 0, currentStep: 0, totalSteps }
  }

  function status() {
    return {
      state: state.phase,
      elapsedMs: elapsedMs(),
      currentStep: state.currentStep,
      totalSteps
    }
  }

  return { start, stop, status }
}

module.exports = {
  createDemoTimeline,
  timelineFlagEnabled,
  buildTimeline,
  DEMO_MATCH_ID
}
