// F16 (Ship 4 semifinal) brittle tests: commentator multi-locale fanout.
//
// Design: symmetric to bare/goalPipeline.js per-locale fanout. Every viewer
// gets commentary in their preferred language. After the LLM finishes, the
// sanitized reaction is translated per-locale via Bergamot and routed through
// the same TTS gate (voiceClone or announcer).
//
// Docs-verification memo (2026-07-11):
//   - bare/translate.js translate({text, from, to}) contract (line 496).
//     Positional shape is also accepted by translateWithTimeout so a stub
//     with either signature works.
//   - bare/goalPipeline.js:420 for the reference per-locale fanout pattern.
//   - Promise.allSettled semantics — MDN: never rejects, resolves with an
//     array of { status: 'fulfilled'|'rejected', value|reason }.

const test = require('brittle')

const {
  createCommentator,
  commentatorMultiLocaleFlagEnabled,
  parseCommentatorLocalesEnv,
  runMultiLocaleFanout,
  translateWithTimeout,
  MULTI_LOCALE_TRANSLATE_TIMEOUT_MS
} = require('../bare/commentator.js')

// -- Fakes -----------------------------------------------------------------

function fakeChat () {
  const systemSent = []
  return {
    systemSent,
    async sendSystem (m) {
      const enriched = { by_peer: 'host-fake', match_time_ms: 0, wall_clock_ms: 0, ...m }
      systemSent.push(enriched)
      return enriched
    }
  }
}

function fakeAnnouncer () {
  const calls = []
  return {
    calls,
    async openSpeakStream ({ locale }) {
      calls.push({ locale })
      return {
        write (chunk) { calls.push({ locale, write: chunk }) },
        end () { calls.push({ locale, end: true }) },
        destroy () {},
        chunks: (async function * () {
          yield { buffer: [1, 2], chunkIndex: 0, done: true }
        })()
      }
    }
  }
}

function fakeVoiceClone ({ enrolled = true } = {}) {
  const calls = []
  return {
    calls,
    status () { return { enrolled, ready: true, flagEnabled: true } },
    async speakStream (text, locale) {
      calls.push({ text, locale })
      return {
        chunks: (async function * () {
          yield { buffer: [1], sampleRate: 24000, done: true }
        })(),
        end () {},
        destroy () {}
      }
    },
    async speak () { return null }
  }
}

function fakeTranslate ({ delayMs = 0, throwFor = new Set(), timeoutFor = new Set() } = {}) {
  const calls = []
  return {
    calls,
    async translate (a, b) {
      // Accept both {text, from, to} and (text, targetLocale) signatures.
      let text, to
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        text = a.text
        to = a.to
      } else {
        text = a
        to = b
      }
      calls.push({ text, to })
      if (throwFor.has(to)) throw new Error('translate boom for ' + to)
      if (timeoutFor.has(to)) {
        // Never resolve (simulates a slow translator; caller times out).
        return new Promise(() => {})
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      return '[' + to + '] ' + String(text || '')
    }
  }
}

function fakeSdk ({ tokens = ['Golazo del ', 'Argentina!'] } = {}) {
  return {
    modelId: 'qwen-fake',
    completion (_params) {
      const events = (async function * () {
        for (const t of tokens) yield { type: 'contentDelta', text: t }
        yield { type: 'completionDone', stopReason: 'eos' }
      })()
      return { events }
    }
  }
}

function collectEmits () {
  const events = []
  return {
    emit: (e, p) => events.push({ e, p }),
    events
  }
}

// -- Env helpers -----------------------------------------------------------

function withEnv (key, value, fn) {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  })
}

// -- Pure helper tests -----------------------------------------------------

test('commentatorMultiLocaleFlagEnabled: default (unset) is false', async (t) => {
  await withEnv('CURVA_COMMENTATOR_MULTI_LOCALE_ENABLED', undefined, () => {
    t.is(commentatorMultiLocaleFlagEnabled(), false, 'unset -> false')
  })
})

