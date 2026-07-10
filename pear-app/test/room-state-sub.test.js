// F2 Wave 3: hyperbee.sub() namespacing refactor for roomState.
//
// Covers:
//   1. openRoom exposes `roomStateSubs.{room, qvac, providers, presence}` and
//      each is a Hyperbee-shaped instance (has put/get/createReadStream).
//   2. Writes through the new call sites (handleWriterRequest path, invitation
//      seeds, host-tip-address, host-pubkey) land under the `room` sub prefix
//      and are readable via the sub's own get() calls.
//   3. Legacy top-level `room/*` keys already in the bee are lazily migrated
//      into the sub AND deleted from the legacy location on host open.
//   4. `readRoomKey(subKey)` falls through to legacy keys when the sub is
//      empty, preserving backwards compat with un-migrated bees.
//
// Docs consulted (2026-07-10):
//   * https://docs.pears.com/reference/building-blocks/hyperbee/#beesubprefix-options
//   * pear-app/node_modules/hyperbee/index.js:793 sub()

const test = require('brittle')
const { makeStore } = require('./_helpers.js')
const { openRoom } = require('../bare/room.js')

test('F2: openRoom exposes namespaced sub-bees', async (t) => {
  const { store, cleanup } = await makeStore()
  const room = await openRoom(store, {
    slug: 'sub-room-a',
    isHost: true,
    myPubkey: 'aa'.repeat(32)
  })

  t.ok(room.roomStateSubs, 'roomStateSubs surface exposed')
  for (const name of ['room', 'qvac', 'providers', 'presence']) {
    const sub = room.roomStateSubs[name]
    t.ok(sub, name + ' sub present')
    t.is(typeof sub.put, 'function', name + '.put callable')
    t.is(typeof sub.get, 'function', name + '.get callable')
    t.is(typeof sub.createReadStream, 'function', name + '.createReadStream callable')
  }

  await room.close()
  await cleanup()
})

test('F2: invitation seed writes land in the room sub', async (t) => {
  const { store, cleanup } = await makeStore()
  const room = await openRoom(store, {
    slug: 'sub-room-b',
    isHost: true,
    myPubkey: 'bb'.repeat(32)
  })

  // Force lazy seed generation by calling signMyWriterInvitations().
  await room.signMyWriterInvitations()

  const chatSeed = await room.roomStateSubs.room.get('invitation-seed/chat')
  const phSeed = await room.roomStateSubs.room.get('invitation-seed/playhead')
  t.ok(chatSeed, 'chat seed persisted in room sub')
  t.ok(phSeed, 'playhead seed persisted in room sub')
  t.is(typeof chatSeed.value.seedHex, 'string')
  t.is(chatSeed.value.seedHex.length, 64, 'seed is 32 bytes hex')

  await room.close()
  await cleanup()
})

test('F2: legacy top-level keys are migrated to the sub on host open', async (t) => {
  const { store, cleanup } = await makeStore()

  // Round 1: open a room and seed a legacy key directly through the raw
  // roomState (bypassing the sub) so we mimic a bee written by an older host.
  const first = await openRoom(store, {
    slug: 'sub-room-migrate',
    isHost: true,
    myPubkey: 'cc'.repeat(32)
  })
  const legacyHex = 'ff'.repeat(32)
  await first.roomState.put('room/writers/' + legacyHex, {
    base: 'chat',
    addedAt: Date.now(),
    invitedBy: 'legacy'
  })
  // Confirm the legacy key is present before migration.
  const preLegacy = await first.roomState.get('room/writers/' + legacyHex)
  t.ok(preLegacy, 'legacy key seeded')
  await first.close()

  // Round 2: reopen the same corestore-backed room. The lazy migration should
  // sweep the legacy key into the sub and remove the top-level entry.
  const second = await openRoom(store, {
    slug: 'sub-room-migrate',
    isHost: true,
    myPubkey: 'cc'.repeat(32)
  })
  // Await the migration task by giving the event loop a couple of ticks.
  await second.migrateLegacyRoomKeys()

  const postSub = await second.roomStateSubs.room.get('writers/' + legacyHex)
  t.ok(postSub, 'legacy key migrated into room sub')
  t.is(postSub.value.invitedBy, 'legacy', 'value preserved')

  const postLegacy = await second.roomState.get('room/writers/' + legacyHex)
  t.absent(postLegacy, 'legacy top-level key removed after migration')

  await second.close()
  await cleanup()
})

test('F2: readRoomKey falls through to legacy prefix when sub is empty', async (t) => {
  const { store, cleanup } = await makeStore()
  // Open as PEER (isHost=false) so migration does NOT run — this exercises
  // the read-through path a peer would traverse against a legacy host's bee.
  const room = await openRoom(store, {
    slug: 'sub-room-fallthrough',
    isHost: false,
    myPubkey: 'dd'.repeat(32)
  })

  // Seed a legacy value directly.
  await room.roomState.put('room/host-tip-address', {
    chainId: 11155111,
    smartAddress: '0x' + '1'.repeat(40),
    ownerAddress: '0x' + '2'.repeat(40),
    publishedAt: 1
  })

  const legacyRead = await room.readRoomKey('host-tip-address')
  t.ok(legacyRead, 'readRoomKey returns legacy entry')
  t.is(legacyRead.value.smartAddress, '0x' + '1'.repeat(40))

  // Now write a fresh sub entry and confirm read prefers the sub.
  await room.roomStateSubs.room.put('host-tip-address', {
    chainId: 11155111,
    smartAddress: '0x' + '9'.repeat(40),
    ownerAddress: '0x' + '8'.repeat(40),
    publishedAt: 2
  })
  const subRead = await room.readRoomKey('host-tip-address')
  t.is(subRead.value.smartAddress, '0x' + '9'.repeat(40), 'sub value wins over legacy')

  await room.close()
  await cleanup()
})

test('F2: sub-write only path — host-pubkey lands in sub AND legacy (double-write)', async (t) => {
  const { store, cleanup } = await makeStore()
  const room = await openRoom(store, {
    slug: 'sub-room-hostkey',
    isHost: true,
    myPubkey: 'ee'.repeat(32)
  })

  const subEntry = await room.roomStateSubs.room.get('host-pubkey')
  const legacyEntry = await room.roomState.get('room/host-pubkey')
  t.ok(subEntry, 'sub host-pubkey present')
  t.ok(legacyEntry, 'legacy host-pubkey preserved for pre-migration peers')
  t.is(subEntry.value.pubkeyHex, 'ee'.repeat(32))
  t.is(legacyEntry.value.pubkeyHex, 'ee'.repeat(32))

  await room.close()
  await cleanup()
})
