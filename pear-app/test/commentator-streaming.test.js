// Commentator streaming completion events + kvCache tests.
//
// Verifies that runTrigger() consumes the SDK's `result.events` async iterator
// (docs: pear-app/node_modules/@qvac/sdk/dist/schemas/completion-event.d.ts)
// and emits the four downstream IPC events (`commentator:token`,
// `commentator:thinking`, `commentator:stats`, `commentator:done`) plus
// forwards `kvCache: '<key>'` on the completion call.

const test = require('brittle')
const { createCommentator } = require('../bare/commentator.js')

function fakeChat () {
  const sent = []
  return {
    sent,
    async sendSystem (m) {
      const enriched = { ...m, by_peer: 'host-hex' }
      sent.push(enriched)
      return enriched
    }
  }
}

// Build an events-based fake SDK. The completion() call captures its options
// (so we can assert kvCache) and returns an object with an async iterable
// `events` yielding the scripted deltas + stats + done.
function eventsSdk ({ events = [], captured = [] } = {}) {
  return async () => ({
    modelId: 'fake-qwen3-events',
    completion: (callOpts) => {
      captured.push(callOpts)
      return {
        events: (async function * () {
          for (const e of events) yield e
        })()
      }
    },
    unloadModel: async () => {}
  })
}

test('runTrigger consumes result.events and emits streaming lifecycle events in order', async (t) => {
  const chat = fakeChat()
  const emitted = []
  const captured = []
  const scripted = [
    { type: 'thinkingDelta', seq: 0, text: 'analyzing...' },
    { type: 'contentDelta', seq: 1, text: 'GOOOOAL' },
    { type: 'contentDelta', seq: 2, text: '! Italy scores' },
    { type: 'completionStats', seq: 3, stats: { tokensPerSecond: 22.5, timeToFirstToken: 180, generatedTokens: 3, backendDevice: 'cpu' } },
    { type: 'completionDone', seq: 4, stopReason: 'eos' }
  ]
  const c = createCommentator({
    storageDir: '/tmp/curva-stream-test',
    isHost: true,
    chat,
    sdkFactory: eventsSdk({ events: scripted, captured }),
    tickMs: 60_000,
    roomSlug: 'ita-vs-fra',
    getMatchTimeMs: () => 30_000,
    getMatchTitle: () => 'ITA vs FRA',
    emit: (ev, p) => emitted.push({ ev, p })
  })
  await c.enable()
  const ok = await c.runTrigger({ type: 'tick' })
  t.ok(ok, 'runTrigger returned true')

  // kvCache assertion: verify the completion() call received the room-scoped key.
  t.is(captured.length, 1, 'completion called exactly once')
  t.is(captured[0].kvCache, 'commentator:room:ita-vs-fra', 'kvCache carries the room slug')
  t.is(captured[0].stream, true, 'stream: true forwarded')

  // Event order sanity check.
  const eventNames = emitted.map((e) => e.ev)
  const thinkStartIdx = eventNames.indexOf('commentator:thinking-start')
  const firstThinkIdx = eventNames.indexOf('commentator:thinking')
  const firstTokenIdx = eventNames.indexOf('commentator:token')
  const statsIdx = eventNames.indexOf('commentator:stats')
  const doneIdx = eventNames.indexOf('commentator:done')
  t.ok(thinkStartIdx >= 0, 'thinking-start fired')
  t.ok(firstThinkIdx > thinkStartIdx, 'thinking event after thinking-start')
  t.ok(firstTokenIdx > firstThinkIdx, 'first token AFTER thinking (matches script)')
  t.ok(statsIdx > firstTokenIdx, 'stats after tokens')
  t.ok(doneIdx > statsIdx, 'done last')

  const tokenEvents = emitted.filter((e) => e.ev === 'commentator:token')
  t.is(tokenEvents.length, 2, 'one commentator:token per contentDelta')
  t.is(tokenEvents[0].p.text, 'GOOOOAL')

  const legacy = emitted.filter((e) => e.ev === 'commentary:tokens')
  t.is(legacy.length, 2, 'legacy commentary:tokens events also emitted for renderer back-compat')

  const stats = emitted.find((e) => e.ev === 'commentator:stats')
  t.is(stats.p.tokensPerSecond, 22.5)
  t.is(stats.p.backendDevice, 'cpu')

  const done = emitted.find((e) => e.ev === 'commentator:done')
  t.is(done.p.stopReason, 'eos')
  t.ok(done.p.totalText.includes('GOOOOAL'), 'done event carries full text')

  // Chat message assertions.
  t.is(chat.sent.length, 1)
  t.is(chat.sent[0].type, 'system:commentary')
  t.ok(chat.sent[0].text.includes('GOOOOAL'), 'sanitized text still contains streamed content')

  await c.close()
})

test('runTrigger falls back to tokenStream when events iterator absent', async (t) => {
  const chat = fakeChat()
  const emitted = []
  const captured = []
  const tokens = ['Bel', 'la ', 'parata!']
  const legacySdk = async () => ({
    modelId: 'fake-legacy',
    completion: (callOpts) => {
      captured.push(callOpts)
      return {
        tokenStream: (async function * () { for (const t of tokens) yield t })(),
        text: Promise.resolve(tokens.join(''))
      }
    },
    unloadModel: async () => {}
  })
  const c = createCommentator({
    storageDir: '/tmp/curva-legacy-test',
    isHost: true,
    chat,
    sdkFactory: legacySdk,
    tickMs: 60_000,
    roomSlug: 'legacy',
    emit: (ev, p) => emitted.push({ ev, p })
  })
  await c.enable()
  const ok = await c.runTrigger({ type: 'tick' })
  t.ok(ok)
  // kvCache still applied even on the legacy path.
  t.is(captured[0].kvCache, 'commentator:room:legacy')
  const legacy = emitted.filter((e) => e.ev === 'commentary:tokens')
  t.is(legacy.length, tokens.length, 'legacy token events per chunk')
  const modern = emitted.filter((e) => e.ev === 'commentator:token')
  t.is(modern.length, tokens.length, 'modern token events also emitted')
  const done = emitted.find((e) => e.ev === 'commentator:done')
  t.ok(done, 'done still emitted on legacy path')
  await c.close()
})

test('runTrigger with only completionDone (no content) still emits done', async (t) => {
  const chat = fakeChat()
  const emitted = []
  const c = createCommentator({
    storageDir: '/tmp/curva-empty-test',
    isHost: true,
    chat,
    sdkFactory: eventsSdk({
      events: [
        { type: 'completionStats', seq: 0, stats: { tokensPerSecond: 0 } },
        { type: 'completionDone', seq: 1, stopReason: 'length' }
      ]
    }),
    roomSlug: 'empty',
    emit: (ev, p) => emitted.push({ ev, p })
  })
  await c.enable()
  const ok = await c.runTrigger({ type: 'tick' })
  // Empty output triggers EMPTY_OUTPUT error, so ok should be false but the
  // done event should still have fired.
  t.absent(ok, 'empty output returns false')
  const done = emitted.find((e) => e.ev === 'commentator:done')
  t.ok(done, 'commentator:done still fired')
  t.is(done.p.stopReason, 'length', 'stopReason surfaced')
  const err = emitted.find((e) => e.ev === 'commentary:error')
  t.ok(err, 'error emitted')
  t.is(err.p.code, 'EMPTY_OUTPUT')
  await c.close()
})