test('commentatorMultiLocaleFlagEnabled: accepts truthy strings', async (t) => {
  for (const v of ['1', 'true', 'yes', 'ON']) {
    await withEnv('CURVA_COMMENTATOR_MULTI_LOCALE_ENABLED', v, () => {
      t.is(commentatorMultiLocaleFlagEnabled(), true, 'accepted: ' + v)
    })
  }
  for (const v of ['0', 'false', 'no', 'off', '']) {
    await withEnv('CURVA_COMMENTATOR_MULTI_LOCALE_ENABLED', v, () => {
      t.is(commentatorMultiLocaleFlagEnabled(), false, 'rejected: ' + v)
    })
  }
})

test('parseCommentatorLocalesEnv: comma-split + dedupe + lowercase', async (t) => {
  await withEnv('CURVA_COMMENTATOR_LOCALES', 'EN, it,ID,en , es', () => {
    const out = parseCommentatorLocalesEnv()
    t.alike(out, ['en', 'it', 'id', 'es'], 'normalised + deduped')
  })
})

test('parseCommentatorLocalesEnv: unset returns null', async (t) => {
  await withEnv('CURVA_COMMENTATOR_LOCALES', undefined, () => {
    t.is(parseCommentatorLocalesEnv(), null)
  })
})

test('translateWithTimeout: returns translated text on success', async (t) => {
  const tr = fakeTranslate()
  const out = await translateWithTimeout(tr, 'Goal!', 'en', 'it', 500)
  t.is(out, '[it] Goal!', 'translated text returned')
})

test('translateWithTimeout: null handle returns null', async (t) => {
  const out = await translateWithTimeout(null, 'Goal!', 'en', 'it', 500)
  t.is(out, null)
})

test('translateWithTimeout: throw returns null', async (t) => {
  const tr = fakeTranslate({ throwFor: new Set(['it']) })
  const out = await translateWithTimeout(tr, 'Goal!', 'en', 'it', 500)
  t.is(out, null, 'throw is swallowed and returns null')
})

test('translateWithTimeout: timeout returns null', async (t) => {
  const tr = fakeTranslate({ timeoutFor: new Set(['it']) })
  const out = await translateWithTimeout(tr, 'Goal!', 'en', 'it', 100)
  t.is(out, null, 'timeout returns null')
})

// -- runMultiLocaleFanout ---------------------------------------------------

test('runMultiLocaleFanout: fires translate + speak per additional locale', async (t) => {
  const tr = fakeTranslate()
  const announcer = fakeAnnouncer()
  const { emit, events } = collectEmits()
  const results = await runMultiLocaleFanout({
    sentence: 'Goal Argentina!',
    sourceLocale: 'en',
    additionalLocales: ['it', 'id'],
    translate: tr,
    voiceClone: null,
    announcer,
    emit,
    log: () => {}
  })
  t.is(results.length, 2, 'two settled results')
  t.is(tr.calls.length, 2, 'translate called per locale')
  t.ok(tr.calls.some((c) => c.to === 'it'), 'it translated')
  t.ok(tr.calls.some((c) => c.to === 'id'), 'id translated')
  const speakEvts = events.filter((e) => e.e === 'commentator:multi-locale-speak')
  t.is(speakEvts.length, 2, 'multi-locale-speak fired twice')
  t.ok(speakEvts.some((e) => e.p.locale === 'it'), 'it speak event')
  t.ok(speakEvts.some((e) => e.p.locale === 'id'), 'id speak event')
  for (const e of speakEvts) {
    t.is(e.p.source, 'en', 'source locale carried on event')
    t.is(e.p.via, 'announcer', 'via reflects TTS route')
  }
})

