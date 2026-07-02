// Curva Attendance Ticket Tools (Wave 14).
//
// Host-side attendance-pass issuance. When a peer joins the room, the host
// signs a canonical off-chain attendance message via wallet.signAttendance and
// appends a `system:attendance-issued` message to the chat Autobase. The pass
// also lands in the room-state Hyperbee under `attendance/<peerAddress>` so
// late joiners see historical attendance without replaying the whole chat log.
//
// Docs consulted (2026-07-05):
//   - https://eips.ethereum.org/EIPS/eip-191 (personal_sign message format)
//   - https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/api-reference/
//     (account.sign returns Promise<string>). Full memo lives at the top of
//     backend/src/lib/evm/attendance.ts.
//
// Signed message shape (must exactly match backend/src/lib/evm/attendance.ts):
//   curva-attendance-pass:v1:<slug>:<matchId>:<peerAddress>:<issuedAt>
//
// Rate limit: max 3 passes per peer per hour (reconnect churn tolerance).
// Feature flag: CURVA_ATTENDANCE_ENABLED (default off).

const LOG = '[Curva][Attendance]'
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/
const HEX_SIG = /^0x[0-9a-fA-F]{130,132}$/

const RATE_MAX_PER_PEER = 3
const RATE_WINDOW_MS = 60 * 60 * 1000 // 1 hour

/**
 * Build the canonical bytes-signed-by-host message. Must be kept in sync with
 * backend/src/lib/evm/attendance.ts::buildAttendanceMessage.
 */
function buildAttendanceMessage({ slug, matchId, peerAddress, issuedAt }) {
  const s = String(slug || '').toLowerCase().trim()
  const m = matchId ? String(matchId).trim() : ''
  const p = String(peerAddress || '').toLowerCase().trim()
  const t = Math.floor(Number(issuedAt) || 0)
  return `curva-attendance-pass:v1:${s}:${m}:${p}:${t}`
}

function attendanceFlagEnabled() {
  try {
    const v = (typeof process !== 'undefined' && process.env && process.env.CURVA_ATTENDANCE_ENABLED) || ''
    return String(v).toLowerCase() === 'true'
  } catch { return false }
}

/**
 * @param {object} opts
 * @param {object} opts.wallet         - must expose signAttendance({slug,matchId,peerAddress,issuedAt})
 * @param {object} opts.chat           - room chat with sendSystem (host writer only)
 * @param {object} opts.roomStateBee   - hyperbee for persistent per-peer attendance log
 * @param {string} opts.slug           - room slug
 * @param {string} [opts.matchId]      - optional match id (persisted with the pass)
 * @param {boolean} opts.isHost        - only hosts issue; peers still can subscribe
 * @param {Function} [opts.log]        - structured logger (level, msg, meta)
 */
