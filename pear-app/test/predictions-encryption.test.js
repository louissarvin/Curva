// F3 Wave 3: sealed-bid predictions via hypercore block-level encryption.
//
// Covers:
//   1. deriveSealKey() is deterministic for the same (slug, epoch, hostSecret)
//      tuple and different otherwise.
//   2. createSealedPrediction() writes an encrypted block; without the key,
//      the raw block is undecodable (readPrediction returns null).
//   3. readPrediction() with the CORRECT key returns the plaintext prediction.
//   4. readPrediction() with a WRONG key returns null (silent failure — no
//      leaking stack trace).
//   5. revealPredictions() produces a `system:reveal` message shape carrying
//      the encryption key so any subscriber can re-derive.
//
// Docs consulted (2026-07-10):
//   * https://docs.pears.com/reference/building-blocks/hypercore/
//   * pear-app/node_modules/hypercore/index.js:1394 getEncryptionOption()
//   * pear-app/node_modules/hypercore-crypto/index.js:127 hash()

const test = require('brittle')
const b4a = require('b4a')
const { makeStore } = require('./_helpers.js')
const {
  createSealedPrediction,
  revealPredictions,
  readPrediction,
  deriveSealKey,
  _internalSealed
} = require('../bare/predictions.js')

const HOST_SECRET = 'do-not-share-this-32-byte-secret-value-please'

test('F3: deriveSealKey is deterministic per (slug, epoch, hostSecret)', (t) => {
  const a = deriveSealKey({ slug: 'arg-vs-ita', epoch: '1', hostSecret: HOST_SECRET })
  const b = deriveSealKey({ slug: 'arg-vs-ita', epoch: '1', hostSecret: HOST_SECRET })
  t.is(a.byteLength, 32, '32-byte key')
  t.ok(b4a.equals(a, b), 'same inputs -> same key')

  const c = deriveSealKey({ slug: 'arg-vs-ita', epoch: '2', hostSecret: HOST_SECRET })
  t.absent(b4a.equals(a, c), 'different epoch -> different key')

  const d = deriveSealKey({ slug: 'bra-vs-fra', epoch: '1', hostSecret: HOST_SECRET })
  t.absent(b4a.equals(a, d), 'different slug -> different key')
})

test('F3: deriveSealKey rejects short host secrets', (t) => {
  t.exception.all(() => deriveSealKey({ slug: 's', epoch: '1', hostSecret: 'short' }))
  t.exception.all(() => deriveSealKey({ slug: '', epoch: '1', hostSecret: HOST_SECRET }))
  t.exception.all(() => deriveSealKey({ slug: 's', epoch: '', hostSecret: HOST_SECRET }))
})

test('F3: createSealedPrediction round-trip with matching key returns plaintext', async (t) => {
  const { store, cleanup } = await makeStore()
  const key = deriveSealKey({ slug: 'arg-vs-ita', epoch: 'ep-1', hostSecret: HOST_SECRET })

  const peerPubkey = 'aa'.repeat(32)
  const prediction = { winner: 'HOME', homeGoals: 2, awayGoals: 1 }

  const { seq } = await createSealedPrediction({
    store,
    slug: 'arg-vs-ita',
    epoch: 'ep-1',
    peerPubkey,
    prediction,
    encryptionKey: key
  })
  t.is(seq, 0, 'first block appended')

  const readBack = await readPrediction({
    store,
    slug: 'arg-vs-ita',
    epoch: 'ep-1',
    peerPubkey,
    encryptionKey: key
  })
  t.ok(readBack, 'plaintext recovered')
  t.is(readBack.winner, 'HOME')
  t.is(readBack.homeGoals, 2)
  t.is(readBack.awayGoals, 1)

  await cleanup()
})

test('F3: readPrediction with WRONG key returns null (no throw, no leak)', async (t) => {
  const { store, cleanup } = await makeStore()
  const correctKey = deriveSealKey({ slug: 's1', epoch: 'e1', hostSecret: HOST_SECRET })
  const wrongKey = deriveSealKey({ slug: 's1', epoch: 'e1', hostSecret: HOST_SECRET + '-tampered' })

  const peerPubkey = 'bb'.repeat(32)
  await createSealedPrediction({
    store,
    slug: 's1',
    epoch: 'e1',
    peerPubkey,
    prediction: { winner: 'DRAW' },
    encryptionKey: correctKey
  })

  const badRead = await readPrediction({
    store,
    slug: 's1',
    epoch: 'e1',
    peerPubkey,
    encryptionKey: wrongKey
  })
  t.is(badRead, null, 'wrong key returns null')

  // Sanity: correct key still works after the wrong-key read attempt.
  const goodRead = await readPrediction({
    store,
    slug: 's1',
    epoch: 'e1',
    peerPubkey,
    encryptionKey: correctKey
  })
  t.ok(goodRead, 'correct key still decrypts')
  t.is(goodRead.winner, 'DRAW')

  await cleanup()
})

