// Wave 8A: signed writer-invitation handshake for Autobase Pattern B.
//
// A peer that wants to be promoted to an Autobase indexer sends a signed
// payload proving:
//   1. It owns the ed25519 signing keypair whose public half is `pubkey`.
//   2. The invitation was minted within the freshness window (replay defense).
//
// The host verifies the signature and calls `chatBase.addWriter(pubkey,
// { indexer: true })` + `playheadBase.addWriter(...)`. See docs:
//   - https://github.com/holepunchto/autobase (addWriter, indexer, writable)
//   - https://github.com/holepunchto/hypercore-crypto (sign, verify)
//
// SECURITY:
//   - Signature covers the full canonical bytes `curva.writer-invite/v1|<pubkey_hex>|<timestamp>`
//     (legacy) or `curva.writer-invite/v2|<pubkey_hex>|<timestamp>|<tier>` (v2)
//     so it cannot be replayed against a different pubkey or promoted to a
//     different tier.
//   - `timestamp` older than MAX_AGE_MS is rejected. Clock skew tolerance
//     of ~60s is enough for LAN + realistic NTP drift; tighter than a signed
//     JWT would be because both parties are on Hyperswarm and the RTT is low.
//   - `verifyInvitation` treats malformed input as invalid, never throws.
//
// Spectator tier (Autopass-style read-only): when the invitation encodes
// `tier: 'reader'`, the sig binds to that tier so a reader invitation cannot
// be replayed by a malicious host as a writer invitation. Legacy invitations
// with no `tier` field verify against the v1 canonical bytes and default to
// `tier: 'writer'` for backward compat. See
// `memory/impl_autopass_reader.md` for the full design memo.

const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const DOMAIN = 'curva.writer-invite/v1'
const DOMAIN_V2 = 'curva.writer-invite/v2'
const MAX_AGE_MS = 60_000
const VALID_TIERS = new Set(['reader', 'writer'])

/**
 * Build the canonical message bytes signed by a v1 (legacy) invitation.
 * @param {string} pubkeyHex ed25519 public key, 64 hex chars
 * @param {number} timestamp ms since epoch
 * @returns {Buffer}
 */
function canonicalBytes(pubkeyHex, timestamp) {
  return b4a.from(DOMAIN + '|' + pubkeyHex.toLowerCase() + '|' + String(timestamp))
}

/**
 * Build the canonical message bytes signed by a v2 (tier-bound) invitation.
 * Tier is a lowercase ASCII token in VALID_TIERS. The signature commits to it
 * so a reader-tier invitation cannot be replayed as writer-tier.
 */
function canonicalBytesV2(pubkeyHex, timestamp, tier) {
  return b4a.from(
    DOMAIN_V2 + '|' + pubkeyHex.toLowerCase() + '|' + String(timestamp) + '|' + tier
  )
}

/**
 * Sign an invitation from a keypair seed (or full keypair).
 *
 * Accepts either:
 *   - a 32-byte seed buffer (we derive the keypair via crypto.keyPair(seed))
 *   - a keypair object { publicKey, secretKey }
 *
 * @param {Buffer|Uint8Array|{publicKey:Buffer,secretKey:Buffer}} seedOrKeyPair
 * @param {string} [pubkeyHexOverride]  hex form of publicKey; if omitted we
 *   compute it from the derived keypair.
 * @param {{ tier?: 'reader'|'writer' }} [opts]  when `tier` is present the
 *   sig binds to that tier and the returned object carries the field.
 * @returns {{ pubkey: string, sig: string, timestamp: number, tier?: string }}
 */
