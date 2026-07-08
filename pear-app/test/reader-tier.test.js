// Spectator tier (Autopass-style read-only) brittle tests.
//
// Covers:
//   1. signInvitation carries `tier` in the signed v2 payload.
//   2. verifyInvitation accepts legacy (no-tier) invitations as writer.
//   3. Tier binding: a v2 reader invitation cannot be replayed as writer by
//      stripping the tier field.
//   4. chat.addReaderKey registers a denylist entry the apply reducer honors.
//   5. chat apply reducer drops non-system messages from denylisted writers.
//   6. system:reader-joined shape validator round-trip.
//   7. Non-host cannot forge system:reader-joined (host-only gate).
//   8. room.js signMyWriterInvitations({tier:'reader'}) throws FEATURE_DISABLED
//      when the flag is off, and works when it is on.
//   9. room.js handleWriterRequest reader branch persists tier-map and does
//      NOT add the peer to the writer roster.
//
// Ground truth: memory/impl_autopass_reader.md.

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { makeStore } = require('./_helpers.js')
const { openRoom } = require('../bare/room.js')
const { createChat, _internal: chatInternal } = require('../bare/chat.js')
const {
  signInvitation,
  verifyInvitation,
  verifyInvitationWithTier,
  _internal: invInternal
} = require('../bare/writerInvitation.js')

// -----------------------------------------------------------------------------
// Task 1: writerInvitation.js — tier in the signed payload
// -----------------------------------------------------------------------------

test('signInvitation with tier reader emits v2 payload carrying tier field', (t) => {
  const kp = crypto.keyPair(crypto.randomBytes(32))
  const inv = signInvitation(kp, undefined, { tier: 'reader' })
  t.is(inv.tier, 'reader', 'tier field present')
  t.is(inv.pubkey, b4a.toString(kp.publicKey, 'hex').toLowerCase())
  t.is(inv.sig.length, 128)
  t.ok(verifyInvitation(inv), 'sig verifies (boolean gate)')
  const withTier = verifyInvitationWithTier(inv)
  t.ok(withTier.ok)
  t.is(withTier.tier, 'reader')
})

test('signInvitation with tier writer emits v2 payload carrying tier field', (t) => {
  const kp = crypto.keyPair(crypto.randomBytes(32))
  const inv = signInvitation(kp, undefined, { tier: 'writer' })
  t.is(inv.tier, 'writer')
  const withTier = verifyInvitationWithTier(inv)
  t.ok(withTier.ok)
  t.is(withTier.tier, 'writer')
})

test('signInvitation with no tier opt emits legacy v1 payload (no tier field)', (t) => {
  const kp = crypto.keyPair(crypto.randomBytes(32))
  const inv = signInvitation(kp)
  t.is(inv.tier, undefined, 'legacy payload does not carry tier field')
  t.ok(verifyInvitation(inv))
  const withTier = verifyInvitationWithTier(inv)
  t.ok(withTier.ok)
  t.is(withTier.tier, 'writer', 'legacy defaults to writer')
})

test('signInvitation rejects invalid tier values', (t) => {
  const kp = crypto.keyPair(crypto.randomBytes(32))
  let threwOnAdmin = false
  try { signInvitation(kp, undefined, { tier: 'admin' }) } catch { threwOnAdmin = true }
  t.ok(threwOnAdmin, "tier: 'admin' rejected")
  let threwOnNumber = false
  try { signInvitation(kp, undefined, { tier: 42 }) } catch { threwOnNumber = true }
  t.ok(threwOnNumber, 'tier: 42 rejected')
})

test('verifyInvitation refuses to downgrade a v2 reader payload to writer', (t) => {
  // Attacker takes a legitimate reader-tier invitation, strips the `tier`
  // field, and re-submits. The signature was minted over v2 canonical bytes
  // that bind tier=reader, so it cannot verify against v1 bytes.
  const kp = crypto.keyPair(crypto.randomBytes(32))
  const readerInv = signInvitation(kp, undefined, { tier: 'reader' })
  const stripped = { pubkey: readerInv.pubkey, sig: readerInv.sig, timestamp: readerInv.timestamp }
  t.absent(verifyInvitation(stripped), 'stripped payload does not verify against v1 bytes')

  // Attacker relabels the tier to `writer` while keeping the reader sig.
  const relabeled = { ...readerInv, tier: 'writer' }
  t.absent(verifyInvitation(relabeled), 'sig does not verify against writer-tier bytes')
})

