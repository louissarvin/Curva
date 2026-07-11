// F22 (Ship 4 semifinal) brittle tests: voice coach cross-lingual bracket.
//
// Design: when the STT-classified user locale is non-EN AND a Bergamot translate
// handle is available AND CURVA_VOICE_COACH_CROSS_LINGUAL_ENABLED is truthy,
// the pipeline:
//   1. translates transcript -> EN before rag.search
//   2. still feeds the ORIGINAL transcript to the LLM (Qwen3 cross-lingual)
//   3. translates the LLM answer -> user's locale before TTS
// EN users bypass the bracket entirely (zero regression).
//
// Docs-verification memo (2026-07-11):
//   - bare/translate.js translate({text, from, to}) contract (line 496).
//   - Voice-assistant recipe: https://docs.qvac.tether.io/ai-capabilities/voice-assistant/
//   - Qwen3's cross-lingual capability documented at
//     https://docs.qvac.tether.io/ai-capabilities/text-generation/

const test = require('brittle')

const {
  createVoiceCoach,
  crossLingualFlagEnabled,
  translateOrFallback,
  CROSS_LINGUAL_TRANSLATE_TIMEOUT_MS
} = require('../bare/voiceCoach.js')

// -- Fakes -----------------------------------------------------------------

function fakeChat () {
  const sent = []
  const systemSent = []
  return {
    sent,
    systemSent,
    async send (m) { sent.push(m); return { ...m, wall_clock_ms: 1 } },
    async sendSystem (m) {
      const enriched = { by_peer: 'coach-fake', match_time_ms: 0, wall_clock_ms: 2, ...m }
      systemSent.push(enriched)
      return enriched
    }
  }
}

function fakeAnnouncer () {
  const calls = []
  return {
    calls,
    async speak (args) { calls.push(args); return { ok: true } }
  }
}

function fakeRag ({ hits = [] } = {}) {
  const calls = []
  return {
    calls,
    async search (q, opts) { calls.push({ q, opts }); return hits }
  }
}

function fakeTranslate ({ delayMs = 0, throwFor = new Set(), timeoutFor = new Set() } = {}) {
  const calls = []
  return {
    calls,
    async translate (a, b) {
      let text, to, from
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        text = a.text
        to = a.to
        from = a.from
      } else {
        text = a
        to = b
      }
      calls.push({ text, to, from })
      if (throwFor.has(to)) throw new Error('boom')
      if (timeoutFor.has(to)) return new Promise(() => {})
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      return '[' + to + '] ' + String(text || '')
    }
  }
}

function fakeSttSdk ({ events = [] } = {}) {
  const writes = []
  const session = {
    write (b) { writes.push(b.byteLength) },
    end () {},
    destroy () {},
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
    async transcribeStream (params) { sdk.lastParams = params; return session }
  }
  return { sdk, session, writes }
}

function fakeLlm ({ tokens = ['Answer ', 'in English.'] } = {}) {
  const calls = { completion: 0 }
  return {
    modelId: 'qwen-fake',
    completion (params) {
      calls.completion += 1
      calls.lastArgs = params
      const events = (async function * () {
        for (const t of tokens) yield { type: 'contentDelta', text: t }
        yield { type: 'completionDone', stopReason: 'eos' }
      })()
      return { events, requestId: 'req-fake-' + calls.completion }
    },
    _calls: calls
  }
}

function collectEmits () {
  const events = []
  return { events, emit: (e, p) => events.push({ e, p }) }
}

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

test('crossLingualFlagEnabled: default (unset) is ON per brief', async (t) => {
  await withEnv('CURVA_VOICE_COACH_CROSS_LINGUAL_ENABLED', undefined, () => {
    t.is(crossLingualFlagEnabled(), true, 'default ON')
  })
})

test('crossLingualFlagEnabled: explicit off honoured', async (t) => {
  for (const v of ['0', 'false', 'no', 'off']) {
    await withEnv('CURVA_VOICE_COACH_CROSS_LINGUAL_ENABLED', v, () => {
      t.is(crossLingualFlagEnabled(), false, 'rejected: ' + v)
    })
  }
  for (const v of ['1', 'true', 'yes', 'on']) {
    await withEnv('CURVA_VOICE_COACH_CROSS_LINGUAL_ENABLED', v, () => {
      t.is(crossLingualFlagEnabled(), true, 'accepted: ' + v)
    })
  }
})

test('translateOrFallback: success path returns translated string', async (t) => {
  const tr = fakeTranslate()
  const out = await translateOrFallback(tr, 'halo', 'id', 'en', 500)
  t.is(out, '[en] halo')
})

test('translateOrFallback: null handle returns raw', async (t) => {
  const out = await translateOrFallback(null, 'halo', 'id', 'en', 500)
  t.is(out, 'halo')
})

test('translateOrFallback: timeout returns raw', async (t) => {
  const tr = fakeTranslate({ timeoutFor: new Set(['en']) })
  const out = await translateOrFallback(tr, 'halo', 'id', 'en', 80)
  t.is(out, 'halo', 'raw returned on timeout')
})