test('runMultiLocaleFanout: allSettled semantics — one timeout does not block others', async (t) => {
  const tr = fakeTranslate({ timeoutFor: new Set(['it']) })
  const announcer = fakeAnnouncer()
  const { emit, events } = collectEmits()
  const started = Date.now()
  const results = await runMultiLocaleFanout({
    sentence: 'Goal!',
    sourceLocale: 'en',
    additionalLocales: ['it', 'id'],
    translate: tr,
    voiceClone: null,
    announcer,
    emit,
    log: () => {}
  })
  const elapsed = Date.now() - started
  t.is(results.length, 2, 'both locales settled')
  // Timeout budget is MULTI_LOCALE_TRANSLATE_TIMEOUT_MS (1500). Total must
  // be roughly the timeout (not 2x) because of Promise.allSettled parallelism.
  t.ok(elapsed < MULTI_LOCALE_TRANSLATE_TIMEOUT_MS + 500, 'elapsed under 2s: ' + elapsed)
  // The `id` locale must still have fired its speak event.
  const speakEvts = events.filter((e) => e.e === 'commentator:multi-locale-speak')
  t.ok(speakEvts.some((e) => e.p.locale === 'id'), 'id speak fired despite it timeout')
  const skipEvts = events.filter((e) => e.e === 'commentator:multi-locale-skipped')
  t.ok(skipEvts.some((e) => e.p.locale === 'it'), 'it skipped')
})

test('runMultiLocaleFanout: empty additionalLocales returns []', async (t) => {
  const { emit } = collectEmits()
  const out = await runMultiLocaleFanout({
    sentence: 'x',
    sourceLocale: 'en',
    additionalLocales: [],
    translate: fakeTranslate(),
    voiceClone: null,
    announcer: fakeAnnouncer(),
    emit,
    log: () => {}
  })
  t.alike(out, [])
})

// -- End-to-end via createCommentator + runTrigger --------------------------

async function bootHostCommentator (extraOpts = {}) {
  const chat = fakeChat()
  const announcer = fakeAnnouncer()
  const { emit, events } = collectEmits()
  const sdk = fakeSdk()
  const commentator = createCommentator({
    storageDir: '/tmp/curva-test',
    isHost: true,
    chat,
    announcer,
    announcerLocale: 'en',
    sdkFactory: async () => sdk,
    tickMs: 60_000,
    rateLimitMs: 0, // don't rate-limit tests
    emit,
    log: () => {},
    now: () => Date.now(),
    ...extraOpts
  })
  await commentator.loadModel()
  await commentator.enable()
  return { commentator, chat, announcer, events, sdk }
}

test('single-locale room bypasses fanout entirely', async (t) => {
  await withEnv('CURVA_COMMENTATOR_MULTI_LOCALE_ENABLED', 'true', async () => {
    const tr = fakeTranslate()
    const { commentator, chat, events } = await bootHostCommentator({
      translate: tr,
      locales: ['en'] // same as announcerLocale => no additional
    })
    await commentator.runTrigger({ type: 'tick' })
    t.is(tr.calls.length, 0, 'translate NOT called for single-locale room')
    const speakEvts = events.filter((e) => e.e === 'commentator:multi-locale-speak')
    t.is(speakEvts.length, 0, 'no multi-locale-speak events')
    t.is(chat.systemSent.length, 1, 'chat.sendSystem still fired for source locale')
    await commentator.close()
  })
})

test('flag OFF makes commentator identical to pre-F16 (fanout skipped)', async (t) => {
  await withEnv('CURVA_COMMENTATOR_MULTI_LOCALE_ENABLED', 'false', async () => {
    const tr = fakeTranslate()
    const { commentator, chat, events } = await bootHostCommentator({
      translate: tr,
      locales: ['en', 'it', 'id']
    })
    await commentator.runTrigger({ type: 'tick' })
    t.is(tr.calls.length, 0, 'translate NOT called when flag off')
    const speakEvts = events.filter((e) => e.e === 'commentator:multi-locale-speak')
    t.is(speakEvts.length, 0, 'no multi-locale-speak events when flag off')
    t.is(chat.systemSent.length, 1, 'chat.sendSystem still fired')
    await commentator.close()
  })
})

