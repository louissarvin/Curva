// QVAC Ship 3 F1 brittle tests: goal pipeline voice-clone routing.
//
// Verifies the extension to bare/goalPipeline.js that routes per-locale TTS
// through bare/voiceClone.speak when a handle is passed AND the locale is in
// the Chatterbox allowlist. Falls back to announcer.openSpeakStream in every
// other case. Never crashes the pipeline on voiceClone errors.
//
// Docs-verification memo:
//   - Chatterbox languages: pear-app/node_modules/@qvac/sdk/dist/schemas/
//     text-to-speech.d.ts:2 (fetched 2026-07-10). Curva Ship 3 widens the
//     allowlist to EN, IT, ES, FR, DE, PT — all members of that literal.
//   - voiceClone.speak() contract: bare/voiceClone.js:344 returns
//     `{ samples, sampleRate, locale }` on success or null on skip/failure.
//   - announcer.openSpeakStream() contract: bare/announcer.js:615 returns
//     `{ write, end, destroy, chunks }` or null.

const test = require('brittle')

const {
  createGoalPipeline,
  VOICE_CLONE_ALLOWED,
  _internal: { routeTts }
} = require('../bare/goalPipeline.js')

// -- fakes -----------------------------------------------------------------

function makeOcr (blocks) {
  return {
    async read () {
      return { ok: true, blocks, durationMs: 5 }
    }
  }
}

function makeGoalCard (card) {
  return { async parse () { return { ok: true, card } } }
}

function makeAnnouncer (events) {
  return {
    async openSpeakStream ({ locale }) {
      events.push({ type: 'announcer-open', locale })
      return {
        write () {},
        end () { events.push({ type: 'announcer-end', locale }) },
        destroy () {},
        chunks: (async function * () {
          yield { buffer: [1], chunkIndex: 0, done: true }
        })()
      }
    }
  }
}

function makeVoiceClone ({ throwOnSpeak = false, returnNull = false } = {}) {
  const calls = []
  return {
    calls,
    async speak (text, locale) {
      calls.push({ text, locale })
      if (throwOnSpeak) throw new Error('chatterbox down')
      if (returnNull) return null
      return { samples: [1, 2, 3, 4], sampleRate: 24000, locale }
    }
  }
}

function makeChat (received) {
  return { async sendSystem (payload) { received.push(payload) } }
}

function makeEmitter () {
  const events = []
  return {
    emit: (name, payload) => events.push({ name, payload }),
    events
  }
}

// -- Ship 3 F1 --------------------------------------------------------------

test('VOICE_CLONE_ALLOWED matches the six-language safe set', async (t) => {
  t.ok(VOICE_CLONE_ALLOWED.has('en'), 'en allowed')
  t.ok(VOICE_CLONE_ALLOWED.has('it'), 'it allowed')
  t.ok(VOICE_CLONE_ALLOWED.has('es'), 'es allowed')
  t.ok(VOICE_CLONE_ALLOWED.has('fr'), 'fr allowed')
  t.ok(VOICE_CLONE_ALLOWED.has('de'), 'de allowed')
  t.ok(VOICE_CLONE_ALLOWED.has('pt'), 'pt allowed')
  t.absent(VOICE_CLONE_ALLOWED.has('id'), 'id (Indonesian) NOT in Chatterbox set')
  t.absent(VOICE_CLONE_ALLOWED.has('zh'), 'zh excluded from Curva Ship 3 safe set')
})

test('routeTts picks voiceClone for an allowlisted locale', async (t) => {
  const vc = makeVoiceClone()
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const { emit, events } = makeEmitter()
  const out = await routeTts(vc, announcer, 'en', 'Goal!', () => {}, emit)
  t.is(out.via, 'voiceClone', 'voiceClone chosen')
  t.is(vc.calls.length, 1, 'voiceClone.speak called once')
  t.is(vc.calls[0].locale, 'en', 'locale forwarded')
  t.is(announcerEvents.length, 0, 'announcer NOT opened')
  const names = events.map((e) => e.name)
  t.ok(names.includes('goalpipe:tts-open'), 'tts-open emitted')
  t.ok(names.includes('goalpipe:tts-end'), 'tts-end emitted')
  const openEvt = events.find((e) => e.name === 'goalpipe:tts-open')
  t.is(openEvt.payload.via, 'voiceClone', 'tts-open carries via: voiceClone')
})