test('translateOrFallback: throw returns raw', async (t) => {
  const tr = fakeTranslate({ throwFor: new Set(['en']) })
  const out = await translateOrFallback(tr, 'halo', 'id', 'en', 500)
  t.is(out, 'halo', 'raw returned on throw')
})

// -- End-to-end via createVoiceCoach + startTurn -> endTurn ----------------

async function drivePipeline (coach) {
  await coach.startTurn()
  await coach.pushAudio(new Uint8Array(32))
  await new Promise((r) => setTimeout(r, 0))
  await coach.endTurn()
}

test('EN user locale: bracket bypasses translation, LLM answer flows straight to TTS', async (t) => {
  await withEnv('CURVA_VOICE_COACH_CROSS_LINGUAL_ENABLED', 'true', async () => {
    const chat = fakeChat()
    const rag = fakeRag()
    const announcer = fakeAnnouncer()
    const tr = fakeTranslate()
    const { sdk } = fakeSttSdk({ events: [{ type: 'text', text: 'explain pressing' }] })
    const llm = fakeLlm({ tokens: ['Pressing ', 'means high defensive line.'] })
    const { events, emit } = collectEmits()
    const coach = createVoiceCoach({
      chat, sdk, sharedLlmHandle: llm, ragHandle: rag, announcer,
      translate: tr,
      detectLocale: () => 'en',
      lang: 'en', emit
    })
    await drivePipeline(coach)
    t.is(tr.calls.length, 0, 'translate NOT called for EN user')
    t.is(rag.calls[0].q, 'explain pressing', 'rag.search got raw transcript')
    t.is(announcer.calls[0].text, 'Pressing means high defensive line.', 'TTS got raw LLM answer')
    t.is(announcer.calls[0].targetLocale, 'en', 'TTS locale unchanged')
    const cross = events.filter((e) => e.e === 'voice:cross-lingual')
    t.is(cross.length, 0, 'cross-lingual event NOT emitted for EN user')
    await coach.close()
  })
})

test('ID user locale: query translated ID -> EN before rag.search; answer translated EN -> ID before TTS', async (t) => {
  await withEnv('CURVA_VOICE_COACH_CROSS_LINGUAL_ENABLED', 'true', async () => {
    const chat = fakeChat()
    const rag = fakeRag({ hits: [{ content: 'pressing = high line', score: 0.9 }] })
    const announcer = fakeAnnouncer()
    const tr = fakeTranslate()
    const { sdk } = fakeSttSdk({ events: [{ type: 'text', text: 'jelaskan pressing' }] })
    const llm = fakeLlm({ tokens: ['Pressing is a defensive tactic.'] })
    const { events, emit } = collectEmits()
    const coach = createVoiceCoach({
      chat, sdk, sharedLlmHandle: llm, ragHandle: rag, announcer,
      translate: tr,
      detectLocale: () => 'id',
      lang: 'id', emit
    })
    await drivePipeline(coach)

    // Two translate calls: id->en on transcript, en->id on answer.
    t.is(tr.calls.length, 2, 'translate called twice for ID user')
    const toEn = tr.calls.find((c) => c.to === 'en')
    const toId = tr.calls.find((c) => c.to === 'id')
    t.ok(toEn, 'en translation call')
    t.is(toEn.text, 'jelaskan pressing', 'transcript sent to translate')
    t.ok(toId, 'id translation call')
    t.is(toId.text, 'Pressing is a defensive tactic.', 'answer sent to translate')

    // rag.search used the EN-translated query.
    t.is(rag.calls[0].q, '[en] jelaskan pressing', 'rag.search got EN-translated query')

    // TTS got the ID-back-translated answer + targetLocale=id.
    t.is(announcer.calls[0].text, '[id] Pressing is a defensive tactic.', 'TTS got ID answer')
    t.is(announcer.calls[0].targetLocale, 'id', 'TTS locale is id')

    // Cross-lingual event fired with correct locales.
    const cross = events.filter((e) => e.e === 'voice:cross-lingual')
    t.is(cross.length, 1, 'exactly one cross-lingual event')
    t.is(cross[0].p.userLocale, 'id', 'userLocale carried')
    t.is(cross[0].p.translatedQueryToEn, '[en] jelaskan pressing', 'query translation carried')
    t.is(cross[0].p.translatedAnswerBack, '[id] Pressing is a defensive tactic.', 'answer back-translation carried')

    // LLM still received ORIGINAL transcript in the user turn (Qwen3 handles cross-lingual).
    const historyUser = llm._calls.lastArgs.history.find((h) => h.role === 'user')
    t.ok(historyUser, 'user turn in history')
    t.is(historyUser.content, 'jelaskan pressing', 'LLM user turn is the ORIGINAL non-EN transcript')

    await coach.close()
  })
})

