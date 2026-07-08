// Tests for bare/tacticalChannel.js
//
// Coverage:
//   - attachTacticalChannel creates a channel with correct protocol + id
//   - Every send helper reaches the underlying message .send()
//   - Non-host sendFreeze/sendUnfreeze are short-circuited (no wire traffic)
//   - Host-signed freeze/unfreeze fire onFreeze/onUnfreeze on the receive side
//   - Peer-forged freeze (senderPeerKey != host pubkey) is dropped
//   - Missing hostPubkeyRef.get() result drops host frames (fail-closed)
//   - Coordinate normalization roundtrip preserves [0..1] values
//   - close() is idempotent and destroys the channel
//   - resolveMuxer prefers a passed Protomux instance over stream resolution
//
// We use a FakeMuxer instead of a real corestore replicate pipeline so the
// test suite stays fast + hermetic. The fake exposes the same createChannel
// shape as protomux@3.11.0.

const test = require('brittle')
const b4a = require('b4a')

const {
  attachTacticalChannel,
  resolveMuxer,
  PROTOCOL
} = require('../bare/tacticalChannel.js')

// ---- fake muxer + channel --------------------------------------------------

function makeFakeMuxer({ returnNullOnCreate = false } = {}) {
  const created = []
  const mux = {
    // Duck-type recognized by resolveMuxer (via .isProtomux flag OR via the
    // Protomux.isProtomux static). We set the flag so the code path bypasses
    // the getProtocolMuxer lookup.
    isProtomux: true,
    createChannel(opts) {
      if (returnNullOnCreate) return null
      const messageSlots = []
      const channel = {
        opts,
        opened: false,
        closed: false,
        addMessage(msgOpts) {
          const msg = {
            opts: msgOpts,
            sentPayloads: [],
            send(payload) {
              this.sentPayloads.push(payload)
              return true
            },
            // Test hook: simulate the remote side delivering a frame.
            deliver(payload) {
              if (typeof msgOpts.onmessage === 'function') msgOpts.onmessage(payload)
            }
          }
          messageSlots.push(msg)
          return msg
        },
        open(handshake) {
          channel.opened = true
          channel.handshake = handshake
        },
        close() { channel.closed = true },
        messageSlots
      }
      created.push(channel)
      return channel
    }
  }
  return { mux, created }
}

function makeRoomTopic() {
  return b4a.alloc(32, 0x11)
}

function hostRef(hex) {
  return { get: () => hex }
}

// ---- tests -----------------------------------------------------------------

test('creates channel with protocol name and roomTopic as id', (t) => {
  const { mux, created } = makeFakeMuxer()
  const roomTopic = makeRoomTopic()
  const h = attachTacticalChannel(mux, {
    roomTopic,
    isHost: true,
    hostPubkeyRef: hostRef('aa'.repeat(32)),
    myPubkeyHex: 'aa'.repeat(32)
  })
  t.is(created.length, 1, 'one channel created')
  const ch = created[0]
  t.is(ch.opts.protocol, PROTOCOL, 'protocol is curva/tactical/1')
  t.is(ch.opts.protocol, 'curva/tactical/1', 'literal string match')
  t.ok(b4a.equals(ch.opts.id, roomTopic), 'id === roomTopic')
  t.is(ch.messageSlots.length, 5, 'five message slots: stroke, presence, typing, freeze, unfreeze')
  t.ok(ch.opened, 'channel.open() called')
  t.is(ch.handshake?.roomTopicHex, b4a.toString(roomTopic, 'hex'), 'handshake carries topic hex')
  t.is(ch.handshake?.peerKey, 'aa'.repeat(32), 'handshake carries myPubkeyHex')
  t.is(h.protocol, PROTOCOL, 'handle exposes PROTOCOL')
  h.close()
})

test('sendStroke broadcasts to the stroke message slot', (t) => {
  const { mux, created } = makeFakeMuxer()
  const h = attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: false,
    hostPubkeyRef: hostRef('bb'.repeat(32)),
    myPubkeyHex: 'cc'.repeat(32)
  })
  const ch = created[0]
  const strokeSlot = ch.messageSlots[0]
  t.ok(h.sendStroke({ strokeId: 'x', kind: 'freehand', points: [[0, 0], [0.5, 0.5]] }), 'send returns true')
  t.is(strokeSlot.sentPayloads.length, 1)
  t.is(strokeSlot.sentPayloads[0].strokeId, 'x')
  t.alike(strokeSlot.sentPayloads[0].points, [[0, 0], [0.5, 0.5]])
})

test('sendStroke onmessage handler receives inbound frame', (t) => {
  const { mux, created } = makeFakeMuxer()
  let received = null
  attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: false,
    hostPubkeyRef: hostRef('bb'.repeat(32)),
    myPubkeyHex: 'cc'.repeat(32),
    onStroke: (m) => { received = m }
  })
  const ch = created[0]
  ch.messageSlots[0].deliver({ strokeId: 'y', kind: 'arrow', points: [[0.1, 0.2], [0.9, 0.8]] })
  t.ok(received, 'onStroke invoked')
  t.is(received.strokeId, 'y')
  t.alike(received.points, [[0.1, 0.2], [0.9, 0.8]])
})