test('verifyInvitationWithTier returns {ok:false,tier:null} on malformed input', (t) => {
  t.alike(verifyInvitationWithTier(null), { ok: false, tier: null })
  t.alike(verifyInvitationWithTier({}), { ok: false, tier: null })
  t.alike(verifyInvitationWithTier({ pubkey: 'zz' }), { ok: false, tier: null })
})

test('verifyInvitationWithTier rejects unknown tier values in the payload', (t) => {
  const kp = crypto.keyPair(crypto.randomBytes(32))
  const inv = signInvitation(kp, undefined, { tier: 'reader' })
  const bad = { ...inv, tier: 'admin' }
  t.alike(verifyInvitationWithTier(bad), { ok: false, tier: null })
})

test('encode/decodeInvitationForUrl round-trips the tier field', (t) => {
  const { encodeInvitationForUrl, decodeInvitationFromUrl } = require('../bare/writerInvitation.js')
  const kp = crypto.keyPair(crypto.randomBytes(32))
  const inv = signInvitation(kp, undefined, { tier: 'reader' })
  const token = encodeInvitationForUrl(inv)
  const restored = decodeInvitationFromUrl(token)
  t.is(restored.pubkey, inv.pubkey)
  t.is(restored.sig, inv.sig)
  t.is(restored.timestamp, inv.timestamp)
  t.is(restored.tier, 'reader')
  t.ok(verifyInvitation(restored), 'decoded payload still verifies')
})

test('encode/decodeInvitationForUrl legacy payload has no tier field on restore', (t) => {
  const { encodeInvitationForUrl, decodeInvitationFromUrl } = require('../bare/writerInvitation.js')
  const kp = crypto.keyPair(crypto.randomBytes(32))
  const inv = signInvitation(kp)
  const restored = decodeInvitationFromUrl(encodeInvitationForUrl(inv))
  t.is(restored.tier, undefined, 'legacy round-trip stays legacy')
})

// -----------------------------------------------------------------------------
// Task 3: chat.js reader denylist ingress
// -----------------------------------------------------------------------------

test('chat.addReaderKey/removeReaderKey/isReaderKey maintain the Set', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'aa'.repeat(32) })
  const hex = 'bb'.repeat(32)
  t.absent(c.isReaderKey(hex), 'not-yet-added key is not on denylist')
  c.addReaderKey(hex)
  t.ok(c.isReaderKey(hex), 'added key is on denylist')
  t.ok(c.isReaderKey(hex.toUpperCase()), 'lookup is case-insensitive')
  c.removeReaderKey(hex)
  t.absent(c.isReaderKey(hex), 'removed key is off denylist')
  await c.close()
  await cleanup()
})

test('chat.addReaderKey ignores empty/non-string input', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'aa'.repeat(32) })
  c.addReaderKey('')
  c.addReaderKey(null)
  c.addReaderKey(undefined)
  c.addReaderKey(42)
  t.absent(c.isReaderKey(''))
  await c.close()
  await cleanup()
})

test('apply reducer drops non-system messages from a denylisted writer', async (t) => {
  // A locally-appended message goes through apply() with node.from.key equal
  // to the local writer core key. If we add our own writer hex to the reader
  // denylist BEFORE the append, the reducer must silently drop the message so
  // it never reaches the Hyperbee view.
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'aa'.repeat(32) })
  const myWriterHex = c.getWriterKey()
  t.ok(typeof myWriterHex === 'string' && myWriterHex.length === 64,
    'writer key ready before we add ourselves as reader')

  c.addReaderKey(myWriterHex)

  await c.send({ text: 'this should be dropped', match_time_ms: 1000 })
  // Give autobase a moment to run the apply reducer.
  await new Promise((r) => setTimeout(r, 100))

  const rows = await c.history({ from: 0, limit: 50 })
  const found = rows.find((m) => m && m.text === 'this should be dropped')
  t.absent(found, 'reader-tier append is not persisted to the chat view')

  await c.close()
  await cleanup()
})

test('apply reducer still admits messages after reader denylist entry is removed', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'aa'.repeat(32) })
  const myWriterHex = c.getWriterKey()
  c.addReaderKey(myWriterHex)
  c.removeReaderKey(myWriterHex)

  await c.send({ text: 'admitted after removal', match_time_ms: 2000 })
  await new Promise((r) => setTimeout(r, 100))

  const rows = await c.history({ from: 0, limit: 50 })
  const found = rows.find((m) => m && m.text === 'admitted after removal')
  t.ok(found, 'message is persisted once we lift the denylist')

  await c.close()
  await cleanup()
})

// -----------------------------------------------------------------------------
// Shape validator for system:reader-joined
// -----------------------------------------------------------------------------

