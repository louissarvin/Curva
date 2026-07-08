// Wave 13B brittle tests: chat.js validators + apply()-gate for the new
// system:bot-query / system:bot-reply message types.
//
// The apply() gate is verified via checkHostSystemAuthorship, which is the
// pure helper the reducer uses under the hood. This avoids booting Autobase
// while still asserting the "non-host bot-reply is dropped" property.

const test = require('brittle')

const { _internal: chatInternal } = require('../bare/chat.js')
const {
  isValidSystemBotQuery,
  isValidSystemBotReply,
  isValidMessage,
  chatKey,
  checkHostSystemAuthorship
} = chatInternal

// -- system:bot-query -------------------------------------------------------

test('isValidSystemBotQuery accepts a well-formed query', async (t) => {
  const good = {
    type: 'system:bot-query',
    text: 'tip the host 1 USDT',
    byPeer: 'peerA',
    match_time_ms: 0,
    wall_clock_ms: Date.now(),
    query_id: 'bq_123_456'
  }
  t.ok(isValidSystemBotQuery(good), 'baseline shape accepted')
  t.ok(isValidMessage(good), 'dispatches through isValidMessage')
})

test('isValidSystemBotQuery rejects malformed shapes', async (t) => {
  const base = {
    type: 'system:bot-query',
    text: 'help',
    byPeer: 'peerA',
    match_time_ms: 0,
    wall_clock_ms: 100,
    query_id: 'q1'
  }
  t.absent(isValidSystemBotQuery({ ...base, type: 'msg' }), 'wrong type rejected')
  t.absent(isValidSystemBotQuery({ ...base, text: '' }), 'empty text rejected')
  t.absent(isValidSystemBotQuery({ ...base, text: 'x'.repeat(501) }), 'oversized text rejected')
  t.absent(isValidSystemBotQuery({ ...base, byPeer: 123 }), 'non-string byPeer rejected')
  t.absent(isValidSystemBotQuery({ ...base, byPeer: 'x'.repeat(129) }), 'oversized byPeer rejected')
  t.absent(isValidSystemBotQuery({ ...base, wall_clock_ms: -1 }), 'negative wall_clock_ms rejected')
  t.absent(isValidSystemBotQuery({ ...base, match_time_ms: 'zero' }), 'non-numeric match_time_ms rejected')
  t.absent(isValidSystemBotQuery({ ...base, query_id: '' }), 'empty query_id rejected')
  t.absent(isValidSystemBotQuery({ ...base, query_id: 'x'.repeat(65) }), 'oversized query_id rejected')
  t.absent(isValidSystemBotQuery(null), 'null rejected')
  t.absent(isValidSystemBotQuery('string'), 'primitive rejected')
})

// -- system:bot-reply -------------------------------------------------------

test('isValidSystemBotReply accepts a well-formed reply', async (t) => {
  const good = {
    type: 'system:bot-reply',
    text: 'Tipped host successfully.',
    byPeer: 'peerA',
    match_time_ms: 0,
    wall_clock_ms: Date.now(),
    query_id: 'bq_123_456',
    tool_calls: [
      { name: 'send_tip', ok: true },
      { name: 'verify_tip_attribution', ok: false, error: 'not found' }
    ]
  }
  t.ok(isValidSystemBotReply(good), 'baseline shape accepted')
  t.ok(isValidMessage(good), 'dispatches through isValidMessage')
})

test('isValidSystemBotReply: tool_calls is optional', async (t) => {
  const noTools = {
    type: 'system:bot-reply',
    text: 'ok',
    byPeer: '',
    match_time_ms: 0,
    wall_clock_ms: 1,
    query_id: 'q1'
  }
  t.ok(isValidSystemBotReply(noTools), 'accepted without tool_calls')
})

test('isValidSystemBotReply rejects malformed shapes', async (t) => {
  const base = {
    type: 'system:bot-reply',
    text: 'answer',
    byPeer: 'peerA',
    match_time_ms: 0,
    wall_clock_ms: 100,
    query_id: 'q1',
    tool_calls: [{ name: 'send_tip', ok: true }]
  }
  t.absent(isValidSystemBotReply({ ...base, type: 'msg' }), 'wrong type rejected')
  t.absent(isValidSystemBotReply({ ...base, text: '' }), 'empty text rejected')
  t.absent(isValidSystemBotReply({ ...base, text: 'x'.repeat(281) }), 'oversized text (>280) rejected')
  t.absent(isValidSystemBotReply({ ...base, query_id: '' }), 'empty query_id rejected')
  t.absent(isValidSystemBotReply({ ...base, tool_calls: 'oops' }), 'non-array tool_calls rejected')
  t.absent(
    isValidSystemBotReply({ ...base, tool_calls: new Array(9).fill({ name: 'x', ok: true }) }),
    'oversized tool_calls array (>8) rejected'
  )
  t.absent(
    isValidSystemBotReply({ ...base, tool_calls: [{ name: 'x', ok: 'nope' }] }),
    'non-bool tool_calls[].ok rejected'
  )
  t.absent(
    isValidSystemBotReply({ ...base, tool_calls: [{ name: '', ok: true }] }),
    'empty tool_calls[].name rejected'
  )
  t.absent(
    isValidSystemBotReply({ ...base, tool_calls: [{ name: 'x'.repeat(65), ok: true }] }),
    'oversized tool_calls[].name rejected'
  )
  t.absent(
    isValidSystemBotReply({ ...base, tool_calls: [{ name: 'x', ok: true, error: 'x'.repeat(97) }] }),
    'oversized tool_calls[].error rejected'
  )
})

// -- apply()-gate (via checkHostSystemAuthorship) --------------------------

test('non-host system:bot-reply is dropped by apply() gate', async (t) => {
  const host = 'a'.repeat(64)
  const peer = 'b'.repeat(64)
  // The apply reducer calls isAuthorizedHostSystem(writerHex), which is the
  // closure-scoped alias of checkHostSystemAuthorship (verified inline in
  // bare/chat.js). Same host-only gate protects system:bot-reply.
  t.ok(checkHostSystemAuthorship(host, host), 'host may author bot-reply')
  t.absent(checkHostSystemAuthorship(peer, host), 'non-host bot-reply rejected')
  t.ok(checkHostSystemAuthorship(peer, null), 'pre-init grace: any writer allowed')
})

// -- chatKey: deterministic Hyperbee slot per query_id --------------------

test('chatKey encodes system:bot-query + reply with shared query_id', async (t) => {
  const q = {
    type: 'system:bot-query',
    text: 'hi',
    byPeer: 'peerA',
    match_time_ms: 0,
    wall_clock_ms: 1234567890,
    query_id: 'bq_abc_42'
  }
  const r = {
    type: 'system:bot-reply',
    text: 'hi back',
    byPeer: 'peerA',
    match_time_ms: 0,
    wall_clock_ms: 1234567891,
    query_id: 'bq_abc_42',
    tool_calls: []
  }
  const kQ = chatKey(q)
  const kR = chatKey(r)
  t.ok(kQ.startsWith('chat/'), 'query lives under chat/ prefix')
  t.ok(kR.startsWith('chat/'), 'reply lives under chat/ prefix')
  t.ok(kQ.includes('bq-'), 'query key tagged with bq-')
  t.ok(kR.includes('br-'), 'reply key tagged with br-')
  // Deterministic key layout: the same shape must produce the same key on
  // replay (autobase rebase idempotency requirement).
  t.is(chatKey(q), kQ, 'query key is deterministic')
  t.is(chatKey(r), kR, 'reply key is deterministic')
})
