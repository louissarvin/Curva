// Curva keet-identity-key portable identity wrapper (Tier 4 Round 2).
//
// Portable identity = 24-word BIP-39 mnemonic that derives a stable Ed25519
// identity root, plus a per-install device keypair signed under the identity
// root. The identity root SURVIVES reinstall and swap-of-laptop; the device
// key is fresh per install and attested by the identity via bootstrap().
//
// Sits ABOVE Wave 8A writer capability (bare/writerInvitation.js). This is
// NOT a replacement for the writer cap. A promoted writer whose device is
// stolen can still be spotted because attestations forged with a stolen
// device key will not verify against the roster-registered identity root.
//
// SECURITY
// - Mnemonic is persisted encrypted-at-rest via wdk-secret-manager under the
//   same passcode as the WDK wallet. Keys are namespaced so wallet reset does
//   not silently corrupt the identity blob.
// - Mnemonic is NEVER logged, NEVER put on the P2P wire, NEVER IPC-emitted
//   except ONCE on first generation (renderer shows it, then drops).
// - Device seed is a SEPARATE encrypted blob so a stolen device seed can be
//   rotated without touching the mnemonic (spec requirement).
// - IdentityKey.verify returns `null | {receipt, identityPublicKey,
//   devicePublicKey}` per the authoritative source. Callers coerce via `!!res`.
//
// Docs verified against source: https://unpkg.com/keet-identity-key@3.2.0/index.js
// See /Users/macbookair/Documents/curva/memory/impl_keet_identity.md.

'use strict'

const IdentityKey = require('keet-identity-key')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const LOG = '[Curva][KeetIdentity]'

const MNEMONIC_KEY = 'curva/keet-identity/mnemonic'
const DEVICE_SEED_KEY = 'curva/keet-identity/device-seed'

const FLAG_ENV = 'CURVA_KEET_IDENTITY_ENABLED'

function featureEnabled() {
  try {
    const v = (typeof process !== 'undefined' && process.env && process.env[FLAG_ENV]) || ''
    return String(v).toLowerCase() === 'true'
  } catch { return false }
}

/**
 * Build a keet-identity handle bound to a WDK SecretManager instance + storage
 * dir. Nothing is loaded eagerly. Callers drive lifecycle via loadOrGenerate /
 * restore.
 *
 * @param {object} opts
 * @param {object} opts.SecretManager  wdk-secret-manager default export (class)
 * @param {string} opts.storageDir     dir passed to new SecretManager(...)
 * @param {Function} [opts.log]        structured logger
 */
