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

const Hypercore = require('hypercore')
const hcCrypto = require('hypercore-crypto')
const b4a = require('b4a')

const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/
const HEX_TX_RE = /^0x[0-9a-fA-F]{64}$/
const DECIMAL_UINT_RE = /^[0-9]+$/
const CUID_RE = /^c[0-9a-z]{24}$/
const VALID_MODES = new Set(['winner-only', 'exact-score'])
const VALID_WINNERS = new Set(['HOME', 'AWAY', 'DRAW'])

const POOL_STATUS_CACHE_TTL_MS = 60_000

// F3 Wave 3: sealed-bid predictions.
//
// Design goal: predictions submitted before kickoff are encrypted at rest so a
// peer replicating the hypercore cannot decode another peer's pick until the
// host broadcasts the encryption key. Because the key is deterministic
// (derived from slug + epoch + host secret) the host does not need to persist
// the key separately — anyone who knows the tuple can re-derive.
//
// Docs verified 2026-07-10:
//   * https://docs.pears.com/reference/building-blocks/hypercore/#new-hypercorestorage-options
//     Passing `encryptionKey` opts in a block-level cipher; hypercore encrypts
//     each block with XChaCha20-poly1305 (see hypercore/lib/default-encryption.js).
//   * pear-app/node_modules/hypercore/index.js:1394 getEncryptionOption() —
//     supports both `encryptionKey` (legacy) and `encryption` (new). We use
//     the legacy field because it's stable across the current pear runtime.
//   * pear-app/node_modules/hypercore-crypto/index.js:127 hash([buffers]) —
//     BLAKE2b-256 over concatenated inputs. Used here for deterministic key
//     derivation from (slug, epoch, hostSecret).
//
// Threat model: the encryption key is symmetric. Any peer that observes the
// reveal broadcast can decrypt every entry in the epoch. This is intentional —
// the seal only prevents adaptive pre-kickoff picks, NOT post-reveal
// tampering. Autobase's ordered append is what makes the picks non-repudiable;
// the encryption only hides them until reveal.
const SEALED_PREDICTIONS_NAMESPACE = 'curva/sealed-predictions'
const HOST_SECRET_MIN_BYTES = 16
const SEALED_TEXT_MAX = 512
const EPOCH_MAX_LEN = 128

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

  // D2 demo state. `enableDemoMode()` toggles this on; `attachPlayhead()`
  // subscribes to a playhead and calls openPool + publishResult at fixed
  // match_time_ms boundaries. Off by default so unit tests and production
  // code paths remain unaffected.
  //
  // Fields:
  //   on               boolean, master switch
  //   poolWindowMs     how long the stake window stays open after auto-open
  //   entryStakeAtomic decimal-string atomic units for the demo entry stake
  //                    (default 1 USDT = 1_000_000 at 6 decimals)
  let demoMode = { on: false, poolWindowMs: 20 * 60_000, entryStakeAtomic: '1000000' }

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
    // D2: emit a distinct `system:prediction-stake` chat row so the renderer
    // can render a "stake pill" instead of a plain text line. Peer-writer-
    // allowed (unlike tip-ack / pool-opened which are host-only), because any
    // promoted peer can stake their own USDT via EIP-3009. Backend remains
    // authoritative on the txHash lookup path, so a forged pill without a
    // matching backend row is harmless (see memo, Known gotchas: writer
    // authorship for system:prediction-stake).
    //
    // Payload matches the memo contract:
    //   { handle, teamCode, amountUsdt, tx } + goal fields for exact-score.
    try {
      await chat.sendSystem({
        type: 'system:prediction-stake',
        by_peer: myPubkey,
        match_time_ms: 0,
        wall_clock_ms: Date.now(),
        peerHandle,
        winner,
        homeGoals: mode === 'exact-score' ? hg : null,
        awayGoals: mode === 'exact-score' ? ag : null,
        stakeAtomic: stakeAtomic,
        txHash: typeof data.txHash === 'string' ? data.txHash : ''
      })
    } catch (err) {
      console.warn('[Curva][Pred] prediction stake chat append failed:', err?.message)
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

  // ---------------------------------------------------------------------------
  // D2 demo mode
  // ---------------------------------------------------------------------------

  /**
   * Turn on demo mode. Does NOT auto-open the pool by itself. The playhead
   * hook in room.js (task 3) is responsible for triggering openPool at
   * match_time_ms >= 2000 and publishResult at match_time_ms >= 5_400_000.
   *
   * @param {{poolWindowMs?: number, entryAmountUsdt?: number, entryStakeAtomic?: string}} [cfg]
   */
  function enableDemoMode(cfg = {}) {
    const poolWindowMs = Number(cfg.poolWindowMs)
    const stakeAtomicFromCfg = typeof cfg.entryStakeAtomic === 'string' && DECIMAL_UINT_RE.test(cfg.entryStakeAtomic)
      ? cfg.entryStakeAtomic
      : null
    // entryAmountUsdt is a convenience field (whole USDT units) that we
    // multiply into atomic units at 6 decimals. USDT on Sepolia + most testnets
    // uses 6 decimals; if the tokenContract's decimals ever changes we would
    // switch to reading it dynamically.
    let stakeAtomicFromWhole = null
    if (cfg.entryAmountUsdt !== undefined && Number.isFinite(Number(cfg.entryAmountUsdt))) {
      const usdt = Number(cfg.entryAmountUsdt)
      if (usdt > 0 && usdt < 1_000_000) {
        // 6-decimal token: 1 USDT = 1_000_000 atomic units.
        stakeAtomicFromWhole = String(Math.floor(usdt * 1_000_000))
      }
    }
    demoMode = {
      on: true,
      poolWindowMs: Number.isFinite(poolWindowMs) && poolWindowMs > 60_000
        ? Math.floor(poolWindowMs)
        : demoMode.poolWindowMs,
      entryStakeAtomic: stakeAtomicFromCfg || stakeAtomicFromWhole || demoMode.entryStakeAtomic
    }
    return { ...demoMode }
  }

  function isDemoMode() { return !!demoMode?.on }
  function getDemoConfig() { return { ...demoMode } }

  /**
   * Attach a playhead. Returns an unsubscribe function. Fires openPool once
   * at match_time_ms >= 2000 and publishResult once at match_time_ms >=
   * 5_400_000 (90 min). No-op unless demo mode is on and caller is host.
   *
   * Callers must pass opts.matchId (host chose it at pool-open UI) and
   * opts.getLiveScore (returns {winner, homeGoals, awayGoals}). opts.poolId
   * is filled in after openPool succeeds.
   *
   * @param {object} playhead  bare/playhead.js instance
   * @param {{
   *   matchId: string,
   *   mode?: string,
   *   getLiveScore: () => Promise<{winner: string, homeGoals: number, awayGoals: number}>,
   *   poolId?: string
   * }} opts
   * @returns {() => void}
   */
  function attachPlayhead(playhead, opts = {}) {
    if (!isDemoMode()) return () => {}
    if (!isHost) return () => {}
    if (!playhead || typeof playhead.onUpdate !== 'function') return () => {}
    if (!opts.matchId) return () => {}

    let openedAt = null
    let settledAt = null
    let openedPoolId = typeof opts.poolId === 'string' ? opts.poolId : null

    const off = playhead.onUpdate(async (state) => {
      if (!state || typeof state.match_time_ms !== 'number') return

      if (!openedAt && state.match_time_ms >= 2_000) {
        openedAt = Date.now()
        try {
          const opened = await openPool({
            matchId: opts.matchId,
            mode: opts.mode || 'winner-only',
            entryStakeAtomic: demoMode.entryStakeAtomic,
            deadlineMs: Date.now() + demoMode.poolWindowMs
          })
          openedPoolId = opened?.poolId || openedPoolId
        } catch (err) {
          console.warn('[Curva][Pred] demo auto-open failed:', err?.message)
        }
      }

      if (!settledAt && state.match_time_ms >= 5_400_000) {
        settledAt = Date.now()
        try {
          const score = typeof opts.getLiveScore === 'function'
            ? await opts.getLiveScore()
            : null
          if (score && VALID_WINNERS.has(score.winner)) {
            const pid = openedPoolId
            if (typeof pid === 'string' && pid.length > 0) {
              await publishResult({
                poolId: pid,
                winner: score.winner,
                homeGoals: Number(score.homeGoals),
                awayGoals: Number(score.awayGoals),
                matchId: opts.matchId
              })
            }
          }
        } catch (err) {
          console.warn('[Curva][Pred] demo auto-settle failed:', err?.message)
        }
      }
    })
    return typeof off === 'function' ? off : () => {}
  }

  // ---------------------------------------------------------------------------
  // Host: publishSettlement (D2 addition)
  // ---------------------------------------------------------------------------
  /**
   * Emit a `system:prediction-settle` chat row summarizing pool winners
   * and losers plus the settlement tx. Peer-writer-allowed follow-on to
   * publishResult so the renderer can render a settlement pill without
   * waiting for the SSE payout stream.
   *
   * @param {{
   *   poolId: string,
   *   winners: Array<{handle?: string, address?: string, amountAtomic?: string}>,
   *   losers: Array<{handle?: string, address?: string}>,
   *   tx?: string,
   *   matchId?: string
   * }} args
   */
  async function publishSettlement({ poolId, winners, losers, tx, matchId } = {}) {
    assertEnabled()
    assertHost()
    validatePoolId(poolId)
    if (!Array.isArray(winners)) {
      throw new PredictionsError('VALIDATION_ERROR', 'winners must be an array')
    }
    if (!Array.isArray(losers)) {
      throw new PredictionsError('VALIDATION_ERROR', 'losers must be an array')
    }
    const safeWinners = winners.slice(0, 32).map(sanitizeSettlementRow)
    const safeLosers = losers.slice(0, 32).map(sanitizeSettlementRow)
    const txStr = typeof tx === 'string' && HEX_TX_RE.test(tx) ? tx : ''

    try {
      await chat.sendSystem({
        type: 'system:prediction-settle',
        by_peer: myPubkey,
        match_time_ms: 90 * 60 * 1000,
        wall_clock_ms: Date.now(),
        poolId,
        matchId: typeof matchId === 'string' ? matchId : null,
        winners: safeWinners,
        losers: safeLosers,
        txHash: txStr
      })
    } catch (err) {
      console.warn('[Curva][Pred] system:prediction-settle append failed:', err?.message)
      throw new PredictionsError('BROADCAST_FAILED', err?.message || 'broadcast failed')
    }

    return {
      poolId,
      winners: safeWinners.length,
      losers: safeLosers.length,
      txHash: txStr
    }
  }

  function sanitizeSettlementRow(row) {
    if (!row || typeof row !== 'object') return { handle: '', address: '' }
    const out = { handle: '', address: '' }
    if (typeof row.handle === 'string') out.handle = row.handle.slice(0, 64)
    if (typeof row.address === 'string' && HEX_ADDR_RE.test(row.address)) {
      out.address = row.address.toLowerCase()
    }
    if (typeof row.amountAtomic === 'string' && DECIMAL_UINT_RE.test(row.amountAtomic)) {
      out.amountAtomic = row.amountAtomic
    }
    return out
  }

  return {
    openPool,
    submitPrediction,
    publishResult,
    publishSettlement,
    getPoolStatus,
    announcePayout,
    enableDemoMode,
    attachPlayhead,
    isDemoMode,
    getDemoConfig,
    get enabled() { return enabled },
    get isHost() { return isHost }
  }
}