test('isValidSystemReaderJoined accepts a well-formed payload', (t) => {
  const ok = {
    type: 'system:reader-joined',
    by_peer: 'aa'.repeat(32),
    wall_clock_ms: Date.now(),
    match_time_ms: 0,
    readerHex: 'bb'.repeat(32)
  }
  t.ok(chatInternal.isValidSystemReaderJoined(ok))
  t.ok(chatInternal.isValidMessage(ok), 'isValidMessage delegates to the shape validator')
})

test('isValidSystemReaderJoined rejects bad shapes', (t) => {
  const base = {
    type: 'system:reader-joined',
    by_peer: 'aa'.repeat(32),
    wall_clock_ms: Date.now(),
    match_time_ms: 0,
    readerHex: 'bb'.repeat(32)
  }
  t.absent(chatInternal.isValidSystemReaderJoined(null))
  t.absent(chatInternal.isValidSystemReaderJoined({ ...base, type: 'msg' }))
  t.absent(chatInternal.isValidSystemReaderJoined({ ...base, by_peer: '' }))
  t.absent(chatInternal.isValidSystemReaderJoined({ ...base, wall_clock_ms: -1 }))
  t.absent(chatInternal.isValidSystemReaderJoined({ ...base, match_time_ms: 'now' }))
  t.absent(chatInternal.isValidSystemReaderJoined({ ...base, readerHex: 'zz' }))
  t.absent(chatInternal.isValidSystemReaderJoined({ ...base, readerHex: 'AA'.repeat(32) }),
    'uppercase hex rejected; readerHex is normalized to lowercase')
})

// -----------------------------------------------------------------------------
// Task 4 / Task 2: room.js signMyWriterInvitations tier + feature flag
// -----------------------------------------------------------------------------

test('signMyWriterInvitations({tier:reader}) throws FEATURE_DISABLED when flag off', async (t) => {
  const previous = process.env.CURVA_SPECTATOR_TIER_ENABLED
  delete process.env.CURVA_SPECTATOR_TIER_ENABLED
  const { store, cleanup } = await makeStore()
  const room = await openRoom(store, {
    slug: 'reader-tier-off', isHost: false, myPubkey: 'aa'.repeat(32)
  })
  try {
    await room.signMyWriterInvitations({ tier: 'reader' })
    t.fail('expected FEATURE_DISABLED')
  } catch (err) {
    t.is(err.code, 'FEATURE_DISABLED')
  }
  await room.close()
  await cleanup()
  if (previous !== undefined) process.env.CURVA_SPECTATOR_TIER_ENABLED = previous
})

test('signMyWriterInvitations({tier:reader}) emits tier-bound payload when flag on', async (t) => {
  const previous = process.env.CURVA_SPECTATOR_TIER_ENABLED
  process.env.CURVA_SPECTATOR_TIER_ENABLED = 'true'
  const { store, cleanup } = await makeStore()
  const room = await openRoom(store, {
    slug: 'reader-tier-on', isHost: false, myPubkey: 'aa'.repeat(32)
  })
  const payload = await room.signMyWriterInvitations({ tier: 'reader' })
  t.is(payload.tier, 'reader')
  t.is(payload.chat.tier, 'reader')
  t.is(payload.playhead.tier, 'reader')
  const chatVer = verifyInvitationWithTier(payload.chat)
  const phVer = verifyInvitationWithTier(payload.playhead)
  t.ok(chatVer.ok)
  t.is(chatVer.tier, 'reader')
  t.ok(phVer.ok)
  t.is(phVer.tier, 'reader')
  await room.close()
  await cleanup()
  if (previous === undefined) delete process.env.CURVA_SPECTATOR_TIER_ENABLED
  else process.env.CURVA_SPECTATOR_TIER_ENABLED = previous
})

test('signMyWriterInvitations() with no tier opt keeps legacy shape', async (t) => {
  const previous = process.env.CURVA_SPECTATOR_TIER_ENABLED
  process.env.CURVA_SPECTATOR_TIER_ENABLED = 'true'
  const { store, cleanup } = await makeStore()
  const room = await openRoom(store, {
    slug: 'reader-tier-legacy', isHost: false, myPubkey: 'aa'.repeat(32)
  })
  const payload = await room.signMyWriterInvitations()
  t.is(payload.tier, undefined, 'no tier field on the container')
  t.is(payload.chat.tier, undefined, 'no tier field on the chat invitation')
  t.is(payload.playhead.tier, undefined, 'no tier field on the playhead invitation')
  await room.close()
  await cleanup()
  if (previous === undefined) delete process.env.CURVA_SPECTATOR_TIER_ENABLED
  else process.env.CURVA_SPECTATOR_TIER_ENABLED = previous
})