function createAttendance(opts = {}) {
  if (!opts.chat || typeof opts.chat.sendSystem !== 'function') {
    throw new TypeError('chat with sendSystem required')
  }
  if (!opts.roomStateBee || typeof opts.roomStateBee.put !== 'function') {
    throw new TypeError('roomStateBee required')
  }
  if (typeof opts.slug !== 'string' || opts.slug.length === 0) {
    throw new RangeError('slug required')
  }

  const chat = opts.chat
  const bee = opts.roomStateBee
  const slug = opts.slug.toLowerCase()
  const matchId = typeof opts.matchId === 'string' ? opts.matchId : null
  const isHost = !!opts.isHost
  const wallet = opts.wallet
  const log = typeof opts.log === 'function'
    ? opts.log
    : (level, msg, meta) => console.log(LOG, level, msg, meta || '')

  // Per-peer rate limit map. Reset only across process restart which is fine —
  // the pear-app lifetime bounds per-user issuance too.
  const rateBuckets = new Map() // peerAddressLower -> [ts,...]

  function rateAllows(peerAddressLower) {
    const now = Date.now()
    const cutoff = now - RATE_WINDOW_MS
    let arr = rateBuckets.get(peerAddressLower)
    if (!arr) { arr = []; rateBuckets.set(peerAddressLower, arr) }
    while (arr.length > 0 && arr[0] < cutoff) arr.shift()
    if (arr.length >= RATE_MAX_PER_PEER) return false
    arr.push(now)
    return true
  }

  /**
   * Host-side: issue an attendance pass for a peer. Idempotent-ish — if the
   * peer already has a persisted pass in this room-state Hyperbee we skip
   * signing and return the existing one. Callers may force a re-sign by
   * passing `{ force: true }` (subject to the per-peer rate limit).
   *
   * Returns `{ ok: true, pass }` on success or `{ ok: false, reason }` on
   * every non-crash rejection. Never throws.
   */
  async function issuePass(peerAddress, extra = {}) {
    if (!attendanceFlagEnabled()) {
      return { ok: false, reason: 'FEATURE_DISABLED' }
    }
    if (!isHost) {
      return { ok: false, reason: 'NOT_HOST' }
    }
    if (typeof peerAddress !== 'string' || !HEX_ADDR.test(peerAddress)) {
      return { ok: false, reason: 'ADDRESS_INVALID' }
    }
    if (!wallet || typeof wallet.signAttendance !== 'function') {
      return { ok: false, reason: 'WALLET_UNAVAILABLE' }
    }
    const peer = peerAddress.toLowerCase()

    if (!extra.force) {
      try {
        const existing = await bee.get(passKey(peer))
        if (existing && existing.value && HEX_SIG.test(String(existing.value.signature || ''))) {
          return { ok: true, pass: existing.value, cached: true }
        }
      } catch { /* best-effort lookup */ }
    }

    if (!rateAllows(peer)) {
      log('warn', 'attendance rate-limit hit', { peer: peer.slice(0, 10) })
      return { ok: false, reason: 'RATE_LIMITED' }
    }

    const issuedAt = Math.floor(Date.now() / 1000)
    let signed
    try {
      signed = await wallet.signAttendance({
        slug,
        matchId: matchId || '',
        peerAddress: peer,
        issuedAt
      })
    } catch (err) {
      log('warn', 'signAttendance threw', { message: err?.message })
      return { ok: false, reason: 'SIGN_FAILED' }
    }
    if (!signed || typeof signed.signature !== 'string' || !HEX_SIG.test(signed.signature)) {
      return { ok: false, reason: 'SIGN_FAILED' }
    }
    const hostAddress = typeof signed.hostAddress === 'string'
      ? signed.hostAddress.toLowerCase()
      : ''
    if (!HEX_ADDR.test(hostAddress)) {
      return { ok: false, reason: 'HOST_ADDRESS_INVALID' }
    }

    const pass = {
      slug,
      matchId: matchId || null,
      peerAddress: peer,
      hostAddress,
      issuedAt,
      signature: signed.signature
    }

    // Persist to room-state so late joiners see the pass on replay.
    try {
      await bee.put(passKey(peer), pass)
    } catch (err) {
      log('warn', 'attendance bee.put failed', { message: err?.message })
      // Non-fatal: still broadcast to chat below so live peers see the pass.
    }

    // Broadcast to chat. The `system:attendance-issued` type is host-only in
    // chat.js apply(); any non-host writer's append is silently dropped.
    try {
      await chat.sendSystem({
        type: 'system:attendance-issued',
        by_peer: peer,
        match_time_ms: 0,
        wall_clock_ms: Date.now(),
        peerAddress: peer,
        hostAddress,
        matchId: matchId || null,
        issuedAt,
        signature: pass.signature
      })
    } catch (err) {
      log('warn', 'attendance chat.sendSystem failed', { message: err?.message })
      return { ok: false, reason: 'BROADCAST_FAILED', pass }
    }

    return { ok: true, pass }
  }

  /**
   * List every persisted attendance pass in the room-state Hyperbee. Returned
   * shape mirrors the chat message shape (minus the transport metadata).
   */
  async function listPasses({ limit = 200 } = {}) {
    const out = []
    try {
      const stream = bee.createReadStream({
        gt: 'attendance/',
        lt: 'attendance0',
        limit
      })
      for await (const { value } of stream) {
        if (value && typeof value === 'object') out.push(value)
      }
    } catch { /* best-effort */ }
    return out
  }

  /**
   * Look up one pass by peer address. Returns null when the peer has never
   * been issued a pass in this room.
   */
  async function getPass(peerAddress) {
    if (typeof peerAddress !== 'string' || !HEX_ADDR.test(peerAddress)) return null
    try {
      const entry = await bee.get(passKey(peerAddress.toLowerCase()))
      return entry?.value ?? null
    } catch {
      return null
    }
  }

  return {
    issuePass,
    listPasses,
    getPass,
    // Read-only introspection.
    get slug() { return slug },
    get matchId() { return matchId },
    get isHost() { return isHost }
  }
}

function passKey(peerAddressLower) {
  return 'attendance/' + peerAddressLower
}

module.exports = {
  createAttendance,
  buildAttendanceMessage,
  attendanceFlagEnabled,
  _internal: {
    RATE_MAX_PER_PEER,
    RATE_WINDOW_MS,
    passKey
  }
}
