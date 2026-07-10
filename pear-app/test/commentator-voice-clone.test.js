// Ship 3 F5 brittle tests: commentator voice-clone TTS routing.
//
// Mirrors the shape of test/voice-clone-goal-pipeline.test.js but exercises
// the session-shaped router used by bare/commentator.js runTrigger. Routes to
// voiceClone.speakStream for allowlisted locales, falls back to
// announcer.openSpeakStream for everything else (locale not in Chatterbox
// allowlist, missing voiceClone handle, or voiceClone throwing).
//
// Docs-verification memo:
//   - VOICE_CLONE_ALLOWED matches Chatterbox languages verified against
//     node_modules/@qvac/sdk/dist/schemas/text-to-speech.d.ts:2 (fetched
//     2026-07-10).
//   - voiceClone.speakStream contract: bare/voiceClone.js:434 returns
//     `{ chunks: AsyncIterable<{buffer,sampleRate,done}>, end, destroy }` or
//     null.
//   - announcer.openSpeakStream contract: bare/announcer.js:615 returns
//     `{ write, end, destroy, chunks }` or null.

const test = require('brittle')

const {
  routeTts,
  VOICE_CLONE_ALLOWED,
  commentatorVoiceCloneFlagEnabled
} = require('../bare/commentator.js')

// -- fakes -----------------------------------------------------------------

function makeAnnouncer (events, { throwOnOpen = false } = {}) {
  return {
    async openSpeakStream ({ locale }) {
      if (throwOnOpen) throw new Error('announcer offline')
      events.push({ type: 'announcer-open', locale })
      return {
        write (chunk) { events.push({ type: 'announcer-write', locale, chunk }) },
        end () { events.push({ type: 'announcer-end', locale }) },
        destroy () { events.push({ type: 'announcer-destroy', locale }) },
        chunks: (async function * () {
          yield { buffer: [1], chunkIndex: 0, done: true }
        })()
      }
    }
  }
}

function makeVoiceClone ({
  throwOnSpeakStream = false,
  returnNull = false,
  enrolled = true
} = {}) {
  const calls = []
  return {
    calls,
    status () { return { enrolled, ready: true, flagEnabled: true } },
    async speakStream (text, locale) {
      calls.push({ text, locale })
      if (throwOnSpeakStream) throw new Error('chatterbox down')
      if (returnNull) return null
      return {
        chunks: (async function * () {
          yield { buffer: [1, 2, 3], sampleRate: 24000, done: false }
          yield { buffer: [4, 5, 6], sampleRate: 24000, done: true }
        })(),
        end () {},
        destroy () {}
      }
    },
    // Ensure a `speak` presence for routes that check `speak` (not required by
    // routeTts, but matches the real API surface).
    async speak () { return null }
  }
}

function makeEmitter () {
  const events = []
  return {
    emit: (name, payload) => events.push({ name, payload }),
    events
  }
}

// -- VOICE_CLONE_ALLOWED matches the Chatterbox safe set --------------------

test('VOICE_CLONE_ALLOWED matches the six-language safe set', async (t) => {
  t.ok(VOICE_CLONE_ALLOWED.has('en'), 'en allowed')
  t.ok(VOICE_CLONE_ALLOWED.has('it'), 'it allowed')
  t.ok(VOICE_CLONE_ALLOWED.has('es'), 'es allowed')
  t.ok(VOICE_CLONE_ALLOWED.has('fr'), 'fr allowed')
  t.ok(VOICE_CLONE_ALLOWED.has('de'), 'de allowed')
  t.ok(VOICE_CLONE_ALLOWED.has('pt'), 'pt allowed')
  t.absent(VOICE_CLONE_ALLOWED.has('id'), 'id (Indonesian) NOT in Chatterbox set')
})

test('commentatorVoiceCloneFlagEnabled reads env flag correctly', async (t) => {
  const orig = process.env.CURVA_COMMENTATOR_VOICE_CLONE_ENABLED
  try {
    process.env.CURVA_COMMENTATOR_VOICE_CLONE_ENABLED = 'true'
    t.is(commentatorVoiceCloneFlagEnabled(), true, 'true')
    process.env.CURVA_COMMENTATOR_VOICE_CLONE_ENABLED = 'false'
    t.is(commentatorVoiceCloneFlagEnabled(), false, 'false')
    delete process.env.CURVA_COMMENTATOR_VOICE_CLONE_ENABLED
    t.is(commentatorVoiceCloneFlagEnabled(), null, 'null (auto)')
  } finally {
    if (orig === undefined) delete process.env.CURVA_COMMENTATOR_VOICE_CLONE_ENABLED
    else process.env.CURVA_COMMENTATOR_VOICE_CLONE_ENABLED = orig
  }
})

// -- routeTts core --------------------------------------------------------

