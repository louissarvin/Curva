// Wave 14 tests for bare/attendance.js + chat.js host-only gate on
// system:attendance-issued.
//
// Coverage:
//   - buildAttendanceMessage produces the canonical shape (matches backend)
//   - createAttendance rejects when feature flag is off
//   - Host issues a pass, persists to hyperbee, broadcasts to chat
//   - Non-host issuePass returns NOT_HOST
//   - Rate-limit: 4th issuance for same peer within an hour is rejected
//   - Idempotent-ish: second call returns cached pass without re-signing
//   - Chat shape validator accepts a well-formed message
//   - Chat shape validator rejects malformed shapes
//   - Chat host-only gate rejects non-host writers

const test = require('brittle')
const { createAttendance, buildAttendanceMessage, _internal } = require('../bare/attendance.js')
const chatModule = require('../bare/chat.js')
const { isValidSystemAttendanceIssued, checkHostSystemAuthorship } = chatModule._internal

const PEER = '0x' + '11'.repeat(20)
const OTHER_PEER = '0x' + '22'.repeat(20)
const HOST = '0x' + 'aa'.repeat(20)
const SLUG = 'curva-sud-torino'

function makeFakeBee() {
  const data = new Map()
  return {
    _data: data,
    async put(k, v) { data.set(k, JSON.parse(JSON.stringify(v))) },
    async del(k) { data.delete(k) },
    async get(k) {
      const v = data.get(k)
      return v ? { key: k, value: v } : null
    },
    async close() {},
    createReadStream({ gt, lt, limit } = {}) {
      const keys = [...data.keys()].sort()
      const filtered = keys.filter((k) => {
        if (gt && k <= gt) return false
        if (lt && k >= lt) return false
        return true
      })
      const trimmed = typeof limit === 'number' ? filtered.slice(0, limit) : filtered
      return (async function* () {
        for (const k of trimmed) yield { key: k, value: data.get(k) }
      })()
    }
  }
}

function makeFakeChat() {
  const appended = []
  return {
    appended,
    async sendSystem(msg) {
      appended.push(msg)
      return msg
    }
  }
}

function makeFakeWallet({ throwOnSign = false } = {}) {
  const calls = []
  return {
    calls,
    async signAttendance({ slug, matchId, peerAddress, issuedAt }) {
      calls.push({ slug, matchId, peerAddress, issuedAt })
      if (throwOnSign) throw new Error('boom')
      return {
        signature: '0x' + 'cd'.repeat(65),
        hostAddress: HOST,
        message: buildAttendanceMessage({ slug, matchId, peerAddress, issuedAt })
      }
    }
  }
}

// -----------------------------------------------------------------------------

test('buildAttendanceMessage: canonical shape matches backend', (t) => {
  const msg = buildAttendanceMessage({
    slug: 'CURVA-SUD',
    matchId: 'match-1',
    peerAddress: PEER.toUpperCase(),
    issuedAt: 1_700_000_000
  })
  // Slug + peer lowercased; matchId preserved as-is (trim only); issuedAt floored.
  t.is(
    msg,
    `curva-attendance-pass:v1:curva-sud:match-1:${PEER.toLowerCase()}:1700000000`
  )
})

test('createAttendance: FEATURE_DISABLED when env flag is off', async (t) => {
  const priorEnv = process.env.CURVA_ATTENDANCE_ENABLED
  process.env.CURVA_ATTENDANCE_ENABLED = 'false'
  try {
    const bee = makeFakeBee()
    const chat = makeFakeChat()
    const wallet = makeFakeWallet()
    const svc = createAttendance({ wallet, chat, roomStateBee: bee, slug: SLUG, isHost: true })
    const res = await svc.issuePass(PEER)
    t.is(res.ok, false)
    t.is(res.reason, 'FEATURE_DISABLED')
  } finally {
    if (priorEnv === undefined) delete process.env.CURVA_ATTENDANCE_ENABLED
    else process.env.CURVA_ATTENDANCE_ENABLED = priorEnv
  }
})