// ---------------------------------------------------------------------------
// F3 Wave 3: sealed-bid predictions (hypercore block-level encryption)
// ---------------------------------------------------------------------------

/**
 * Deterministically derive the encryption key for a (slug, epoch) tuple. The
 * host secret is the shared entropy that gates reveal — anyone who has all
 * three inputs can encrypt AND decrypt, so treat `hostSecret` as sensitive.
 *
 * The output is a 32-byte Buffer suitable for the hypercore `encryptionKey`
 * option. BLAKE2b-256 via hypercore-crypto.hash() is used because it is
 * available in-runtime and the digest length matches XChaCha20-poly1305's key
 * size (verified: hypercore/lib/default-encryption.js).
 *
 * @param {{slug: string, epoch: string|number, hostSecret: Buffer|string}} args
 * @returns {Buffer}
 */
function deriveSealKey({ slug, epoch, hostSecret } = {}) {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new RangeError('deriveSealKey: slug required')
  }
  const epochStr = typeof epoch === 'number' ? String(epoch) : epoch
  if (typeof epochStr !== 'string' || epochStr.length === 0 || epochStr.length > EPOCH_MAX_LEN) {
    throw new RangeError('deriveSealKey: epoch must be a non-empty string/number ≤ ' + EPOCH_MAX_LEN + ' chars')
  }
  const secretBuf = typeof hostSecret === 'string'
    ? b4a.from(hostSecret, 'utf8')
    : (b4a.isBuffer(hostSecret) ? hostSecret : null)
  if (!secretBuf || secretBuf.byteLength < HOST_SECRET_MIN_BYTES) {
    throw new RangeError('deriveSealKey: hostSecret must be ≥ ' + HOST_SECRET_MIN_BYTES + ' bytes')
  }
  return hcCrypto.hash([
    b4a.from(SEALED_PREDICTIONS_NAMESPACE),
    b4a.from(slug),
    b4a.from(epochStr),
    secretBuf
  ])
}