test('translate timeout falls back gracefully to raw text', async (t) => {
  await withEnv('CURVA_VOICE_COACH_CROSS_LINGUAL_ENABLED', 'true', async () => {
    const chat = fakeChat()
    const rag = fakeRag()
    const announcer = fakeAnnouncer()
    // Time out the en direction (transcript -> en) and the id direction (answer -> id).
    const tr = fakeTranslate({ timeoutFor: new Set(['en', 'id']) })
    const { sdk } = fakeSttSdk({ events: [{ type: 'text', text: 'jelaskan pressing' }] })
    const llm = fakeLlm({ tokens: ['Pressing means high defensive line.'] })
    const { events, emit } = collectEmits()
    const coach = createVoiceCoach({
      chat, sdk, sharedLlmHandle: llm, ragHandle: rag, announcer,
      translate: tr,
      detectLocale: () => 'id',
      lang: 'id', emit
    })
    const started = Date.now()
    await drivePipeline(coach)
    const elapsed = Date.now() - started
    // Both translations time out but neither blocks longer than the budget.
    t.ok(elapsed < 2 * CROSS_LINGUAL_TRANSLATE_TIMEOUT_MS + 1000, 'elapsed under 2x budget: ' + elapsed)

    // rag.search fell back to raw non-EN transcript.
    t.is(rag.calls[0].q, 'jelaskan pressing', 'rag got raw transcript on translate timeout')
    // TTS fell back to raw EN answer.
    t.is(announcer.calls[0].text, 'Pressing means high defensive line.', 'TTS got raw answer on timeout')

    // Cross-lingual event still fires (bracket ran; both were graceful fallbacks).
    const cross = events.filter((e) => e.e === 'voice:cross-lingual')
    t.is(cross.length, 1, 'cross-lingual event still emitted')
    t.is(cross[0].p.translatedQueryToEn, null, 'query translation null on timeout')
    t.is(cross[0].p.translatedAnswerBack, null, 'answer back-translation null on timeout')

    await coach.close()
  })
})

test('flag OFF makes coach identical to pre-F22 (no translate, no cross-lingual event)', async (t) => {
  await withEnv('CURVA_VOICE_COACH_CROSS_LINGUAL_ENABLED', 'false', async () => {
    const chat = fakeChat()
    const rag = fakeRag()
    const announcer = fakeAnnouncer()
    const tr = fakeTranslate()
    const { sdk } = fakeSttSdk({ events: [{ type: 'text', text: 'jelaskan pressing' }] })
    const llm = fakeLlm({ tokens: ['Pressing means high defensive line.'] })
    const { events, emit } = collectEmits()
    const coach = createVoiceCoach({
      chat, sdk, sharedLlmHandle: llm, ragHandle: rag, announcer,
      translate: tr,
      detectLocale: () => 'id',
      lang: 'id', emit
    })
    await drivePipeline(coach)
    t.is(tr.calls.length, 0, 'translate NOT called when flag off')
    t.is(rag.calls[0].q, 'jelaskan pressing', 'rag got raw transcript')
    t.is(announcer.calls[0].text, 'Pressing means high defensive line.', 'TTS got raw answer')
    t.is(announcer.calls[0].targetLocale, 'id', 'TTS locale is factory lang')
    const cross = events.filter((e) => e.e === 'voice:cross-lingual')
    t.is(cross.length, 0, 'no cross-lingual event when flag off')
    await coach.close()
  })
})

test('coach conversational memory ring is unaffected by cross-lingual bracket', async (t) => {
  await withEnv('CURVA_VOICE_COACH_CROSS_LINGUAL_ENABLED', 'true', async () => {
    await withEnv('CURVA_VOICE_COACH_MEMORY_ENABLED', 'true', async () => {
      const chat = fakeChat()
      const announcer = fakeAnnouncer()
      const tr = fakeTranslate()
      // First turn: ID transcript => cross-lingual bracket engages.
      const sttA = fakeSttSdk({ events: [{ type: 'text', text: 'jelaskan pressing' }] })
      const llm = fakeLlm({ tokens: ['Pressing keeps the line high.'] })
      const { emit } = collectEmits()
      const coach = createVoiceCoach({
        chat, sdk: sttA.sdk, sharedLlmHandle: llm, announcer,
        translate: tr,
        detectLocale: () => 'id',
        lang: 'id', emit
      })
      await drivePipeline(coach)

      // Memory ring should contain exactly one turn — the ORIGINAL non-EN transcript
      // and the EN answer (per pushConversationTurn which runs on the pre-translate
      // answerText). This is the regression-safety check: bracket did not corrupt
      // memory shape.
      const mem = coach.getConversationHistory()
      t.is(mem.length, 1, 'memory ring has one turn after first cross-lingual pass')
      t.is(mem[0].userText, 'jelaskan pressing', 'memory userText is ORIGINAL transcript')
      t.is(mem[0].coachAnswer, 'Pressing keeps the line high.', 'memory coachAnswer is the LLM answer text')

      await coach.close()
    })
  })
})
