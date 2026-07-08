// D1: attendance batch mint tests.
//
// Coverage:
//   1. issuePassesForRoster for a roster of 3 produces 3 signed passes AND
//      3 chat messages.
//   2. Gate: CURVA_ATTENDANCE_AUTOISSUE=false is a room.js-level flag; here we
//      exercise the module-level gate CURVA_ATTENDANCE_ENABLED=false which
//      short-circuits the batch method just like the single-mint path.
//   3. Non-host: no batch mint (returns {issued:[], skipped:[], failed:[]}).
//
// Docs verified via WebFetch on 2026-07-06:
//   - https://eips.ethereum.org/EIPS/eip-191 confirms EIP-191 has NO batch
//     signing primitive and NO merkle aggregation. Signing N attendance
//     messages requires N distinct ecrecoverable signatures. That is what
//     issuePassesForRoster produces (via N calls to wallet.signAttendance).

const test = require('brittle')
const { createAttendance, buildAttendanceMessage } = require('../bare/attendance.js')

const HOST = '0x' + 'aa'.repeat(20)
const SLUG = 'curva-batch-demo'

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

function makeFakeWallet() {
  const calls = []
  return {
    calls,
    async signAttendance({ slug, matchId, peerAddress, issuedAt }) {
      calls.push({ slug, matchId, peerAddress, issuedAt })
      return {
        signature: '0x' + 'cd'.repeat(65),
        hostAddress: HOST,
        message: buildAttendanceMessage({ slug, matchId, peerAddress, issuedAt })
      }
    }
  }
}

function makeRoster(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    // Distinct 20-byte addresses seeded from i.
    const nibble = (i + 1).toString(16).padStart(2, '0')
    out.push({ address: '0x' + nibble.repeat(20), handle: 'peer-' + i })
  }
  return out
}

// -----------------------------------------------------------------------------

test('issuePassesForRoster: roster of 3 produces 3 passes and 3 chat rows', async (t) => {
  const priorEnv = process.env.CURVA_ATTENDANCE_ENABLED
  process.env.CURVA_ATTENDANCE_ENABLED = 'true'
  try {
    const bee = makeFakeBee()
    const chat = makeFakeChat()
    const wallet = makeFakeWallet()
    const svc = createAttendance({
      wallet, chat, roomStateBee: bee,
      slug: SLUG, isHost: true, matchId: 'match-42'
    })
    const roster = makeRoster(3)
    const res = await svc.issuePassesForRoster(roster)

    t.is(res.issued.length, 3, 'three passes signed')
    t.is(res.skipped.length, 0)
    t.is(res.failed.length, 0)
    t.is(wallet.calls.length, 3, 'three EIP-191 signatures')
    t.is(chat.appended.length, 3, 'three chat rows appended')

    // Every appended row is a system:attendance-issued for a distinct peer.
    const seen = new Set()
    for (const m of chat.appended) {
      t.is(m.type, 'system:attendance-issued')
      t.ok(/^0x[0-9a-f]{40}$/.test(m.peerAddress))
      seen.add(m.peerAddress)
    }
    t.is(seen.size, 3, 'all three peers covered')
  } finally {
    if (priorEnv === undefined) delete process.env.CURVA_ATTENDANCE_ENABLED
    else process.env.CURVA_ATTENDANCE_ENABLED = priorEnv
  }
})

test('issuePassesForRoster: gate CURVA_ATTENDANCE_ENABLED=false yields empty result', async (t) => {
  const priorEnv = process.env.CURVA_ATTENDANCE_ENABLED
  process.env.CURVA_ATTENDANCE_ENABLED = 'false'
  try {
    const bee = makeFakeBee()
    const chat = makeFakeChat()
    const wallet = makeFakeWallet()
    const svc = createAttendance({
      wallet, chat, roomStateBee: bee, slug: SLUG, isHost: true
    })
    const res = await svc.issuePassesForRoster(makeRoster(3))
    t.is(res.issued.length, 0)
    t.is(res.skipped.length, 0)
    t.is(res.failed.length, 0)
    t.is(wallet.calls.length, 0, 'no signatures produced when disabled')
    t.is(chat.appended.length, 0, 'no chat rows appended when disabled')
  } finally {
    if (priorEnv === undefined) delete process.env.CURVA_ATTENDANCE_ENABLED
    else process.env.CURVA_ATTENDANCE_ENABLED = priorEnv
  }
})

