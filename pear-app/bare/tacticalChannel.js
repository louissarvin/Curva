// Curva tactical drawing channel.
//
// Multiplexes an ephemeral drawing + presence + freeze/unfreeze protocol on
// top of the existing corestore replication stream via protomux. Strokes
// never enter Autobase or Hyperbee; they are pure P2P side traffic that
// vanishes when the frame unfreezes.
//
// Docs verified (2026-07-06). Sources:
//   https://docs.pears.com/reference/helpers/protomux/
//   https://github.com/holepunchto/protomux (installed 3.11.0)
//   pear-app/node_modules/hypercore/index.js:146 (getProtocolMuxer)
//   pear-app/node_modules/corestore/index.js (replicate returns Duplex,
//     with the Protomux attached at stream.noiseStream.userData)
//
// The single non-negotiable rule: this module NEVER double-wraps the
// replication stream. Given a Protomux-shaped `mux` argument we use it
// directly; given a stream, we resolve the existing muxer via
// `Hypercore.getProtocolMuxer(stream)` (or `Protomux.from(stream.noiseStream)`
// as a fallback because `Protomux.from` short-circuits when a muxer is
// already attached at `stream.userData`).
//
// Anti-pattern references (do NOT do any of these):
//   - `new Protomux(rawSocket)`         -> two muxers on one socket, replication breaks
//   - `new Protomux(replicateStream)`   -> wraps the outer Duplex, same failure
//   - `Protomux.from(replicateStream)`  -> outer Duplex is not the framed noiseStream

const Protomux = require('protomux')
const Hypercore = require('hypercore')
const c = require('compact-encoding')
const b4a = require('b4a')

const PROTOCOL = 'curva/tactical/1'

// compact-encoding does not ship a first-class JSON codec, so we build one on
// top of the utf8 string codec. This keeps the wire format human-debuggable
// during the demo and matches the spec's `cenc.json` intent. A future v2 of
// the protocol can swap this for a binary stroke encoding without breaking
// the handshake (which is guarded by the `curva/tactical/1` protocol name).
const jsonEnc = {
  preencode(state, value) {
    const str = JSON.stringify(value === undefined ? null : value)
    c.utf8.preencode(state, str)
  },
  encode(state, value) {
    const str = JSON.stringify(value === undefined ? null : value)
    c.utf8.encode(state, str)
  },
  decode(state) {
    const str = c.utf8.decode(state)
    if (str === '' || str == null) return null
    try { return JSON.parse(str) } catch { return null }
  }
}

/**
 * Resolve a stream (or already-muxed Protomux) to the shared Protomux
 * instance that corestore replication attaches to `noiseStream.userData`.
 * Never constructs a fresh muxer over an already-muxed socket.
 *
 * @param {object} streamOrMux
 * @returns {object} Protomux instance
 */
function resolveMuxer(streamOrMux) {
  if (!streamOrMux) throw new TypeError('mux required')
  // Already a Protomux? Return as-is.
  if (typeof Protomux.isProtomux === 'function' && Protomux.isProtomux(streamOrMux)) {
    return streamOrMux
  }
  if (streamOrMux.isProtomux === true) return streamOrMux

  // Stream shape. Preferred path: hypercore's documented helper.
  if (typeof Hypercore.getProtocolMuxer === 'function') {
    try {
      const mux = Hypercore.getProtocolMuxer(streamOrMux)
      if (mux) return mux
    } catch { /* fall through */ }
  }
  // Fallback: read noiseStream.userData directly.
  if (streamOrMux.noiseStream && streamOrMux.noiseStream.userData) {
    return streamOrMux.noiseStream.userData
  }
  // Last-resort: Protomux.from is idempotent when a muxer is already attached
  // to userData. If nothing is attached yet, this creates one on the
  // noiseStream (still the correct framing layer).
  if (streamOrMux.noiseStream) {
    return Protomux.from(streamOrMux.noiseStream)
  }
  throw new Error('cannot locate protomux (no noiseStream on argument)')
}

/**
 * Attach a tactical channel to an EXISTING Protomux instance (or a
 * replication stream from which the shared Protomux can be resolved).
 *
 * @param {object} mux                Protomux instance OR corestore replication stream
 * @param {{
 *   roomTopic: Buffer,               // 32-byte topic; channel id
 *   isHost: boolean,                 // this peer's role in the room
 *   hostPubkeyRef: { get: () => (Buffer|string|null) },
 *                                    // authoritative host pubkey lookup;
 *                                    // read lazily on every inbound freeze
 *                                    // so late-published host keys still
 *                                    // unblock verification.
 *   myPubkeyHex?: string,            // this peer's Hyperswarm identity (hex);
 *                                    // stamped into outbound freeze frames.
 *   onStroke?:   (msg) => void,
 *   onPresence?: (msg) => void,
 *   onTyping?:   (msg) => void,
 *   onFreeze?:   (msg) => void,      // only fires when senderPeerKey matches host
 *   onUnfreeze?: (msg) => void,
 *   log?: (level, msg, meta) => void
 * }} opts
 *
 * @returns {{
 *   sendStroke:   (payload) => boolean,
 *   sendPresence: (payload) => boolean,
 *   sendTyping:   (payload) => boolean,
 *   sendFreeze:   (payload) => boolean,   // no-op when isHost=false
 *   sendUnfreeze: (payload) => boolean,   // no-op when isHost=false
 *   close: () => void,
 *   channel: object,                       // for tests + diagnostics
 *   protocol: string
 * }}
 */
