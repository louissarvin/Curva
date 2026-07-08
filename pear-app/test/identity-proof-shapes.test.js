// Tier 4 Round 2 shape-validator tests for the optional `identity_proof` field
// on `msg`, `system:tip`, and `system:attendance-issued`.
//
// Coverage:
//   - isValidIdentityProof: null/undefined pass, hex length + charset checks
//   - isValidMessage accepts msg WITH and WITHOUT identity_proof (backward-compat)
//   - isValidSystemTip accepts and rejects identity_proof shapes
//   - isValidSystemAttendanceIssued accepts and rejects identity_proof shapes
//
// The reader/writer path (attach on emit, verify on receive) is exercised in
// keet-identity.test.js.

'use strict'

const test = require('brittle')
const chatModule = require('../bare/chat.js')

const {
  isValidIdentityProof,
  isValidMessage,
  isValidSystemTip,
  isValidSystemAttendanceIssued
} = chatModule._internal

// 65-byte Ed25519 signatures serialize to 130 hex chars; a full keet proof is
// larger (device chain + signature). 260 hex chars is a safe midpoint that
// mirrors what the real proof buffers look like in the keet-identity tests.
const REAL_PROOF_HEX = 'ab'.repeat(130) // 260 chars

// -----------------------------------------------------------------------------

test('isValidIdentityProof: null/undefined pass (legacy backward-compat)', (t) => {
  t.ok(isValidIdentityProof(undefined), 'undefined passes')
  t.ok(isValidIdentityProof(null), 'null passes')
})

test('isValidIdentityProof: rejects non-string types', (t) => {
  t.absent(isValidIdentityProof(123), 'number rejected')
  t.absent(isValidIdentityProof({}), 'object rejected')
  t.absent(isValidIdentityProof([]), 'array rejected')
  t.absent(isValidIdentityProof(true), 'boolean rejected')
})

test('isValidIdentityProof: enforces hex charset and length bounds', (t) => {
  t.absent(isValidIdentityProof(''), 'empty string rejected')
  t.absent(isValidIdentityProof('deadbeef'), 'too short rejected (< 130 chars)')
  t.absent(isValidIdentityProof('zz'.repeat(70)), 'non-hex chars rejected')
  t.absent(isValidIdentityProof('a'.repeat(4097)), 'oversize rejected (> 4096)')
  t.ok(isValidIdentityProof(REAL_PROOF_HEX), 'well-formed 260-char hex accepted')
  t.ok(isValidIdentityProof('ff'.repeat(65)), 'minimum well-formed (130 chars) accepted')
})

// -----------------------------------------------------------------------------

const BASE_MSG = {
  type: 'msg',
  text: 'forza curva',
  by_peer: 'peer-a',
  match_time_ms: 0,
  wall_clock_ms: 1
}

test('isValidMessage: legacy msg without identity_proof still validates', (t) => {
  t.ok(isValidMessage({ ...BASE_MSG }), 'legacy msg accepted')
})

test('isValidMessage: msg with valid identity_proof validates', (t) => {
  t.ok(isValidMessage({ ...BASE_MSG, identity_proof: REAL_PROOF_HEX }), 'msg + proof accepted')
})

test('isValidMessage: msg with null identity_proof validates (legacy field ready shape)', (t) => {
  t.ok(isValidMessage({ ...BASE_MSG, identity_proof: null }), 'msg + null proof accepted')
})

test('isValidMessage: msg with malformed identity_proof rejected', (t) => {
  t.absent(isValidMessage({ ...BASE_MSG, identity_proof: 'not-hex!' }), 'non-hex rejected')
  t.absent(isValidMessage({ ...BASE_MSG, identity_proof: 12345 }), 'number rejected')
  t.absent(isValidMessage({ ...BASE_MSG, identity_proof: '' }), 'empty rejected')
})

// -----------------------------------------------------------------------------

const BASE_TIP = {
  type: 'system:tip',
  by_peer: 'peer-a',
  wall_clock_ms: 1,
  match_time_ms: 0,
  amount: '1000000',
  tx_hash: '0x' + 'ab'.repeat(32)
}

test('isValidSystemTip: legacy tip without identity_proof still validates', (t) => {
  t.ok(isValidSystemTip({ ...BASE_TIP }), 'legacy tip accepted')
})

test('isValidSystemTip: tip with valid identity_proof validates', (t) => {
  t.ok(isValidSystemTip({ ...BASE_TIP, identity_proof: REAL_PROOF_HEX }), 'tip + proof accepted')
})

test('isValidSystemTip: tip with malformed identity_proof rejected', (t) => {
  t.absent(isValidSystemTip({ ...BASE_TIP, identity_proof: 'nope' }), 'too short + non-hex rejected')
  t.absent(isValidSystemTip({ ...BASE_TIP, identity_proof: 42 }), 'number rejected')
})

// -----------------------------------------------------------------------------

const BASE_ATTENDANCE = {
  type: 'system:attendance-issued',
  by_peer: '0x' + '11'.repeat(20),
  wall_clock_ms: 1,
  match_time_ms: 0,
  peerAddress: '0x' + '11'.repeat(20),
  hostAddress: '0x' + 'aa'.repeat(20),
  issuedAt: 1700000000,
  signature: '0x' + 'cd'.repeat(65),
  matchId: null
}

test('isValidSystemAttendanceIssued: legacy pass without identity_proof still validates', (t) => {
  t.ok(isValidSystemAttendanceIssued({ ...BASE_ATTENDANCE }), 'legacy pass accepted')
})

test('isValidSystemAttendanceIssued: pass with valid identity_proof validates', (t) => {
  t.ok(isValidSystemAttendanceIssued({ ...BASE_ATTENDANCE, identity_proof: REAL_PROOF_HEX }), 'pass + proof accepted')
})

test('isValidSystemAttendanceIssued: pass with malformed identity_proof rejected', (t) => {
  t.absent(isValidSystemAttendanceIssued({ ...BASE_ATTENDANCE, identity_proof: 'zz'.repeat(70) }), 'non-hex rejected')
  t.absent(isValidSystemAttendanceIssued({ ...BASE_ATTENDANCE, identity_proof: '' }), 'empty rejected')
})