test('routeTts falls back to announcer for a locale not in Chatterbox', async (t) => {
  const vc = makeVoiceClone()
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const { emit, events } = makeEmitter()
  const out = await routeTts(vc, announcer, 'id', 'Gol!', () => {}, emit)
  t.is(out.via, 'announcer', 'announcer chosen for id')
  t.is(vc.calls.length, 0, 'voiceClone.speak NOT called for id')
  t.ok(announcerEvents.some((e) => e.type === 'announcer-open'), 'announcer opened')
  const openEvt = events.find((e) => e.name === 'goalpipe:tts-open')
  t.is(openEvt.payload.via, 'announcer', 'tts-open carries via: announcer')
})

test('routeTts falls back to announcer when voiceClone is null', async (t) => {
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const { emit, events } = makeEmitter()
  const out = await routeTts(null, announcer, 'en', 'Goal!', () => {}, emit)
  t.is(out.via, 'announcer', 'null voiceClone falls back to announcer')
  t.ok(announcerEvents.some((e) => e.type === 'announcer-open'), 'announcer opened')
  const openEvt = events.find((e) => e.name === 'goalpipe:tts-open')
  t.is(openEvt.payload.via, 'announcer', 'via: announcer')
})

test('routeTts does not crash when voiceClone.speak throws', async (t) => {
  const vc = makeVoiceClone({ throwOnSpeak: true })
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const { emit, events } = makeEmitter()
  const out = await routeTts(vc, announcer, 'en', 'Goal!', () => {}, emit)
  t.is(out.via, 'announcer', 'thrown voiceClone falls back to announcer')
  t.is(vc.calls.length, 1, 'voiceClone was attempted')
  t.ok(announcerEvents.some((e) => e.type === 'announcer-open'), 'announcer opened after fallback')
  const fallback = events.find((e) => e.name === 'goalpipe:tts-fallback')
  t.ok(fallback, 'tts-fallback event emitted')
  t.is(fallback.payload.reason, 'threw', 'fallback reason: threw')
})

test('routeTts falls back when voiceClone.speak returns null', async (t) => {
  const vc = makeVoiceClone({ returnNull: true })
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const { emit, events } = makeEmitter()
  const out = await routeTts(vc, announcer, 'en', 'Goal!', () => {}, emit)
  t.is(out.via, 'announcer', 'null-return voiceClone falls back to announcer')
  const fallback = events.find((e) => e.name === 'goalpipe:tts-fallback')
  t.ok(fallback, 'tts-fallback event emitted')
  t.is(fallback.payload.reason, 'skipped', 'fallback reason: skipped')
})

// -- Integration through createGoalPipeline --------------------------------

test('createGoalPipeline routes per-locale via voiceClone when eligible', async (t) => {
  const vc = makeVoiceClone()
  const announcerEvents = []
  const chatReceived = []
  const emitter = makeEmitter()

  const pipeline = createGoalPipeline({
    ocr: makeOcr([{ text: 'ITA 2 - 1 FRA', confidence: 0.9 }]),
    goalCard: makeGoalCard({ minute: 34, scorer: 'Kean', team: 'Italy', assist: null }),
    mcp: null,
    translate: null,
    announcer: makeAnnouncer(announcerEvents),
    voiceClone: vc,
    chat: makeChat(chatReceived),
    roomSlug: 'demo',
    locales: ['en', 'it', 'id'],
    emit: emitter.emit,
    flagOverride: true
  })

  const res = await pipeline.trigger({
    image: Buffer.from([1]),
    currentScore: { home: 1, away: 1 }
  })

  t.is(res.ok, true, 'pipeline succeeds end-to-end')
  const perLocale = res.speak.reduce((acc, r) => { acc[r.locale] = r.via; return acc }, {})
  t.is(perLocale.en, 'voiceClone', 'en routed to voiceClone')
  t.is(perLocale.it, 'voiceClone', 'it routed to voiceClone')
  t.is(perLocale.id, 'announcer', 'id fell back to announcer')

  // voiceClone got exactly two invocations (en + it), announcer got one (id).
  t.is(vc.calls.length, 2, 'voiceClone.speak called for two allowlisted locales')
  const announcerOpens = announcerEvents.filter((e) => e.type === 'announcer-open')
  t.is(announcerOpens.length, 1, 'announcer opened only for id')
  t.is(announcerOpens[0].locale, 'id', 'announcer opened for id')
})

