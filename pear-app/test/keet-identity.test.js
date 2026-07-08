// Tier 4 Round 2 tests for bare/keetIdentity.js.
//
// Coverage:
//   - loadOrGenerate produces a stable identityPublicKey across restarts
//   - restore from a mnemonic yields the SAME identityPublicKey as generate
//   - attest + verify round-trip succeeds
//   - Forged proof from a different mnemonic fails verify
//   - canonicalize is deterministic under key-order permutation
//   - Feature-flag gate: when off, attest and verify return null
//
// The real @tetherto/wdk-secret-manager depends on Bare-specific `require.addon`
// and cannot boot under brittle-node. We substitute an in-memory get/set/init
// stub that matches the exact surface consumed by createKeetIdentity: `new
// SecretManager({ storage, passcode })`, `secret.init()`, `secret.get(key)`,
// `secret.set(key, value)`, `secret.get` throws ENOENT-style when the key is
// absent and `WRONG_PASSCODE` when a persisted store is opened with a mismatched
// passcode. This isolates the identity roundtrip from the encrypted-storage
// path (which is exercised in wallet-worklet tests already).

'use strict'

const test = require('brittle')
const path = require('path')
const os = require('os')
const fs = require('fs')

const b4a = require('b4a')

const { createKeetIdentity, FLAG_ENV } = require('../bare/keetIdentity.js')

// Per-storage-dir persistent map. Two instances that share the same storage dir
// (as in "restart the app with the same passcode") see the same blob.
const PERSISTENT_STORES = new Map() // dir -> { passcode, entries: Map<string,string> }

function FakeSecretManager({ storage, passcode }) {
  if (typeof storage !== 'string' || !storage) throw new TypeError('storage required')
  if (typeof passcode !== 'string' || passcode.length < 4) throw new TypeError('passcode required')
  const rec = PERSISTENT_STORES.get(storage)
  if (rec && rec.passcode !== passcode) {
    // Deferred: real SecretManager fails at get/set. Match that by remembering
    // the mismatch and throwing on first operation.
    this._wrongPasscode = true
  }
  this._storage = storage
  this._passcode = passcode
  if (!rec) PERSISTENT_STORES.set(storage, { passcode, entries: new Map() })
}
FakeSecretManager.prototype.init = async function () { /* no-op */ }
FakeSecretManager.prototype.get = async function (key) {
  if (this._wrongPasscode) {
    const e = new Error('wrong passcode')
    throw e
  }
  const rec = PERSISTENT_STORES.get(this._storage)
  if (!rec || !rec.entries.has(key)) {
    const err = new Error('ENOENT')
    err.code = 'ENOENT'
    throw err
  }
  return rec.entries.get(key)
}
FakeSecretManager.prototype.set = async function (key, value) {
  if (this._wrongPasscode) throw new Error('wrong passcode')
  const rec = PERSISTENT_STORES.get(this._storage)
  rec.entries.set(key, String(value))
}

const SecretManager = FakeSecretManager

