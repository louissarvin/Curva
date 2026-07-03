// Phase 1 brittle test: chat reducer + Hyperbee view + goal cluster detection.

const test = require('brittle')
const { makeStore } = require('./_helpers.js')
const { createChat, _internal } = require('../bare/chat.js')

test('createChat returns the expected surface', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'aa'.repeat(32) })
  t.is(typeof c.send, 'function')
  t.is(typeof c.history, 'function')
  t.is(typeof c.onMessage, 'function')
  t.is(typeof c.onGoalCluster, 'function')
  t.is(typeof c.close, 'function')
  await c.close()
  await cleanup()
})

test('send + history round trip', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'aa'.repeat(32) })
  await c.send({ text: 'ciao curva', match_time_ms: 12345 })

  const found = await waitFor(async () => {
    const rows = await c.history({ from: 0, limit: 10 })
    return rows.find((m) => m.text === 'ciao curva')
  }, (v) => !!v)

  t.ok(found, 'message present in history')
  t.is(found.match_time_ms, 12345)
  t.is(found.by_peer, 'aa'.repeat(32))

  await c.close()
  await cleanup()
})

test('sanitizeText enforces 280-char cap', (t) => {
  const long = 'x'.repeat(300)
  const cleaned = _internal.sanitizeText(long)
  t.is(cleaned.length, _internal.MAX_CHARS)
})

test('sanitizeText strips control chars', (t) => {
  const dirty = 'hi' + String.fromCharCode(0) + ' there' + String.fromCharCode(7) + 'buddy' + String.fromCharCode(0x1b) + String.fromCharCode(0x9d)
  const cleaned = _internal.sanitizeText(dirty)
  t.is(cleaned, 'hi therebuddy', 'C0 + C1 chars stripped')
  t.absent(/[\x00-\x1f\x7f-\x9f]/.test(cleaned), 'no C0 or C1 chars remain')
})

test('sanitizeText trims + collapses whitespace', (t) => {
  const dirty = '   hello   world\t\n  '
  const cleaned = _internal.sanitizeText(dirty)
  t.is(cleaned, 'hello world')
})

test('isValidMessage rejects malformed messages', (t) => {
  t.absent(_internal.isValidMessage(null))
  t.absent(_internal.isValidMessage({ type: 'nope' }))
  t.absent(_internal.isValidMessage({ type: 'msg', text: '', by_peer: 'a', match_time_ms: 0, wall_clock_ms: 0 }))
  t.absent(_internal.isValidMessage({ type: 'msg', text: 'x'.repeat(500), by_peer: 'a', match_time_ms: 0, wall_clock_ms: 0 }))
  t.ok(_internal.isValidMessage({ type: 'msg', text: 'hi', by_peer: 'a', match_time_ms: 0, wall_clock_ms: 1 }))
})

// Wave 6 T4 + T14: system:tip-congrats and system:tip-ack schemas.
test('isValidMessage accepts system:tip-congrats with text + lang', (t) => {
  const ok = {
    type: 'system:tip-congrats',
    by_peer: 'a'.repeat(64),
    match_time_ms: 0,
    wall_clock_ms: 123,
    text: '@nord-cobalt-72 just tipped 5 USDT!',
    lang: 'en',
    source_lang: 'en',
    tx_hash: '0x' + 'a'.repeat(64)
  }
  t.ok(_internal.isValidMessage(ok), 'congrats accepted')

  t.absent(_internal.isValidMessage({ ...ok, text: '' }), 'empty text rejected')
  t.absent(_internal.isValidMessage({ ...ok, text: 'x'.repeat(500) }), 'over-length text rejected')
  t.absent(_internal.isValidMessage({ ...ok, tx_hash: 'nope' }), 'bad tx_hash rejected')
})

test('isValidMessage accepts system:tip-ack with 65-byte signature', (t) => {
  const ok = {
    type: 'system:tip-ack',
    by_peer: 'a'.repeat(64),
    match_time_ms: 0,
    wall_clock_ms: 123,
    tx_hash: '0x' + 'a'.repeat(64),
    // 65 bytes = 130 hex + '0x' prefix = 132 chars.
    signature: '0x' + 'b'.repeat(130),
    signer: '0x' + 'c'.repeat(40)
  }
  t.ok(_internal.isValidMessage(ok), 'ack accepted')

  t.absent(_internal.isValidMessage({ ...ok, signer: '0xshort' }), 'bad signer rejected')
  t.absent(_internal.isValidMessage({ ...ok, signature: '0xshort' }), 'short signature rejected')
  t.absent(_internal.isValidMessage({ ...ok, tx_hash: 'nope' }), 'bad tx_hash rejected')
})

