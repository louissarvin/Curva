// Wave 13B - client-side x402 payment flow.
//
// Wraps a plain `fetch(url)` with the x402 handshake:
//   1. GET url with no X-Payment header.
//   2. If server responds 200, return the body directly (no payment needed).
//   3. If server responds 402, extract the challenge from the JSON body OR
//      the X-Payment-Required response header.
//   4. Emit an `x402:paywall` event so the renderer PaywallModal can prompt
//      the user. When the user cancels, the promise rejects with USER_CANCELLED.
//   5. When the user confirms, sign an EIP-3009 authorization matching the
//      challenge nonce and re-fetch with the X-Payment request header.
//   6. Return the resource body OR reject with a classified error.
//
// The signer is a `wallet` object with a `signEip3009({ chainId, tokenAddress,
// to, value, validAfter, validBefore, nonce })` method returning
// `{ v, r, s, from, nonce, validAfter, validBefore }` — this is the exact
// shape produced by bare/wallet/worklet.js so no adapter is needed.
//
// Docs verified: same set as backend/src/lib/evm/x402.ts (WDK x402 spec +
// x402.org canonical + EIP-3009). This client is a pure JS module so it can
// be exercised by brittle-node without electron/preload.

'use strict'

class X402Error extends Error {
  constructor(code, message, extra = {}) {
    super(message || code)
    this.name = 'X402Error'
    this.code = code
    for (const [k, v] of Object.entries(extra)) this[k] = v
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Parse a 402 response into a normalized challenge shape. Accepts either the
 * JSON body ({ x402Version, accepts: [...] }) or the X-Payment-Required
 * response header (single accept entry as JSON string). Returns null when the
 * shape is unrecognized.
 */
function parseX402Challenge(bodyJson, headerJson) {
  // Prefer body — it carries x402Version and lets us pick from multiple
  // accept entries in a future upgrade.
  if (isPlainObject(bodyJson) && Array.isArray(bodyJson.accepts) && bodyJson.accepts.length > 0) {
    const a = bodyJson.accepts[0]
    if (isPlainObject(a)) return normalizeAccept(a)
  }
  if (isPlainObject(headerJson)) {
    return normalizeAccept(headerJson)
  }
  return null
}

function normalizeAccept(a) {
  const chainMatch = typeof a.network === 'string' && a.network.match(/^eip155:(\d+)$/)
  const chainId = chainMatch ? Number(chainMatch[1]) : (Number.isInteger(a.chainId) ? a.chainId : null)
  if (!Number.isInteger(chainId) || chainId <= 0) return null

  const asset = typeof a.asset === 'string' ? a.asset.toLowerCase() : null
  const payTo = typeof a.payTo === 'string' ? a.payTo.toLowerCase() : null
  const maxAmountRequired = typeof a.maxAmountRequired === 'string' ? a.maxAmountRequired : null
  const resource = typeof a.resource === 'string' ? a.resource : null
  const nonce = typeof a.nonce === 'string' ? a.nonce.toLowerCase() : null
  const validAfter = Number.isInteger(a.validAfter) ? a.validAfter : 0
  const validBefore = Number.isInteger(a.validBefore) ? a.validBefore : null

  if (!asset || !payTo || !maxAmountRequired || !resource || !nonce || !validBefore) return null
  if (!/^0x[0-9a-f]{40}$/.test(asset)) return null
  if (!/^0x[0-9a-f]{40}$/.test(payTo)) return null
  if (!/^[0-9]+$/.test(maxAmountRequired)) return null
  if (!/^0x[0-9a-f]{64}$/.test(nonce)) return null

  return {
    chainId,
    asset,
    payTo,
    maxAmountRequired,
    resource,
    nonce,
    validAfter,
    validBefore,
    description: typeof a.description === 'string' ? a.description : null,
    scheme: a.scheme || 'exact'
  }
}

/**
 * Build the X-Payment header value from a challenge + a wallet signature.
 * Returns a JSON string suitable to set on the retry request.
 */
function buildPaymentHeader(challenge, sig) {
  return JSON.stringify({
    scheme: 'exact',
    network: `eip155:${challenge.chainId}`,
    chainId: challenge.chainId,
    tokenAddress: challenge.asset,
    from: sig.from.toLowerCase(),
    to: challenge.payTo,
    value: challenge.maxAmountRequired,
    validAfter: sig.validAfter,
    validBefore: sig.validBefore,
    nonce: challenge.nonce,
    v: sig.v,
    r: sig.r,
    s: sig.s
  })
}

/**
 * Create an x402 client bound to a wallet + a paywall-prompt function.
 *
 * @param {object} deps
 * @param {object} deps.wallet   - object with signEip3009(opts) -> {v,r,s,from,nonce,validAfter,validBefore}
 * @param {function} [deps.fetch] - fetch impl; defaults to global fetch
 * @param {function} [deps.promptUser] - async (challenge) -> boolean; true=pay, false=cancel
 *   If omitted, non-cached challenges reject with PAYWALL_REQUIRED so the caller can drive the UI.
 * @param {function} [deps.emit] - (eventName, payload) => void; used to broadcast x402:paywall
 * @param {number}   [deps.timeoutMs]
 */
function createX402Client(deps = {}) {
  if (!deps || typeof deps !== 'object') throw new TypeError('deps required')
  if (!deps.wallet || typeof deps.wallet.signEip3009 !== 'function') {
    throw new TypeError('wallet.signEip3009 is required')
  }
  const fetchImpl = deps.fetch || (typeof fetch === 'function' ? fetch : null)
  if (!fetchImpl) throw new TypeError('fetch impl required')
  const promptUser = typeof deps.promptUser === 'function' ? deps.promptUser : null
  const emit = typeof deps.emit === 'function' ? deps.emit : () => {}
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_TIMEOUT_MS

  async function fetchWithTimeout(url, init) {
    if (typeof AbortController !== 'function') return fetchImpl(url, init)
    const controller = new AbortController()
    const t = setTimeout(() => { try { controller.abort() } catch (_) { /* noop */ } }, timeoutMs)
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(t)
    }
  }

  /**
   * Fetch a paywalled URL with automatic x402 handling.
   * @param {string} url
   * @param {object} [opts]
   * @returns {Promise<{status:number, body:object|null, txHash?:string, replay?:boolean}>}
   */
  async function fetchPaid(url, opts = {}) {
    if (typeof url !== 'string' || url.length === 0) throw new TypeError('url required')

    // First hop: no payment header.
    const first = await fetchWithTimeout(url, { method: 'GET', headers: { 'Accept': 'application/json' } })
    if (first.status !== 402) {
      const body = await safeJson(first)
      return { status: first.status, body }
    }

    // Parse the challenge from body + header.
    const rawBody = await safeJson(first)
    let headerObj = null
    try {
      const raw = first.headers.get ? first.headers.get('x-payment-required') : first.headers['x-payment-required']
      if (raw) headerObj = JSON.parse(raw)
    } catch (_) { /* ignore malformed header */ }
    const challenge = parseX402Challenge(rawBody, headerObj)
    if (!challenge) {
      throw new X402Error('BAD_CHALLENGE', 'server 402 did not include a valid challenge')
    }

    // Emit the paywall event so a renderer modal can pop up. This is fire-
    // and-forget; the actual gate is promptUser().
    emit('x402:paywall', {
      url,
      chainId: challenge.chainId,
      asset: challenge.asset,
      amount: challenge.maxAmountRequired,
      resource: challenge.resource,
      description: challenge.description
    })

    if (!promptUser) {
      throw new X402Error('PAYWALL_REQUIRED', 'server requires payment; no promptUser callback configured', {
        challenge
      })
    }
    let approved
    try {
      approved = await promptUser(challenge)
    } catch (err) {
      throw new X402Error('USER_CANCELLED', 'user cancelled paywall prompt', { cause: err.message })
    }
    if (!approved) {
      throw new X402Error('USER_CANCELLED', 'user cancelled paywall prompt')
    }

    // Sign the EIP-3009 authorization. The wallet enforces `from = ownerAddress`
    // itself; we only pass the challenge-derived fields.
    let sig
    try {
      sig = await deps.wallet.signEip3009({
        chainId: challenge.chainId,
        tokenAddress: challenge.asset,
        to: challenge.payTo,
        value: challenge.maxAmountRequired,
        nonce: challenge.nonce,
        validAfter: challenge.validAfter,
        validBefore: challenge.validBefore
      })
    } catch (err) {
      throw new X402Error('WALLET_SIGN_FAILED', err.message || String(err))
    }
    if (!sig || typeof sig.v !== 'number' || typeof sig.r !== 'string' || typeof sig.s !== 'string' || typeof sig.from !== 'string') {
      throw new X402Error('WALLET_SIGN_FAILED', 'wallet returned malformed signature')
    }

    // Second hop: retry with the X-Payment header.
    const paymentHeader = buildPaymentHeader(challenge, sig)
    const second = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Payment': paymentHeader }
    })
    const body = await safeJson(second)
    if (second.status === 200) {
      let txHash = null
      let replay = false
      try {
        const raw = second.headers.get ? second.headers.get('x-payment-response') : second.headers['x-payment-response']
        if (raw) {
          const parsed = JSON.parse(raw)
          txHash = typeof parsed.txHash === 'string' ? parsed.txHash : null
          replay = !!parsed.replay
        }
      } catch (_) { /* ignore */ }
      return { status: 200, body, txHash, replay }
    }
    // Classified errors surface with the backend's error code so callers can
    // react (e.g. show a "server rejected payment: nonce already used" toast).
    const errCode = body && body.error && typeof body.error.code === 'string' ? body.error.code : `HTTP_${second.status}`
    const errMsg = body && body.error && typeof body.error.message === 'string' ? body.error.message : `retry failed with status ${second.status}`
    throw new X402Error(errCode, errMsg, { status: second.status, body })
  }

  return {
    fetchPaid,
    // Exposed for tests + advanced callers that manage their own retry loop.
    parseChallenge: parseX402Challenge,
    buildPaymentHeader
  }
}

async function safeJson(resp) {
  if (!resp) return null
  try {
    const txt = await resp.text()
    if (!txt) return null
    return JSON.parse(txt)
  } catch (_) {
    return null
  }
}

module.exports = {
  createX402Client,
  X402Error,
  parseX402Challenge,
  buildPaymentHeader
}