function attachTacticalChannel(mux, opts) {
  if (!mux) throw new TypeError('mux required')
  const {
    roomTopic,
    isHost,
    hostPubkeyRef,
    myPubkeyHex,
    onStroke, onPresence, onTyping, onFreeze, onUnfreeze,
    log
  } = opts || {}

  if (!b4a.isBuffer(roomTopic) || roomTopic.byteLength !== 32) {
    throw new RangeError('roomTopic must be a 32-byte Buffer')
  }
  if (typeof isHost !== 'boolean') throw new TypeError('isHost must be boolean')
  if (!hostPubkeyRef || typeof hostPubkeyRef.get !== 'function') {
    throw new TypeError('hostPubkeyRef.get() required')
  }

  const emit = (level, m, meta) => {
    if (typeof log === 'function') log(level, '[TacticalChannel] ' + m, meta || {})
  }

  const protomuxInstance = resolveMuxer(mux)

  const channel = protomuxInstance.createChannel({
    protocol: PROTOCOL,
    id: roomTopic,
    handshake: jsonEnc,
    onopen(handshake) {
      emit('info', 'channel opened', {
        peer: handshake && handshake.peerKey ? String(handshake.peerKey).slice(0, 8) : '?'
      })
    },
    onclose() { emit('info', 'channel closed') }
  })

  // createChannel returns null when the same protocol+id is already open on
  // this muxer (duplicate handshake race). Not fatal; return a no-op handle so
  // callers can uniformly track and later close().
  if (!channel) {
    emit('info', 'channel already open (duplicate) — returning no-op handle')
    return {
      sendStroke: () => false,
      sendPresence: () => false,
      sendTyping: () => false,
      sendFreeze: () => false,
      sendUnfreeze: () => false,
      close: () => {},
      channel: null,
      protocol: PROTOCOL
    }
  }

  // Message slots. Order matters for wire compat: keep this list stable
  // across releases. New messages append; existing ones never re-order.
  const mStroke = channel.addMessage({
    encoding: jsonEnc,
    onmessage(m) { if (m && typeof onStroke === 'function') onStroke(m) }
  })
  const mPresence = channel.addMessage({
    encoding: jsonEnc,
    onmessage(m) { if (m && typeof onPresence === 'function') onPresence(m) }
  })
  const mTyping = channel.addMessage({
    encoding: jsonEnc,
    onmessage(m) { if (m && typeof onTyping === 'function') onTyping(m) }
  })
  const mFreeze = channel.addMessage({
    encoding: jsonEnc,
    onmessage(m) { handleHostFrame('freeze', m, onFreeze) }
  })
  const mUnfreeze = channel.addMessage({
    encoding: jsonEnc,
    onmessage(m) { handleHostFrame('unfreeze', m, onUnfreeze) }
  })

  function normalizeHex(v) {
    if (v == null) return ''
    if (b4a.isBuffer(v)) return b4a.toString(v, 'hex').toLowerCase()
    if (typeof v === 'string') return v.toLowerCase()
    return ''
  }

  function handleHostFrame(kind, m, cb) {
    if (!m) return
    const senderHex = normalizeHex(m.senderPeerKey)
    if (!senderHex) {
      emit('warn', 'dropped ' + kind + ': missing senderPeerKey')
      return
    }
    let hostHex = ''
    try { hostHex = normalizeHex(hostPubkeyRef.get()) } catch { hostHex = '' }
    if (!hostHex) {
      // Host key not yet known on this peer (room-state replication still
      // catching up). Drop rather than accept a potentially forged frame.
      emit('warn', 'dropped ' + kind + ': host pubkey not yet known', {
        sender: senderHex.slice(0, 8)
      })
      return
    }
    if (senderHex !== hostHex) {
      emit('warn', 'rejected non-host ' + kind, {
        sender: senderHex.slice(0, 8),
        expected: hostHex.slice(0, 8)
      })
      return
    }
    if (typeof cb === 'function') cb(m)
  }

  // Open the channel with the handshake payload. Note: `channel.open` fires
  // BEFORE the remote side observes onopen; this send is what triggers the
  // remote's onopen callback.
  try {
    channel.open({
      roomTopicHex: b4a.toString(roomTopic, 'hex'),
      peerKey: typeof myPubkeyHex === 'string' ? myPubkeyHex : ''
    })
  } catch (err) {
    emit('warn', 'channel.open threw', { message: err?.message })
  }

  function sendStroke(payload) {
    if (!payload || typeof payload !== 'object') return false
    return !!mStroke.send(payload)
  }
  function sendPresence(payload) {
    if (!payload || typeof payload !== 'object') return false
    return !!mPresence.send(payload)
  }
  function sendTyping(payload) {
    if (!payload || typeof payload !== 'object') return false
    return !!mTyping.send(payload)
  }
  function sendFreeze(payload) {
    // Two layers of defense: (1) short-circuit locally so a non-host renderer
    // cannot even serialize the frame; (2) receivers still verify sender key.
    if (!isHost) return false
    if (!payload || typeof payload !== 'object') return false
    const stamped = { ...payload, senderPeerKey: myPubkeyHex || '' }
    return !!mFreeze.send(stamped)
  }
  function sendUnfreeze(payload) {
    if (!isHost) return false
    if (!payload || typeof payload !== 'object') return false
    const stamped = { ...payload, senderPeerKey: myPubkeyHex || '' }
    return !!mUnfreeze.send(stamped)
  }

  let closed = false
  function close() {
    if (closed) return
    closed = true
    try { channel.close() } catch { /* noop */ }
  }

  return {
    sendStroke, sendPresence, sendTyping,
    sendFreeze, sendUnfreeze,
    close,
    channel,
    protocol: PROTOCOL
  }
}

module.exports = {
  attachTacticalChannel,
  resolveMuxer,
  PROTOCOL,
  _internal: { jsonEnc }
}