test('goal cluster: 5 messages in 3 seconds emits cluster event', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'cc'.repeat(32) })

  let cluster = null
  c.onGoalCluster((payload) => { cluster = payload })

  for (let i = 0; i < 5; i++) {
    await c.send({ text: 'GOOOOL ' + i, match_time_ms: 60_000 + i })
  }

  await waitFor(() => cluster, (v) => !!v, { timeoutMs: 3000 })

  t.ok(cluster, 'cluster event fired')
  t.ok(cluster.count >= 5, `count >= 5 (got ${cluster.count})`)
  t.is(cluster.messageIds.length, cluster.count)

  await c.close()
  await cleanup()
})

test('non-cluster: messages spread over time do NOT emit cluster', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'dd'.repeat(32) })

  let cluster = null
  c.onGoalCluster((payload) => { cluster = payload })

  // Fire 3 messages with ~1.2s gaps. Cluster window is 3s + threshold 5 -> never trips.
  for (let i = 0; i < 3; i++) {
    await c.send({ text: 'just chatting ' + i, match_time_ms: 60_000 + i * 1000 })
    await waitMs(1200)
  }
  await waitMs(300)
  t.absent(cluster, 'no cluster event should fire for slow chat')

  await c.close()
  await cleanup()
})

test('onMessage dedupes: each message emits exactly once', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'ee'.repeat(32) })

  const seen = new Map() // wall_clock_ms -> count
  c.onMessage((msg) => {
    seen.set(msg.wall_clock_ms, (seen.get(msg.wall_clock_ms) || 0) + 1)
  })

  for (let i = 0; i < 4; i++) {
    await c.send({ text: 'msg ' + i, match_time_ms: 1000 + i })
    await waitMs(5)
  }
  await waitMs(200)

  for (const [k, count] of seen) {
    t.is(count, 1, `wall_clock=${k} emitted once (got ${count})`)
  }

  await c.close()
  await cleanup()
})

test('send rejects empty / oversized inputs', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'ff'.repeat(32) })

  await t.exception.all(() => c.send({ text: '', match_time_ms: 0 }), 'empty rejected')
  await t.exception.all(() => c.send({ text: '   ', match_time_ms: 0 }), 'whitespace-only rejected')
  await t.exception.all(() => c.send({ text: 42, match_time_ms: 0 }), 'non-string rejected')
  await t.exception.all(() => c.send({ text: 'x', match_time_ms: -1 }), 'negative time rejected')

  await c.close()
  await cleanup()
})

// -- Phase 3.5: source_lang propagation ------------------------------------

test('Phase 3.5: send with source_lang persists both source_lang and legacy lang', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'a1'.repeat(32) })

  await c.send({ text: 'ciao', match_time_ms: 1000, source_lang: 'it' })

  const rows = await waitFor(async () => {
    const r = await c.history({ from: 0, limit: 10 })
    return r.find((m) => m.text === 'ciao')
  }, (v) => !!v)

  t.ok(rows, 'stored')
  t.is(rows.source_lang, 'it', 'source_lang field stored')
  t.is(rows.lang, 'it', 'legacy lang field also stored (backward compat)')

  await c.close()
  await cleanup()
})

test('Phase 3.5: legacy lang field is honored when source_lang absent', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'a2'.repeat(32) })

  await c.send({ text: 'test-legacy', match_time_ms: 2000, lang: 'id' })

  const rows = await waitFor(async () => {
    const r = await c.history({ from: 0, limit: 10 })
    return r.find((m) => m.text === 'test-legacy')
  }, (v) => !!v)

  t.ok(rows, 'stored')
  t.is(rows.source_lang, 'id', 'source_lang derived from legacy lang')
  t.is(rows.lang, 'id', 'legacy field preserved')

  await c.close()
  await cleanup()
})