test('createGoalPipeline does not crash when voiceClone throws — falls back', async (t) => {
  const vc = makeVoiceClone({ throwOnSpeak: true })
  const announcerEvents = []
  const pipeline = createGoalPipeline({
    ocr: makeOcr([{ text: 'ITA 2 - 1 FRA', confidence: 0.9 }]),
    goalCard: makeGoalCard({ minute: 34, scorer: 'K', team: 'I', assist: null }),
    announcer: makeAnnouncer(announcerEvents),
    voiceClone: vc,
    chat: makeChat([]),
    locales: ['en'],
    flagOverride: true
  })
  const res = await pipeline.trigger({ image: Buffer.from([1]) })
  t.is(res.ok, true, 'pipeline still succeeds')
  t.is(res.speak[0].via, 'announcer', 'fell back to announcer')
})

test('createGoalPipeline without voiceClone behaves as before (all announcer)', async (t) => {
  const announcerEvents = []
  const pipeline = createGoalPipeline({
    ocr: makeOcr([{ text: 'ITA 3 - 1 FRA', confidence: 0.9 }]),
    goalCard: makeGoalCard({ minute: 42, scorer: 'K', team: 'I', assist: null }),
    announcer: makeAnnouncer(announcerEvents),
    voiceClone: null,
    chat: makeChat([]),
    locales: ['en', 'it'],
    flagOverride: true
  })
  const res = await pipeline.trigger({ image: Buffer.from([1]) })
  t.is(res.ok, true)
  for (const r of res.speak) t.is(r.via, 'announcer', r.locale + ' via announcer')
})

test('voiceClone module exports the widened allowlist including es/fr/de/pt', async (t) => {
  const vc = require('../bare/voiceClone.js')
  t.ok(vc.ALLOWED_CLONE_LOCALES.has('en'))
  t.ok(vc.ALLOWED_CLONE_LOCALES.has('it'))
  t.ok(vc.ALLOWED_CLONE_LOCALES.has('es'))
  t.ok(vc.ALLOWED_CLONE_LOCALES.has('fr'))
  t.ok(vc.ALLOWED_CLONE_LOCALES.has('de'))
  t.ok(vc.ALLOWED_CLONE_LOCALES.has('pt'))
  t.absent(vc.ALLOWED_CLONE_LOCALES.has('id'), 'id (Indonesian) still refused')
})

test('voiceClone.normaliseLocale accepts the widened set', async (t) => {
  const { normaliseLocale } = require('../bare/voiceClone.js')
  t.is(normaliseLocale('en'), 'en')
  t.is(normaliseLocale('ES'), 'es', 'case-insensitive')
  t.is(normaliseLocale('fr'), 'fr')
  t.is(normaliseLocale('de'), 'de')
  t.is(normaliseLocale('pt'), 'pt')
  t.is(normaliseLocale('id'), null, 'id rejected')
  t.is(normaliseLocale('zh'), null, 'zh rejected (outside Curva safe set)')
})

test('createVoiceClone exposes speakStream in the returned handle', async (t) => {
  const { createVoiceClone } = require('../bare/voiceClone.js')
  const inst = createVoiceClone({ sdk: null })
  t.is(typeof inst.speakStream, 'function', 'speakStream present')
})