test('issuePass: host signs, persists, broadcasts', async (t) => {
  const priorEnv = process.env.CURVA_ATTENDANCE_ENABLED
  process.env.CURVA_ATTENDANCE_ENABLED = 'true'
  try {
    const bee = makeFakeBee()
    const chat = makeFakeChat()
    const wallet = makeFakeWallet()
    const svc = createAttendance({
      wallet,
      chat,
      roomStateBee: bee,
      slug: SLUG,
      matchId: 'match-1',
      isHost: true
    })
    const res = await svc.issuePass(PEER)
    t.is(res.ok, true)
    t.ok(res.pass)
    t.is(res.pass.peerAddress, PEER.toLowerCase())
    t.is(res.pass.hostAddress, HOST.toLowerCase())
    t.is(typeof res.pass.signature, 'string')
    // Wallet was called with the canonical args.
    t.is(wallet.calls.length, 1)
    t.is(wallet.calls[0].slug, SLUG)
    t.is(wallet.calls[0].peerAddress, PEER.toLowerCase())
    // Persisted to hyperbee.
    const stored = await bee.get(_internal.passKey(PEER.toLowerCase()))
    t.ok(stored?.value)
    // Broadcast to chat.
    t.is(chat.appended.length, 1)
    t.is(chat.appended[0].type, 'system:attendance-issued')
    t.is(chat.appended[0].peerAddress, PEER.toLowerCase())
    t.is(chat.appended[0].hostAddress, HOST.toLowerCase())
  } finally {
    if (priorEnv === undefined) delete process.env.CURVA_ATTENDANCE_ENABLED
    else process.env.CURVA_ATTENDANCE_ENABLED = priorEnv
  }
})

test('issuePass: non-host returns NOT_HOST', async (t) => {
  const priorEnv = process.env.CURVA_ATTENDANCE_ENABLED
  process.env.CURVA_ATTENDANCE_ENABLED = 'true'
  try {
    const bee = makeFakeBee()
    const chat = makeFakeChat()
    const wallet = makeFakeWallet()
    const svc = createAttendance({ wallet, chat, roomStateBee: bee, slug: SLUG, isHost: false })
    const res = await svc.issuePass(PEER)
    t.is(res.ok, false)
    t.is(res.reason, 'NOT_HOST')
    t.is(wallet.calls.length, 0)
    t.is(chat.appended.length, 0)
  } finally {
    if (priorEnv === undefined) delete process.env.CURVA_ATTENDANCE_ENABLED
    else process.env.CURVA_ATTENDANCE_ENABLED = priorEnv
  }
})

test('issuePass: returns cached pass on second call (no re-sign)', async (t) => {
  const priorEnv = process.env.CURVA_ATTENDANCE_ENABLED
  process.env.CURVA_ATTENDANCE_ENABLED = 'true'
  try {
    const bee = makeFakeBee()
    const chat = makeFakeChat()
    const wallet = makeFakeWallet()
    const svc = createAttendance({ wallet, chat, roomStateBee: bee, slug: SLUG, isHost: true })
    const r1 = await svc.issuePass(PEER)
    t.is(r1.ok, true)
    const r2 = await svc.issuePass(PEER)
    t.is(r2.ok, true)
    t.is(r2.cached, true)
    // Wallet was called exactly once — second call short-circuited.
    t.is(wallet.calls.length, 1)
  } finally {
    if (priorEnv === undefined) delete process.env.CURVA_ATTENDANCE_ENABLED
    else process.env.CURVA_ATTENDANCE_ENABLED = priorEnv
  }
})

test('issuePass: rate limit at 4th force-issued pass for same peer', async (t) => {
  const priorEnv = process.env.CURVA_ATTENDANCE_ENABLED
  process.env.CURVA_ATTENDANCE_ENABLED = 'true'
  try {
    const bee = makeFakeBee()
    const chat = makeFakeChat()
    const wallet = makeFakeWallet()
    const svc = createAttendance({ wallet, chat, roomStateBee: bee, slug: SLUG, isHost: true })
    const results = []
    for (let i = 0; i < 4; i++) {
      results.push(await svc.issuePass(PEER, { force: true }))
    }
    // First three succeed, fourth is RATE_LIMITED.
    t.is(results[0].ok, true)
    t.is(results[1].ok, true)
    t.is(results[2].ok, true)
    t.is(results[3].ok, false)
    t.is(results[3].reason, 'RATE_LIMITED')
    t.is(wallet.calls.length, 3)
  } finally {
    if (priorEnv === undefined) delete process.env.CURVA_ATTENDANCE_ENABLED
    else process.env.CURVA_ATTENDANCE_ENABLED = priorEnv
  }
})