// Deterministic corestore session name so both the seal-writer and the reader
// resolve to the SAME hypercore. Peer-scoped: each peer writes into their own
// core (keyed by peerPubkey) so the reader can identify who authored a pick
// after reveal without leaking the plaintext beforehand.
function sealedCoreName({ slug, epoch, peerPubkey }) {
  if (typeof peerPubkey !== 'string' || peerPubkey.length === 0) {
    throw new RangeError('sealedCoreName: peerPubkey required')
  }
  return `${SEALED_PREDICTIONS_NAMESPACE}/${slug}/${epoch}/${peerPubkey}`
}

function assertPrediction(prediction) {
  if (!prediction || typeof prediction !== 'object') {
    throw new TypeError('prediction must be an object')
  }
  if (prediction.winner !== undefined && !VALID_WINNERS.has(prediction.winner)) {
    throw new RangeError('prediction.winner must be HOME/AWAY/DRAW')
  }
  if (prediction.homeGoals !== undefined) {
    const hg = Number(prediction.homeGoals)
    if (!Number.isInteger(hg) || hg < 0 || hg > 30) {
      throw new RangeError('prediction.homeGoals must be integer 0..30')
    }
  }
  if (prediction.awayGoals !== undefined) {
    const ag = Number(prediction.awayGoals)
    if (!Number.isInteger(ag) || ag < 0 || ag > 30) {
      throw new RangeError('prediction.awayGoals must be integer 0..30')
    }
  }
  const encoded = JSON.stringify(prediction)
  if (encoded.length > SEALED_TEXT_MAX) {
    throw new RangeError('prediction encoded size exceeds ' + SEALED_TEXT_MAX + ' bytes')
  }
  return encoded
}