// -----------------------------------------------------------------------------
// Task 2: room.js handleWriterRequest reader branch
// -----------------------------------------------------------------------------

test('handleWriterRequest reader branch persists tier-map, skips writer roster', async (t) => {
  const previous = process.env.CURVA_SPECTATOR_TIER_ENABLED
  process.env.CURVA_SPECTATOR_TIER_ENABLED = 'true'
  const { store: hostStore, cleanup: cleanupHost } = await makeStore()
  const { store: peerStore, cleanup: cleanupPeer } = await makeStore()

  const host = await openRoom(hostStore, { slug: 'rd-branch', isHost: true, myPubkey: 'aa'.repeat(32) })
  const peer = await openRoom(peerStore, { slug: 'rd-branch', isHost: false, myPubkey: 'bb'.repeat(32) })

  const payload = await peer.signMyWriterInvitations({ tier: 'reader' })
  const res = await host.handleWriterRequest(payload, 'cc'.repeat(32))

  t.ok(res.ok, 'reader promotion ok')
  t.is(res.tier, 'reader')
  t.alike(res.bases, ['chat', 'playhead'])

  const roster = host.getWriterRoster()
  t.absent(roster.has(payload.chat.pubkey), 'reader is NOT on the writer roster')
  t.absent(roster.has(payload.playhead.pubkey))

  const tierEntry = await host.roomState.get('room/tier-map/' + payload.chat.pubkey)
  t.ok(tierEntry, 'tier-map entry persisted')
  t.is(tierEntry.value.tier, 'reader')
  t.is(tierEntry.value.base, 'chat')
  t.is(tierEntry.value.invitedBy, 'aa'.repeat(32))

  // room/writers/<hex> must NOT be present for a reader.
  const writerEntry = await host.roomState.get('room/writers/' + payload.chat.pubkey)
  t.absent(writerEntry, 'reader key is NOT in room/writers/*')

  await host.close()
  await peer.close()
  await cleanupHost()
  await cleanupPeer()
  if (previous === undefined) delete process.env.CURVA_SPECTATOR_TIER_ENABLED
  else process.env.CURVA_SPECTATOR_TIER_ENABLED = previous
})

test('handleWriterRequest rejects a mismatched tier pair when flag is on', async (t) => {
  const previous = process.env.CURVA_SPECTATOR_TIER_ENABLED
  process.env.CURVA_SPECTATOR_TIER_ENABLED = 'true'
  const { store, cleanup } = await makeStore()
  const host = await openRoom(store, { slug: 'rd-mismatch', isHost: true, myPubkey: 'aa'.repeat(32) })
  const kp1 = crypto.keyPair(crypto.randomBytes(32))
  const kp2 = crypto.keyPair(crypto.randomBytes(32))
  const payload = {
    chat: signInvitation(kp1, undefined, { tier: 'reader' }),
    playhead: signInvitation(kp2, undefined, { tier: 'writer' })
  }
  const res = await host.handleWriterRequest(payload, 'cc'.repeat(32))
  t.absent(res.ok)
  t.is(res.reason, 'tier-mismatch')
  await host.close()
  await cleanup()
  if (previous === undefined) delete process.env.CURVA_SPECTATOR_TIER_ENABLED
  else process.env.CURVA_SPECTATOR_TIER_ENABLED = previous
})

test('handleWriterRequest with flag off treats tier=reader payload as writer', async (t) => {
  // A partial rollout (peer upgraded, host not) must not accidentally admit a
  // reader as writer with side-effect of skipping the addWriter Autobase call.
  // With the flag OFF the host forces tier back to writer and follows the
  // original happy path. The peer-side signInvitation of course cannot mint a
  // v2 reader payload when the flag is off (that raises FEATURE_DISABLED), so
  // to simulate a rogue payload we build one directly.
  const previous = process.env.CURVA_SPECTATOR_TIER_ENABLED
  delete process.env.CURVA_SPECTATOR_TIER_ENABLED
  const { store, cleanup } = await makeStore()
  const host = await openRoom(store, { slug: 'rd-flag-off', isHost: true, myPubkey: 'aa'.repeat(32) })

  const kp = crypto.keyPair(crypto.randomBytes(32))
  const payload = {
    chat: signInvitation(kp, undefined, { tier: 'reader' }),
    playhead: signInvitation(kp, undefined, { tier: 'reader' })
  }
  const res = await host.handleWriterRequest(payload, 'dd'.repeat(32))
  t.ok(res.ok)
  t.is(res.tier, 'writer', 'flag off forces writer path')
  t.ok(host.getWriterRoster().has(payload.chat.pubkey), 'peer went through writer path')

  await host.close()
  await cleanup()
  if (previous !== undefined) process.env.CURVA_SPECTATOR_TIER_ENABLED = previous
})