test('issuePassesForRoster: non-host yields no batch mint', async (t) => {
  const priorEnv = process.env.CURVA_ATTENDANCE_ENABLED
  process.env.CURVA_ATTENDANCE_ENABLED = 'true'
  try {
    const bee = makeFakeBee()
    const chat = makeFakeChat()
    const wallet = makeFakeWallet()
    const svc = createAttendance({
      wallet, chat, roomStateBee: bee, slug: SLUG, isHost: false
    })
    const res = await svc.issuePassesForRoster(makeRoster(3))
    t.is(res.issued.length, 0)
    t.is(wallet.calls.length, 0, 'peer does not sign')
    t.is(chat.appended.length, 0, 'peer does not broadcast')
  } finally {
    if (priorEnv === undefined) delete process.env.CURVA_ATTENDANCE_ENABLED
    else process.env.CURVA_ATTENDANCE_ENABLED = priorEnv
  }
})

test('issuePassesForRoster: mixed roster with a bad address collects a failure row', async (t) => {
  const priorEnv = process.env.CURVA_ATTENDANCE_ENABLED
  process.env.CURVA_ATTENDANCE_ENABLED = 'true'
  try {
    const bee = makeFakeBee()
    const chat = makeFakeChat()
    const wallet = makeFakeWallet()
    const svc = createAttendance({
      wallet, chat, roomStateBee: bee, slug: SLUG, isHost: true
    })
    const roster = [
      { address: '0x' + '11'.repeat(20) },
      { address: 'not-hex' },
      { address: '0x' + '22'.repeat(20) }
    ]
    const res = await svc.issuePassesForRoster(roster)
    t.is(res.issued.length, 2, 'two valid addresses signed')
    t.is(res.failed.length, 1, 'one invalid address rejected')
    t.is(res.failed[0].reason, 'ADDRESS_INVALID')
    t.is(wallet.calls.length, 2)
    t.is(chat.appended.length, 2)
  } finally {
    if (priorEnv === undefined) delete process.env.CURVA_ATTENDANCE_ENABLED
    else process.env.CURVA_ATTENDANCE_ENABLED = priorEnv
  }
})

test('issuePassesForRoster: cached passes go into skipped (idempotent replay)', async (t) => {
  const priorEnv = process.env.CURVA_ATTENDANCE_ENABLED
  process.env.CURVA_ATTENDANCE_ENABLED = 'true'
  try {
    const bee = makeFakeBee()
    const chat = makeFakeChat()
    const wallet = makeFakeWallet()
    const svc = createAttendance({
      wallet, chat, roomStateBee: bee, slug: SLUG, isHost: true
    })
    const roster = makeRoster(2)
    // First run: both peers get fresh passes.
    const first = await svc.issuePassesForRoster(roster)
    t.is(first.issued.length, 2)
    t.is(first.skipped.length, 0)
    // Second run: both hit the cache. No new signatures, no new chat rows.
    const second = await svc.issuePassesForRoster(roster)
    t.is(second.issued.length, 0)
    t.is(second.skipped.length, 2)
    t.is(wallet.calls.length, 2, 'wallet called 2 times total, cache short-circuited replay')
  } finally {
    if (priorEnv === undefined) delete process.env.CURVA_ATTENDANCE_ENABLED
    else process.env.CURVA_ATTENDANCE_ENABLED = priorEnv
  }
})
