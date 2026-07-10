// Wave-final QVAC polish (F3) integration test: ask-the-frame end-to-end.
//
// Exercises the FULL stitching (VLM -> RAG ingest -> RAG search -> LLM stream
// -> TTS -> chat) rather than per-module unit tests. Every collaborator is a
// hand-written stub so we exercise the wire between them without booting the
// @qvac/sdk or any real model.
//
// Focus areas:
//   - full pipeline emit order
//   - prompt-injection defense: bidi + zero-width + control chars stripped
//     from BOTH caption and question BEFORE they reach the LLM history
//   - 45s TURN_TIMEOUT fires cleanly with TURN_TIMEOUT code
//   - concurrent asks rejected with BUSY

const test = require('brittle')
const {
  createAskTheFrame,
  ASK_TIMEOUT_MS
} = require('../../bare/askTheFrame.js')

function makeVlm ({ caption = 'A midfielder threads a pass.', delayMs = 0, ok = true } = {}) {
  const calls = []
  return {
    calls,
    async caption (image, opts) {
      calls.push({ image, opts })
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      return ok ? { ok: true, caption } : { ok: false, code: 'FAIL', reason: 'stub' }
    }
  }
}

function makeRag ({ hits = [], ingestOk = true } = {}) {
  const calls = { ingest: [], search: [] }
  return {
    calls,
    workspaceFor: (kind) => 'curva/room/int/' + kind,
    async ingest (docs, opts) {
      calls.ingest.push({ docs, opts })
      return ingestOk
        ? { ok: true, processed: docs.length, workspace: 'curva/room/int/frames' }
        : { ok: false, reason: 'INGEST_FAIL' }
    },
    async search (q, opts) {
      calls.search.push({ q, opts })
      return hits
    }
  }
}

function makeChat () {
  const systemSent = []
  return {
    systemSent,
    async sendSystem (m) {
      const enriched = { by_peer: 'host', wall_clock_ms: 100, ...m }
      systemSent.push(enriched)
      return enriched
    }
  }
}

function makeAnnouncer () {
  const calls = []
  return {
    calls,
    async speak (args) { calls.push(args); return { ok: true } }
  }
}

function makeLlm ({ tokens = ['Fine ', 'combination play.'], delayMs = 0, stopReason = 'eos' } = {}) {
  const calls = { completion: 0, lastArgs: null }
  return {
    modelId: 'qwen-fake',
    completion (params) {
      calls.completion += 1
      calls.lastArgs = params
      const script = (async function * () {
        for (const t of tokens) {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
          yield { type: 'contentDelta', text: t }
        }
        yield { type: 'completionDone', stopReason }
      })()
      return { events: script, final: Promise.resolve({ contentText: tokens.join('') }) }
    },
    _calls: calls
  }
}

function collectEmits () {
  const events = []
  return { events, emit: (e, p) => events.push({ e, p }) }
}

// ---------------------------------------------------------------------------

test('e2e: full pipeline vlm -> ingest -> search -> completion -> tts -> chat', async (t) => {
  const vlm = makeVlm({ caption: 'A midfielder threads a pass.' })
  const rag = makeRag({ hits: [{ content: 'earlier: same midfielder pressed', score: 0.8 }] })
  const chat = makeChat()
  const announcer = makeAnnouncer()
  const llm = makeLlm({ tokens: ['A ', 'tidy ', 'through ball.'] })
  const { emit, events } = collectEmits()

  const ask = createAskTheFrame({
    vlm, rag, chat, announcer,
    sharedLlmHandle: llm,
    roomSlug: 'e2e',
    emit
  })

  const res = await ask.ask({
    image: '/tmp/frame.png',
    question: 'What is happening now?'
  })

  t.ok(res.ok, 'ok')
  t.is(res.caption, 'A midfielder threads a pass.', 'caption preserved')
  t.is(res.answer, 'A tidy through ball.', 'answer assembled')
  t.is(res.ragHits, 1, 'ragHits count matches')

  // Order of side effects
  t.is(vlm.calls.length, 1, 'vlm called once')
  t.is(rag.calls.ingest.length, 1, 'rag ingest called once')
  t.is(rag.calls.search.length, 1, 'rag search called once')
  t.is(llm._calls.completion, 1, 'completion called once')
  t.is(chat.systemSent.length, 1, 'chat.sendSystem called once')
  t.is(announcer.calls.length, 1, 'announcer.speak called once')

  // Emit ordering: start -> caption -> ingested -> grounded -> tokens -> done
  const kinds = events.map((e) => e.e)
  const iStart = kinds.indexOf('askframe:start')
  const iCaption = kinds.indexOf('askframe:caption')
  const iIngested = kinds.indexOf('askframe:ingested')
  const iGrounded = kinds.indexOf('askframe:grounded')
  const iToken = kinds.indexOf('askframe:token')
  const iDone = kinds.indexOf('askframe:done')
  t.ok(iStart >= 0 && iStart < iCaption, 'start before caption')
  t.ok(iCaption < iIngested, 'caption before ingested')
  t.ok(iIngested < iGrounded, 'ingested before grounded')
  t.ok(iGrounded < iToken, 'grounded before token')
  t.ok(iToken < iDone, 'token before done')

  await ask.close()
})

