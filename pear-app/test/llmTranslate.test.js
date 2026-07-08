// Curva llmTranslate.js unit tests.
//
// The module wraps @qvac/sdk's completion API to give Bergamot a fallback for
// unloaded language pairs. All tests use an injected loadSdkLlmImpl so the
// suite never touches the network or the real SDK.

const test = require('brittle')
const { createLlmTranslator, _internal } = require('../bare/llmTranslate.js')

// --- helpers ---------------------------------------------------------------

function makeStubHandle ({ replies = [], throwOnCompletion = null } = {}) {
  let callIdx = 0
  const calls = []
  return {
    modelId: 'stub-qwen3',
    completion (params) {
      calls.push(params)
      if (throwOnCompletion) {
        throw throwOnCompletion
      }
      const reply = replies[callIdx++] ?? { text: '' }
      // Return the completion-run shape the module reads (.text promise).
      return {
        text: Promise.resolve(reply.text)
      }
    },
    unloadModel: async () => {},
    _calls: calls
  }
}

function makeLoader ({ handle = null, throwOnce = false } = {}) {
  let thrown = false
  return async () => {
    if (throwOnce && !thrown) {
      thrown = true
      throw new Error('boom')
    }
    return handle
  }
}

// --- buildMessages ---------------------------------------------------------

test('buildMessages produces a system+user pair with the language names', (t) => {
  const msgs = _internal.buildMessages({ text: 'Ciao Torino', from: 'it', to: 'id' })
  t.is(msgs.length, 2)
  t.is(msgs[0].role, 'system')
  t.ok(/only the translated text/i.test(msgs[0].content), 'system message enforces bare output')
  t.is(msgs[1].role, 'user')
  t.ok(msgs[1].content.includes('Italian'), 'user message names source language')
  t.ok(msgs[1].content.includes('Indonesian'), 'user message names target language')
  t.ok(msgs[1].content.includes('Ciao Torino'), 'user message carries the original text')
})

test('langLabel maps supported codes and falls back to uppercased code', (t) => {
  t.is(_internal.langLabel('it'), 'Italian')
  t.is(_internal.langLabel('id'), 'Indonesian')
  t.is(_internal.langLabel('en'), 'English')
  t.is(_internal.langLabel('sv'), 'SV', 'unknown lang falls back to uppercase')
  t.is(_internal.langLabel(''), 'the target language', 'empty falls back to human label')
})

// --- cleanOutput ------------------------------------------------------------

test('cleanOutput strips straight and curly quote wrappers', (t) => {
  t.is(_internal.cleanOutput('"Halo Torino"'), 'Halo Torino')
  t.is(_internal.cleanOutput("'Halo Torino'"), 'Halo Torino')
  t.is(_internal.cleanOutput('“Halo Torino”'), 'Halo Torino')
  t.is(_internal.cleanOutput('‘Halo Torino’'), 'Halo Torino')
})

test('cleanOutput strips common preambles', (t) => {
  t.is(_internal.cleanOutput('Translation: Halo dunia'), 'Halo dunia')
  t.is(_internal.cleanOutput("Sure, here's the translation: Halo dunia"), 'Halo dunia')
  t.is(_internal.cleanOutput('Translated: Halo dunia'), 'Halo dunia')
})

test('cleanOutput keeps only the first line', (t) => {
  t.is(_internal.cleanOutput('Halo dunia\n(literally: hello world)'), 'Halo dunia')
})

test('cleanOutput handles pure text unchanged', (t) => {
  t.is(_internal.cleanOutput('Halo dari Jakarta'), 'Halo dari Jakarta')
})

// --- createLlmTranslator (feature flag) -------------------------------------

test('createLlmTranslator respects CURVA_QVAC_LLM_TRANSLATE_ENABLED=false', async (t) => {
  const prev = process.env.CURVA_QVAC_LLM_TRANSLATE_ENABLED
  process.env.CURVA_QVAC_LLM_TRANSLATE_ENABLED = 'false'
  try {
    const inst = await createLlmTranslator({ loadSdkLlmImpl: () => { throw new Error('should not load') } })
    t.is(inst.status().mode, 'disabled')
    await t.exception.all(() => inst.translate({ text: 'x', from: 'it', to: 'id' }))
  } finally {
    if (prev === undefined) delete process.env.CURVA_QVAC_LLM_TRANSLATE_ENABLED
    else process.env.CURVA_QVAC_LLM_TRANSLATE_ENABLED = prev
  }
})

