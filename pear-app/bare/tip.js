// Curva tip service.
//
// Orchestrates the tip flow between the wallet worklet, the F11 facilitator,
// and the Room-State Hyperbee tip log (ARCHITECTURE.md §5.5, pre-broadcast).
//
// Not a worklet itself — runs in the main Bare worker. Wallet integration is
// injected: opts.wallet is any object implementing signEip3009(msg), which
// keeps this module trivially testable with a stub.
//
// State machine per tip:
//   pending -> signing -> submitting -> submitted -> confirmed
//                                                \-> failed
//
// The Hyperbee row is inserted at `pending` BEFORE any network I/O so the
// renderer can render instant feedback. Each state transition rewrites the
// same row (keyed by wall_clock_ms + a synth txPlaceholder).

const b4a = require('b4a')
const { randomNonce, SEPOLIA, DEMO_AMOUNT_BASE_UNITS } = require('./wallet/eip3009.js')

const LOG = '[Curva][Tip]'

// Wave 8C: which failure codes from the F11 facilitator client should trigger
// the ERC-4337 UserOp fallback. Keep this narrow: business-logic errors from
// the facilitator (bad signature, chain unsupported, insufficient EOA balance)
// are NOT infrastructure failures and should surface to the user directly.
const FALLBACK_ELIGIBLE_CODES = new Set([
  'FACILITATOR_DISABLED', // backend returned 503 (RELAY_SPONSOR_PK unset)
  'BACKEND_UNAVAILABLE',  // no fetch in runtime
  'BACKEND_UNREACHABLE',  // network error / DNS / connection refused
  'BACKEND_TIMEOUT'       // 8s AbortController fired in backend client
])

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/
// Wave 6 T6: raise the demo cap from 1 USDT to 100 USDT so the tip button
// can offer 1/5/10 presets + a custom slider up to 100. Sepolia USDT is not
// real money so the raise has no economic risk; still capped hard here so a
// buggy renderer can't propose an absurd amount.
const MAX_DEMO_AMOUNT_BASE = 100_000000n // 100 USDT (6 decimals).

/**
 * @param {object} opts
 * @param {object} opts.wallet          - signEip3009(msg) -> {v,r,s,from,...}
 * @param {object} opts.backend         - createBackendClient() result
 * @param {object} opts.roomStateBee    - Hyperbee for room state / tip log
 * @param {string} opts.tipperPubkey    - hex 32-byte peer pubkey (for logging)
 * @param {string} opts.hostSmartAddr   - required
 * @param {string} [opts.hostOwnerAddr] - optional, for facilitator's registered-host verification
 * @param {number} [opts.chainId]       - default Sepolia
 * @param {string} [opts.tokenAddress]  - default Sepolia USDT
 * @param {Function} [opts.onStateChange]
 * @param {boolean}  [opts.erc4337Fallback] - Wave 8C: enable ERC-4337 UserOp
 *   fallback when facilitator is down. Reads env CURVA_ERC4337_FALLBACK when
 *   omitted ('off' disables, anything else enables — default on).
 */