function createKeetIdentity({ SecretManager, storageDir, log } = {}) {
  if (!SecretManager) throw new TypeError('SecretManager required')
  if (typeof storageDir !== 'string' || storageDir.length === 0) {
    throw new RangeError('storageDir required')
  }
  const logFn = typeof log === 'function' ? log : (() => {})

  // Loaded state. Never expose the underlying IdentityKey instance to callers;
  // we hold onto deviceKeyPair + deviceProof + identity public key only.
  let loaded = null // {identityPublicKey, identityPublicKeyHex, deviceKeyPair, deviceProof}

  async function openSecret(passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length < 4) {
      throw new TypeError('passphrase must be a string of length >= 4')
    }
    const secret = new SecretManager({ storage: storageDir, passcode: passphrase })
    if (typeof secret.init === 'function') await secret.init()
    return secret
  }

  async function readMnemonic(secret) {
    try {
      const v = await secret.get(MNEMONIC_KEY)
      return v ? String(v) : null
    } catch (err) {
      if (err && err.code === 'ENOENT') return null
      if (err && /passcode|decrypt/i.test(err.message || '')) {
        const e = new Error('KEET_WRONG_PASSCODE')
        e.code = 'KEET_WRONG_PASSCODE'
        throw e
      }
      throw err
    }
  }

  async function readDeviceSeed(secret) {
    try {
      const v = await secret.get(DEVICE_SEED_KEY)
      if (!v) return null
      const buf = b4a.from(String(v), 'hex')
      return buf.length === 32 ? buf : null
    } catch (err) {
      if (err && err.code === 'ENOENT') return null
      throw err
    }
  }

  async function deriveFromMnemonic(mnemonic, secret) {
    // Bootstrap identity + device.
    const identity = await IdentityKey.from({ mnemonic })

    let deviceSeed = await readDeviceSeed(secret)
    if (!deviceSeed) {
      deviceSeed = b4a.from(crypto.randomBytes(32))
      await secret.set(DEVICE_SEED_KEY, b4a.toString(deviceSeed, 'hex'))
    }
    const deviceKeyPair = crypto.keyPair(deviceSeed)

    // bootstrap(devicePublicKey) is async and returns the proof Buffer that
    // attestData() later chains through.
    const deviceProof = await identity.bootstrap(deviceKeyPair.publicKey)

    const identityPublicKey = b4a.from(identity.identityPublicKey)

    // Zero the mnemonic-holding identity instance material once we have the
    // derived pubkey + device proof.
    try { identity.clear() } catch { /* best-effort */ }

    return {
      identityPublicKey,
      identityPublicKeyHex: b4a.toString(identityPublicKey, 'hex'),
      deviceKeyPair,
      deviceProof
    }
  }

  /**
   * Load an existing identity from the SecretManager, or generate a fresh
   * mnemonic + device keypair and persist both.
   *
   * @param {object} args
   * @param {string} args.passphrase
   * @param {boolean} [args.force]  regenerate a new mnemonic even if one exists
   * @returns {Promise<{
   *   identityPublicKey: Buffer,
   *   identityPublicKeyHex: string,
   *   deviceKeyPair: {publicKey:Buffer, secretKey:Buffer},
   *   deviceProof: Buffer,
   *   proof: Buffer,          // alias of deviceProof for callers using the spec name
   *   mnemonic: string | null // ONLY non-null on first-time generate
   * }>}
   */
  async function loadOrGenerate({ passphrase, force } = {}) {
    const secret = await openSecret(passphrase)

    let mnemonic = force ? null : await readMnemonic(secret)
    let generatedMnemonic = null

    if (!mnemonic) {
      mnemonic = IdentityKey.generateMnemonic()
      generatedMnemonic = mnemonic
      await secret.set(MNEMONIC_KEY, mnemonic)
      // Force a fresh device seed on brand-new identity too.
      if (force) {
        try { await secret.set(DEVICE_SEED_KEY, b4a.toString(b4a.from(crypto.randomBytes(32)), 'hex')) }
        catch { /* best-effort */ }
      }
      logFn('info', 'keet identity generated (24-word mnemonic; persisted encrypted)')
    } else {
      logFn('info', 'keet identity loaded from encrypted store')
    }

    const derived = await deriveFromMnemonic(mnemonic, secret)
    loaded = derived
    return {
      ...derived,
      proof: derived.deviceProof,
      mnemonic: generatedMnemonic
    }
  }

  /**
   * Restore an identity from an externally-supplied 24-word mnemonic. Overwrites
   * any existing mnemonic + device seed in the secret store. Callers MUST have
   * user consent before invoking (this destroys the prior device-seed binding).
   *
   * @param {object} args
   * @param {string} args.mnemonic  24-word BIP-39 phrase
   * @param {string} args.passphrase
   */
  async function restore({ mnemonic, passphrase } = {}) {
    if (typeof mnemonic !== 'string' || mnemonic.trim().split(/\s+/).length !== 24) {
      const e = new Error('MNEMONIC_INVALID')
      e.code = 'MNEMONIC_INVALID'
      throw e
    }
    const clean = mnemonic.trim().replace(/\s+/g, ' ')
    const secret = await openSecret(passphrase)
    await secret.set(MNEMONIC_KEY, clean)
    // Fresh device seed on restore: this device is new; do NOT reuse whatever
    // seed was left in the store.
    const newSeed = b4a.from(crypto.randomBytes(32))
    await secret.set(DEVICE_SEED_KEY, b4a.toString(newSeed, 'hex'))
    const derived = await deriveFromMnemonic(clean, secret)
    loaded = derived
    return {
      ...derived,
      proof: derived.deviceProof
    }
  }

  /**
   * Canonicalize a payload to deterministic bytes.
   *
   * Sorted-keys JSON. Numbers must be finite integers or ordinary strings; we
   * reject NaN/Infinity and floats to keep the byte-representation stable across
   * platforms. Booleans and null pass through.
   *
   * Whitespace-free JSON.stringify output UTF-8 encoded.
   *
   * @param {object} payload
   * @returns {Buffer}
   */
  function canonicalize(payload) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('canonicalize: payload must be a plain object')
    }
    const out = canonicalValue(payload)
    return b4a.from(JSON.stringify(out), 'utf8')
  }

  function canonicalValue(v) {
    if (v === null) return null
    if (typeof v === 'string' || typeof v === 'boolean') return v
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        throw new RangeError('canonicalize: non-finite number')
      }
      if (!Number.isInteger(v)) {
        throw new RangeError('canonicalize: floats not permitted')
      }
      return v
    }
    if (typeof v === 'bigint') return v.toString()
    if (Array.isArray(v)) return v.map(canonicalValue)
    if (typeof v === 'object') {
      const keys = Object.keys(v).sort()
      const obj = {}
      for (const k of keys) {
        const val = v[k]
        if (val === undefined) continue
        obj[k] = canonicalValue(val)
      }
      return obj
    }
    throw new TypeError('canonicalize: unsupported value type ' + typeof v)
  }

  /**
   * Attest a message payload with the loaded device key + device proof. Returns
   * a hex-encoded proof suitable for embedding on a chat/tip/attendance
   * message's `identity_proof` field.
   *
   * When the feature flag is OFF or the identity is not yet loaded, returns
   * null so callers can skip the field.
   *
   * @param {object} payload  plain object; will be canonicalized before signing
   * @returns {string|null}   hex string or null
   */
  function attest(payload) {
    if (!featureEnabled()) return null
    if (!loaded) return null
    const canonical = canonicalize(payload)
    const proofBuf = IdentityKey.attestData(canonical, loaded.deviceKeyPair, loaded.deviceProof)
    return b4a.toString(proofBuf, 'hex')
  }

  /**
   * Verify an attestation against an expected identity public key.
   *
   * `IdentityKey.verify` returns `null | { receipt, identityPublicKey,
   * devicePublicKey }`. This wrapper returns a plain boolean.
   *
   * When the feature flag is OFF returns null so the caller can distinguish
   * "not attempted" from "attempted-and-failed".
   *
   * @param {string} proofHex
   * @param {object} payload
   * @param {string|Buffer} expectedIdentityPubKey
   * @returns {boolean|null}
   */
  function verify(proofHex, payload, expectedIdentityPubKey) {
    if (!featureEnabled()) return null
    if (typeof proofHex !== 'string' || proofHex.length === 0) return false
    if (!/^[0-9a-fA-F]+$/.test(proofHex)) return false
    let proofBuf
    let canonical
    let expectedBuf
    try {
      proofBuf = b4a.from(proofHex, 'hex')
      canonical = canonicalize(payload)
      expectedBuf = typeof expectedIdentityPubKey === 'string'
        ? b4a.from(expectedIdentityPubKey, 'hex')
        : b4a.from(expectedIdentityPubKey)
    } catch {
      return false
    }
    try {
      const res = IdentityKey.verify(proofBuf, canonical, { expectedIdentity: expectedBuf })
      return !!res
    } catch {
      return false
    }
  }

  function getIdentityPublicKeyHex() {
    return loaded ? loaded.identityPublicKeyHex : null
  }

  function isLoaded() {
    return !!loaded
  }

  function dispose() {
    if (loaded && loaded.deviceKeyPair && loaded.deviceKeyPair.secretKey) {
      try { loaded.deviceKeyPair.secretKey.fill(0) } catch { /* noop */ }
    }
    loaded = null
  }

  return {
    loadOrGenerate,
    restore,
    attest,
    verify,
    canonicalize,
    getIdentityPublicKeyHex,
    isLoaded,
    dispose,
    // Internals for tests only; not part of the stable surface.
    _internal: {
      featureEnabled,
      canonicalValue,
      MNEMONIC_KEY,
      DEVICE_SEED_KEY
    }
  }
}