function signInvitation(seedOrKeyPair, pubkeyHexOverride, opts) {
  const keyPair = normalizeKeyPair(seedOrKeyPair)
  if (!keyPair) throw new TypeError('signInvitation requires a seed or keypair')

  const pubkeyHex = (pubkeyHexOverride || b4a.toString(keyPair.publicKey, 'hex')).toLowerCase()
  if (!isHex32Bytes(pubkeyHex)) {
    throw new RangeError('pubkey must be a 32-byte hex string')
  }

  const rawTier = opts && typeof opts === 'object' ? opts.tier : undefined
  const timestamp = Date.now()

  // Legacy (no tier requested): emit v1 canonical bytes and omit the `tier`
  // field entirely. Preserves byte-for-byte compat with the pre-spectator
  // wire format so a host running the old code still verifies these.
  if (rawTier === undefined) {
    const msg = canonicalBytes(pubkeyHex, timestamp)
    const sig = crypto.sign(msg, keyPair.secretKey)
    return {
      pubkey: pubkeyHex,
      sig: b4a.toString(sig, 'hex'),
      timestamp
    }
  }

  if (!VALID_TIERS.has(rawTier)) {
    throw new RangeError('tier must be one of reader|writer')
  }
  const tier = rawTier
  const msg = canonicalBytesV2(pubkeyHex, timestamp, tier)
  const sig = crypto.sign(msg, keyPair.secretKey)
  return {
    pubkey: pubkeyHex,
    sig: b4a.toString(sig, 'hex'),
    timestamp,
    tier
  }
}

/**
 * Verify an invitation. Returns true iff:
 *   - shape is valid
 *   - timestamp is within MAX_AGE_MS of `now` (and not in the future by
 *     more than 5s; small skew allowed)
 *   - if `expectedSigner` is provided, invitation.pubkey === expectedSigner
 *   - ed25519 sig verifies against invitation.pubkey under either the v2
 *     tier-bound canonical bytes (if `inv.tier` is present) or the v1 bytes
 *     (legacy).
 *
 * Callers that need the tier out of a verified invitation must use
 * `verifyInvitationWithTier`, which returns `{ ok, tier }`. This entry
 * point keeps its boolean return shape so pre-existing truthy call sites
 * (`if (verifyInvitation(inv)) ...`) do not regress.
 *
 * @param {{pubkey:string,sig:string,timestamp:number,tier?:string}} inv
 * @param {string} [expectedSigner]  hex pubkey the caller expects; optional
 * @param {{ now?: number, maxAgeMs?: number }} [opts]
 * @returns {boolean}
 */
function verifyInvitation(inv, expectedSigner, opts = {}) {
  return verifyInvitationWithTier(inv, expectedSigner, opts).ok
}

/**
 * Same as `verifyInvitation` but returns `{ ok, tier }`. Tier defaults to
 * `'writer'` for legacy (v1) invitations that lack the field. Malformed or
 * expired invitations return `{ ok: false, tier: null }`.
 */
function verifyInvitationWithTier(inv, expectedSigner, opts = {}) {
  if (!inv || typeof inv !== 'object') return { ok: false, tier: null }
  if (typeof inv.pubkey !== 'string' || !isHex32Bytes(inv.pubkey)) {
    return { ok: false, tier: null }
  }
  if (typeof inv.sig !== 'string' || !/^[0-9a-fA-F]{128}$/.test(inv.sig)) {
    return { ok: false, tier: null }
  }
  if (typeof inv.timestamp !== 'number' || !Number.isFinite(inv.timestamp)) {
    return { ok: false, tier: null }
  }

  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const maxAge = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : MAX_AGE_MS
  if (now - inv.timestamp > maxAge) return { ok: false, tier: null }
  if (inv.timestamp - now > 5_000) return { ok: false, tier: null } // future skew

  if (expectedSigner && String(expectedSigner).toLowerCase() !== inv.pubkey.toLowerCase()) {
    return { ok: false, tier: null }
  }

  let pubkeyBuf, sigBuf
  try {
    pubkeyBuf = b4a.from(inv.pubkey, 'hex')
    sigBuf = b4a.from(inv.sig, 'hex')
  } catch { return { ok: false, tier: null } }

  // If the invitation carries a `tier` field, verify strictly against the v2
  // canonical bytes for that tier. Do NOT fall back to v1 for tier-bearing
  // invitations: that would let an attacker strip the tier field and downgrade
  // a reader invitation into a writer one, since v1 bytes do not commit to
  // tier at all. Only invitations that omit tier entirely fall back to v1.
  if (typeof inv.tier === 'string') {
    if (!VALID_TIERS.has(inv.tier)) return { ok: false, tier: null }
    const msgV2 = canonicalBytesV2(inv.pubkey, inv.timestamp, inv.tier)
    try {
      if (crypto.verify(msgV2, sigBuf, pubkeyBuf)) return { ok: true, tier: inv.tier }
      return { ok: false, tier: null }
    } catch { return { ok: false, tier: null } }
  }

  // Legacy v1: no tier field, verify against the pre-spectator canonical bytes
  // and default the caller-visible tier to 'writer'.
  const msgV1 = canonicalBytes(inv.pubkey, inv.timestamp)
  try {
    if (crypto.verify(msgV1, sigBuf, pubkeyBuf)) return { ok: true, tier: 'writer' }
    return { ok: false, tier: null }
  } catch { return { ok: false, tier: null } }
}

