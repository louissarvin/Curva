// Wave 10 brittle tests — Match Prediction Pool.
//
// Coverage:
//   * Shape validators for `system:pool-opened`, `system:match-result`,
//     `system:pool-payout` (positive + negative).
//   * Host-only authorship gate (host writer accepted, non-host rejected).
//   * chatKey suffix determinism for the three new host-only message types
//     (so idempotent Autobase replay writes the SAME Hyperbee key).

const test = require('brittle')
const { _internal } = require('../bare/chat.js')

const HOST_HEX = 'aa'.repeat(32)
const OTHER_HEX = 'bb'.repeat(32)

const validPoolOpened = () => ({
  type: 'system:pool-opened',
  matchId: 'match-arg-ita',
  poolAddress: '0x' + 'cd'.repeat(20),
  stakeToken: '0x' + 'ef'.repeat(20),
  entryStakeAtomic: '1000000',
  mode: 'winner-only',
  deadlineMs: Date.now() + 3_600_000,
  by_peer: HOST_HEX,
  match_time_ms: 0,
  wall_clock_ms: Date.now(),
})

const validMatchResult = () => ({
  type: 'system:match-result',
  matchId: 'match-arg-ita',
  winner: 'HOME',
  homeGoals: 2,
  awayGoals: 1,
  by_peer: HOST_HEX,
  match_time_ms: 90 * 60 * 1000,
  wall_clock_ms: Date.now(),
})

const validPoolPayout = () => ({
  type: 'system:pool-payout',
  matchId: 'match-arg-ita',
  txHash: '0x' + 'ab'.repeat(32),
  toAddress: '0x' + '11'.repeat(20),
  amountAtomic: '15000000',
  route: 'erc20-transfer',
  by_peer: HOST_HEX,
  match_time_ms: 90 * 60 * 1000,
  wall_clock_ms: Date.now(),
})

// ---------------------------------------------------------------------------
// Shape validators
// ---------------------------------------------------------------------------

test('isValidSystemPoolOpened accepts well-formed pool-opened', (t) => {
  t.ok(_internal.isValidSystemPoolOpened(validPoolOpened()))
})

test('isValidSystemPoolOpened rejects unknown mode', (t) => {
  const m = validPoolOpened()
  m.mode = 'lottery'
  t.absent(_internal.isValidSystemPoolOpened(m))
})

test('isValidSystemPoolOpened rejects malformed poolAddress', (t) => {
  const m = validPoolOpened()
  m.poolAddress = 'not-an-address'
  t.absent(_internal.isValidSystemPoolOpened(m))
})

test('isValidSystemPoolOpened rejects non-numeric entryStakeAtomic', (t) => {
  const m = validPoolOpened()
  m.entryStakeAtomic = '1.5'
  t.absent(_internal.isValidSystemPoolOpened(m))
})

test('isValidSystemMatchResult accepts well-formed match-result', (t) => {
  t.ok(_internal.isValidSystemMatchResult(validMatchResult()))
})

test('isValidSystemMatchResult rejects unknown winner side', (t) => {
  const m = validMatchResult()
  m.winner = 'BOTH'
  t.absent(_internal.isValidSystemMatchResult(m))
})

test('isValidSystemMatchResult rejects negative goals', (t) => {
  const m = validMatchResult()
  m.homeGoals = -1
  t.absent(_internal.isValidSystemMatchResult(m))
})

test('isValidSystemMatchResult rejects out-of-range goals', (t) => {
  const m = validMatchResult()
  m.awayGoals = 999
  t.absent(_internal.isValidSystemMatchResult(m))
})

test('isValidSystemPoolPayout accepts well-formed pool-payout', (t) => {
  t.ok(_internal.isValidSystemPoolPayout(validPoolPayout()))
})

test('isValidSystemPoolPayout rejects malformed txHash', (t) => {
  const m = validPoolPayout()
  m.txHash = '0xdeadbeef'
  t.absent(_internal.isValidSystemPoolPayout(m))
})

test('isValidSystemPoolPayout rejects malformed toAddress', (t) => {
  const m = validPoolPayout()
  m.toAddress = 'nope'
  t.absent(_internal.isValidSystemPoolPayout(m))
})

test('isValidSystemPoolPayout rejects unknown route value', (t) => {
  const m = validPoolPayout()
  m.route = 'lightning'
  t.absent(_internal.isValidSystemPoolPayout(m))
})

// ---------------------------------------------------------------------------
// isValidMessage dispatch — the reducer routes on `type`.
// ---------------------------------------------------------------------------

test('isValidMessage accepts all three host-only pool types', (t) => {
  t.ok(_internal.isValidMessage(validPoolOpened()))
  t.ok(_internal.isValidMessage(validMatchResult()))
  t.ok(_internal.isValidMessage(validPoolPayout()))
})

test('isValidMessage rejects a pool message with the wrong type tag', (t) => {
  const m = validPoolOpened()
  m.type = 'system:pool-mystery'
  t.absent(_internal.isValidMessage(m))
})

// ---------------------------------------------------------------------------
// Host-only authorship gate — pool-opened / match-result / pool-payout MUST
// only be accepted from the host writer key. The gate is grace-mode (accept
// all) until room.js publishes hostWriterHex.
// ---------------------------------------------------------------------------

test('anti-spoofing: host system messages from non-host are rejected', (t) => {
  t.ok(
    _internal.checkHostSystemAuthorship(HOST_HEX, HOST_HEX),
    'host writer accepted'
  )
  t.absent(
    _internal.checkHostSystemAuthorship(OTHER_HEX, HOST_HEX),
    'non-host writer rejected'
  )
})

test('anti-spoofing: pre-init grace accepts any writer', (t) => {
  // hostWriterHex null/empty means the room has not yet published the writer
  // pubkey. We must not reject in that window or the very first system message
  // could be silently dropped.
  t.ok(_internal.checkHostSystemAuthorship(HOST_HEX, null))
  t.ok(_internal.checkHostSystemAuthorship(OTHER_HEX, ''))
})

// ---------------------------------------------------------------------------
// chatKey determinism — Autobase replays the SAME node during rebase, and the
// reducer must write the SAME Hyperbee key. Non-idempotent keys would double
// the message on rebase.
// ---------------------------------------------------------------------------

test('chatKey: pool-opened suffix is stable across replays', (t) => {
  const m = validPoolOpened()
  const k1 = _internal.chatKey(m)
  const k2 = _internal.chatKey(m)
  t.is(k1, k2)
  t.ok(k1.includes('pool-open-'))
})

test('chatKey: match-result suffix is stable across replays', (t) => {
  const m = validMatchResult()
  const k1 = _internal.chatKey(m)
  const k2 = _internal.chatKey(m)
  t.is(k1, k2)
  t.ok(k1.includes('pool-res-'))
})

test('chatKey: pool-payout suffix is stable across replays', (t) => {
  const m = validPoolPayout()
  const k1 = _internal.chatKey(m)
  const k2 = _internal.chatKey(m)
  t.is(k1, k2)
  t.ok(k1.includes('pool-pay-'))
})

test('chatKey: two payouts with different txHashes get different keys', (t) => {
  const a = validPoolPayout()
  const b = validPoolPayout()
  b.txHash = '0x' + 'cd'.repeat(32)
  b.wall_clock_ms = a.wall_clock_ms // same time, different tx
  t.not(_internal.chatKey(a), _internal.chatKey(b))
})