/**
 * ADR-002: stateless verifier for a peer's identity proof. Given a proof
 * buffer (or hex string) and the attested data bytes, ecrecover-style walk
 * the identity chain via `IdentityKey.verify` and return the derived
 * identity + device public keys. Returns `{ ok: false }` on ANY failure so
 * the caller cannot leak a partial result.
 *
 * This is a MODULE-LEVEL export, not on the createKeetIdentity handle, so
 * the room presence pipeline can call it without holding an identity load.
 * The verifier is stateless by design: presence messages carry the exact
 * (proof, attestedData) pair produced by the peer's attest() call.
 *
 * Verified against source:
 *   pear-app/node_modules/keet-identity-key/index.js:138-193
 *   returns null | { receipt, identityPublicKey, devicePublicKey }
 *
 * @param {string|Buffer} proof         proof bytes (hex string or Buffer)
 * @param {string|Buffer} attestedData  canonical attested bytes
 * @returns {{ok:true, identityPublicKeyHex:string, devicePublicKeyHex:string} | {ok:false}}
 */
function verifyPeerProof(proof, attestedData) {
  try {
    if (proof === undefined || proof === null) return { ok: false }
    if (attestedData === undefined || attestedData === null) return { ok: false }
    let proofBuf
    if (typeof proof === 'string') {
      if (proof.length === 0) return { ok: false }
      if (!/^[0-9a-fA-F]+$/.test(proof)) return { ok: false }
      proofBuf = b4a.from(proof, 'hex')
    } else if (b4a.isBuffer(proof) || proof instanceof Uint8Array) {
      proofBuf = proof
    } else {
      return { ok: false }
    }
    let dataBuf
    if (typeof attestedData === 'string') {
      dataBuf = b4a.from(attestedData, 'utf8')
    } else if (b4a.isBuffer(attestedData) || attestedData instanceof Uint8Array) {
      dataBuf = attestedData
    } else {
      return { ok: false }
    }
    const res = IdentityKey.verify(proofBuf, dataBuf, {})
    if (!res || !res.identityPublicKey || !res.devicePublicKey) return { ok: false }
    return {
      ok: true,
      identityPublicKeyHex: b4a.toString(res.identityPublicKey, 'hex'),
      devicePublicKeyHex: b4a.toString(res.devicePublicKey, 'hex')
    }
  } catch {
    return { ok: false }
  }
}

module.exports = {
  createKeetIdentity,
  featureEnabled,
  verifyPeerProof,
  FLAG_ENV,
  MNEMONIC_KEY,
  DEVICE_SEED_KEY,
  // Re-exported for tests to inspect the raw class if needed.
  _IdentityKey: IdentityKey
}
