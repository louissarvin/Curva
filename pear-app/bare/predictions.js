// Wave 11: Match Prediction Pool client for Curva Pear app.
//
// Orchestrates the four Wave 10 backend endpoints and mirrors host-only pool
// lifecycle into the shared chat Autobase (system:pool-opened,
// system:match-result, system:pool-payout). Peer entries mirror the tip.js
// pre-broadcast pattern: sign EIP-3009 locally, POST /predictions/entry, then
// on 200 append a `prediction` display event to the chat Autobase.
//
// Signed-message contracts MUST match backend/src/routes/predictionRoutes.ts:
//   openPool:    `curva-predictions-open:<slug>:<matchId>:<deadlineMs>`
//   publishResult: `curva-predictions-result:<poolId>:<winner>:<hg>:<ag>`
//
// Docs-first (verified 2026-07-04):
//   * WDK account.sign(message) returns Promise<string> (0x-prefixed hex).
//     https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/api-reference/
//     Wallet worklet exposes signMessage(text) -> { signature, signer, text }
//     which wraps either ethers.signMessage (preferred, EOA) or account.sign.
//   * EIP-191 personal_sign prefix is 0x19 0x45 "Ethereum Signed Message:\n" + len(msg)
//     (https://eips.ethereum.org/EIPS/eip-191). We rely on the wallet worklet's
//     signMessage() to produce the canonical envelope; backend recovers via
//     ethers verifyMessage which uses the same digest.
//   * EIP-3009 typed data (backend /predictions/entry) shares the exact same
//     TransferWithAuthorization type + domain as F11. We reuse
//     wallet.signEip3009 verbatim so a domain change lands in one place.
//
// The feature-flag gate lives in workers/main.js — if
// CURVA_PREDICTIONS_ENABLED != 'true' the module is never instantiated. This
// module MUST still guard against malformed input; a hostile renderer could
// otherwise pass unchecked strings to base.append.

const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/
const HEX_TX_RE = /^0x[0-9a-fA-F]{64}$/
const DECIMAL_UINT_RE = /^[0-9]+$/
const CUID_RE = /^c[0-9a-z]{24}$/
const VALID_MODES = new Set(['winner-only', 'exact-score'])
const VALID_WINNERS = new Set(['HOME', 'AWAY', 'DRAW'])

const POOL_STATUS_CACHE_TTL_MS = 60_000

function buildOpenMessage(roomSlug, matchId, deadlineMs) {
  return `curva-predictions-open:${roomSlug}:${matchId}:${deadlineMs}`
}
function buildResultMessage(poolId, winner, homeGoals, awayGoals) {
  return `curva-predictions-result:${poolId}:${winner}:${homeGoals}:${awayGoals}`
}

class PredictionsError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PredictionsError'
    this.code = code
  }
}

/**
 * Create a predictions client bound to a room + chat + wallet + backend.
 *
 * @param {object} opts
 * @param {object} opts.backend        createBackendClient() result. Required.
 * @param {object} opts.chat           chat instance from bare/chat.js.
 *                                     Required so host-only system messages land
 *                                     on the shared Autobase.
 * @param {object} opts.wallet         wallet adapter (signMessage, signEip3009).
 *                                     Required for host-side open/publishResult
 *                                     AND peer-side submit.
 * @param {string} opts.roomSlug       lowercased slug used in signed messages.
 * @param {boolean} opts.isHost        gates host-only ops.
 * @param {string} opts.myPubkey       local Autobase writer pubkey (hex).
 *                                     Stamped on chat rows as by_peer.
 * @param {string} [opts.myHandle]     display handle (rendered on chat rows).
 * @param {string} [opts.hostSmartAddr] peer-only: the host smart address for
 *                                      pool address discovery hint (unused
 *                                      today; backend returns poolAddress
 *                                      directly on open).
 * @param {boolean} [opts.enabled]     when false, all methods reject
 *                                     FEATURE_DISABLED. Defaults to true so
 *                                     the workers/main.js flag gate is the
 *                                     single source of truth.
 */