// -----------------------------------------------------------------------------
// Task 5: system:reader-joined authorship gate is host-only
// -----------------------------------------------------------------------------

test('system:reader-joined authorship gate uses the shared host-system check', (t) => {
  // Non-host writers must fail the host-only check. The check function itself
  // is exported for direct unit assertion so we do not need to boot Autobase
  // to exercise the negative case. Same pattern as the wave-8A anti-spoof
  // tip-ack test in writer-invitation.test.js:301.
  const hostWriter = 'aa'.repeat(32)
  const nonHost = 'bb'.repeat(32)
  t.ok(chatInternal.checkHostSystemAuthorship(hostWriter, hostWriter),
    'host writer allowed to author system:reader-joined')
  t.absent(chatInternal.checkHostSystemAuthorship(nonHost, hostWriter),
    'non-host writer blocked from forging system:reader-joined')
})

// -----------------------------------------------------------------------------
// Backward-compat: legacy invitations without tier default to writer
// -----------------------------------------------------------------------------

test('backward-compat: legacy invitation payload is admitted as writer', async (t) => {
  const previous = process.env.CURVA_SPECTATOR_TIER_ENABLED
  process.env.CURVA_SPECTATOR_TIER_ENABLED = 'true'
  const { store: hostStore, cleanup: cleanupHost } = await makeStore()
  const { store: peerStore, cleanup: cleanupPeer } = await makeStore()
  const host = await openRoom(hostStore, { slug: 'rd-legacy', isHost: true, myPubkey: 'aa'.repeat(32) })
  const peer = await openRoom(peerStore, { slug: 'rd-legacy', isHost: false, myPubkey: 'bb'.repeat(32) })

  // No tier option: legacy shape.
  const payload = await peer.signMyWriterInvitations()
  t.is(payload.chat.tier, undefined, 'legacy shape confirmed')

  const res = await host.handleWriterRequest(payload, 'cc'.repeat(32))
  t.ok(res.ok)
  t.is(res.tier, 'writer', 'legacy defaults to writer per verifyInvitationWithTier')
  t.ok(host.getWriterRoster().has(payload.chat.pubkey))

  await host.close()
  await peer.close()
  await cleanupHost()
  await cleanupPeer()
  if (previous === undefined) delete process.env.CURVA_SPECTATOR_TIER_ENABLED
  else process.env.CURVA_SPECTATOR_TIER_ENABLED = previous
})

// -----------------------------------------------------------------------------
// Upgrade path: reader promoted to writer clears the denylist entry
// -----------------------------------------------------------------------------

test('reader-to-writer upgrade clears the chat reader denylist', async (t) => {
  const previous = process.env.CURVA_SPECTATOR_TIER_ENABLED
  process.env.CURVA_SPECTATOR_TIER_ENABLED = 'true'
  const { store: hostStore, cleanup: cleanupHost } = await makeStore()
  const { store: peerStore, cleanup: cleanupPeer } = await makeStore()
  const host = await openRoom(hostStore, { slug: 'rd-upgrade', isHost: true, myPubkey: 'aa'.repeat(32) })
  const peer = await openRoom(peerStore, { slug: 'rd-upgrade', isHost: false, myPubkey: 'bb'.repeat(32) })

  const readerPayload = await peer.signMyWriterInvitations({ tier: 'reader' })
  const readerRes = await host.handleWriterRequest(readerPayload, 'cc'.repeat(32))
  t.ok(readerRes.ok)
  t.ok(host.chat.isReaderKey(readerPayload.chat.pubkey), 'chat denylist populated')

  // Same peer signs a writer-tier invitation. The chat writer-key hex is the
  // SAME as the reader payload (the seed is per-peer, not per-tier), so the
  // upgrade must strip the denylist entry rather than leave stale state.
  const writerPayload = await peer.signMyWriterInvitations({ tier: 'writer' })
  const writerRes = await host.handleWriterRequest(writerPayload, 'cc'.repeat(32))
  t.ok(writerRes.ok)
  t.is(writerRes.tier, 'writer')
  t.absent(host.chat.isReaderKey(writerPayload.chat.pubkey),
    'denylist entry cleared on writer promotion')

  await host.close()
  await peer.close()
  await cleanupHost()
  await cleanupPeer()
  if (previous === undefined) delete process.env.CURVA_SPECTATOR_TIER_ENABLED
  else process.env.CURVA_SPECTATOR_TIER_ENABLED = previous
})