test('issuePass: rejects malformed peer address', async (t) => {
  const priorEnv = process.env.CURVA_ATTENDANCE_ENABLED
  process.env.CURVA_ATTENDANCE_ENABLED = 'true'
  try {
    const bee = makeFakeBee()
    const chat = makeFakeChat()
    const wallet = makeFakeWallet()
    const svc = createAttendance({ wallet, chat, roomStateBee: bee, slug: SLUG, isHost: true })
    const res = await svc.issuePass('not-hex')
    t.is(res.ok, false)
    t.is(res.reason, 'ADDRESS_INVALID')
  } finally {
    if (priorEnv === undefined) delete process.env.CURVA_ATTENDANCE_ENABLED
    else process.env.CURVA_ATTENDANCE_ENABLED = priorEnv
  }
})

test('listPasses + getPass roundtrip', async (t) => {
  const priorEnv = process.env.CURVA_ATTENDANCE_ENABLED
  process.env.CURVA_ATTENDANCE_ENABLED = 'true'
  try {
    const bee = makeFakeBee()
    const chat = makeFakeChat()
    const wallet = makeFakeWallet()
    const svc = createAttendance({ wallet, chat, roomStateBee: bee, slug: SLUG, isHost: true })
    await svc.issuePass(PEER)
    await svc.issuePass(OTHER_PEER)
    const list = await svc.listPasses({})
    t.is(list.length, 2)
    const one = await svc.getPass(PEER)
    t.ok(one)
    t.is(one.peerAddress, PEER.toLowerCase())
    const none = await svc.getPass('0x' + 'ff'.repeat(20))
    t.is(none, null)
  } finally {
    if (priorEnv === undefined) delete process.env.CURVA_ATTENDANCE_ENABLED
    else process.env.CURVA_ATTENDANCE_ENABLED = priorEnv
  }
})

// -----------------------------------------------------------------------------
// chat.js shape validator + host-only authorship gate.
// -----------------------------------------------------------------------------

test('isValidSystemAttendanceIssued: accepts well-formed shape', (t) => {
  const ok = isValidSystemAttendanceIssued({
    type: 'system:attendance-issued',
    by_peer: 'local',
    match_time_ms: 0,
    wall_clock_ms: Date.now(),
    peerAddress: PEER,
    hostAddress: HOST,
    issuedAt: Math.floor(Date.now() / 1000),
    signature: '0x' + 'cd'.repeat(65),
    matchId: 'match-1'
  })
  t.is(ok, true)
})

test('isValidSystemAttendanceIssued: rejects missing signature', (t) => {
  const ok = isValidSystemAttendanceIssued({
    type: 'system:attendance-issued',
    by_peer: 'local',
    match_time_ms: 0,
    wall_clock_ms: Date.now(),
    peerAddress: PEER,
    hostAddress: HOST,
    issuedAt: Math.floor(Date.now() / 1000)
  })
  t.is(ok, false)
})

test('isValidSystemAttendanceIssued: rejects malformed peer address', (t) => {
  const ok = isValidSystemAttendanceIssued({
    type: 'system:attendance-issued',
    by_peer: 'local',
    match_time_ms: 0,
    wall_clock_ms: Date.now(),
    peerAddress: 'not-hex',
    hostAddress: HOST,
    issuedAt: Math.floor(Date.now() / 1000),
    signature: '0x' + 'cd'.repeat(65)
  })
  t.is(ok, false)
})

test('checkHostSystemAuthorship gate: rejects non-host writer', (t) => {
  const hostHex = 'aa'.repeat(32)
  const otherHex = 'bb'.repeat(32)
  t.is(checkHostSystemAuthorship(hostHex, hostHex), true)
  t.is(checkHostSystemAuthorship(otherHex, hostHex), false)
  // Pre-init grace: hostWriterHex not yet set -> allowed.
  t.is(checkHostSystemAuthorship(otherHex, null), true)
})

test('signAttendance shape: matches backend canonical bytes', (t) => {
  const msg = buildAttendanceMessage({
    slug: SLUG,
    matchId: 'match-1',
    peerAddress: PEER,
    issuedAt: 1_700_000_000
  })
  t.is(msg.startsWith('curva-attendance-pass:v1:'), true)
  t.is(msg.includes(':match-1:'), true)
  t.is(msg.endsWith(':1700000000'), true)
})