test('routeTts picks voiceClone for an allowlisted locale + enrolled', async (t) => {
  const vc = makeVoiceClone({ enrolled: true })
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const { emit, events } = makeEmitter()

  const routed = await routeTts(vc, announcer, 'en', () => {}, emit)
  t.is(routed.via, 'voiceClone', 'voiceClone chosen')
  t.ok(routed.session, 'session returned')

  const openEvt = events.find((e) => e.name === 'commentator:tts-open')
  t.ok(openEvt, 'tts-open emitted')
  t.is(openEvt.payload.via, 'voiceClone', 'tts-open carries via: voiceClone')
  t.is(openEvt.payload.locale, 'en', 'locale forwarded on tts-open')

  // Feed a chunk, end, and drain chunks.
  routed.session.write('Hello ')
  routed.session.write('world.')
  routed.session.end()
  const collected = []
  for await (const c of routed.session.chunks) collected.push(c)
  t.ok(collected.length >= 1, 'chunks drained')
  t.is(vc.calls.length, 1, 'voiceClone.speakStream called exactly once')
  t.is(vc.calls[0].text, 'Hello world.', 'full buffered text forwarded')
  t.is(vc.calls[0].locale, 'en', 'locale forwarded')
  t.is(announcerEvents.length, 0, 'announcer NOT opened')
})

test('routeTts falls back to announcer for locale not in Chatterbox (id)', async (t) => {
  const vc = makeVoiceClone({ enrolled: true })
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const { emit, events } = makeEmitter()

  const routed = await routeTts(vc, announcer, 'id', () => {}, emit)
  t.is(routed.via, 'announcer', 'announcer chosen for id')
  t.is(vc.calls.length, 0, 'voiceClone NOT called for id')
  t.ok(announcerEvents.some((e) => e.type === 'announcer-open'), 'announcer opened')
  const openEvt = events.find((e) => e.name === 'commentator:tts-open')
  t.is(openEvt.payload.via, 'announcer', 'tts-open carries via: announcer')
})

test('routeTts falls back to announcer when voiceClone is null', async (t) => {
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const { emit, events } = makeEmitter()
  const routed = await routeTts(null, announcer, 'en', () => {}, emit)
  t.is(routed.via, 'announcer', 'null voiceClone falls back')
  t.ok(routed.session, 'announcer session returned')
  t.ok(announcerEvents.some((e) => e.type === 'announcer-open'), 'announcer opened')
})

test('routeTts falls back to announcer when voiceClone.status.enrolled is false', async (t) => {
  const vc = makeVoiceClone({ enrolled: false })
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const { emit } = makeEmitter()
  const routed = await routeTts(vc, announcer, 'en', () => {}, emit)
  t.is(routed.via, 'announcer', 'unenrolled voiceClone falls back')
  t.is(vc.calls.length, 0, 'voiceClone.speakStream NOT called')
})

test('routeTts falls back gracefully when voiceClone.speakStream throws', async (t) => {
  const vc = makeVoiceClone({ enrolled: true, throwOnSpeakStream: true })
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const { emit, events } = makeEmitter()

  const routed = await routeTts(vc, announcer, 'en', () => {}, emit)
  t.is(routed.via, 'voiceClone', 'still selects voiceClone route')
  t.ok(routed.session, 'session returned')

  // Trigger the throw via end() then observe: consumer sees the fallback event
  // and the chunks iterator completes without error.
  routed.session.write('boom')
  routed.session.end()
  const drained = []
  for await (const c of routed.session.chunks) drained.push(c)
  // No successful chunks, and the fallback event fires from within pumpVoiceClone.
  const fallback = events.find((e) => e.name === 'commentator:tts-fallback')
  t.ok(fallback, 'tts-fallback emitted when voiceClone throws')
  t.is(fallback.payload.reason, 'threw', 'reason: threw')
})

test('routeTts fallback event fires when voiceClone.speakStream returns null', async (t) => {
  const vc = makeVoiceClone({ enrolled: true, returnNull: true })
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const { emit, events } = makeEmitter()

  const routed = await routeTts(vc, announcer, 'en', () => {}, emit)
  t.is(routed.via, 'voiceClone', 'voiceClone route selected')
  routed.session.write('hello')
  routed.session.end()
  const drained = []
  for await (const c of routed.session.chunks) drained.push(c)
  const fallback = events.find((e) => e.name === 'commentator:tts-fallback')
  t.ok(fallback, 'tts-fallback emitted')
  t.is(fallback.payload.reason, 'skipped', 'reason: skipped')
})

test('routeTts emits `via` field on tts-open events for both paths', async (t) => {
  {
    const vc = makeVoiceClone({ enrolled: true })
    const { emit, events } = makeEmitter()
    await routeTts(vc, makeAnnouncer([]), 'en', () => {}, emit)
    const openEvts = events.filter((e) => e.name === 'commentator:tts-open')
    t.ok(openEvts.length >= 1, 'tts-open present for voiceClone path')
    t.ok(openEvts.every((e) => typeof e.payload.via === 'string'), 'every tts-open has via')
    t.is(openEvts[0].payload.via, 'voiceClone', 'voiceClone via')
  }
  {
    const { emit, events } = makeEmitter()
    await routeTts(null, makeAnnouncer([]), 'en', () => {}, emit)
    const openEvt = events.find((e) => e.name === 'commentator:tts-open')
    t.is(openEvt.payload.via, 'announcer', 'announcer via')
  }
})

test('routeTts returns null session when neither voiceClone nor announcer usable', async (t) => {
  const { emit } = makeEmitter()
  const routed = await routeTts(null, null, 'en', () => {}, emit)
  t.is(routed.session, null, 'no session')
  t.is(routed.ok, false, 'ok=false')
})