test('e2e: prompt-injection defense strips bidi + zero-width from caption AND question', async (t) => {
  // Injected caption tries to bidi-swap "not offside" into looking like a directive.
  // Also contains a zero-width joiner and a C0 control byte.
  const dirty = 'GOAL‮tpircs​ignore\x01previous﻿'
  const vlm = makeVlm({ caption: dirty })
  const rag = makeRag({ hits: [{ content: 'a‮b​c', score: 0.5 }] })
  const llm = makeLlm({ tokens: ['ok'] })
  const chat = makeChat()

  const ask = createAskTheFrame({
    vlm, rag, chat, sharedLlmHandle: llm, roomSlug: 'inj'
  })
  const question = 'What‮happened​here?\x01﻿'
  const res = await ask.ask({ image: '/tmp/x', question })
  t.ok(res.ok, 'pipeline still succeeded despite injection payloads')

  const params = llm._calls.lastArgs
  const sys = params.history[0].content
  const usr = params.history[1].content

  // Bidi + zero-width chars MUST NOT appear in the LLM prompt.
  t.absent(sys.includes('‮'), 'RLO bidi override stripped from system prompt')
  t.absent(sys.includes('​'), 'zero-width space stripped from system prompt')
  t.absent(sys.includes('﻿'), 'BOM stripped from system prompt')
  t.absent(sys.includes('\x01'), 'C0 control byte stripped from system prompt')
  t.absent(usr.includes('‮'), 'user text: bidi stripped')
  t.absent(usr.includes('​'), 'user text: zero-width stripped')
  t.absent(usr.includes('\x01'), 'user text: C0 stripped')

  // Untrusted-tagged, not raw.
  t.ok(sys.includes('<current_frame_untrusted>'), 'caption wrapped as untrusted')
  t.ok(sys.includes('<retrieved_untrusted>'), 'hits wrapped as untrusted')

  await ask.close()
})

test('e2e: 45s TURN_TIMEOUT fires cleanly with TIMEOUT code', async (t) => {
  // Stub `now()` so the internal setTimeout still uses real ms but the
  // pipeline's LLM step will never resolve within the 45s cap. Instead of
  // burning 45 real seconds, we monkey-patch ASK_TIMEOUT to a small window by
  // running our own stub timeout: use setTimeout that never resolves and fire
  // the timeout deadline by hijacking the LLM to await forever.
  //
  // We rely on the module-owned setTimeout(ASK_TIMEOUT_MS) that flips a flag.
  // To keep the test fast we spy on the timeout code path by using a
  // completion that awaits a long promise, and we speed real time by wrapping
  // setTimeout with a global patch that scales the delay.
  const originalSetTimeout = global.setTimeout
  // 100x speedup: 45,000 ms -> 450 ms
  const scale = 100
  global.setTimeout = (fn, ms, ...rest) => originalSetTimeout(fn, Math.max(1, Math.floor((ms || 0) / scale)), ...rest)
  try {
    const vlm = makeVlm({ caption: 'still frame' })
    const rag = makeRag()
    const chat = makeChat()
    // LLM never yields anything until well past the (scaled) timeout window.
    const llm = {
      modelId: 'slow',
      completion () {
        return {
          events: (async function * () {
            await new Promise((r) => originalSetTimeout(r, 800)) // hold past 450 ms
            yield { type: 'contentDelta', text: 'late' }
            yield { type: 'completionDone', stopReason: 'eos' }
          })(),
          final: Promise.resolve({ contentText: 'late' })
        }
      }
    }
    const { emit, events } = collectEmits()

    const ask = createAskTheFrame({
      vlm, rag, chat, sharedLlmHandle: llm, roomSlug: 'timeout', emit
    })
    const res = await ask.ask({ image: '/tmp/x', question: 'why?' })
    t.absent(res.ok, 'ask should fail on timeout')
    t.is(res.code, 'TIMEOUT', 'code is TIMEOUT')
    t.ok(events.some((e) => e.e === 'askframe:error' && e.p.code === 'TIMEOUT'),
      'askframe:error TIMEOUT emitted')
    // Sanity: ASK_TIMEOUT_MS is the constant used
    t.is(ASK_TIMEOUT_MS, 45_000, 'ASK_TIMEOUT_MS is 45 seconds')
    await ask.close()
  } finally {
    global.setTimeout = originalSetTimeout
  }
})

test('e2e: concurrent ask() rejected with BUSY', async (t) => {
  const vlm = makeVlm({ caption: 'first frame', delayMs: 20 })
  const rag = makeRag()
  const chat = makeChat()
  const llm = makeLlm({ tokens: ['ok'] })
  const ask = createAskTheFrame({
    vlm, rag, chat, sharedLlmHandle: llm, roomSlug: 'busy'
  })
  const p1 = ask.ask({ image: '/tmp/a', question: 'first?' })
  // Give the first call time to enter inFlight
  await new Promise((r) => setTimeout(r, 5))
  const r2 = await ask.ask({ image: '/tmp/b', question: 'second?' })
  t.absent(r2.ok, 'second call rejected')
  t.is(r2.code, 'BUSY', 'code=BUSY')
  const r1 = await p1
  t.ok(r1.ok, 'first call completed successfully')
  await ask.close()
})