// --- happy path -------------------------------------------------------------

test('translate() calls completion with the built prompt and returns cleaned text', async (t) => {
  const handle = makeStubHandle({
    replies: [{ text: '"Halo dari Torino"' }] // model wraps in quotes; cleaner strips them
  })
  const inst = await createLlmTranslator({
    loadSdkLlmImpl: makeLoader({ handle })
  })
  const out = await inst.translate({ text: 'Ciao da Torino', from: 'it', to: 'id' })
  t.is(out, 'Halo dari Torino')
  t.is(handle._calls.length, 1)
  const call = handle._calls[0]
  t.is(call.modelId, 'stub-qwen3')
  t.is(call.history.length, 2)
  t.is(call.history[0].role, 'system')
  t.is(call.history[1].role, 'user')
  t.is(call.stream, false)
})

test('translate() short-circuits when from === to', async (t) => {
  let loaded = false
  const inst = await createLlmTranslator({
    loadSdkLlmImpl: async () => { loaded = true; return makeStubHandle() }
  })
  const out = await inst.translate({ text: 'no-op', from: 'en', to: 'en' })
  t.is(out, 'no-op')
  t.absent(loaded, 'model should not load for a same-lang short-circuit')
})

test('translate() rejects on non-string text', async (t) => {
  const inst = await createLlmTranslator({
    loadSdkLlmImpl: makeLoader({ handle: makeStubHandle() })
  })
  await t.exception.all(() => inst.translate({ text: 42, from: 'it', to: 'id' }))
  await t.exception.all(() => inst.translate({ text: '', from: 'it', to: 'id' }))
})

test('translate() rejects when the loader returns null (SDK unavailable)', async (t) => {
  const inst = await createLlmTranslator({
    loadSdkLlmImpl: async () => null
  })
  await t.exception.all(() => inst.translate({ text: 'x', from: 'it', to: 'id' }))
  t.is(inst.status().mode, 'idle')
})

test('translate() rejects on LLM_EMPTY when the model returns nothing usable', async (t) => {
  const handle = makeStubHandle({ replies: [{ text: '' }] })
  const inst = await createLlmTranslator({
    loadSdkLlmImpl: makeLoader({ handle })
  })
  await t.exception.all(() => inst.translate({ text: 'Ciao', from: 'it', to: 'id' }))
})

test('translate() enforces the timeout on a hanging completion', async (t) => {
  const inst = await createLlmTranslator({
    loadSdkLlmImpl: async () => ({
      modelId: 'stub',
      completion: () => ({
        // Never resolves.
        text: new Promise(() => {})
      })
    }),
    timeoutMs: 50
  })
  const start = Date.now()
  await t.exception.all(() => inst.translate({ text: 'Ciao', from: 'it', to: 'id' }))
  const elapsed = Date.now() - start
  t.ok(elapsed >= 40 && elapsed < 500, 'timeout fired within reasonable window (got ' + elapsed + 'ms)')
})

test('close() releases the model handle so subsequent translate reloads', async (t) => {
  let loads = 0
  let handle = null
  const loader = async () => {
    loads++
    handle = makeStubHandle({ replies: [{ text: 'Halo' }, { text: 'Halo lagi' }] })
    return handle
  }
  const inst = await createLlmTranslator({ loadSdkLlmImpl: loader })
  await inst.translate({ text: 'Ciao', from: 'it', to: 'id' })
  t.is(loads, 1)
  await inst.close()
  t.is(inst.status().mode, 'idle')
  await inst.translate({ text: 'Ciao', from: 'it', to: 'id' })
  t.is(loads, 2, 'close forces the next translate to load a fresh handle')
})

test('ensureLoaded is idempotent under concurrent callers', async (t) => {
  let loads = 0
  const loader = async () => {
    loads++
    // Add a tick so both callers race the same in-flight promise.
    await new Promise((resolve) => setTimeout(resolve, 10))
    return makeStubHandle({ replies: [{ text: 'A' }, { text: 'B' }] })
  }
  const inst = await createLlmTranslator({ loadSdkLlmImpl: loader })
  const [a, b] = await Promise.all([
    inst.translate({ text: 'x', from: 'it', to: 'id' }),
    inst.translate({ text: 'y', from: 'it', to: 'id' })
  ])
  t.is(loads, 1, 'concurrent translates share one load')
  t.is(a, 'A')
  t.is(b, 'B')
})