test('F3: readPrediction returns null on missing / malformed inputs', async (t) => {
  const { store, cleanup } = await makeStore()
  const key = deriveSealKey({ slug: 's2', epoch: 'e2', hostSecret: HOST_SECRET })

  // Never-written epoch.
  const missing = await readPrediction({
    store,
    slug: 's2',
    epoch: 'e2',
    peerPubkey: 'cc'.repeat(32),
    encryptionKey: key
  })
  t.is(missing, null, 'reader returns null for empty core')

  // Wrong-shaped key (Buffer of wrong length).
  const shortKey = Buffer.alloc(16, 0)
  const bad = await readPrediction({
    store,
    slug: 's2',
    epoch: 'e2',
    peerPubkey: 'cc'.repeat(32),
    encryptionKey: shortKey
  })
  t.is(bad, null, 'reader rejects short key without throw')

  await cleanup()
})

test('F3: createSealedPrediction rejects malformed prediction shapes', async (t) => {
  const { store, cleanup } = await makeStore()
  const key = deriveSealKey({ slug: 's3', epoch: 'e3', hostSecret: HOST_SECRET })

  await t.exception.all(() => createSealedPrediction({
    store,
    slug: 's3',
    epoch: 'e3',
    peerPubkey: 'dd'.repeat(32),
    prediction: { winner: 'MAYBE' },
    encryptionKey: key
  }), 'bad winner rejected')

  await t.exception.all(() => createSealedPrediction({
    store,
    slug: 's3',
    epoch: 'e3',
    peerPubkey: 'dd'.repeat(32),
    prediction: { winner: 'HOME', homeGoals: 999 },
    encryptionKey: key
  }), 'out-of-range homeGoals rejected')

  await t.exception.all(() => createSealedPrediction({
    store,
    slug: 's3',
    epoch: 'e3',
    peerPubkey: 'dd'.repeat(32),
    prediction: { winner: 'HOME', notes: 'x'.repeat(_internalSealed.SEALED_TEXT_MAX + 10) },
    encryptionKey: key
  }), 'oversized payload rejected')

  await cleanup()
})

test('F3: revealPredictions emits a system:reveal shape carrying the key hex', async (t) => {
  const key = deriveSealKey({ slug: 'reveal-slug', epoch: '9', hostSecret: HOST_SECRET })

  const captured = []
  const fakeChat = {
    async sendSystem(msg) { captured.push(msg); return msg }
  }

  const msg = await revealPredictions({
    chat: fakeChat,
    slug: 'reveal-slug',
    epoch: 9,
    encryptionKey: key,
    myPubkey: 'ee'.repeat(32)
  })

  t.is(msg.type, 'system:reveal')
  t.is(msg.slug, 'reveal-slug')
  t.is(msg.epoch, '9')
  t.is(typeof msg.encryptionKeyHex, 'string')
  t.is(msg.encryptionKeyHex.length, 64, 'hex-encoded 32-byte key')
  t.is(msg.encryptionKeyHex, key.toString('hex'), 'hex round-trips to the same key')
})

test('F3: two peers seal independently; host-provided reveal decodes both', async (t) => {
  const { store, cleanup } = await makeStore()
  const slug = 'multi-peer'
  const epoch = 'ep-A'
  const key = deriveSealKey({ slug, epoch, hostSecret: HOST_SECRET })

  const peerA = 'aa'.repeat(32)
  const peerB = 'bb'.repeat(32)
  await createSealedPrediction({
    store, slug, epoch, peerPubkey: peerA,
    prediction: { winner: 'HOME', homeGoals: 3, awayGoals: 0 },
    encryptionKey: key
  })
  await createSealedPrediction({
    store, slug, epoch, peerPubkey: peerB,
    prediction: { winner: 'AWAY', homeGoals: 0, awayGoals: 2 },
    encryptionKey: key
  })

  // Anyone with the reveal key can decode both peers' entries.
  const revealed = await revealPredictions({
    chat: { async sendSystem(m) { return m } },
    slug, epoch, encryptionKey: key, myPubkey: 'host'
  })
  const rederived = Buffer.from(revealed.encryptionKeyHex, 'hex')

  const readA = await readPrediction({
    store, slug, epoch, peerPubkey: peerA, encryptionKey: rederived
  })
  const readB = await readPrediction({
    store, slug, epoch, peerPubkey: peerB, encryptionKey: rederived
  })
  t.is(readA.winner, 'HOME')
  t.is(readB.winner, 'AWAY')
  t.is(readA.homeGoals, 3)
  t.is(readB.awayGoals, 2)

  await cleanup()
})