function createTipService(opts = {}) {
  if (!opts.wallet || typeof opts.wallet.signEip3009 !== 'function') {
    throw new TypeError('wallet with signEip3009 required')
  }
  if (!opts.roomStateBee) throw new TypeError('roomStateBee required')
  if (typeof opts.hostSmartAddr !== 'string' || !HEX_ADDR.test(opts.hostSmartAddr)) {
    throw new RangeError('hostSmartAddr must be 0x-prefixed 20-byte hex')
  }

  const wallet = opts.wallet
  const backend = opts.backend
  const bee = opts.roomStateBee
  const hostSmartAddr = opts.hostSmartAddr.toLowerCase()
  const hostOwnerAddr = opts.hostOwnerAddr?.toLowerCase()
  const chainId = opts.chainId ?? SEPOLIA.chainId
  const tokenAddress = (opts.tokenAddress || SEPOLIA.usdtAddress).toLowerCase()
  const tipperPubkey = opts.tipperPubkey || ''
  const onStateChange = typeof opts.onStateChange === 'function' ? opts.onStateChange : null
  // Wave 6 T14: host-side receipt broadcast. If we ARE the host, we sign a
  // personal-message receipt for every confirmed tip that targets our smart
  // address and append it to chat as a `system:tip-ack`. Non-hosts skip this
  // path (they don't have the receiving-address key).
  const isHostSide = !!opts.isHost
  // Task 6: chat reference (optional). When a tip becomes `submitted`, we
  // append a `system:tip` message via chat.sendSystem so all peers see it
  // in-line. Never opens a new Autobase — reuses the room chat's Autobase.
  const chat = opts.chat && typeof opts.chat.sendSystem === 'function' ? opts.chat : null
  const fromHandle = typeof opts.fromHandle === 'string' ? opts.fromHandle : null
  const explorerBase = typeof opts.explorerBase === 'string'
    ? opts.explorerBase
    : (chainId === SEPOLIA.chainId ? 'https://sepolia.etherscan.io/tx/' : null)

  // Wave 8C: feature-flag the fallback. Default ON so a facilitator outage
  // during the demo silently degrades to the on-device UserOp path. Set
  // CURVA_ERC4337_FALLBACK=off to hard-fail on facilitator outage (used for
  // demos where we want to visibly prove the Companion dependency).
  const envFallback = (() => {
    try {
      const v = (typeof process !== 'undefined' && process.env && process.env.CURVA_ERC4337_FALLBACK)
      if (typeof v === 'string') return v.toLowerCase() !== 'off'
    } catch { /* Bare may not expose process.env */ }
    return true
  })()
  const erc4337FallbackEnabled = opts.erc4337Fallback !== undefined
    ? !!opts.erc4337Fallback
    : envFallback

  let closed = false
  const inflight = new Map() // synthHash -> row

  async function proposeTip({ amount, note } = {}) {
    if (closed) throw new TipError('TIP_CLOSED', 'tip service closed')
    if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount)) {
      throw new TipError('VALIDATION_ERROR', 'amount must be a decimal base-unit string')
    }
    let amountBig
    try { amountBig = BigInt(amount) } catch {
      throw new TipError('VALIDATION_ERROR', 'amount not a valid uint')
    }
    if (amountBig <= 0n) {
      throw new TipError('VALIDATION_ERROR', 'amount must be > 0')
    }
    if (amountBig > MAX_DEMO_AMOUNT_BASE) {
      throw new TipError('AMOUNT_EXCEEDS_CAP', 'demo cap is 100 USDT (100_000_000 base units)')
    }
    if (note !== undefined && typeof note !== 'string') {
      throw new TipError('VALIDATION_ERROR', 'note must be a string')
    }
    if (note && note.length > 140) {
      throw new TipError('VALIDATION_ERROR', 'note too long (max 140)')
    }

    // Step 1: pre-broadcast pending row.
    const nowMs = Date.now()
    const nonce = randomNonce()
    const synthHash = 'pending-' + nonce.slice(2, 18)
    const key = tipKey(nowMs, synthHash)
    const row = {
      from_peer: tipperPubkey,
      from_address: null,        // filled after sign
      to_address: hostSmartAddr,
      amount: amount,
      token: tokenAddress,
      chainId,
      tx_hash: synthHash,
      status: 'pending',
      nonce,
      note: note || null,
      created_at: nowMs,
      submitted_at: null,
      confirmed_at: null,
      facilitator_url: backend ? backend.baseUrl : null
    }
    await beePut(key, row)
    inflight.set(synthHash, { key, row })
    fire('pending', row)

    // Step 2: sign in the worklet.
    let sig
    try {
      row.status = 'signing'
      await beePut(key, row)
      fire('signing', row)
      sig = await wallet.signEip3009({
        chainId,
        tokenAddress,
        to: hostSmartAddr,
        value: amount,
        nonce
      })
      if (!sig || typeof sig.v !== 'number' || !sig.r || !sig.s || !sig.from) {
        throw new TipError('WALLET_SIGN_FAILED', 'wallet returned malformed signature')
      }
    } catch (err) {
      return finalizeFailed(key, row, err.code || 'WALLET_SIGN_FAILED', err.message)
    }

    row.from_address = String(sig.from).toLowerCase()
    row.status = 'submitting'
    row.route = 'eip3009' // Wave 8C: default route
    await beePut(key, row)
    fire('submitting', row)

    // Step 3: submit to F11 facilitator (primary path). On infrastructure
    // failure AND when the ERC-4337 UserOp fallback is enabled AND the
    // wallet supports account.transfer, fall back to the on-device UserOp
    // path so the tip survives a facilitator outage.
    let submitRes = null
    let facilitatorAttempted = false
    if (backend) {
      facilitatorAttempted = true
      try {
        submitRes = await backend.submitFacilitator({
          chainId,
          tokenAddress,
          from: sig.from,
          to: hostSmartAddr,
          value: amount,
          validAfter: sig.validAfter,
          validBefore: sig.validBefore,
          nonce: sig.nonce,
          v: sig.v,
          r: sig.r,
          s: sig.s
        })
      } catch (err) {
        // backend client is designed to NEVER throw, but be defensive.
        submitRes = { ok: false, error: { code: 'BACKEND_UNREACHABLE', message: err.message } }
      }
    } else {
      submitRes = { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'no backend configured' } }
    }

    let txHash = null
    if (submitRes.ok) {
      txHash = String(submitRes.data?.txHash || submitRes.data?.tx_hash || '').toLowerCase()
      if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
        return finalizeFailed(key, row, 'FACILITATOR_BAD_RESPONSE', 'no txHash in facilitator response')
      }
    } else {
      // Facilitator failed. Decide: business error (surface) vs infra error (fallback).
      const errCode = submitRes.error?.code || 'FACILITATOR_ERROR'
      const errMsg = submitRes.error?.message || 'facilitator error'
      const isInfra = FALLBACK_ELIGIBLE_CODES.has(errCode)
      const canFallback = erc4337FallbackEnabled &&
        isInfra &&
        typeof wallet.sendUsdtViaAccountTransfer === 'function'

      if (!canFallback) {
        return finalizeFailed(key, row, errCode, errMsg)
      }

      // Structured warning so ops can grep for fallback events.
      console.warn(LOG, JSON.stringify({
        event: 'facilitator_fallback',
        reason: errCode,
        message: errMsg,
        tipperPubkey: tipperPubkey ? tipperPubkey.slice(0, 8) : null,
        to: hostSmartAddr,
        amount
      }))

      row.route = 'erc4337'
      row.facilitator_error = { code: errCode, message: errMsg }
      await beePut(key, row)

      let userOpRes
      try {
        userOpRes = await wallet.sendUsdtViaAccountTransfer({
          recipient: hostSmartAddr,
          amount
        })
      } catch (err) {
        // Wallet-side errors carry their own code (USEROP_*).
        const code = err && err.code ? err.code : 'USEROP_FAILED'
        return finalizeFailed(key, row, code, err.message || 'ERC-4337 UserOp failed')
      }

      if (!userOpRes || !userOpRes.txHash) {
        return finalizeFailed(key, row, 'USEROP_BAD_RESPONSE', 'no txHash from UserOp')
      }
      txHash = userOpRes.txHash
      row.user_op_hash = userOpRes.userOpHash
      if (userOpRes.fee) row.userop_fee = userOpRes.fee
    }

    row.tx_hash = txHash
    row.status = 'submitted'
    row.submitted_at = Date.now()
    // Best-effort cleanup of the pending key.
    try { await bee.del(key) } catch { /* noop */ }
    const finalKey = tipKey(row.created_at, txHash)
    await beePut(finalKey, row)
    inflight.delete(synthHash)
    fire('submitted', row)

    // Task 6: broadcast a `system:tip` chat message so peers see the tip
    // in-line. Guarded so an error here NEVER poisons the tip flow — we
    // already awarded the row, and the confirmation SSE will still land.
    // Single append, no recursion: onMessage listeners for `system:tip`
    // treat this as pure display state, not a signal to re-tip.
    if (chat) {
      try {
        await chat.sendSystem({
          type: 'system:tip',
          by_peer: tipperPubkey,
          match_time_ms: 0,
          wall_clock_ms: Date.now(),
          amount: String(amount),
          tx_hash: txHash,
          explorer_url: explorerBase ? explorerBase + txHash : undefined,
          to_host: hostSmartAddr,
          from_handle: fromHandle || undefined,
          // Wave 8C: which submit path produced this tx. Debug consoles show
          // both possible routes so judges can see the fallback engage live.
          route: row.route
        })
      } catch (err) {
        console.warn(LOG, 'system:tip chat append failed:', err.message)
      }

      // Wave 6 T4: also append a translatable congrats line so every viewer
      // sees a QVAC-translated message in their preferred language. This is
      // strictly a UI cameo — no funds, no signature. Emitted as English
      // (source_lang='en') because our display copy is authored in English.
      try {
        const whole = Number(BigInt(amount)) / 1_000_000
        const amtDisplay = whole.toFixed(whole >= 1 ? 0 : 2)
        const handle = fromHandle || (tipperPubkey ? tipperPubkey.slice(0, 8) : 'a peer')
        const congratsText = `@${handle} just tipped ${amtDisplay} USDT to the host! Forza Curva!`
        await chat.sendSystem({
          type: 'system:tip-congrats',
          by_peer: tipperPubkey,
          match_time_ms: 0,
          wall_clock_ms: Date.now(),
          text: congratsText,
          lang: 'en',
          source_lang: 'en',
          tx_hash: txHash
        })
      } catch (err) {
        console.warn(LOG, 'system:tip-congrats append failed:', err.message)
      }
    }

    return row
  }

  async function markConfirmed(txHash, extra = {}) {
    if (typeof txHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(txHash)) return null
    const target = txHash.toLowerCase()
    // Linear scan of the tips/ prefix — cheap since demo tip volume is small.
    let updated = null
    for await (const { key, value } of bee.createReadStream({
      gt: 'tips/',
      lt: 'tips/~'
    })) {
      if (value && value.tx_hash === target && value.status !== 'confirmed') {
        value.status = 'confirmed'
        value.confirmed_at = Date.now()
        if (extra.block) value.block = extra.block
        await beePut(key, value)
        updated = value
        fire('confirmed', value)
        break
      }
    }

    // Wave 6 T14: host-signed receipt. If we ARE the host AND the tip targets
    // our smart address, sign a short EIP-191 personal message and append
    // `system:tip-ack` so all peers can display a "verified by host" badge
    // (any peer can ecrecover offline). Never blocks confirmation; failures
    // are logged and swallowed.
    if (isHostSide && chat && updated && typeof wallet.signMessage === 'function') {
      try {
        const toAddr = String(updated.to_address || '').toLowerCase()
        if (toAddr === hostSmartAddr) {
          const timestamp = updated.confirmed_at || Date.now()
          const receiptText = `Curva tip receipt: ${target} at ${timestamp}`
          const sig = await wallet.signMessage(receiptText)
          if (sig?.signature && sig?.signer) {
            await chat.sendSystem({
              type: 'system:tip-ack',
              by_peer: tipperPubkey,
              match_time_ms: 0,
              wall_clock_ms: Date.now(),
              tx_hash: target,
              signature: sig.signature,
              signer: sig.signer,
              text: receiptText
            })
          }
        }
      } catch (err) {
        console.warn(LOG, 'system:tip-ack broadcast failed:', err.message)
      }
    }

    return updated
  }

  async function listTips({ limit = 100 } = {}) {
    const out = []
    for await (const { value } of bee.createReadStream({
      gt: 'tips/',
      lt: 'tips/~',
      limit
    })) {
      out.push(value)
    }
    return out
  }

  async function finalizeFailed(key, row, code, message) {
    row.status = 'failed'
    row.error = { code, message }
    try { await beePut(key, row) } catch { /* noop */ }
    inflight.delete(row.tx_hash)
    fire('failed', row)
    // We DO NOT throw. Tip failure is a UI event, not a bug. But we still
    // return the row so IPC callers can respond correctly.
    return row
  }

  function fire(kind, row) {
    if (onStateChange) {
      try { onStateChange(kind, row) } catch (err) {
        console.warn(LOG, 'onStateChange threw:', err.message)
      }
    }
  }

  async function beePut(key, value) {
    // Hyperbee.put is idempotent — later puts overwrite. Value is JSON-serialized
    // by the bee's valueEncoding.
    await bee.put(key, value)
  }

  function close() {
    closed = true
    inflight.clear()
  }

  return {
    proposeTip,
    markConfirmed,
    listTips,
    close,
    // Read-only introspection for renderer/host UI:
    get hostSmartAddr() { return hostSmartAddr },
    get hostOwnerAddr() { return hostOwnerAddr },
    get chainId() { return chainId },
    get tokenAddress() { return tokenAddress }
  }
}

// tips/<padded_ts>/<tx_hash> — sortable by time; tx_hash disambiguates rapid taps.
function tipKey(ts, txHash) {
  const padded = String(ts).padStart(16, '0')
  return `tips/${padded}/${txHash}`
}

class TipError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TipError'
    this.code = code
  }
}

module.exports = {
  createTipService,
  TipError,
  DEMO_AMOUNT_BASE_UNITS,
  MAX_DEMO_AMOUNT_BASE
}