test('sendFreeze from non-host is silently dropped (no wire traffic)', (t) => {
  const { mux, created } = makeFakeMuxer()
  const h = attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: false,
    hostPubkeyRef: hostRef('bb'.repeat(32)),
    myPubkeyHex: 'cc'.repeat(32)
  })
  const ch = created[0]
  const freezeSlot = ch.messageSlots[3]
  t.absent(h.sendFreeze({ videoTsMs: 12345 }), 'sendFreeze returns false')
  t.absent(h.sendUnfreeze({ videoTsMs: 12345 }), 'sendUnfreeze returns false')
  t.is(freezeSlot.sentPayloads.length, 0, 'no freeze payload sent')
  t.is(ch.messageSlots[4].sentPayloads.length, 0, 'no unfreeze payload sent')
})

test('host-signed freeze stamps senderPeerKey on the outgoing frame', (t) => {
  const { mux, created } = makeFakeMuxer()
  const HOST = 'aa'.repeat(32)
  const h = attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: true,
    hostPubkeyRef: hostRef(HOST),
    myPubkeyHex: HOST
  })
  const ch = created[0]
  t.ok(h.sendFreeze({ videoTsMs: 4200 }))
  const sent = ch.messageSlots[3].sentPayloads[0]
  t.is(sent.senderPeerKey, HOST, 'outgoing senderPeerKey === host key')
  t.is(sent.videoTsMs, 4200)
})

test('receiver accepts host-signed freeze and rejects peer-forged freeze', (t) => {
  const { mux, created } = makeFakeMuxer()
  const HOST = 'aa'.repeat(32)
  const ATTACKER = 'ee'.repeat(32)
  let received = null
  attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: false,
    hostPubkeyRef: hostRef(HOST),
    myPubkeyHex: 'ff'.repeat(32),
    onFreeze: (m) => { received = m }
  })
  const freezeSlot = created[0].messageSlots[3]

  // Legit host frame is accepted.
  freezeSlot.deliver({ senderPeerKey: HOST, videoTsMs: 100 })
  t.ok(received, 'onFreeze fired for host-signed frame')
  t.is(received.videoTsMs, 100)

  // Peer-forged frame is dropped.
  received = null
  freezeSlot.deliver({ senderPeerKey: ATTACKER, videoTsMs: 200 })
  t.is(received, null, 'onFreeze NOT fired for attacker-signed frame')

  // Missing senderPeerKey is dropped.
  freezeSlot.deliver({ videoTsMs: 300 })
  t.is(received, null, 'onFreeze NOT fired for unsigned frame')
})

test('unfreeze also verifies senderPeerKey against host', (t) => {
  const { mux, created } = makeFakeMuxer()
  const HOST = 'aa'.repeat(32)
  let received = null
  attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: false,
    hostPubkeyRef: hostRef(HOST),
    myPubkeyHex: 'ff'.repeat(32),
    onUnfreeze: (m) => { received = m }
  })
  const unfreezeSlot = created[0].messageSlots[4]
  unfreezeSlot.deliver({ senderPeerKey: HOST, videoTsMs: 999 })
  t.ok(received)
  received = null
  unfreezeSlot.deliver({ senderPeerKey: 'ee'.repeat(32), videoTsMs: 1000 })
  t.is(received, null, 'peer-forged unfreeze dropped')
})

test('host key is compared case-insensitively', (t) => {
  const { mux, created } = makeFakeMuxer()
  let received = null
  attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: false,
    hostPubkeyRef: hostRef('AA'.repeat(32)), // upper case
    myPubkeyHex: 'ff'.repeat(32),
    onFreeze: (m) => { received = m }
  })
  const freezeSlot = created[0].messageSlots[3]
  freezeSlot.deliver({ senderPeerKey: 'aa'.repeat(32), videoTsMs: 1 }) // lower case
  t.ok(received, 'case mismatch does not cause false rejection')
})

test('host frames dropped when hostPubkeyRef.get() returns null (fail-closed)', (t) => {
  const { mux, created } = makeFakeMuxer()
  let received = null
  attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: false,
    hostPubkeyRef: { get: () => null }, // not yet known
    myPubkeyHex: 'ff'.repeat(32),
    onFreeze: (m) => { received = m }
  })
  const freezeSlot = created[0].messageSlots[3]
  freezeSlot.deliver({ senderPeerKey: 'aa'.repeat(32), videoTsMs: 1 })
  t.is(received, null, 'freeze dropped when host key unknown')
})

