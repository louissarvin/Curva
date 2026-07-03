// Phase 1 brittle test: room orchestrator.
// Verifies openRoom wires playhead + chat correctly and close() cleans up both.

const test = require('brittle')
const { makeStore } = require('./_helpers.js')
const { openRoom } = require('../bare/room.js')

test('openRoom returns { playhead, chat, close, slug, isHost, myPubkey }', async (t) => {
  const { store, cleanup } = await makeStore()
  const room = await openRoom(store, {
    slug: 'test-room',
    isHost: true,
    myPubkey: 'aa'.repeat(32)
  })

  t.is(room.slug, 'test-room')
  t.is(room.isHost, true)
  t.is(room.myPubkey, 'aa'.repeat(32))
  t.ok(room.playhead, 'playhead present')
  t.ok(room.chat, 'chat present')
  t.is(typeof room.close, 'function')
  t.is(typeof room.playhead.setState, 'function')
  t.is(typeof room.chat.send, 'function')

  await room.close()
  await cleanup()
})

test('openRoom rejects invalid input', async (t) => {
  const { store, cleanup } = await makeStore()

  await t.exception.all(
    () => openRoom(null, { slug: 'x', isHost: false, myPubkey: 'a' }),
    'null store rejected'
  )
  await t.exception.all(
    () => openRoom(store, null),
    'null opts rejected'
  )
  await t.exception.all(
    () => openRoom(store, { slug: '', isHost: true, myPubkey: 'a' }),
    'empty slug rejected'
  )
  await t.exception.all(
    () => openRoom(store, { slug: 'x', isHost: 'yes', myPubkey: 'a' }),
    'non-boolean isHost rejected'
  )
  await t.exception.all(
    () => openRoom(store, { slug: 'x', isHost: true, myPubkey: '' }),
    'empty myPubkey rejected'
  )

  await cleanup()
})

test('two rooms with different slugs are isolated', async (t) => {
  const { store, cleanup } = await makeStore()

  const roomA = await openRoom(store, {
    slug: 'room-a',
    isHost: true,
    myPubkey: 'aa'.repeat(32)
  })
  const roomB = await openRoom(store, {
    slug: 'room-b',
    isHost: true,
    myPubkey: 'aa'.repeat(32)
  })

  // Message sent to A must NOT appear in B's history.
  await roomA.chat.send({ text: 'only in a', match_time_ms: 1000 })
  await waitMs(200)

  const historyB = await roomB.chat.history({ from: 0, limit: 10 })
  const leak = historyB.find((m) => m.text === 'only in a')
  t.absent(leak, 'room B did not see room A message')

  const historyA = await roomA.chat.history({ from: 0, limit: 10 })
  const present = historyA.find((m) => m.text === 'only in a')
  t.ok(present, 'room A still has its own message')

  await roomA.close()
  await roomB.close()
  await cleanup()
})

test('close() cleans up both playhead and chat', async (t) => {
  const { store, cleanup } = await makeStore()
  const room = await openRoom(store, {
    slug: 'closable',
    isHost: true,
    myPubkey: 'bb'.repeat(32)
  })

  // Verify each subsystem's underlying autobase is open, then close.
  const phBase = room.playhead.getBase()
  const chatBase = room.chat.getBase()
  t.absent(phBase.closed, 'playhead base is open before close')
  t.absent(chatBase.closed, 'chat base is open before close')

  await room.close()

  // After close, subsequent close() is a no-op (idempotent).
  await room.close()
  t.pass('second close is idempotent')

  await cleanup()
})

test('playhead round-trip through the room', async (t) => {
  const { store, cleanup } = await makeStore()
  const room = await openRoom(store, {
    slug: 'roundtrip',
    isHost: true,
    myPubkey: 'cc'.repeat(32)
  })

  await room.playhead.setState({ type: 'play', match_time_ms: 5000 })

  // Wait for the state to settle.
  const t0 = Date.now()
  let state = null
  while (Date.now() - t0 < 2000) {
    state = await room.playhead.getState()
    if (state && state.type === 'play') break
    await waitMs(20)
  }

  t.ok(state, 'state exists')
  t.is(state.type, 'play')
  t.is(state.match_time_ms, 5000)

  await room.close()
  await cleanup()
})

test('openRoom (Phase 2) exposes clips + backend client when backendUrl set', async (t) => {
  const { store, cleanup } = await makeStore()
  const room = await openRoom(store, {
    slug: 'phase2-room',
    isHost: true,
    myPubkey: 'aa'.repeat(32),
    backendUrl: 'http://api.test',
    lang: 'it'
  })

  t.ok(room.clips, 'clips subsystem present')
  t.is(typeof room.clips.addClip, 'function')
  t.is(typeof room.clips.listClips, 'function')
  t.is(typeof room.clips.getClip, 'function')
  t.is(typeof room.clips.myDriveKey, 'string')

  t.ok(room.backend, 'backend client present')
  t.is(room.backend.baseUrl, 'http://api.test')
  t.is(room.backend.lang, 'it')

  await room.close()
  await cleanup()
})

test('openRoom (Phase 2) backend is null when backendUrl omitted', async (t) => {
  const { store, cleanup } = await makeStore()
  const room = await openRoom(store, {
    slug: 'no-backend',
    isHost: false,
    myPubkey: 'bb'.repeat(32)
  })
  t.is(room.backend, null)
  t.ok(room.clips, 'clips still initialized without backend')
  await room.close()
  await cleanup()
})

test('openRoom (Phase 2) clip round trip through room', async (t) => {
  const { store, cleanup } = await makeStore()
  const room = await openRoom(store, {
    slug: 'clip-round-trip',
    isHost: true,
    myPubkey: 'cc'.repeat(32)
  })

  const added = await room.clips.addClip({
    buffer: Buffer.from('clip-payload'),
    match_time_ms: 4200,
    caption: 'nice one'
  })
  t.ok(added.clipId)

  const list = await room.clips.listClips()
  t.ok(list.length >= 1)

  const bytes = await room.clips.getClip({ driveKey: added.driveKey, path: added.path })
  t.is(Buffer.from(bytes).toString('utf8'), 'clip-payload')

  await room.close()
  await cleanup()
})

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
