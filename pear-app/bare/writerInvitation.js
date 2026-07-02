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
//     so it cannot be replayed against a different pubkey.
//   - `timestamp` older than MAX_AGE_MS is rejected. Clock skew tolerance
//     of ~60s is enough for LAN + realistic NTP drift; tighter than a signed
//     JWT would be because both parties are on Hyperswarm and the RTT is low.
//   - `verifyInvitation` treats malformed input as invalid, never throws.

const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const DOMAIN = 'curva.writer-invite/v1'
const MAX_AGE_MS = 60_000

/**
 * Build the canonical message bytes signed by an invitation.
 * @param {string} pubkeyHex ed25519 public key, 64 hex chars
 * @param {number} timestamp ms since epoch
 * @returns {Buffer}
 */
function canonicalBytes(pubkeyHex, timestamp) {
  return b4a.from(DOMAIN + '|' + pubkeyHex.toLowerCase() + '|' + String(timestamp))
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
 * @returns {{ pubkey: string, sig: string, timestamp: number }}
 */
function signInvitation(seedOrKeyPair, pubkeyHexOverride) {
  const keyPair = normalizeKeyPair(seedOrKeyPair)
  if (!keyPair) throw new TypeError('signInvitation requires a seed or keypair')

  const pubkeyHex = (pubkeyHexOverride || b4a.toString(keyPair.publicKey, 'hex')).toLowerCase()
  if (!isHex32Bytes(pubkeyHex)) {
    throw new RangeError('pubkey must be a 32-byte hex string')
  }

  const timestamp = Date.now()
  const msg = canonicalBytes(pubkeyHex, timestamp)
  const sig = crypto.sign(msg, keyPair.secretKey)
  return {
    pubkey: pubkeyHex,
    sig: b4a.toString(sig, 'hex'),
    timestamp
  }
}

/**
 * Verify an invitation. Returns true iff:
 *   - shape is valid
 *   - timestamp is within MAX_AGE_MS of `now` (and not in the future by
 *     more than 5s; small skew allowed)
 *   - if `expectedSigner` is provided, invitation.pubkey === expectedSigner
 *   - ed25519 sig verifies against invitation.pubkey
 *
 * @param {{pubkey:string,sig:string,timestamp:number}} inv
 * @param {string} [expectedSigner]  hex pubkey the caller expects; optional
 * @param {{ now?: number, maxAgeMs?: number }} [opts]
 * @returns {boolean}
 */
function verifyInvitation(inv, expectedSigner, opts = {}) {
  if (!inv || typeof inv !== 'object') return false
  if (typeof inv.pubkey !== 'string' || !isHex32Bytes(inv.pubkey)) return false
  if (typeof inv.sig !== 'string' || !/^[0-9a-fA-F]{128}$/.test(inv.sig)) return false
  if (typeof inv.timestamp !== 'number' || !Number.isFinite(inv.timestamp)) return false

  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const maxAge = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : MAX_AGE_MS
  if (now - inv.timestamp > maxAge) return false
  if (inv.timestamp - now > 5_000) return false // future skew

  if (expectedSigner && String(expectedSigner).toLowerCase() !== inv.pubkey.toLowerCase()) {
    return false
  }

  let pubkeyBuf, sigBuf
  try {
    pubkeyBuf = b4a.from(inv.pubkey, 'hex')
    sigBuf = b4a.from(inv.sig, 'hex')
  } catch { return false }

  const msg = canonicalBytes(inv.pubkey, inv.timestamp)
  try {
    return crypto.verify(msg, sigBuf, pubkeyBuf)
  } catch { return false }
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

module.exports = {
  signInvitation,
  verifyInvitation,
  _internal: {
    canonicalBytes,
    normalizeKeyPair,
    DOMAIN,
    MAX_AGE_MS
  }
}