function normalizeKeyPair(input) {
  if (!input) return null
  if (input.publicKey && input.secretKey) {
    return {
      publicKey: b4a.isBuffer(input.publicKey) ? input.publicKey : b4a.from(input.publicKey),
      secretKey: b4a.isBuffer(input.secretKey) ? input.secretKey : b4a.from(input.secretKey)
    }
  }
  const seed = b4a.isBuffer(input) ? input : (input instanceof Uint8Array ? b4a.from(input) : null)
  if (!seed || seed.byteLength !== 32) return null
  return crypto.keyPair(seed)
}

function isHex32Bytes(x) {
  return typeof x === 'string' && /^[0-9a-fA-F]{64}$/.test(x)
}

// RFC 4648 base32 (Crockford variant is intentionally NOT used, we want the
// standard alphabet so external tooling can round-trip the token). Used to
// embed a signed invitation in a pear:// URL:
//   pear://<KEY>/room/<slug>?invite=<base32>
// Chosen over base64url so the token survives being read aloud, and over hex
// so the QR stays under 200 modules for a signed-invitation payload (roughly
// 130 bytes JSON that expands to 210 base32 chars).
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32urlEncode(buf) {
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out.toLowerCase()
}

function base32urlDecode(str) {
  const s = String(str).toUpperCase().replace(/=+$/, '')
  const bytes = []
  let bits = 0
  let value = 0
  for (const ch of s) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx < 0) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return b4a.from(bytes)
}

function encodeInvitationForUrl(inv) {
  if (!inv || typeof inv !== 'object') return null
  const packed = { p: inv.pubkey, s: inv.sig, t: inv.timestamp }
  if (typeof inv.tier === 'string' && VALID_TIERS.has(inv.tier)) {
    packed.r = inv.tier // short field name to keep the base32 token compact
  }
  const json = JSON.stringify(packed)
  return base32urlEncode(b4a.from(json))
}

function decodeInvitationFromUrl(token) {
  const buf = base32urlDecode(token)
  if (!buf) return null
  try {
    const j = JSON.parse(b4a.toString(buf))
    const out = { pubkey: j.p, sig: j.s, timestamp: j.t }
    if (typeof j.r === 'string' && VALID_TIERS.has(j.r)) out.tier = j.r
    return out
  } catch {
    return null
  }
}

module.exports = {
  signInvitation,
  verifyInvitation,
  verifyInvitationWithTier,
  encodeInvitationForUrl,
  decodeInvitationFromUrl,
  _internal: {
    canonicalBytes,
    canonicalBytesV2,
    normalizeKeyPair,
    base32urlEncode,
    base32urlDecode,
    DOMAIN,
    DOMAIN_V2,
    MAX_AGE_MS,
    VALID_TIERS
  }
}