function tmpDir(tag) {
  const d = path.join(os.tmpdir(), `curva-keet-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function withFlagOn(fn) {
  return async (t) => {
    const prev = process.env[FLAG_ENV]
    process.env[FLAG_ENV] = 'true'
    try {
      await fn(t)
    } finally {
      if (prev === undefined) delete process.env[FLAG_ENV]
      else process.env[FLAG_ENV] = prev
    }
  }
}

const PASSPHRASE = 'test-passcode-1234'

test('loadOrGenerate: fresh generate emits a 24-word mnemonic + 32-byte identity pubkey', withFlagOn(async (t) => {
  const dir = tmpDir('gen')
  const handle = createKeetIdentity({ SecretManager, storageDir: dir })
  const res = await handle.loadOrGenerate({ passphrase: PASSPHRASE })
  t.ok(typeof res.mnemonic === 'string', 'mnemonic returned on first generate')
  t.is(res.mnemonic.trim().split(/\s+/).length, 24, 'mnemonic is 24 BIP-39 words')
  t.is(res.identityPublicKey.length, 32, 'identity pubkey is 32 bytes')
  t.is(typeof res.identityPublicKeyHex, 'string')
  t.is(res.identityPublicKeyHex.length, 64, 'hex form is 64 chars')
  t.ok(res.deviceKeyPair && res.deviceKeyPair.publicKey && res.deviceKeyPair.secretKey, 'deviceKeyPair present')
  t.ok(b4a.isBuffer(res.deviceProof) || res.deviceProof instanceof Uint8Array, 'deviceProof is bytes')
}))

test('loadOrGenerate: second call in same storage returns stable identity pubkey and null mnemonic', withFlagOn(async (t) => {
  const dir = tmpDir('stable')
  const h1 = createKeetIdentity({ SecretManager, storageDir: dir })
  const r1 = await h1.loadOrGenerate({ passphrase: PASSPHRASE })
  t.ok(r1.mnemonic, 'first call returns mnemonic')

  const h2 = createKeetIdentity({ SecretManager, storageDir: dir })
  const r2 = await h2.loadOrGenerate({ passphrase: PASSPHRASE })
  t.is(r2.mnemonic, null, 'second call does not resurface the mnemonic')
  t.is(r2.identityPublicKeyHex, r1.identityPublicKeyHex, 'identity pubkey stable across handle recreation')
}))

test('restore: yields the SAME identityPublicKey as the original generate', withFlagOn(async (t) => {
  const dir1 = tmpDir('restore-src')
  const h1 = createKeetIdentity({ SecretManager, storageDir: dir1 })
  const gen = await h1.loadOrGenerate({ passphrase: PASSPHRASE })
  const savedMnemonic = gen.mnemonic
  t.ok(savedMnemonic, 'have mnemonic from source install')

  // Simulate a fresh install with wiped storage.
  const dir2 = tmpDir('restore-dst')
  const h2 = createKeetIdentity({ SecretManager, storageDir: dir2 })
  const restored = await h2.restore({ mnemonic: savedMnemonic, passphrase: PASSPHRASE })
  t.is(restored.identityPublicKeyHex, gen.identityPublicKeyHex, 'restored identity pubkey matches original')
}))

test('attest + verify: correct roundtrip returns true', withFlagOn(async (t) => {
  const dir = tmpDir('roundtrip')
  const h = createKeetIdentity({ SecretManager, storageDir: dir })
  const res = await h.loadOrGenerate({ passphrase: PASSPHRASE })

  const payload = {
    type: 'msg',
    by_peer: 'peer-a',
    match_time_ms: 12000,
    wall_clock_ms: 1700000000000,
    text: 'forza curva sud'
  }
  const proofHex = h.attest(payload)
  t.ok(typeof proofHex === 'string' && proofHex.length > 100, 'attest returns hex string')
  t.ok(/^[0-9a-fA-F]+$/.test(proofHex), 'proof is hex')

  const ok = h.verify(proofHex, payload, res.identityPublicKeyHex)
  t.is(ok, true, 'verify returns true for correct payload + identity')
}))

test('verify: forged proof from a DIFFERENT mnemonic returns false', withFlagOn(async (t) => {
  const dirA = tmpDir('forge-a')
  const dirB = tmpDir('forge-b')
  const hA = createKeetIdentity({ SecretManager, storageDir: dirA })
  const hB = createKeetIdentity({ SecretManager, storageDir: dirB })
  const rA = await hA.loadOrGenerate({ passphrase: PASSPHRASE })
  const rB = await hB.loadOrGenerate({ passphrase: PASSPHRASE })
  t.not(rA.identityPublicKeyHex, rB.identityPublicKeyHex, 'identities differ across mnemonics')

  const payload = {
    type: 'msg',
    by_peer: 'peer-a',
    match_time_ms: 0,
    wall_clock_ms: 1,
    text: 'I am peer A'
  }
  // Attest with B's device keys but claim identity A -> underlying source
  // returns null; our wrapper coerces to boolean false.
  const proofByB = hB.attest(payload)
  const ok = hA.verify(proofByB, payload, rA.identityPublicKeyHex)
  t.is(ok, false, 'proof by B does not verify against A')
}))

test('verify: tampered payload returns false', withFlagOn(async (t) => {
  const dir = tmpDir('tamper')
  const h = createKeetIdentity({ SecretManager, storageDir: dir })
  const r = await h.loadOrGenerate({ passphrase: PASSPHRASE })
  const payload = {
    type: 'msg', by_peer: 'peer-a', match_time_ms: 0, wall_clock_ms: 1, text: 'hello'
  }
  const proofHex = h.attest(payload)
  const tampered = { ...payload, text: 'goodbye' }
  const ok = h.verify(proofHex, tampered, r.identityPublicKeyHex)
  t.is(ok, false, 'tampered payload does not verify')
}))

test('canonicalize: deterministic bytes under key-order permutation', withFlagOn(async (t) => {
  const dir = tmpDir('canon')
  const h = createKeetIdentity({ SecretManager, storageDir: dir })
  await h.loadOrGenerate({ passphrase: PASSPHRASE })

  const a = h.canonicalize({ type: 'msg', by_peer: 'x', match_time_ms: 0, wall_clock_ms: 1, text: 'hi' })
  const b = h.canonicalize({ text: 'hi', match_time_ms: 0, by_peer: 'x', wall_clock_ms: 1, type: 'msg' })
  t.ok(b4a.equals(a, b), 'byte-identical for same payload with permuted keys')
}))

test('canonicalize: rejects floats and non-finite numbers', withFlagOn(async (t) => {
  const dir = tmpDir('canon-nan')
  const h = createKeetIdentity({ SecretManager, storageDir: dir })
  await h.loadOrGenerate({ passphrase: PASSPHRASE })

  t.exception.all(() => h.canonicalize({ n: 1.5 }), /floats/)
  t.exception.all(() => h.canonicalize({ n: NaN }), /non-finite/)
  t.exception.all(() => h.canonicalize({ n: Infinity }), /non-finite/)
}))

test('feature-flag gate: when OFF, attest and verify return null', async (t) => {
  const prev = process.env[FLAG_ENV]
  // Force flag OFF for the duration of this test.
  delete process.env[FLAG_ENV]
  try {
    const dir = tmpDir('flag-off')
    const h = createKeetIdentity({ SecretManager, storageDir: dir })
    // Turn the flag ON to load the identity, then flip it OFF to check gates.
    process.env[FLAG_ENV] = 'true'
    await h.loadOrGenerate({ passphrase: PASSPHRASE })
    delete process.env[FLAG_ENV]

    const payload = { type: 'msg', by_peer: 'x', match_time_ms: 0, wall_clock_ms: 1, text: 'y' }
    t.is(h.attest(payload), null, 'attest is null when flag off')
    t.is(h.verify('deadbeef'.repeat(20), payload, '00'.repeat(32)), null, 'verify is null when flag off')
  } finally {
    if (prev === undefined) delete process.env[FLAG_ENV]
    else process.env[FLAG_ENV] = prev
  }
})

test('verify contract: source returns null|{...}; wrapper coerces to boolean', withFlagOn(async (t) => {
  // Sanity check that the wrapper matches the spec's !!res coercion pattern.
  const IdentityKey = require('keet-identity-key')
  const dir = tmpDir('coerce')
  const h = createKeetIdentity({ SecretManager, storageDir: dir })
  const r = await h.loadOrGenerate({ passphrase: PASSPHRASE })
  const payload = { type: 'msg', by_peer: 'x', match_time_ms: 0, wall_clock_ms: 1, text: 'y' }
  const proofHex = h.attest(payload)

  // Direct call to the underlying source returns an object on success.
  const canonical = h.canonicalize(payload)
  const raw = IdentityKey.verify(
    b4a.from(proofHex, 'hex'),
    canonical,
    { expectedIdentity: b4a.from(r.identityPublicKeyHex, 'hex') }
  )
  t.ok(raw && typeof raw === 'object', 'raw source returns object on success (not boolean)')
  t.ok(raw.receipt && raw.identityPublicKey && raw.devicePublicKey, 'object has receipt/identity/device pubkey')

  t.is(h.verify(proofHex, payload, r.identityPublicKeyHex), true, 'wrapper coerces to true')
}))