function createPredictionsClient(opts = {}) {
  if (!opts.backend || typeof opts.backend !== 'object') {
    throw new TypeError('backend client required')
  }
  if (!opts.chat || typeof opts.chat.sendSystem !== 'function') {
    throw new TypeError('chat with sendSystem required')
  }
  if (!opts.wallet || typeof opts.wallet !== 'object') {
    throw new TypeError('wallet required')
  }
  if (typeof opts.roomSlug !== 'string' || opts.roomSlug.length === 0) {
    throw new RangeError('roomSlug required')
  }
  if (typeof opts.myPubkey !== 'string' || opts.myPubkey.length === 0) {
    throw new RangeError('myPubkey required')
  }

  const enabled = opts.enabled !== false
  const isHost = !!opts.isHost
  const roomSlug = opts.roomSlug
  const chat = opts.chat
  const wallet = opts.wallet
  const backend = opts.backend
  const myPubkey = opts.myPubkey
  const myHandle = typeof opts.myHandle === 'string' ? opts.myHandle : null
  const fetchFn = typeof opts.fetch === 'function'
    ? opts.fetch
    : (typeof fetch === 'function' ? fetch : null)

  // Small HTTP helper that peels the backend { success, error, data } envelope
  // into { ok, data } | { ok, error }. Mirrors bare/backend.js request() but
  // is inlined so we don't need to widen the backend client's public surface.
  // The backend base URL is trimmed by createBackendClient() so trailing slash
  // is safe. Timeout is 12s: pool ops touch on-chain + facilitator so allow
  // headroom over the default 8s used for read endpoints.
  async function request(pathWithQuery, init = {}) {
    if (typeof fetchFn !== 'function') {
      return { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'fetch not available' } }
    }
    const baseUrl = backend.baseUrl
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      return { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'backend baseUrl unset' } }
    }
    const url = baseUrl + pathWithQuery
    const headers = {
      'Accept': 'application/json',
      'Accept-Language': backend.lang || 'en',
      ...(init.headers || {})
    }
    if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'

    let controller = null
    let timer = null
    if (typeof AbortController === 'function') {
      controller = new AbortController()
      timer = setTimeout(() => { try { controller.abort() } catch { /* noop */ } }, 12_000)
    }
    let resp
    try {
      resp = await fetchFn(url, {
        method: init.method || 'GET',
        headers,
        body: init.body,
        signal: controller?.signal
      })
    } catch (err) {
      if (timer) clearTimeout(timer)
      return {
        ok: false,
        error: {
          code: err?.name === 'AbortError' ? 'BACKEND_TIMEOUT' : 'BACKEND_UNREACHABLE',
          message: err?.message || 'network error'
        }
      }
    }
    if (timer) clearTimeout(timer)
    let json = null
    try { json = await resp.json() } catch { /* fall through */ }
    if (!resp.ok || (json && json.success === false)) {
      return {
        ok: false,
        error: {
          code: json?.error?.code || 'BACKEND_ERROR',
          message: json?.error?.message || `HTTP ${resp.status}`
        }
      }
    }
    return { ok: true, data: json?.data !== undefined ? json.data : json }
  }

  // 60s cache per (roomSlug, matchId) so a repeatedly-polling UI doesn't hit
  // /predictions/pool every tick. Renderer polls at 10s intervals during a
  // live match; TTL is 60s so we serve 5 hits from cache per fetch.
  const statusCache = new Map() // matchId -> { data, expiresAt }

  function assertEnabled() {
    if (!enabled) {
      throw new PredictionsError(
        'FEATURE_DISABLED',
        'The Match Prediction Pool feature is disabled. Set CURVA_PREDICTIONS_ENABLED=true.'
      )
    }
  }

  function assertHost() {
    if (!isHost) {
      throw new PredictionsError(
        'NOT_HOST',
        'Only the room host may perform this action'
      )
    }
  }

  function validateMatchId(m) {
    if (typeof m !== 'string' || !CUID_RE.test(m)) {
      throw new PredictionsError('VALIDATION_ERROR', 'matchId must be a valid CUID')
    }
  }
  function validatePoolId(p) {
    if (typeof p !== 'string' || !CUID_RE.test(p)) {
      throw new PredictionsError('VALIDATION_ERROR', 'poolId must be a valid CUID')
    }
  }
  function validateGoals(g) {
    return Number.isInteger(g) && g >= 0 && g <= 30
  }
  function deriveWinner(hg, ag) {
    if (hg > ag) return 'HOME'
    if (ag > hg) return 'AWAY'
    return 'DRAW'
  }

  // ---------------------------------------------------------------------------
  // Host: openPool
  // ---------------------------------------------------------------------------
  async function openPool({ matchId, mode, entryStakeAtomic, deadlineMs } = {}) {
    assertEnabled()
    assertHost()
    validateMatchId(matchId)
    if (!VALID_MODES.has(mode)) {
      throw new PredictionsError('VALIDATION_ERROR', "mode must be 'winner-only' or 'exact-score'")
    }
    if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs)) {
      throw new PredictionsError('VALIDATION_ERROR', 'deadlineMs must be a finite number')
    }
    if (deadlineMs <= Date.now() + 60_000) {
      throw new PredictionsError(
        'VALIDATION_ERROR',
        'deadlineMs must be at least 60 seconds in the future'
      )
    }
    // entryStakeAtomic is optional here (backend uses PREDICTIONS_ENTRY_STAKE_ATOMIC
    // from main-config.ts) but we forward it if present for future flexibility.
    if (entryStakeAtomic !== undefined && (typeof entryStakeAtomic !== 'string' || !DECIMAL_UINT_RE.test(entryStakeAtomic))) {
      throw new PredictionsError('VALIDATION_ERROR', 'entryStakeAtomic must be decimal string in base units')
    }

    if (typeof wallet.signMessage !== 'function') {
      throw new PredictionsError('WALLET_NO_SIGN_MESSAGE', 'wallet.signMessage unavailable')
    }
    const walletInfo = typeof wallet.getInfo === 'function' ? wallet.getInfo() : null
    const hostAddress = walletInfo?.ownerAddress
    if (typeof hostAddress !== 'string' || !HEX_ADDR_RE.test(hostAddress)) {
      throw new PredictionsError('WALLET_NOT_INIT', 'wallet owner address unavailable')
    }

    const message = buildOpenMessage(roomSlug, matchId, deadlineMs)
    let sig
    try {
      sig = await wallet.signMessage(message)
    } catch (err) {
      throw new PredictionsError('SIGN_FAILED', 'sign open message failed: ' + (err?.message || 'unknown'))
    }
    if (!sig || typeof sig.signature !== 'string') {
      throw new PredictionsError('SIGN_FAILED', 'wallet returned malformed signature')
    }

    const res = await request('/predictions/open', {
      method: 'POST',
      body: JSON.stringify({
        roomSlug,
        matchId,
        mode,
        deadlineMs,
        hostAddress,
        signature: sig.signature
      })
    })
    if (!res.ok) {
      throw new PredictionsError(res.error?.code || 'BACKEND_ERROR', res.error?.message || 'openPool failed')
    }
    const data = res.data || {}
    // Append the host-only pool-opened Autobase entry so peers see the pool
    // materialize immediately. Silent-on-failure: the row can also arrive via
    // /predictions/pool/... polling on the peer side.
    try {
      await chat.sendSystem({
        type: 'system:pool-opened',
        by_peer: myPubkey,
        match_time_ms: 0,
        wall_clock_ms: Date.now(),
        matchId,
        poolAddress: String(data.poolAddress || '').toLowerCase(),
        stakeToken: String(data.stakeToken || '').toLowerCase(),
        entryStakeAtomic: String(data.entryStakeAtomic || ''),
        mode,
        deadlineMs
      })
    } catch (err) {
      // Non-fatal: peers still discover via HTTP poll.
      console.warn('[Curva][Pred] system:pool-opened append failed:', err?.message)
    }

    // Invalidate cache — the pool is now open.
    statusCache.delete(matchId)

    return {
      poolId: data.id,
      poolAddress: data.poolAddress,
      chainId: data.chainId,
      stakeToken: data.stakeToken,
      entryStakeAtomic: data.entryStakeAtomic,
      mode: data.mode,
      deadlineMs: data.deadlineMs,
      status: data.status
    }
  }

  // ---------------------------------------------------------------------------
  // Peer: submitPrediction (EIP-3009 stake)
  // ---------------------------------------------------------------------------
  async function submitPrediction({ poolId, winner, homeGoals, awayGoals, stakeAtomic, poolAddress, chainId, stakeToken, mode } = {}) {
    assertEnabled()
    validatePoolId(poolId)
    if (!VALID_WINNERS.has(winner)) {
      throw new PredictionsError('VALIDATION_ERROR', "winner must be HOME/AWAY/DRAW")
    }
    if (typeof stakeAtomic !== 'string' || !DECIMAL_UINT_RE.test(stakeAtomic)) {
      throw new PredictionsError('VALIDATION_ERROR', 'stakeAtomic must be decimal string in base units')
    }
    if (typeof poolAddress !== 'string' || !HEX_ADDR_RE.test(poolAddress)) {
      throw new PredictionsError('VALIDATION_ERROR', 'poolAddress required')
    }
    if (typeof stakeToken !== 'string' || !HEX_ADDR_RE.test(stakeToken)) {
      throw new PredictionsError('VALIDATION_ERROR', 'stakeToken required')
    }
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new PredictionsError('VALIDATION_ERROR', 'chainId required')
    }
    let hg = null
    let ag = null
    if (mode === 'exact-score') {
      hg = Number(homeGoals)
      ag = Number(awayGoals)
      if (!validateGoals(hg) || !validateGoals(ag)) {
        throw new PredictionsError('VALIDATION_ERROR', 'homeGoals/awayGoals must be integers 0..30')
      }
      if (deriveWinner(hg, ag) !== winner) {
        throw new PredictionsError('VALIDATION_ERROR', 'winner does not match the goal scores')
      }
    }

    if (typeof wallet.signEip3009 !== 'function') {
      throw new PredictionsError('WALLET_NO_EIP3009', 'wallet.signEip3009 unavailable')
    }

    // Sign the EIP-3009 authorization to move stake from peer EOA -> pool.
    let sig
    try {
      sig = await wallet.signEip3009({
        chainId,
        tokenAddress: stakeToken,
        to: poolAddress,
        value: stakeAtomic
        // nonce, validAfter, validBefore are filled in by the wallet worklet.
      })
    } catch (err) {
      throw new PredictionsError('SIGN_FAILED', 'sign stake failed: ' + (err?.message || 'unknown'))
    }
    if (!sig || typeof sig.v !== 'number' || !sig.r || !sig.s || !sig.from) {
      throw new PredictionsError('SIGN_FAILED', 'wallet returned malformed signature')
    }

    const peerHandle = myHandle || (myPubkey ? myPubkey.slice(0, 12) : 'peer')

    const body = {
      poolId,
      winner,
      peerHandle,
      from: sig.from,
      to: poolAddress.toLowerCase(),
      value: stakeAtomic,
      validAfter: sig.validAfter,
      validBefore: sig.validBefore,
      nonce: sig.nonce,
      v: sig.v,
      r: sig.r,
      s: sig.s
    }
    if (mode === 'exact-score') {
      body.homeGoals = hg
      body.awayGoals = ag
    }

    const res = await request('/predictions/entry', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      throw new PredictionsError(res.error?.code || 'BACKEND_ERROR', res.error?.message || 'submitPrediction failed')
    }
    const data = res.data || {}
    // Append a `prediction` chat row so peers see the entry in real time.
    // Note: this is NOT a host-only system:pool-* type so we route it as a
    // regular text-shaped msg-lite. Because chat.sendSystem validates strictly
    // and rejects unknown types, we build a minimal-safe display event using
    // a `msg` type with an embedded [prediction] prefix. This avoids adding a
    // new Autobase message type in the middle of Wave 11 (would require
    // matching backend fix + validator + host-writer gate).
    try {
      const goalStr = mode === 'exact-score' ? ` ${hg}-${ag}` : ''
      await chat.sendSystem({
        type: 'msg',
        by_peer: myPubkey,
        text: `[prediction] ${peerHandle} bet ${winner}${goalStr} • tx ${(data.txHash || '').slice(0, 12)}`,
        match_time_ms: 0,
        wall_clock_ms: Date.now()
      })
    } catch (err) {
      console.warn('[Curva][Pred] prediction chat append failed:', err?.message)
    }

    statusCache.delete(getMatchIdCacheHint(data))

    return {
      predictionId: data.id,
      poolId: data.poolId,
      txHash: data.txHash,
      status: data.status,
      winner: data.winner,
      homeGoals: data.homeGoals,
      awayGoals: data.awayGoals,
      stakeAtomic: data.stakeAtomic
    }
  }

  function getMatchIdCacheHint(_data) {
    // Backend /entry response does not echo matchId; we cannot invalidate a
    // specific slot so callers should manually invalidate via getPoolStatus
    // with { forceRefresh: true }. Return null so the map delete is a no-op.
    return null
  }

  // ---------------------------------------------------------------------------
  // Host: publishResult
  // ---------------------------------------------------------------------------
  async function publishResult({ poolId, winner, homeGoals, awayGoals, matchId } = {}) {
    assertEnabled()
    assertHost()
    validatePoolId(poolId)
    if (!VALID_WINNERS.has(winner)) {
      throw new PredictionsError('VALIDATION_ERROR', 'winner must be HOME/AWAY/DRAW')
    }
    const hg = Number(homeGoals)
    const ag = Number(awayGoals)
    if (!validateGoals(hg) || !validateGoals(ag)) {
      throw new PredictionsError('VALIDATION_ERROR', 'goals must be integers 0..30')
    }
    if (deriveWinner(hg, ag) !== winner) {
      throw new PredictionsError('VALIDATION_ERROR', 'winner does not match the goal scores')
    }

    if (typeof wallet.signMessage !== 'function') {
      throw new PredictionsError('WALLET_NO_SIGN_MESSAGE', 'wallet.signMessage unavailable')
    }
    const walletInfo = typeof wallet.getInfo === 'function' ? wallet.getInfo() : null
    const hostAddress = walletInfo?.ownerAddress
    if (typeof hostAddress !== 'string' || !HEX_ADDR_RE.test(hostAddress)) {
      throw new PredictionsError('WALLET_NOT_INIT', 'wallet owner address unavailable')
    }

    const message = buildResultMessage(poolId, winner, hg, ag)
    let sig
    try {
      sig = await wallet.signMessage(message)
    } catch (err) {
      throw new PredictionsError('SIGN_FAILED', 'sign result message failed: ' + (err?.message || 'unknown'))
    }
    if (!sig || typeof sig.signature !== 'string') {
      throw new PredictionsError('SIGN_FAILED', 'wallet returned malformed signature')
    }

    const res = await request('/predictions/result', {
      method: 'POST',
      body: JSON.stringify({
        poolId,
        winner,
        homeGoals: hg,
        awayGoals: ag,
        hostAddress,
        signature: sig.signature
      })
    })
    if (!res.ok) {
      throw new PredictionsError(res.error?.code || 'BACKEND_ERROR', res.error?.message || 'publishResult failed')
    }

    // Broadcast system:match-result over the chat Autobase. matchId is required
    // by chat's validator; caller must pass it in (we do not fetch it here to
    // avoid an extra HTTP round-trip during the demo).
    if (typeof matchId === 'string' && matchId.length > 0) {
      try {
        await chat.sendSystem({
          type: 'system:match-result',
          by_peer: myPubkey,
          match_time_ms: 90 * 60 * 1000,
          wall_clock_ms: Date.now(),
          matchId,
          winner,
          homeGoals: hg,
          awayGoals: ag
        })
      } catch (err) {
        console.warn('[Curva][Pred] system:match-result append failed:', err?.message)
      }
    }

    // Invalidate every cached slot — the settlement worker will backfill.
    statusCache.clear()

    return {
      poolId: res.data?.id,
      status: res.data?.status,
      resultWinner: res.data?.resultWinner,
      resultHomeGoals: res.data?.resultHomeGoals,
      resultAwayGoals: res.data?.resultAwayGoals
    }
  }

  // ---------------------------------------------------------------------------
  // Anyone: getPoolStatus with 60s TTL cache
  // ---------------------------------------------------------------------------
  async function getPoolStatus({ matchId, forceRefresh = false } = {}) {
    assertEnabled()
    validateMatchId(matchId)

    if (!forceRefresh) {
      const cached = statusCache.get(matchId)
      if (cached && cached.expiresAt > Date.now()) {
        return { ...cached.data, cached: true }
      }
    }

    const url = `/predictions/pool/${encodeURIComponent(roomSlug)}/${encodeURIComponent(matchId)}`
    const res = await request(url, { method: 'GET' })
    if (!res.ok) {
      // 404 is not exceptional — the pool may not have been opened yet.
      if (res.error?.code === 'POOL_NOT_FOUND') {
        return { exists: false, cached: false }
      }
      throw new PredictionsError(res.error?.code || 'BACKEND_ERROR', res.error?.message || 'getPoolStatus failed')
    }

    const snapshot = { exists: true, cached: false, ...res.data }
    statusCache.set(matchId, {
      data: snapshot,
      expiresAt: Date.now() + POOL_STATUS_CACHE_TTL_MS
    })
    return snapshot
  }

  // Payout emit: called by workers/main.js when the /activity/stream SSE
  // reports a prediction.payout event. We append system:pool-payout to chat
  // so peers see the payout row in-line.
  async function announcePayout({ matchId, txHash, toAddress, amountAtomic }) {
    assertEnabled()
    assertHost() // only the host should mint this system message
    if (typeof matchId !== 'string' || matchId.length === 0) {
      throw new PredictionsError('VALIDATION_ERROR', 'matchId required')
    }
    if (typeof txHash !== 'string' || !HEX_TX_RE.test(txHash)) {
      throw new PredictionsError('VALIDATION_ERROR', 'txHash required')
    }
    if (typeof toAddress !== 'string' || !HEX_ADDR_RE.test(toAddress)) {
      throw new PredictionsError('VALIDATION_ERROR', 'toAddress required')
    }
    if (typeof amountAtomic !== 'string' || !DECIMAL_UINT_RE.test(amountAtomic)) {
      throw new PredictionsError('VALIDATION_ERROR', 'amountAtomic required')
    }
    await chat.sendSystem({
      type: 'system:pool-payout',
      by_peer: myPubkey,
      match_time_ms: 90 * 60 * 1000,
      wall_clock_ms: Date.now(),
      matchId,
      txHash,
      toAddress: toAddress.toLowerCase(),
      amountAtomic,
      route: 'erc20-transfer'
    })
  }

  return {
    openPool,
    submitPrediction,
    publishResult,
    getPoolStatus,
    announcePayout,
    get enabled() { return enabled },
    get isHost() { return isHost }
  }
}

module.exports = {
  createPredictionsClient,
  PredictionsError,
  // Exports for tests + the backend contract mirror.
  buildOpenMessage,
  buildResultMessage
}