test('multi-locale room fans out translate + emits events per extra locale', async (t) => {
  await withEnv('CURVA_COMMENTATOR_MULTI_LOCALE_ENABLED', 'true', async () => {
    const tr = fakeTranslate()
    const { commentator, chat, announcer, events } = await bootHostCommentator({
      translate: tr,
      locales: ['en', 'it', 'id']
    })
    await commentator.runTrigger({ type: 'tick' })
    t.is(tr.calls.length, 2, 'translate called for each additional locale (it, id)')
    t.ok(tr.calls.every((c) => c.to !== 'en'), 'source locale (en) not translated')
    const speakEvts = events.filter((e) => e.e === 'commentator:multi-locale-speak')
    t.is(speakEvts.length, 2, 'two multi-locale-speak events')
    // Assert routeTts was called with each additional locale — announcer.openSpeakStream
    // was invoked for 'it' and 'id' (plus the source-locale open from the token loop).
    const announcerLocales = announcer.calls.filter((c) => c.locale !== undefined && c.write === undefined && c.end === undefined).map((c) => c.locale)
    t.ok(announcerLocales.includes('it'), 'announcer opened for it')
    t.ok(announcerLocales.includes('id'), 'announcer opened for id')
    // Chat message still emitted once (source-locale only — additional locales
    // are audio-only per the design).
    t.is(chat.systemSent.length, 1, 'exactly one system:commentary chat row')
    await commentator.close()
  })
})

test('timeout on one locale does not fail the others (allSettled)', async (t) => {
  await withEnv('CURVA_COMMENTATOR_MULTI_LOCALE_ENABLED', 'true', async () => {
    const tr = fakeTranslate({ timeoutFor: new Set(['it']) })
    const { commentator, events } = await bootHostCommentator({
      translate: tr,
      locales: ['en', 'it', 'id']
    })
    await commentator.runTrigger({ type: 'tick' })
    const speakEvts = events.filter((e) => e.e === 'commentator:multi-locale-speak')
    const skipEvts = events.filter((e) => e.e === 'commentator:multi-locale-skipped')
    t.ok(speakEvts.some((e) => e.p.locale === 'id'), 'id spoke through despite it timeout')
    t.ok(skipEvts.some((e) => e.p.locale === 'it'), 'it recorded as skipped')
    await commentator.close()
  })
})

test('voiceClone route wins for allowlisted locales when enrolled', async (t) => {
  await withEnv('CURVA_COMMENTATOR_MULTI_LOCALE_ENABLED', 'true', async () => {
    const tr = fakeTranslate()
    const vc = fakeVoiceClone({ enrolled: true })
    const { commentator, events } = await bootHostCommentator({
      translate: tr,
      voiceClone: vc,
      locales: ['en', 'it', 'id']
    })
    // Force voiceClone flag on so status().enrolled controls routing.
    await withEnv('CURVA_COMMENTATOR_VOICE_CLONE_ENABLED', 'true', async () => {
      await commentator.runTrigger({ type: 'tick' })
    })
    // it is in VOICE_CLONE_ALLOWED => voiceClone chosen for the it fanout.
    // id is NOT allowlisted => announcer used for the id fanout.
    const speakEvts = events.filter((e) => e.e === 'commentator:multi-locale-speak')
    const itSpeak = speakEvts.find((e) => e.p.locale === 'it')
    const idSpeak = speakEvts.find((e) => e.p.locale === 'id')
    t.ok(itSpeak, 'it speak event fired')
    t.is(itSpeak.p.via, 'voiceClone', 'it routed to voiceClone')
    t.ok(idSpeak, 'id speak event fired')
    t.is(idSpeak.p.via, 'announcer', 'id routed to announcer (not in Chatterbox set)')
    await commentator.close()
  })
})