test('Phase 3.5: no lang / source_lang means neither field is set', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'a3'.repeat(32) })

  await c.send({ text: 'no-lang', match_time_ms: 3000 })

  const rows = await waitFor(async () => {
    const r = await c.history({ from: 0, limit: 10 })
    return r.find((m) => m.text === 'no-lang')
  }, (v) => !!v)

  t.ok(rows, 'stored')
  t.is(rows.source_lang, undefined, 'no source_lang')
  t.is(rows.lang, undefined, 'no legacy lang')

  await c.close()
  await cleanup()
})

test('Phase 3.5: readSourceLang falls back to caller default when message has no lang', (t) => {
  const readSourceLang = _internal.readSourceLang
  t.is(readSourceLang({ text: 'x' }), 'en', 'default en')
  t.is(readSourceLang({ text: 'x' }, 'it'), 'it', 'custom default')
  t.is(readSourceLang(null), 'en', 'null-safe')
  t.is(readSourceLang({ source_lang: 'id' }), 'id', 'prefers source_lang')
  t.is(readSourceLang({ lang: 'it' }), 'it', 'falls back to legacy lang')
  t.is(readSourceLang({ source_lang: 'id', lang: 'it' }), 'id', 'source_lang wins over legacy')
})

test('Phase 3.5: normalizeLang normalizes case and rejects invalid', (t) => {
  const n = _internal.normalizeLang
  t.is(n('IT'), 'it', 'lowercases')
  t.is(n(' it '), 'it', 'trims')
  t.is(n('en'), 'en')
  t.is(n('id'), 'id')
  t.is(n(''), null, 'empty rejected')
  t.is(n('x'), null, 'too short rejected')
  t.is(n('this-is-way-too-long'), null, 'too long rejected')
  t.is(n(42), null, 'non-string rejected')
  t.is(n(null), null, 'null-safe')
})

test('Phase 3.5: bad source_lang values are silently dropped (no send error)', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'a4'.repeat(32) })

  // Non-conforming lang codes should not crash; message just drops the field.
  await c.send({ text: 'msg-bad-lang', match_time_ms: 4000, source_lang: 42 })

  const rows = await waitFor(async () => {
    const r = await c.history({ from: 0, limit: 10 })
    return r.find((m) => m.text === 'msg-bad-lang')
  }, (v) => !!v)

  t.ok(rows, 'stored despite bad lang')
  t.is(rows.source_lang, undefined, 'invalid source_lang dropped')

  await c.close()
  await cleanup()
})

test('chatKey padding: keys sort lexicographically by timestamp', (t) => {
  const a = _internal.chatKey({ wall_clock_ms: 100, by_peer: 'aaaaaaaa' })
  const b = _internal.chatKey({ wall_clock_ms: 200, by_peer: 'bbbbbbbb' })
  const c = _internal.chatKey({ wall_clock_ms: 1000000, by_peer: 'cccccccc' })
  t.ok(a < b, 'a < b lexicographically')
  t.ok(b < c, 'b < c lexicographically')
})

// Final Fix Wave T-D3: the chat Autobase exposes BOTH 'writable' and
// 'unwritable' events so workers/main.js can mirror them onto the IPC pipe
// (`room:base-writable` / `room:base-unwritable`). The autobase README pairs
// these as the canonical way to react to writer-status transitions; asserting
// them via listenerCount protects the wiring in workers/main.js:531-556 from
// silent breakage if a future autobase upgrade renames or splits the event.
test('T-D3: chat base accepts unwritable listener alongside writable', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'aa'.repeat(32) })
  const base = c.getBase()
  t.is(typeof base.on, 'function', 'base is an EventEmitter')
  const onWritable = () => {}
  const onUnwritable = () => {}
  base.on('writable', onWritable)
  base.on('unwritable', onUnwritable)
  t.is(base.listenerCount('writable'), 1, 'writable listener registered')
  t.is(base.listenerCount('unwritable'), 1, 'unwritable listener registered')
  base.off('writable', onWritable)
  base.off('unwritable', onUnwritable)
  t.is(base.listenerCount('writable'), 0)
  t.is(base.listenerCount('unwritable'), 0)
  await c.close()
  await cleanup()
})

// -- helpers ---------------------------------------------------------------

async function waitFor(fn, pred, { timeoutMs = 3000, intervalMs = 30 } = {}) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeoutMs) {
    last = await fn()
    if (pred(last)) return last
    await waitMs(intervalMs)
  }
  return last
}

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