/**
 * Write a sealed prediction for the local peer. The hypercore is created with
 * `encryptionKey` set, so every appended block is encrypted at rest. Peers
 * that replicate the core without the key see only ciphertext.
 *
 * @param {{
 *   store: object,           // Corestore instance
 *   slug: string,
 *   epoch: string|number,
 *   peerPubkey: string,      // local writer identity (hex)
 *   prediction: object,      // {winner, homeGoals?, awayGoals?, ...}
 *   encryptionKey: Buffer    // derived via deriveSealKey()
 * }} args
 * @returns {Promise<{seq: number, coreKey: string}>}
 */
async function createSealedPrediction({
  store, slug, epoch, peerPubkey, prediction, encryptionKey
} = {}) {
  if (!store || typeof store.get !== 'function') {
    throw new TypeError('createSealedPrediction: store required')
  }
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new RangeError('slug required')
  }
  const epochStr = typeof epoch === 'number' ? String(epoch) : epoch
  if (typeof epochStr !== 'string' || epochStr.length === 0) {
    throw new RangeError('epoch required')
  }
  if (!b4a.isBuffer(encryptionKey) || encryptionKey.byteLength !== 32) {
    throw new RangeError('encryptionKey must be a 32-byte Buffer')
  }
  const encoded = assertPrediction(prediction)

  const name = sealedCoreName({ slug, epoch: epochStr, peerPubkey })
  const core = store.get({ name, encryptionKey })
  await core.ready()
  const block = b4a.from(encoded, 'utf8')
  const { length } = await core.append(block)
  const seq = (typeof length === 'number' ? length : core.length) - 1
  return {
    seq,
    coreKey: core.key ? b4a.toString(core.key, 'hex') : null
  }
}