test('hostPubkeyRef.get is called lazily on each inbound frame', (t) => {
  const { mux, created } = makeFakeMuxer()
  let hostKey = null
  const ref = { get: () => hostKey }
  let received = null
  attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: false,
    hostPubkeyRef: ref,
    myPubkeyHex: 'ff'.repeat(32),
    onFreeze: (m) => { received = m }
  })
  const freezeSlot = created[0].messageSlots[3]
  // First frame: host not yet known.
  freezeSlot.deliver({ senderPeerKey: 'aa'.repeat(32), videoTsMs: 1 })
  t.is(received, null)
  // Host pubkey shows up (room-state replication catches up).
  hostKey = 'aa'.repeat(32)
  freezeSlot.deliver({ senderPeerKey: 'aa'.repeat(32), videoTsMs: 2 })
  t.ok(received, 'second frame accepted after ref returns key')
  t.is(received.videoTsMs, 2)
})

test('coordinate normalization roundtrip preserves [0..1] values', (t) => {
  const { mux, created } = makeFakeMuxer()
  let received = null
  attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: false,
    hostPubkeyRef: hostRef('aa'.repeat(32)),
    myPubkeyHex: 'ff'.repeat(32),
    onStroke: (m) => { received = m }
  })
  const strokeSlot = created[0].messageSlots[0]
  const points = [[0.0, 0.0], [0.25, 0.5], [0.9999, 0.0001], [1.0, 1.0]]
  strokeSlot.deliver({ strokeId: 'r', kind: 'freehand', points })
  t.ok(received)
  t.is(received.points.length, 4)
  for (let i = 0; i < points.length; i++) {
    t.is(received.points[i][0], points[i][0], 'x preserved at index ' + i)
    t.is(received.points[i][1], points[i][1], 'y preserved at index ' + i)
    t.ok(received.points[i][0] >= 0 && received.points[i][0] <= 1)
    t.ok(received.points[i][1] >= 0 && received.points[i][1] <= 1)
  }
})

test('close() destroys channel and is idempotent', (t) => {
  const { mux, created } = makeFakeMuxer()
  const h = attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: true,
    hostPubkeyRef: hostRef('aa'.repeat(32)),
    myPubkeyHex: 'aa'.repeat(32)
  })
  const ch = created[0]
  t.absent(ch.closed)
  h.close()
  t.ok(ch.closed, 'first close closes channel')
  h.close()
  t.ok(ch.closed, 'second close is a no-op')
})

test('duplicate channel (createChannel returns null) yields a no-op handle', (t) => {
  const { mux } = makeFakeMuxer({ returnNullOnCreate: true })
  const h = attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: true,
    hostPubkeyRef: hostRef('aa'.repeat(32)),
    myPubkeyHex: 'aa'.repeat(32)
  })
  t.is(h.channel, null, 'no channel handle')
  t.absent(h.sendStroke({ strokeId: 'x' }))
  t.absent(h.sendFreeze({ videoTsMs: 1 }))
  h.close() // must not throw
})

test('roomTopic must be a 32-byte buffer', async (t) => {
  const { mux } = makeFakeMuxer()
  await t.exception.all(() => attachTacticalChannel(mux, {
    roomTopic: b4a.alloc(16),
    isHost: true,
    hostPubkeyRef: hostRef('aa'.repeat(32)),
    myPubkeyHex: 'aa'.repeat(32)
  }), /32-byte/)
  await t.exception.all(() => attachTacticalChannel(mux, {
    roomTopic: 'not-a-buffer',
    isHost: true,
    hostPubkeyRef: hostRef('aa'.repeat(32)),
    myPubkeyHex: 'aa'.repeat(32)
  }), /32-byte/)
})

test('hostPubkeyRef is required', async (t) => {
  const { mux } = makeFakeMuxer()
  await t.exception.all(() => attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: true,
    myPubkeyHex: 'aa'.repeat(32)
  }), /hostPubkeyRef/)
})

test('resolveMuxer returns the same Protomux when given one', (t) => {
  const { mux } = makeFakeMuxer()
  const out = resolveMuxer(mux)
  t.is(out, mux, 'identity preserved for Protomux input')
})

test('resolveMuxer reads noiseStream.userData when given a stream', (t) => {
  const { mux } = makeFakeMuxer()
  const fakeStream = { noiseStream: { userData: mux } }
  // Do not set isProtomux flag on fakeStream so the code path falls through
  // to the noiseStream resolution.
  const out = resolveMuxer(fakeStream)
  t.is(out, mux, 'resolved via noiseStream.userData')
})

test('resolveMuxer throws when no muxer can be located', async (t) => {
  await t.exception.all(() => resolveMuxer({}), /noiseStream/)
  await t.exception.all(() => resolveMuxer(null), /required/)
})

test('sendStroke rejects non-object payloads', (t) => {
  const { mux } = makeFakeMuxer()
  const h = attachTacticalChannel(mux, {
    roomTopic: makeRoomTopic(),
    isHost: true,
    hostPubkeyRef: hostRef('aa'.repeat(32)),
    myPubkeyHex: 'aa'.repeat(32)
  })
  t.absent(h.sendStroke(null))
  t.absent(h.sendStroke(undefined))
  t.absent(h.sendPresence('string'))
  t.absent(h.sendTyping(42))
})