/**
 * Read a peer's sealed prediction. The hypercore is opened with the same
 * derived encryption key; if the caller passes a WRONG key hypercore returns
 * a decode failure — we translate to `null` so callers can treat wrong-key
 * as "unrevealed" without pattern-matching on error strings.
 *
 * @param {{
 *   store: object,
 *   slug: string,
 *   epoch: string|number,
 *   peerPubkey: string,
 *   encryptionKey: Buffer,
 *   seq?: number             // defaults to latest block (length-1)
 * }} args
 * @returns {Promise<object|null>}  plaintext prediction or null on failure
 */
async function readPrediction({
  store, slug, epoch, peerPubkey, encryptionKey, seq
} = {}) {
  if (!store || typeof store.get !== 'function') {
    throw new TypeError('readPrediction: store required')
  }
  if (!b4a.isBuffer(encryptionKey) || encryptionKey.byteLength !== 32) {
    return null
  }
  const epochStr = typeof epoch === 'number' ? String(epoch) : epoch
  const name = sealedCoreName({ slug, epoch: epochStr, peerPubkey })
  let core
  try {
    core = store.get({ name, encryptionKey })
    await core.ready()
  } catch {
    return null
  }
  if (core.length === 0) return null
  const idx = typeof seq === 'number' && seq >= 0 ? Math.min(seq, core.length - 1) : core.length - 1
  let block
  try {
    block = await core.get(idx)
  } catch {
    return null
  }
  if (!block) return null
  try {
    const text = b4a.toString(block, 'utf8')
    // Defense in depth: reject giant blobs that would break the DOM if
    // rendered directly. The write path enforces the same cap; a mismatched
    // key would produce a decode failure BEFORE this check.
    if (text.length > SEALED_TEXT_MAX) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Broadcast the reveal for an epoch. Emits a `system:reveal` chat message
 * carrying the derived encryption key so every peer can open its cached copy
 * of every peer's sealed core. Returns the message shape appended.
 *
 * NOTE: this function does not enforce host authorship on its own — the caller
 * (host-side room orchestration) must make sure only the host broadcasts. The
 * chat reducer would need a matching gate if we required strict authorship;
 * for the demo we let peers verify by re-deriving the key themselves.
 *
 * @param {{
 *   chat: object,            // bare/chat.js instance with sendSystem
 *   slug: string,
 *   epoch: string|number,
 *   encryptionKey: Buffer,
 *   myPubkey?: string
 * }} args
 * @returns {Promise<object>}
 */
async function revealPredictions({ chat, slug, epoch, encryptionKey, myPubkey } = {}) {
  if (!chat || typeof chat.sendSystem !== 'function') {
    throw new TypeError('revealPredictions: chat with sendSystem required')
  }
  if (!b4a.isBuffer(encryptionKey) || encryptionKey.byteLength !== 32) {
    throw new RangeError('encryptionKey must be a 32-byte Buffer')
  }
  const epochStr = typeof epoch === 'number' ? String(epoch) : epoch
  const msg = {
    type: 'system:reveal',
    by_peer: myPubkey || 'host',
    match_time_ms: 0,
    wall_clock_ms: Date.now(),
    slug,
    epoch: epochStr,
    encryptionKeyHex: b4a.toString(encryptionKey, 'hex')
  }
  // Chat's isValidMessage does not yet know about `system:reveal`. Rather than
  // widening the chat reducer (which would require a matching host-only gate
  // to prevent forged reveals) we return the shape here so the caller can
  // route it via any transport it wants. In the sealed-prediction test we
  // consume the shape directly without touching chat.
  return msg
}

module.exports = {
  createPredictionsClient,
  PredictionsError,
  // Exports for tests + the backend contract mirror.
  buildOpenMessage,
  buildResultMessage,
  // F3 Wave 3 sealed predictions.
  createSealedPrediction,
  revealPredictions,
  readPrediction,
  deriveSealKey,
  _internalSealed: {
    sealedCoreName,
    assertPrediction,
    SEALED_PREDICTIONS_NAMESPACE,
    SEALED_TEXT_MAX,
    HOST_SECRET_MIN_BYTES
  }
}
