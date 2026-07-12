// Curva preload - the only surface the renderer sees.
// contextBridge isolates the renderer from Node/Electron globals.
// Every method here MUST validate inputs at the boundary before hitting IPC.

const { contextBridge, ipcRenderer } = require('electron')

// qrcode: generate a PNG data URL from a text string in the preload
// (Node) context. Verified against qrcode@1.5.4 (soldair/node-qrcode).
// Kept in preload so the renderer never needs to require CommonJS modules.
let qrcodeMod = null
try { qrcodeMod = require('qrcode') } catch { /* optional */ }

// Wave 8B T3: topic derivation in preload so the renderer can batch peer-count
// lookups without duplicating BLAKE2 in-browser. Uses the exact same
// topicForSlug helper as the Bare worker so hashes match on the wire.
let topicMod = null
try { topicMod = require('../bare/topics.js') } catch { /* optional; renderer degrades */ }
function topicHexForSlug(slug) {
  if (!topicMod || typeof slug !== 'string' || slug.length === 0 || slug.length > 64) return null
  try {
    const buf = topicMod.topicForSlug(slug)
    return Buffer.from(buf).toString('hex')
  } catch { return null }
}
async function toQrDataUrl(text, opts) {
  if (!qrcodeMod) throw new Error('qrcode module unavailable')
  if (typeof text !== 'string' || text.length === 0 || text.length > 1024) {
    throw new RangeError('QR text must be 1-1024 chars')
  }
  return qrcodeMod.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
    ...(opts || {})
  })
}

function toBuffer(data) {
  if (data === null || data === undefined || typeof data === 'number') return data
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

// Framing helper for renderer -> worker messages.
// The worker side is already framed by FramedStream; on this side we send
// the JSON string as a Buffer and FramedStream (in electron/main.js) frames it.
function encodeMessage(message) {
  if (message === null || message === undefined) {
    throw new Error('bridge: message must not be null/undefined')
  }
  if (typeof message === 'string') return Buffer.from(message, 'utf8')
  if (message instanceof Uint8Array) return Buffer.from(message)
  // Objects are JSON-encoded. FramedStream handles length-prefix; the worker
  // decodes with JSON.parse.
  return Buffer.from(JSON.stringify(message), 'utf8')
}

const MAIN_WORKER = '/workers/main.js'
const decoder = new TextDecoder('utf-8')

// nanoid-lite: 21-char base62. Enough entropy for IPC correlation.
function makeId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  const buf = new Uint8Array(21)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(buf)
  else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256)
  for (let i = 0; i < buf.length; i++) out += chars[buf[i] % chars.length]
  return out
}

function writeMain(cmd, payload) {
  const message = { id: makeId(), cmd, payload: payload || {} }
  return ipcRenderer.invoke(
    'pear:worker:writeIPC:' + MAIN_WORKER,
    Buffer.from(JSON.stringify(message), 'utf8')
  )
}

// Correlated request/response over the worker IPC stream. The worker emits
// events with a `requestId` field that echoes the id we sent; we match on
// that to resolve the pending promise. This is what makes translate:text
// actually return the translated string to the caller instead of the raw
// pipe.write boolean that ipcMain.handle otherwise resolves with.
//
// Every entry has a 30 s watchdog so a hung worker cannot pin memory
// forever. Timed-out entries reject with a REQUEST_TIMEOUT error.
const pendingRequests = new Map()
const REQUEST_TIMEOUT_MS = 30_000
function installMainWorkerAckDispatcher() {
  const wrap = (_evt, data) => {
    let msg
    try {
      const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      msg = JSON.parse(decoder.decode(buf))
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const reqId = msg?.payload?.requestId
    if (typeof reqId !== 'string') return
    const entry = pendingRequests.get(reqId)
    if (!entry) return
    pendingRequests.delete(reqId)
    if (entry.timer) clearTimeout(entry.timer)
    if (msg.event === 'error' && msg.payload?.originalRequestId === reqId) {
      entry.reject(new Error(msg.payload?.message || 'worker error'))
    } else {
      entry.resolve(msg.payload)
    }
  }
  ipcRenderer.on('pear:worker:ipc:' + MAIN_WORKER, wrap)
}
installMainWorkerAckDispatcher()

// Per-command timeout overrides. Some SDK verbs (VLM caption, OCR read) can
// take minutes on first-load because SmolVLM2 500MB and OCR_LATIN 15MB have
// to download + validate + load before the first inference runs. The default
// 30 s budget is only right for lightweight IPC. Keep this list small and
// scoped so a stuck worker still gets caught by the default watchdog.
const LONG_TIMEOUT_CMDS = new Set([
  'vlm:caption',    // SmolVLM2 first-load ~4 min then <2 s per subsequent call
  'ocr:read',       // OCR_LATIN + OCR_CRAFT first-load ~30 s, then <500 ms
  'voice:enroll',   // Chatterbox voice-clone reference save + Hyperblob write
  'model:load',     // any explicit model load
  'match:recap',    // 7-cap orchestration budget
  'diagnostics:report' // gathers Prometheus + registry snapshots
])
const LONG_TIMEOUT_MS = 5 * 60_000  // 5 min

function writeMainAwait(cmd, payload) {
  const id = makeId()
  const message = { id, cmd, payload: payload || {} }
  const timeoutMs = LONG_TIMEOUT_CMDS.has(cmd) ? LONG_TIMEOUT_MS : REQUEST_TIMEOUT_MS
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id)
        const err = new Error(`worker request timed out: ${cmd}`)
        err.code = 'REQUEST_TIMEOUT'
        reject(err)
      }
    }, timeoutMs)
    pendingRequests.set(id, { resolve, reject, timer })
  })
  // Fire and forget the invoke; we resolve via the correlated event.
  ipcRenderer.invoke(
    'pear:worker:writeIPC:' + MAIN_WORKER,
    Buffer.from(JSON.stringify(message), 'utf8')
  ).catch((err) => {
    const entry = pendingRequests.get(id)
    if (!entry) return
    pendingRequests.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    entry.reject(err)
  })
  return p
}

// Register a filtered subscription against the worker IPC stream. Returns an
// unsubscribe function.
function onEvent(eventName, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('callback must be a function')
  }
  const wrap = (_evt, data) => {
    let msg
    try {
      const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      msg = JSON.parse(decoder.decode(buf))
    } catch {
      return
    }
    if (msg?.event !== eventName) return
    callback(msg.payload)
  }
  ipcRenderer.on('pear:worker:ipc:' + MAIN_WORKER, wrap)
  return () => ipcRenderer.removeListener('pear:worker:ipc:' + MAIN_WORKER, wrap)
}

// Base64 conversion at the preload boundary. Renderer sends Blob/ArrayBuffer,
// Bare worker expects base64 string on the JSON wire.
function toBase64(input) {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return input
  let bytes
  if (input instanceof ArrayBuffer) bytes = new Uint8Array(input)
  else if (input instanceof Uint8Array) bytes = input
  else if (Buffer.isBuffer(input)) bytes = input
  else throw new TypeError('unsupported buffer type')
  return Buffer.from(bytes).toString('base64')
}

function fromBase64(str) {
  if (typeof str !== 'string') return new ArrayBuffer(0)
  const buf = Buffer.from(str, 'base64')
  // Return a proper ArrayBuffer for renderer consumption.
  const arr = new Uint8Array(buf.length)
  arr.set(buf)
  return arr.buffer
}

// -- pear.assets branding pack ---
// Preload-side cache of the last-known branding snapshot. Populated by the
// `assets:branding` IPC event from workers/main.js. Kept in preload (not the
// renderer window) so that reads survive renderer reloads within the same
// preload lifetime.
const brandingCache = { path: null, bytes: null }
;(function subscribeBrandingCache() {
  try {
    onEvent('assets:branding', (payload) => {
      if (!payload || typeof payload !== 'object') return
      brandingCache.path = (typeof payload.path === 'string' && payload.path.length > 0)
        ? payload.path
        : null
      brandingCache.bytes = (typeof payload.bytes === 'number') ? payload.bytes : null
    })
  } catch { /* noop; if subscription fails, getBrandingPath() stays null */ }
})()
// -- end pear.assets branding pack ---

contextBridge.exposeInMainWorld('curva', {
  // Room lifecycle.
  joinRoom(slug, isHost, opts) {
    if (typeof slug !== 'string' || slug.length === 0 || slug.length > 64) {
      throw new RangeError('slug must be 1-64 chars')
    }
    // opts.invite (optional): base32url-encoded signed invitation token from
    // pear.links deep link. When present, the Bare worker decodes via
    // writerInvitation.decodeInvitationFromUrl and consumes as a Pattern B
    // writer promotion. See pear-app/bare/writerInvitation.js.
    const invite = (opts && typeof opts.invite === 'string' && opts.invite.length > 0)
      ? opts.invite
      : null
    return writeMain('room:join', { slug, isHost: !!isHost, invite })
  },
  leaveRoom() {
    return writeMain('room:leave', {})
  },

  // Playhead. `extras.is_anchor` (bool) marks a host-emitted drift-correction
  // anchor per Wave 6 T3. Non-host callers get silently downgraded on the
  // worker side; the flag here is just plumbing.
  setPlayhead(type, matchTimeMs, extras) {
    if (!['play', 'pause', 'seek', 'rate'].includes(type)) {
      throw new RangeError('invalid playhead type')
    }
    if (typeof matchTimeMs !== 'number' || matchTimeMs < 0) {
      throw new RangeError('matchTimeMs must be >= 0')
    }
    const clean = extras && typeof extras === 'object' ? { ...extras } : {}
    if (clean.is_anchor !== undefined && typeof clean.is_anchor !== 'boolean') {
      throw new TypeError('is_anchor must be boolean')
    }
    return writeMain('playhead:set', { type, matchTimeMs, ...clean })
  },

  // Chat.
  sendChat(text, matchTimeMs, lang) {
    if (typeof text !== 'string') throw new TypeError('text must be a string')
    if (text.length === 0) throw new RangeError('text empty')
    if (text.length > 2048) throw new RangeError('text too long (renderer cap 2048; sanitizer will 280)')
    if (typeof matchTimeMs !== 'number' || matchTimeMs < 0) matchTimeMs = 0
    // Phase 3.5: `lang` doubles as source_lang on the wire; the reducer stores
    // it under both `lang` (legacy) and `source_lang` (new).
    return writeMain('chat:send', { text, matchTimeMs, lang, source_lang: lang })
  },
  loadChatHistory({ from = 0, limit = 100 } = {}) {
    return writeMain('chat:history', { from, limit })
  },

  // Clips.
  addClip(buffer, matchTimeMs, caption) {
    const b64 = toBase64(buffer)
    if (!b64) throw new RangeError('buffer required')
    if (typeof matchTimeMs !== 'number' || matchTimeMs < 0) matchTimeMs = 0
    if (caption !== undefined && typeof caption !== 'string') {
      throw new TypeError('caption must be a string')
    }
    return writeMain('clip:add', { buffer: b64, matchTimeMs, caption })
  },
  listClips({ limit = 200 } = {}) {
    return writeMain('clip:list', { limit })
  },
  getClip(driveKey, path, byPeer) {
    if (typeof driveKey !== 'string' || driveKey.length !== 64) {
      throw new RangeError('driveKey must be 64-char hex')
    }
    if (typeof path !== 'string' || !path.startsWith('/clips/')) {
      throw new RangeError('path must start with /clips/')
    }
    return writeMain('clip:get', { driveKey, path, byPeer })
  },
  trackPeerDrive(peerPubkey, driveKey) {
    return writeMain('clip:track-peer', { peerPubkey, driveKey })
  },
  getClipThumb(coreKey, blobId) {
    if (typeof coreKey !== 'string' || coreKey.length !== 64) {
      throw new RangeError('coreKey must be 64-char hex')
    }
    if (!blobId || typeof blobId !== 'object') {
      throw new RangeError('blobId object required')
    }
    return writeMain('clip:thumb', { coreKey, blobId })
  },
  onClipThumb: (cb) => onEvent('clip:thumb', cb),

  // Fetch a same-origin http://127.0.0.1:PORT URL the renderer can drop into
  // <video src>. The URL is served by hypercore-blob-server in the Bare worker,
  // is Range-friendly (RFC 7233), and carries a token in its query string. The
  // token is single-process-scoped: it rotates on Bare worker restart and on
  // room close. Reply arrives via `curva.onClipLink` with the same requestId.
  // Docs: https://github.com/holepunchto/hypercore-blob-server
  getClipLink({ driveKey, blobPath } = {}) {
    if (typeof driveKey !== 'string' || driveKey.length !== 64) {
      throw new RangeError('driveKey must be 64-char hex')
    }
    if (typeof blobPath !== 'string' || !blobPath.startsWith('/clips/')) {
      throw new RangeError('blobPath must start with /clips/')
    }
    return writeMain('clip:link', { driveKey, blobPath })
  },
  onClipLink: (cb) => onEvent('clip:link', cb),

  // F21 (OCR audit trail): curva.clips.* sub-namespace with object-arg signatures.
  // The renderer's F21 Verify button + goal-proof lightbox expect
  // `curva.clips.getClip({driveKey, path}).then(bytes => ...)`. The historical
  // top-level `curva.getClip(driveKey, path)` uses positional args and returns
  // the raw payload envelope. This sub-namespace wraps the same worker IPC
  // (`clip:get`) via `writeMainAwait` so the promise resolves with the decoded
  // byte array (Uint8Array) rather than the base64 envelope. Same underlying
  // security posture (64-hex driveKey guard, /clips/-prefixed path guard).
  clips: {
    getClip({ driveKey, path, byPeer } = {}) {
      if (typeof driveKey !== 'string' || driveKey.length !== 64) {
        return Promise.reject(new RangeError('driveKey must be 64-char hex'))
      }
      if (typeof path !== 'string' || !path.startsWith('/clips/')) {
        return Promise.reject(new RangeError('path must start with /clips/'))
      }
      return writeMainAwait('clip:get', { driveKey, path, byPeer }).then((res) => {
        if (!res || typeof res.buffer !== 'string') {
          throw new Error('clip:get returned no buffer')
        }
        // Worker encodes bytes as base64; decode back to Uint8Array for the
        // renderer's Blob/Image consumers. Using Buffer here is safe because
        // preload runs in a Node context alongside Electron.
        const bytes = Buffer.from(res.buffer, 'base64')
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      })
    },
    addClip({ buffer, matchTimeMs = 0, caption } = {}) {
      const b64 = toBase64(buffer)
      if (!b64) return Promise.reject(new RangeError('buffer required'))
      if (typeof matchTimeMs !== 'number' || matchTimeMs < 0) matchTimeMs = 0
      if (caption !== undefined && typeof caption !== 'string') {
        return Promise.reject(new TypeError('caption must be a string'))
      }
      return writeMainAwait('clip:add', { buffer: b64, matchTimeMs, caption })
    },
    listClips({ limit = 200 } = {}) {
      return writeMainAwait('clip:list', { limit })
    },
    getClipLink({ driveKey, blobPath } = {}) {
      if (typeof driveKey !== 'string' || driveKey.length !== 64) {
        return Promise.reject(new RangeError('driveKey must be 64-char hex'))
      }
      if (typeof blobPath !== 'string' || !blobPath.startsWith('/clips/')) {
        return Promise.reject(new RangeError('blobPath must start with /clips/'))
      }
      return writeMainAwait('clip:link', { driveKey, blobPath })
    }
  },

  // Backend integration (read-mostly).
  loadMatches(filters) {
    return writeMain('backend:matches', { filters: filters || {} })
  },
  loadMatchesToday() {
    return writeMain('backend:matches', { today: true })
  },
  loadRooms(filters) {
    return writeMain('backend:rooms', { filters: filters || {} })
  },
  publishRoom(fields) {
    return writeMain('backend:publish-room', fields || {})
  },
  connectActivityFeed() {
    return writeMain('backend:activity-connect', {})
  },
  disconnectActivityFeed() {
    return writeMain('backend:activity-disconnect', {})
  },
  // Convenience helper for renderer: convert base64 clip data to ArrayBuffer.
  decodeClipBuffer: fromBase64,

  // Event subscriptions. Each returns an unsubscribe function.
  onRoomReady:      (cb) => onEvent('room:ready', cb),
  onRoomClosed:     (cb) => onEvent('room:closed', cb),
  onPlayheadUpdate: (cb) => onEvent('playhead:update', cb),
  onChatMessage:    (cb) => onEvent('chat:msg', cb),
  onChatHistory:    (cb) => onEvent('chat:history', cb),
  onGoalCluster:    (cb) => onEvent('chat:goal-cluster', cb),
  onError:          (cb) => onEvent('error', cb),
  onPeerConnected:  (cb) => onEvent('peer:connected', cb),
  onPeerDisconnected: (cb) => onEvent('peer:disconnected', cb),
  // ADR-002: verified-peer presence. Bare emits `peer:verified` when a peer's
  // identity proof succeeds, and `peer:verified-count` on any change. Payload:
  //   peer:verified        { peerId, identityPublicKeyHex, devicePublicKeyHex }
  //   peer:verified-count  { verified: number, total: number }
  // Renderer uses these to paint the "N verified" subheader + optional shield
  // glyph next to sender names. The verify result itself is computed in bare
  // (workers/main.js -> room.registerPeerProof); the renderer NEVER re-verifies.
  onPeerVerified:       (cb) => onEvent('peer:verified', cb),
  onPeerVerifiedCount:  (cb) => onEvent('peer:verified-count', cb),

  // -- Supertonic TTS goal announcer (Tier 4) ---
  // Multilingual on-device goal announcements. The Bare worker owns model
  // load + synthesis and pushes a WAV base64 payload per event. Off by
  // default (CURVA_QVAC_TTS_ENABLED). Payload shape:
  //   { wavBase64, lang, matchId, minute, sizeBytes, sampleRate, text }
  // The renderer plays it via `new Audio('data:audio/wav;base64,'+wavBase64)`.
  onAnnouncerAudio:    (cb) => onEvent('announcer:audio', cb),
  onAnnouncerStatus:   (cb) => onEvent('announcer:status', cb),
  onAnnouncerLoading:  (cb) => onEvent('announcer:loading', cb),
  onAnnouncerProgress: (cb) => onEvent('announcer:progress', cb),
  onAnnouncerReady:    (cb) => onEvent('announcer:ready', cb),
  onAnnouncerError:    (cb) => onEvent('announcer:error', cb),
  // Wave 3 F1: pipelined streaming TTS. `tts-first-chunk` carries latencyMs.
  onAnnouncerTtsFirstChunk: (cb) => onEvent('announcer:tts-first-chunk', cb),
  onAnnouncerStreamOpen:    (cb) => onEvent('announcer:stream-open', cb),
  onAnnouncerStreamEnd:     (cb) => onEvent('announcer:stream-end', cb),
  // -- End Supertonic TTS goal announcer ---

  // Phase 2 events.
  onClipAdded:      (cb) => onEvent('clip:added', cb),
  onClipList:       (cb) => onEvent('clip:list', cb),
  onClipData:       (cb) => onEvent('clip:data', cb),
  onClipError:      (cb) => onEvent('clip:error', cb),
  onMatches:        (cb) => onEvent('backend:matches', cb),
  onRooms:          (cb) => onEvent('backend:rooms', cb),
  onPublishRoom:    (cb) => onEvent('backend:publish-room', cb),
  onActivityEvent:  (cb) => onEvent('backend:activity', cb),
  onActivityStatus: (cb) => onEvent('backend:activity:status', cb),

  // -- Live match minute overlay --------------------------------------------
  // Cup Final feature. Bare worker forwards the enriched `match.pulse` SSE
  // frame as `match:minute-update` with { matchId, minute, status,
  // injuryTime, ts }. VideoPlayer subscribes to render a floating badge
  // (top-right of the video wrap). Returns an unsubscribe function.
  onMatchMinute:    (cb) => onEvent('match:minute-update', cb),

  // Phase 3: wallet + tips.
  // Passcode: renderer MAY pass a runtime passcode; in dev the Bare worker
  // falls back to DEV_WALLET_PASSCODE. Validation at boundary — renderer must
  // NEVER send an empty passcode by accident.
  initWallet(passcode) {
    if (passcode !== undefined && (typeof passcode !== 'string' || passcode.length === 0)) {
      throw new RangeError('passcode must be non-empty string or omitted')
    }
    return writeMain('wallet:init', passcode ? { passcode } : {})
  },
  // Set (or supply) the runtime passcode and trigger wallet init. The
  // passcode never round-trips back through IPC. Called from the first-run
  // PasscodePrompt modal.
  setWalletPasscode(passcode) {
    if (typeof passcode !== 'string' || passcode.length < 6 || passcode.length > 128) {
      throw new RangeError('passcode must be 6-128 chars')
    }
    return writeMain('wallet:set-passcode', { passcode })
  },
  onWalletPasscodeRequired: (cb) => onEvent('wallet:passcode-required', cb),

  // T5: OTA update toast events. `update:available` fires while download is
  // in flight; `update:ready` fires when the new drive version is applied and
  // the runtime is ready to reload. Both payloads are best-effort — the
  // renderer must tolerate missing/null fields.
  onUpdateAvailable: (cb) => onEvent('update:available', cb),
  onUpdateReady:     (cb) => onEvent('update:ready', cb),

  // Open an https URL in the OS default browser, subject to the host
  // allowlist above. Validation happens twice: here at the preload boundary
  // AND again in electron/main.js. If the URL fails validation we reject
  // with a RangeError so the caller can log and skip.
  openExternal(url) {
    if (!isAllowedExternal(url)) {
      throw new RangeError('openExternal: url not in allowlist or not https')
    }
    return ipcRenderer.invoke('curva:open-external', String(url))
  },

  // Get the Curva pear:// distribution key (fetched by the Bare worker from
  // GET /distribution/pear-link at boot). Returns null when the backend is
  // unreachable or distribution is disabled — never throws.
  getPearAppKey() {
    return writeMain('distribution:get-key', {})
  },
  // Build an invite link for the given slug. Prefers the pear:// key; falls
  // back to a curva:// deep link when the pear key is not yet published.
  async getInviteLink({ slug } = {}) {
    if (typeof slug !== 'string' || slug.length === 0 || slug.length > 128) {
      throw new RangeError('slug required (1-128 chars)')
    }
    // Ask the Bare worker; the response comes as an event `distribution:key`.
    // Renderer components should subscribe via onDistributionKey; this helper
    // is a convenience wrapper.
    return writeMain('distribution:get-key', { slug })
  },
  onDistributionKey: (cb) => onEvent('distribution:key', cb),

  // Wave 7 Zone C: fetch USDT->fiat quote from the backend pricing endpoint.
  // This bridge lives in preload (rather than the Bare worker) because it's a
  // pure HTTP GET to a well-known constant path and there is no P2P state to
  // resolve. Validated at the boundary: `currency` must be one of the allowed
  // codes. Returns { rate, source, currency, fetchedAt, stale, assumption? }
  // or throws on non-2xx.
  async getUsdtQuote(currency) {
    const ALLOWED = new Set(['IDR', 'USD', 'EUR', 'GBP', 'BRL', 'MXN', 'JPY'])
    if (typeof currency !== 'string' || !ALLOWED.has(currency.toUpperCase())) {
      throw new RangeError('currency must be one of ' + Array.from(ALLOWED).join(','))
    }
    const cfg = ipcRenderer.sendSync('curva:boot-config')
    const base = (cfg && cfg.backend) || 'http://localhost:3700'
    const url = base.replace(/\/+$/, '') + '/pricing/usdt?currency=' + encodeURIComponent(currency.toUpperCase())
    // 5s hard timeout so a stalled backend cannot lock the renderer chip.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) throw new Error('pricing HTTP ' + res.status)
      const body = await res.json()
      if (!body || body.success !== true || !body.data) {
        throw new Error('pricing malformed response')
      }
      return body.data
    } finally {
      clearTimeout(timer)
    }
  },

  // Fetch the backend phrasebook. Bare worker owns the HTTP call so we don't
  // pass a fetch through the renderer. Emits `backend:phrasebook` on reply.
  fetchPhrasebook() {
    return writeMain('backend:phrasebook', {})
  },
  onPhrasebook: (cb) => onEvent('backend:phrasebook', cb),

  // Fetch the leaderboard for a given match. Emits `backend:leaderboard`.
  fetchLeaderboard(matchId) {
    if (matchId !== undefined && (typeof matchId !== 'string' || matchId.length > 128)) {
      throw new RangeError('matchId must be string (max 128)')
    }
    return writeMain('backend:leaderboard', { matchId })
  },
  onLeaderboard: (cb) => onEvent('backend:leaderboard', cb),

  // Final Fix Wave T4: swarm suspend/resume bridge. Called by electron/main.js
  // on browserWindow minimize/restore/focus events so the Hyperswarm instance
  // in the Bare worker can release DHT sockets and stop discovery while the
  // app is backgrounded. Docs:
  //   https://github.com/holepunchto/hyperswarm  (suspend / resume)
  //   https://www.electronjs.org/docs/latest/api/browser-window  (minimize / restore / focus)
  suspendSwarm() { return writeMain('swarm:suspend', {}) },
  resumeSwarm()  { return writeMain('swarm:resume', {}) },
  onSwarmSuspended: (cb) => onEvent('swarm:suspended', cb),
  onSwarmResumed:   (cb) => onEvent('swarm:resumed', cb),

  // Generate a QR code data URL. Runs entirely in preload; no IPC roundtrip.
  toQrDataUrl(text, opts) {
    return toQrDataUrl(text, opts)
  },

  // Deep-link auto-join. Fired when Electron main parses a curva:// URL.
  // This event does NOT go through the Bare worker; it comes directly from
  // Electron main via a dedicated ipcRenderer channel.
  onDeepLinkJoin(cb) {
    if (typeof cb !== 'function') throw new TypeError('cb required')
    const wrap = (_evt, payload) => {
      if (payload && typeof payload.slug === 'string') cb(payload)
    }
    ipcRenderer.on('curva:deeplink:join', wrap)
    return () => ipcRenderer.removeListener('curva:deeplink:join', wrap)
  },
  getWalletInfo() { return writeMain('wallet:info', {}) },
  getBalance() { return writeMain('wallet:balance', {}) },

  // -- Keet identity (Tier 4 Round 2) ---
  // Portable identity via keet-identity-key@3.2.0. 24-word BIP-39 mnemonic
  // that survives reinstall so tips still verify green on a new laptop.
  //
  // hasKeetIdentity()      -> Promise<{ present: boolean, enabled: boolean }>
  // generateNew()          -> Promise<{ mnemonic: string, identityPublicKey: string }>
  //                           (mnemonic shown ONCE; renderer must drop after display)
  // restore({ mnemonic })  -> Promise<{ identityPublicKey: string }>
  // getIdentityPublicKey() -> Promise<{ identityPublicKey: string | null }>
  //
  // Note: the task brief calls these "sync". The Bare worker owns the state,
  // so the only true-sync channel would be ipcRenderer.sendSync to a cache in
  // electron main. Every other renderer surface in this file uses writeMain
  // (Promises) for worker-owned state; we match that convention here for
  // consistency and to avoid a cache-drift bug the first time the mnemonic is
  // rotated. Renderer awaits before painting.
  identity: {
    hasKeetIdentity() {
      return writeMain('identity:has', {})
    },
    generateNew() {
      return writeMain('identity:generate-new', {})
    },
    restore({ mnemonic } = {}) {
      if (typeof mnemonic !== 'string' || mnemonic.trim().length === 0) {
        throw new RangeError('mnemonic required')
      }
      const words = mnemonic.trim().split(/\s+/)
      if (words.length !== 24) {
        throw new RangeError('mnemonic must be exactly 24 BIP-39 words')
      }
      // BIP-39 words are ASCII lowercase; reject anything else at the boundary
      // so an over-clipboard-paste of a decorated string cannot reach the
      // worker.
      for (const w of words) {
        if (!/^[a-z]{3,12}$/.test(w)) {
          throw new RangeError('mnemonic contains non-BIP39 token')
        }
      }
      return writeMain('identity:restore', { mnemonic: words.join(' ') })
    },
    getIdentityPublicKey() {
      return writeMain('identity:get-public-key', {})
    },
    onIdentityReady: (cb) => onEvent('identity:ready', cb),
    onIdentityError: (cb) => onEvent('identity:error', cb)
  },
  // -- End Keet identity (Tier 4 Round 2) ---

  // T6/T7 alias for callers that prefer the more explicit name.
  getWalletBalance() { return writeMain('wallet:balance', {}) },
  tipHost({ amount, note } = {}) {
    // Amount is either a decimal-string of base units OR a shortcut for the
    // demo default. Never accept a floating-point USDT amount at this boundary
    // — force base units to avoid rounding bugs.
    if (amount !== undefined) {
      if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount)) {
        throw new RangeError('amount must be decimal string in base units (e.g. "1000000")')
      }
    }
    if (note !== undefined && (typeof note !== 'string' || note.length > 140)) {
      throw new RangeError('note must be string <= 140 chars')
    }
    return writeMain('tip:propose', { amount, note })
  },
  getTips({ limit = 100 } = {}) {
    return writeMain('tip:list', { limit })
  },

  // -- ERC-4337 batch tip (Tier 4) ---
  // Sends 2..5 USDT transfers as one UserOperation via Safe MultiSend. All
  // validation at the boundary; the Bare worker AND the wallet worklet
  // re-validate before signing.
  tipBatch({ recipients } = {}) {
    if (!Array.isArray(recipients)) {
      throw new TypeError('recipients must be an array')
    }
    if (recipients.length < 2 || recipients.length > 5) {
      throw new RangeError('recipients must contain 2..5 entries')
    }
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i]
      if (!r || typeof r !== 'object') {
        throw new TypeError(`recipients[${i}] must be an object`)
      }
      if (typeof r.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.address)) {
        throw new RangeError(`recipients[${i}].address must be 0x + 20-byte hex`)
      }
      if (typeof r.amountAtomicUsdt !== 'string' || !/^[1-9][0-9]*$/.test(r.amountAtomicUsdt)) {
        throw new RangeError(`recipients[${i}].amountAtomicUsdt must be a positive integer string`)
      }
      if (r.handle !== undefined && (typeof r.handle !== 'string' || r.handle.length > 64)) {
        throw new RangeError(`recipients[${i}].handle must be string (max 64) or omitted`)
      }
    }
    return writeMain('tip:batch', { recipients })
  },
  onTipBatchPending:   (cb) => onEvent('tip:batch-pending', cb),
  onTipBatchConfirmed: (cb) => onEvent('tip:batch-confirmed', cb),
  onTipBatchFailed:    (cb) => onEvent('tip:batch-failed', cb),
  // -- end ERC-4337 batch tip (Tier 4) ---

  onWalletReady:      (cb) => onEvent('wallet:ready', cb),
  onWalletInfo:       (cb) => onEvent('wallet:info', cb),
  onWalletBalance:    (cb) => onEvent('wallet:balance', cb),
  onWalletError:      (cb) => onEvent('wallet:error', cb),
  onTipPending:       (cb) => onEvent('tip:pending', cb),
  onTipSigning:       (cb) => onEvent('tip:signing', cb),
  onTipSubmitting:    (cb) => onEvent('tip:submitting', cb),
  onTipSubmitted:     (cb) => onEvent('tip:submitted', cb),
  onTipConfirmed:     (cb) => onEvent('tip:confirmed', cb),
  onTipFailed:        (cb) => onEvent('tip:failed', cb),
  onTipHostDiscovered: (cb) => onEvent('tip:host-discovered', cb),
  onTipList:          (cb) => onEvent('tip:list', cb),

  // Phase 3.5: QVAC translation cameo. All methods are best-effort; UI
  // must not assume translation is available. See ARCHITECTURE Section 2.6.
  initTranslation({ targetLang } = {}) {
    const allowed = ['en', 'it', 'id']
    if (typeof targetLang !== 'string' || !allowed.includes(targetLang.toLowerCase())) {
      throw new RangeError('targetLang must be one of ' + allowed.join(','))
    }
    return writeMain('translate:init', { targetLang: targetLang.toLowerCase() })
  },
  translateText({ text, from, to } = {}) {
    if (typeof text !== 'string' || text.length === 0) throw new RangeError('text required')
    if (text.length > 2000) throw new RangeError('text too long for translation')
    if (typeof from !== 'string' || typeof to !== 'string') throw new TypeError('from/to required')
    // Use the correlated ack dispatcher so we resolve with the actual
    // translated string. writeMain would resolve with `pipe.write`'s bool.
    return writeMainAwait('translate:text', {
      text,
      from: from.toLowerCase(),
      to: to.toLowerCase()
    }).then((payload) => {
      // Worker emits `translate:text { translated, requestId }`. Return just
      // the string so callers (Chat.js bulk translate) don't need to peel
      // the envelope.
      if (payload && typeof payload.translated === 'string') return payload.translated
      return ''
    })
  },
  getTranslationStatus() { return writeMain('translate:status', {}) },
  // Fix Wave C T4: shallow snapshot for the About integrity badge.
  // Returns { loadedModels, mode, networkCallsThisSession } via `translate:state` event.
  getTranslationState() { return writeMain('translate:state', {}) },
  setUserLanguage(lang) {
    const allowed = ['en', 'it', 'id']
    if (typeof lang !== 'string' || !allowed.includes(lang.toLowerCase())) {
      throw new RangeError('lang must be one of ' + allowed.join(','))
    }
    return writeMain('translate:set-user-lang', { lang: lang.toLowerCase() })
  },
  onTranslationProgress: (cb) => onEvent('translate:progress', cb),
  onTranslationReady:    (cb) => onEvent('translate:ready', cb),
  onTranslationDisabled: (cb) => onEvent('translate:disabled', cb),
  onTranslationError:    (cb) => onEvent('translate:error', cb),
  onTranslationStatus:   (cb) => onEvent('translate:status', cb),
  onTranslationState:    (cb) => onEvent('translate:state', cb),
  onChatTranslated:      (cb) => onEvent('chat:msg:translated', cb),

  // ===== QVAC DELEGATE (Wave 12) =====
  // Subscribe to per-request delegated-inference status from the Bare worker.
  // Payload shape: { provider: <hex>, providerHandle?: string, latencyMs: number, fallback: bool, reason?: string }.
  // The worker emits this once per translate() call so RoomHeader can flip
  // the "translating via <handle>" chip. Guests only; hosts never emit.
  onDelegateStatus:      (cb) => onEvent('translate:delegate-status', cb),
  // ===== END QVAC DELEGATE (Wave 12) =====

  // Phase 4 diagnostics. Consumed by the dev-only `?diag=1` panel.
  getLatencies() { return writeMain('diag:latencies', {}) },
  getHealth()    { return writeMain('diag:health', {}) },
  onLatencySample:  (cb) => onEvent('diag:latency', cb),
  onLatencies:      (cb) => onEvent('diag:latencies', cb),
  onHealth:         (cb) => onEvent('diag:health', cb),

  // Wave 8B T2: in-process seeder stats. Renderer polls every 30s. Returns
  // { activePeers, totalPeersLastHour, bytesReplicated, seederEnabled, pearAppKey }
  // via the `seeder:stats` event.
  getSeederStats() { return writeMain('seeder:stats', {}) },
  onSeederStats:   (cb) => onEvent('seeder:stats', cb),

  // Wave 8B T3: batch DHT peer-count lookup for a list of topics. Returns
  // a Map<topicHex, number> via the `peer-counts:live` event. The Bare worker
  // enforces the 10-concurrent cap and 60s TTL cache.
  getLivePeerCountsForTopics(topics) {
    if (!Array.isArray(topics)) throw new TypeError('topics must be an array')
    if (topics.length === 0) return Promise.resolve()
    if (topics.length > 200) throw new RangeError('topics: max 200 per call')
    // Validate at the boundary. Silently drop malformed entries so a bad
    // slug in the caller cannot poison the whole batch.
    const cleaned = []
    for (const t of topics) {
      if (typeof t === 'string' && /^[0-9a-f]{64}$/i.test(t)) cleaned.push(t.toLowerCase())
    }
    return writeMain('peer-counts:live', { topics: cleaned })
  },
  // Convenience wrapper: pass slugs, get topic-hex-keyed counts back. Uses the
  // topic derivation loaded in preload so hashes match the Bare worker.
  async getLivePeerCountsForSlugs(slugs) {
    if (!Array.isArray(slugs)) throw new TypeError('slugs must be an array')
    if (slugs.length > 200) throw new RangeError('slugs: max 200 per call')
    const topics = []
    const slugByHex = new Map()
    for (const s of slugs) {
      const hex = topicHexForSlug(s)
      if (hex) { topics.push(hex); slugByHex.set(hex, s) }
    }
    if (topics.length === 0) return { slugByHex }
    await writeMain('peer-counts:live', { topics })
    return { slugByHex }
  },
  // Renderer helper: derive the topic hex for a slug (used to correlate
  // onLivePeerCounts payloads back to the slug it originated from).
  topicHexForSlug(slug) { return topicHexForSlug(slug) },
  onLivePeerCounts: (cb) => {
    // Convert the { counts: {hex: {count, cached, error}} } shape into a
    // Map<hex, number> at the renderer boundary so callers see the exact
    // signature promised by Wave 8B T3 (Map<slug, number>). Callers keep
    // slug<->hex mapping locally.
    if (typeof cb !== 'function') throw new TypeError('cb required')
    return onEvent('peer-counts:live', (payload) => {
      const map = new Map()
      const raw = payload?.counts || {}
      for (const [hex, entry] of Object.entries(raw)) {
        map.set(hex, entry?.count ?? 0)
      }
      cb(map, payload?.requestId)
    })
  },

  // Wave 8B T1: relay status. Renderer subscribes to onRelayStatus to flip
  // the "via relay" chip in RoomHeader. `getRelayInfo()` returns the current
  // snapshot (never triggers a re-fetch).
  getRelayInfo() { return writeMain('relay:info', {}) },
  onRelayInfo:       (cb) => onEvent('relay:info', cb),
  onRelayConnection: (cb) => onEvent('relay:connection', cb),
  // Convenience: single "status" subscription that fires on either info or
  // connection events. Payload is normalized to { relayed, remoteKey?, relayKey?, enabled?, forced? }.
  onRelayStatus(cb) {
    if (typeof cb !== 'function') throw new TypeError('cb required')
    const offs = [
      onEvent('relay:info', (p) => cb({
        kind: 'info',
        enabled: !!p?.enabled,
        forced: !!p?.forced,
        relayKey: p?.pubkey || null,
        activeConnections: p?.activeConnections || 0
      })),
      onEvent('relay:connection', (p) => cb({
        kind: 'connection',
        relayed: !!p?.relayed,
        remoteKey: p?.remoteKey || null,
        relayKey: p?.relayKey || null,
        at: p?.at || Date.now()
      }))
    ]
    return () => offs.forEach((f) => { try { f() } catch { /* noop */ } })
  },

  // ===== PREDICTIONS (Wave 11) =====
  // Match Prediction Pool bridge. All methods reject with FEATURE_DISABLED
  // (via the Bare worker) when CURVA_PREDICTIONS_ENABLED != 'true'. Renderer
  // components MUST NOT assume any of these methods succeed — always .catch.
  //
  // Signed-message format for openPool/publishResult follows the strings built
  // in bare/predictions.js which mirror backend/src/routes/predictionRoutes.ts
  // 1:1. The signature is produced by wallet.signMessage (EIP-191 personal_sign)
  // per https://eips.ethereum.org/EIPS/eip-191 and returns a single hex string
  // per https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/api-reference/
  predictions: {
    // Host-only: open a new prediction pool. Feature-flag gated on the Bare
    // worker side. Rejects with { code, message } on the IPC error event.
    openPool({ matchId, mode, entryStakeAtomic, deadlineMs } = {}) {
      if (typeof matchId !== 'string' || matchId.length === 0 || matchId.length > 64) {
        throw new RangeError('matchId is required (1-64 chars)')
      }
      if (mode !== 'winner-only' && mode !== 'exact-score') {
        throw new RangeError("mode must be 'winner-only' or 'exact-score'")
      }
      if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
        throw new RangeError('deadlineMs must be a future timestamp (ms)')
      }
      if (entryStakeAtomic !== undefined && (typeof entryStakeAtomic !== 'string' || !/^[0-9]+$/.test(entryStakeAtomic))) {
        throw new RangeError('entryStakeAtomic must be decimal string (base units)')
      }
      return writeMain('predictions:open', { matchId, mode, entryStakeAtomic, deadlineMs })
    },
    // Peer path: sign EIP-3009 stake authorization and submit to the backend.
    submitPrediction({ poolId, winner, homeGoals, awayGoals, stakeAtomic, poolAddress, chainId, stakeToken, mode } = {}) {
      if (typeof poolId !== 'string' || poolId.length === 0) throw new RangeError('poolId required')
      if (!['HOME', 'AWAY', 'DRAW'].includes(winner)) throw new RangeError('winner must be HOME/AWAY/DRAW')
      if (typeof stakeAtomic !== 'string' || !/^[0-9]+$/.test(stakeAtomic)) {
        throw new RangeError('stakeAtomic must be decimal string in base units')
      }
      if (typeof poolAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(poolAddress)) {
        throw new RangeError('poolAddress required')
      }
      if (typeof stakeToken !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(stakeToken)) {
        throw new RangeError('stakeToken required')
      }
      if (!Number.isInteger(chainId) || chainId <= 0) throw new RangeError('chainId required')
      if (mode !== 'winner-only' && mode !== 'exact-score') throw new RangeError('mode required')
      if (mode === 'exact-score') {
        if (!Number.isInteger(homeGoals) || homeGoals < 0 || homeGoals > 30) throw new RangeError('homeGoals 0..30')
        if (!Number.isInteger(awayGoals) || awayGoals < 0 || awayGoals > 30) throw new RangeError('awayGoals 0..30')
      }
      return writeMain('predictions:submit', {
        poolId, winner, homeGoals, awayGoals, stakeAtomic, poolAddress, chainId, stakeToken, mode
      })
    },
    // Host-only: publish match result (goals + winner). Chat receives a
    // system:match-result message with the same values.
    publishResult({ poolId, winner, homeGoals, awayGoals, matchId } = {}) {
      if (typeof poolId !== 'string' || poolId.length === 0) throw new RangeError('poolId required')
      if (!['HOME', 'AWAY', 'DRAW'].includes(winner)) throw new RangeError('winner must be HOME/AWAY/DRAW')
      if (!Number.isInteger(homeGoals) || homeGoals < 0 || homeGoals > 30) throw new RangeError('homeGoals 0..30')
      if (!Number.isInteger(awayGoals) || awayGoals < 0 || awayGoals > 30) throw new RangeError('awayGoals 0..30')
      if (matchId !== undefined && (typeof matchId !== 'string' || matchId.length > 64)) {
        throw new RangeError('matchId must be string (max 64)')
      }
      return writeMain('predictions:result', { poolId, winner, homeGoals, awayGoals, matchId })
    },
    // Read the current pool snapshot for (roomSlug, matchId). 60s TTL cache
    // on the Bare worker side. Set forceRefresh:true to bypass.
    getStatus({ matchId, forceRefresh = false } = {}) {
      if (typeof matchId !== 'string' || matchId.length === 0 || matchId.length > 64) {
        throw new RangeError('matchId required')
      }
      return writeMain('predictions:status', { matchId, forceRefresh: !!forceRefresh })
    },
    // Renderer-only: subscribe to prediction.* events surfaced by the backend
    // /activity/stream SSE. The Bare worker already forwards every SSE frame
    // as `backend:activity` — here we filter for the prediction subclass and
    // re-emit as `predictions:payout` / `predictions:settled` payloads.
    onPayout(cb) {
      if (typeof cb !== 'function') throw new TypeError('cb required')
      return onEvent('backend:activity', (parsed) => {
        const kind = parsed?.type || parsed?.event
        if (kind === 'prediction.payout') cb(parsed)
      })
    },
    onSettled(cb) {
      if (typeof cb !== 'function') throw new TypeError('cb required')
      return onEvent('backend:activity', (parsed) => {
        const kind = parsed?.type || parsed?.event
        if (kind === 'prediction.settled') cb(parsed)
      })
    },
    // Direct config query. Fires `predictions:config` reply with
    // { enabled, clientReady, isHost }. Renderer uses this on room:ready to
    // decide whether to mount PredictionPanel.
    getConfig() { return writeMain('predictions:config', {}) },
    onConfig:            (cb) => onEvent('predictions:config', cb),
    onOpened:            (cb) => onEvent('predictions:opened', cb),
    onSubmitted:         (cb) => onEvent('predictions:submitted', cb),
    onResultPublished:   (cb) => onEvent('predictions:result-published', cb),
    onStatus:            (cb) => onEvent('predictions:status', cb),
    onError:             (cb) => onEvent('predictions:error', cb),
    // Host: request the Bare worker append system:pool-payout after correlating
    // an SSE prediction.payout event with a pool the host owns.
    announcePayout({ matchId, txHash, toAddress, amountAtomic }) {
      if (typeof matchId !== 'string' || matchId.length === 0) throw new RangeError('matchId required')
      if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new RangeError('txHash required')
      if (typeof toAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(toAddress)) throw new RangeError('toAddress required')
      if (typeof amountAtomic !== 'string' || !/^[0-9]+$/.test(amountAtomic)) throw new RangeError('amountAtomic required')
      return writeMain('predictions:announce-payout', { matchId, txHash, toAddress, amountAtomic })
    },
    // ---- Wave 3 F3: sealed predictions ----
    // Any-role: write a hypercore-encrypted sealed pick that peers can only
    // decode once the host publishes the encryption key. `encryptionKey` is
    // hex-encoded 32-byte value derived out-of-band (see bare/predictions.js
    // deriveSealKey).
    createSealed({ epoch, prediction, encryptionKey } = {}) {
      const epochStr = typeof epoch === 'number' ? String(epoch) : epoch
      if (typeof epochStr !== 'string' || epochStr.length === 0 || epochStr.length > 64) {
        throw new RangeError('epoch required (<=64 chars)')
      }
      if (typeof encryptionKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
        throw new RangeError('encryptionKey must be 64-hex chars (32 bytes)')
      }
      if (!prediction || typeof prediction !== 'object') {
        throw new RangeError('prediction object required')
      }
      return writeMainAwait('predictions:create-sealed', { epoch: epochStr, prediction, encryptionKey })
    },
    // Host-only: broadcast the epoch's encryption key so every peer can open
    // the sealed cores it has already replicated. Worker rejects with NOT_HOST
    // when the local peer is not the room host.
    reveal({ epoch, encryptionKey } = {}) {
      const epochStr = typeof epoch === 'number' ? String(epoch) : epoch
      if (typeof epochStr !== 'string' || epochStr.length === 0 || epochStr.length > 64) {
        throw new RangeError('epoch required (<=64 chars)')
      }
      if (typeof encryptionKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
        throw new RangeError('encryptionKey must be 64-hex chars (32 bytes)')
      }
      return writeMainAwait('predictions:reveal', { epoch: epochStr, encryptionKey })
    },
    onSealedCreated: (cb) => onEvent('predictions:sealed-created', cb),
    onRevealed:      (cb) => onEvent('predictions:revealed', cb)
  },
  // ===== END PREDICTIONS =====

  // ===== QVAC COMMENTATOR (Wave 13A) =====
  // QVAC LLM Room Commentator bridge. Every method is a thin pass-through to
  // the Bare worker; the worker enforces the CURVA_QVAC_COMMENTATOR_ENABLED
  // feature flag AND the host-only writer gate on `system:commentary`.
  // Peers may call getConfig()/onStatus() but their enable() will be rejected
  // with NOT_HOST at the worker.
  commentator: {
    getConfig() { return writeMain('commentator:config', {}) },
    getStatus() { return writeMain('commentator:status', {}) },
    enable() { return writeMain('commentator:enable', {}) },
    disable() { return writeMain('commentator:disable', {}) },
    setTone(tone) {
      if (typeof tone !== 'string' || tone.length === 0 || tone.length > 32) {
        throw new RangeError('tone must be 1-32 chars')
      }
      return writeMain('commentator:set-tone', { tone })
    },
    onConfig:    (cb) => onEvent('commentary:config', cb),
    onStatus:    (cb) => onEvent('commentary:status', cb),
    onLoading:   (cb) => onEvent('commentary:loading', cb),
    onProgress:  (cb) => onEvent('commentary:progress', cb),
    onReady:     (cb) => onEvent('commentary:ready', cb),
    onTrigger:   (cb) => onEvent('commentary:trigger', cb),
    onTokens:    (cb) => onEvent('commentary:tokens', cb),
    onEmitted:   (cb) => onEvent('commentary:emitted', cb),
    onError:     (cb) => onEvent('commentary:error', cb),
    // Full completion-event stream from bare/commentator.js.
    onToken:     (cb) => onEvent('commentator:token', cb),
    onThinking:  (cb) => onEvent('commentator:thinking', cb),
    onStats:     (cb) => onEvent('commentator:stats', cb),
    onDone:      (cb) => onEvent('commentator:done', cb),
    // Wave 3 F1: streaming TTS output events. `tts-chunk` payload has base64
    // PCM (`pcm` field); consumer can decode + feed to a Web Audio buffer.
    onTtsChunk:  (cb) => onEvent('commentator:tts-chunk', cb),
    onTtsDone:   (cb) => onEvent('commentator:tts-done', cb),
    onTtsError:  (cb) => onEvent('commentator:tts-error', cb)
  },
  // ===== END QVAC COMMENTATOR =====

  // ===== WDK X402 (Wave 13B) =====
  // Client-side x402 paid-resource bridge. Every method delegates to the Bare
  // worker which owns the wallet + fetch. Renderer opens PaywallModal on
  // `x402:paywall`, then answers with confirm(id, approved).
  x402: {
    // Kick off a paid GET. `url` is the absolute backend URL (e.g.
    // https://backend.example/x402/premium-translations). Resolves with
    // { status, body, txHash?, replay? } on success. Rejects on user cancel
    // or backend classified error (see bare/x402Client.js X402Error codes).
    fetch(url) {
      if (typeof url !== 'string' || url.length === 0 || url.length > 1024) {
        throw new RangeError('url must be 1-1024 chars')
      }
      // Basic sanity: block obvious javascript: schemes at the boundary.
      if (!/^https?:\/\//i.test(url) && !/^pear:\/\//i.test(url)) {
        throw new RangeError('url must be http(s) or pear scheme')
      }
      return writeMain('x402:fetch', { url })
    },
    // Renderer answers a pending paywall with the user's decision. `id` is
    // the paywall event's requestId; `approved` is boolean.
    confirm(id, approved) {
      if (typeof id !== 'string' || id.length === 0) throw new RangeError('id required')
      return writeMain('x402:confirm', { id, approved: !!approved })
    },
    // Subscribe to paywall prompts. Payload:
    //   { requestId, url, chainId, asset, amount, resource, description, payTo }
    onPaywall: (cb) => onEvent('x402:paywall', cb),
    // Subscribe to unlock events (after successful payment). Payload:
    //   { url, resource, txHash, replay }
    onUnlocked: (cb) => onEvent('x402:unlocked', cb),
    onError: (cb) => onEvent('x402:error', cb)
  },
  // ===== END WDK X402 =====

  // ===== ATTENDANCE (Wave 14) =====
  // Attendance Ticket Tools bridge. All methods reject with FEATURE_DISABLED
  // (via the Bare worker) when CURVA_ATTENDANCE_ENABLED != 'true'. Renderer
  // components MUST NOT assume any of these methods succeed — always .catch.
  //
  // Signed message format follows bare/attendance.js which mirrors
  // backend/src/lib/evm/attendance.ts 1:1. Signature is EIP-191 personal_sign.
  attendance: {
    // Host-only: mint an attendance pass for a peer. Rejects on the IPC error
    // event with FEATURE_DISABLED / ATTENDANCE_NOT_READY / RATE_LIMITED / etc.
    issue({ peerAddress, force = false } = {}) {
      if (typeof peerAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(peerAddress)) {
        throw new RangeError('peerAddress required (0x + 20 hex bytes)')
      }
      return writeMain('attendance:issue', { peerAddress, force: !!force })
    },
    // Any-role: list every persisted attendance pass in the room-state
    // Hyperbee. Peers see the same shape as the host.
    list({ limit = 200 } = {}) {
      if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
        throw new RangeError('limit must be 1-500')
      }
      return writeMain('attendance:list', { limit })
    },
    // Fires attendance:config reply with { enabled, isHost, clientReady }.
    getConfig() { return writeMain('attendance:config', {}) },
    onConfig: (cb) => onEvent('attendance:config', cb),
    onIssued: (cb) => onEvent('attendance:issued', cb),
    onList:   (cb) => onEvent('attendance:list', cb),
    onError:  (cb) => onEvent('attendance:error', cb)
  },
  // ===== END ATTENDANCE (Wave 14) =====

  // ===== TACTICAL DRAWING CHANNEL =====
  // Ephemeral P2P drawing overlay on top of a paused video frame. Strokes are
  // fire-and-forget over a protomux channel that rides the existing corestore
  // replication stream. Never touches Autobase or Hyperbee. Host-only
  // freeze/unfreeze; peers ignore forged host frames (validated on the worker
  // side against the room-state `room/host-pubkey`).
  //
  // Payload shapes:
  //   stroke:    { strokeId, kind: 'freehand'|'line'|'arrow', points: [[x,y],...],
  //                color, widthPx, ts }
  //   presence:  { peerKey, cursor: { x, y }, tool: 'pen'|'eraser' }
  //   typing:    { peerKey, ts }
  //   freeze:    { videoTsMs }   (senderPeerKey stamped by the worker)
  //   unfreeze:  { videoTsMs }   (senderPeerKey stamped by the worker)
  //
  // Coordinates are normalized to [0..1] relative to the video element.
  sendTacticalStroke(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new TypeError('tactical stroke payload required')
    }
    return writeMain('tactical:send-stroke', payload)
  },
  sendTacticalPresence(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new TypeError('tactical presence payload required')
    }
    return writeMain('tactical:send-presence', payload)
  },
  sendTacticalTyping(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new TypeError('tactical typing payload required')
    }
    return writeMain('tactical:send-typing', payload)
  },
  sendTacticalFreeze(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new TypeError('tactical freeze payload required')
    }
    return writeMain('tactical:send-freeze', payload)
  },
  sendTacticalUnfreeze(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new TypeError('tactical unfreeze payload required')
    }
    return writeMain('tactical:send-unfreeze', payload)
  },
  onTacticalStroke:   (cb) => onEvent('tactical:stroke', cb),
  onTacticalPresence: (cb) => onEvent('tactical:presence', cb),
  onTacticalTyping:   (cb) => onEvent('tactical:typing', cb),
  onTacticalFreeze:   (cb) => onEvent('tactical:freeze', cb),
  onTacticalUnfreeze: (cb) => onEvent('tactical:unfreeze', cb),
  // ===== END TACTICAL DRAWING CHANNEL =====

  // ===== BLIND PEERING (Wave 15) =====
  // Third-party blind-peering seeder registration bridge. All methods are
  // safe no-ops when CURVA_BLIND_PEERING_ENABLED != 'true' or when
  // CURVA_BLIND_PEER_KEY is unset — the Bare worker returns { enabled:false }
  // and no room registration happens. Docs:
  //   https://docs.pears.com/how-to/blind-peering/add-blind-peering-to-a-chat-app/
  blindPeering: {
    // Fires blindPeering:status reply with
    //   { enabled, active, peerKeyShort, registrationsCount, lastError }
    getStatus() { return writeMain('blindPeering:status', {}) },
    onStatus:       (cb) => onEvent('blindPeering:status', cb),
    // Fires whenever a room registers or unregisters its Autobases with the
    // blind peer. Payload: { slug, status, unregistered?, at }.
    onRegistration: (cb) => onEvent('blindPeering:registration', cb)
  },
  // ===== END BLIND PEERING (Wave 15) =====

  // Convenience alias: subscribe to ALL tip state changes.
  onTipUpdate(cb) {
    if (typeof cb !== 'function') throw new TypeError('cb required')
    const offs = [
      onEvent('tip:pending', (p) => cb('pending', p)),
      onEvent('tip:signing', (p) => cb('signing', p)),
      onEvent('tip:submitting', (p) => cb('submitting', p)),
      onEvent('tip:submitted', (p) => cb('submitted', p)),
      onEvent('tip:confirmed', (p) => cb('confirmed', p)),
      onEvent('tip:failed', (p) => cb('failed', p))
    ]
    return () => offs.forEach((f) => { try { f() } catch { /* noop */ } })
  },

  // -- pear.assets branding pack ---
  // The Bare worker reads `Pear.app.assets.branding.path` (see
  // bare/assets.js) and emits `assets:branding` with `{path, bytes}`. The
  // path is null until the drive lands (async passive fetch per Pear docs).
  // Renderer must render a bundled fallback first, then re-render when the
  // event delivers a truthy path.
  //
  // `getBrandingPath()` is a synchronous accessor over the cached last-known
  // path. `onBranding(cb)` streams every update including the initial null
  // snapshot the worker emits at boot.
  //
  // `refreshBranding()` asks the worker to re-read the Pear runtime state.
  // Useful because Pear docs describe no fetch-complete event; the renderer
  // polls at low frequency until it sees a non-null path.
  getBrandingPath() {
    return brandingCache.path
  },
  getBrandingBytes() {
    return brandingCache.bytes
  },
  onBranding(cb) {
    if (typeof cb !== 'function') throw new TypeError('cb required')
    // Deliver the current cached value immediately so subscribers don't
    // race the initial emit. Then attach to future updates.
    try { cb({ path: brandingCache.path, bytes: brandingCache.bytes }) } catch { /* noop */ }
    return onEvent('assets:branding', (payload) => {
      cb({ path: brandingCache.path, bytes: brandingCache.bytes })
      void payload
    })
  },
  refreshBranding() {
    return writeMain('assets:refresh', {})
  },
  // -- end pear.assets branding pack ---

  // -- Demo automation (Tier polish) ---
  // One-button pitch driver. Host-only + feature-flagged behind
  // CURVA_DEMO_AUTOMATION_ENABLED in the Bare worker. Every action is a
  // passthrough into an already-shipped code path (chat.send, chat.appendGoal,
  // tip.proposeTip, predictions.openPool + publishSettlement, playhead.setState,
  // announcer.speak, commentator.onGoalCluster). No new features. See
  // bare/demoTimeline.js.
  demoTimeline: {
    start() { return writeMain('demo:start', {}) },
    stop()  { return writeMain('demo:stop', {}) },
    status() { return writeMain('demo:status', {}) }
  },
  // Subscriber for {state, elapsedMs, currentStep, totalSteps} ticks emitted
  // by the timeline on every step boundary. Renderer uses this to drive the
  // floating "elapsed / step of totalSteps" label.
  onDemoTimelineTick(cb) { return onEvent('demo:tick', cb) },
  onDemoTimelineStatus(cb) { return onEvent('demo:status', cb) },
  // -- end Demo automation (Tier polish) ---

  // Feature 1 (WC reel on Hyperdrive): emitted once per room open when the
  // host's (or this peer's) blob-server URL is ready. Payload: { url, driveKey, drivePath }.
  // The renderer's VideoPlayer swaps src from the local file to this URL.
  // textContent/setAttribute only — URL is from a local loopback server.
  onWcReelLink(cb) { return onEvent('wc-reel:link', cb) },

  // Feature 3 (HUD overlay): emitted on room open + on every addWriter.
  // Payload: { writerCount } (total Autobase writer slots; divide by 2 for peer count).
  onWritersUpdate(cb) { return onEvent('room:writers-update', cb) },

  // ===== DEEP QVAC BRIDGES: delegated inference, RAG, MCP tools =====
  //
  // Delegated inference (bare/delegatedProvider.js).
  delegated: {
    list() { return writeMain('delegated:list', {}) },
    ping(pubkey) {
      if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) {
        throw new RangeError('pubkey must be 64-char hex')
      }
      return writeMain('delegated:ping', { pubkey: pubkey.toLowerCase() })
    },
    setFirewall(cfg) {
      const mode = cfg && cfg.mode === 'deny' ? 'deny' : 'allow'
      const publicKeys = Array.isArray(cfg && cfg.publicKeys)
        ? cfg.publicKeys.filter((k) => typeof k === 'string' && /^[0-9a-f]{64}$/i.test(k))
        : []
      return writeMain('delegated:set-firewall', { mode, publicKeys })
    },
    snapshot() { return writeMain('delegated:snapshot', {}) },
    onList:     (cb) => onEvent('delegated:list', cb),
    onPinged:   (cb) => onEvent('delegated:pinged', cb),
    onStarted:  (cb) => onEvent('delegated:started', cb),
    onError:    (cb) => onEvent('delegated:error', cb)
  },

  // RAG bridge (bare/rag.js).
  rag: {
    search(query, opts) {
      if (typeof query !== 'string' || query.length === 0 || query.length > 1024) {
        throw new RangeError('query must be 1-1024 chars')
      }
      const clean = { query }
      if (opts && typeof opts.topK === 'number') clean.topK = Math.max(1, Math.min(10, opts.topK | 0))
      if (opts && typeof opts.kind === 'string') clean.kind = opts.kind.slice(0, 32)
      return writeMain('rag:search', clean)
    },
    ingest(docs, opts) {
      const arr = Array.isArray(docs) ? docs.filter((d) => typeof d === 'string') : []
      if (arr.length === 0) throw new RangeError('docs must be non-empty string array')
      const clean = { docs: arr.slice(0, 128) }
      if (opts && typeof opts.kind === 'string') clean.kind = opts.kind.slice(0, 32)
      return writeMain('rag:ingest', clean)
    },
    status() { return writeMain('rag:status', {}) },
    onReady:    (cb) => onEvent('rag:ready', cb),
    onError:    (cb) => onEvent('rag:error', cb),
    onProgress: (cb) => onEvent('rag:progress', cb)
  },

  // MCP tools bridge (bare/mcpTools.js).
  mcp: {
    listTools() { return writeMain('mcp:list', {}) },
    callTool(name, args) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new RangeError('name required')
      }
      return writeMain('mcp:call', { name: name.slice(0, 64), args: args || {} })
    }
  },

  // ===== VOICE COACH (Cup Final) =====
  // Push-to-talk STT + RAG + LLM + MCP + TTS pipeline. Every method delegates
  // to the Bare worker's voiceCoach factory (bare/voiceCoach.js). Bridge stays
  // silent when the worker cannot construct a coach (commentator not loaded).
  voiceCoach: {
    startTurn() { return writeMain('voice:start-turn', {}) },
    pushAudio(pcm) {
      // Accept Uint8Array / Int16Array / Float32Array / ArrayBuffer / Buffer.
      // Encoded as base64 for the JSON wire (matches the bare-side b4a decode).
      if (pcm == null) throw new TypeError('pcm chunk required')
      let bytes = null
      if (pcm instanceof ArrayBuffer) bytes = new Uint8Array(pcm)
      else if (pcm instanceof Uint8Array) bytes = pcm
      else if (pcm instanceof Int16Array || pcm instanceof Float32Array) {
        bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      } else if (Buffer.isBuffer && Buffer.isBuffer(pcm)) bytes = pcm
      else throw new TypeError('unsupported pcm chunk type')
      // Envelope: hard cap on IPC frame size to prevent renderer runaway.
      // 128 KB per push is ~2s of 16 kHz f32 mono; well above the ~200 ms
      // cadence VoiceCoachPanel emits at.
      if (bytes.byteLength > 128 * 1024) {
        throw new RangeError('pcm chunk too large (>128KB)')
      }
      return writeMain('voice:push-audio', { pcm: toBase64(bytes) })
    },
    endTurn(opts) { return writeMain('voice:end-turn', opts || {}) },
    status() { return writeMainAwait('voice:status', {}) },
    // Generic subscription helper. VoiceCoachPanel calls .on(evt, cb) with the
    // full `voice:*` event name, so we forward directly.
    on(evt, cb) {
      if (typeof evt !== 'string' || evt.length === 0) throw new TypeError('evt required')
      if (typeof cb !== 'function') throw new TypeError('cb required')
      return onEvent(evt, cb)
    },
    onTurnStarted:       (cb) => onEvent('voice:turn-started', cb),
    onTranscriptPartial: (cb) => onEvent('voice:transcript-partial', cb),
    onTranscriptFinal:   (cb) => onEvent('voice:transcript-final', cb),
    onVad:               (cb) => onEvent('voice:vad', cb),
    onEndOfTurn:         (cb) => onEvent('voice:endOfTurn', cb),
    onAnswerToken:       (cb) => onEvent('voice:answer-token', cb),
    onToolCall:          (cb) => onEvent('voice:tool-call', cb),
    onStats:             (cb) => onEvent('voice:stats', cb),
    onGrounded:          (cb) => onEvent('voice:grounded', cb),
    onDone:              (cb) => onEvent('voice:done', cb),
    onError:             (cb) => onEvent('voice:error', cb),
    onAudioCap:          (cb) => onEvent('voice:audio-cap', cb),
    // wave-final QVAC depth F1: best-effort cancel of an in-flight completion.
    // Fire-and-forget; the worker emits `voice:cancelled` on success. Verified
    // per @qvac/sdk dist/client/api/cancel.d.ts:6-15.
    cancel()             { return writeMain('voice-coach:cancel', {}) },
    onCancelled:         (cb) => onEvent('voice:cancelled', cb),
    // Ship 3 F2: clear the conversational memory ring. Fire-and-forget; the
    // worker emits `voice:memory-cleared` on success. Follow-up user turns
    // start cold (no prior Q/A pairs prepended into the LLM history).
    clearMemory()        { return writeMain('voice-coach:clear-memory', {}) },
    onMemoryCleared:     (cb) => onEvent('voice:memory-cleared', cb)
  },

  // ===== VLM CAPTION (Cup Final) =====
  // SmolVLM2 500M Q8_0 frame captioning. Renderer passes either a data URL
  // (`data:image/png;base64,...`) from VideoPlayer.captureFrame OR a raw
  // base64 string; the bare-side handler strips the data-URL header before
  // decoding.
  vlm: {
    caption(dataUrlOrBufferBase64, opts) {
      if (typeof dataUrlOrBufferBase64 !== 'string' || dataUrlOrBufferBase64.length === 0) {
        throw new RangeError('image (data URL or base64) required')
      }
      // Defense-in-depth: cap the base64 body at ~14 MB (roughly 10 MB raw
      // image after decoding). The bare-side vlmCaption also enforces
      // MAX_IMAGE_BYTES=10MB, so this is belt-and-suspenders.
      if (dataUrlOrBufferBase64.length > 14 * 1024 * 1024) {
        throw new RangeError('image payload too large')
      }
      return writeMainAwait('vlm:caption', { image: dataUrlOrBufferBase64, opts: opts || {} })
    },
    onLoading:  (cb) => onEvent('vlm:loading', cb),
    onLoaded:   (cb) => onEvent('vlm:loaded', cb),
    onProgress: (cb) => onEvent('vlm:progress', cb),
    onToken:    (cb) => onEvent('vlm:caption-token', cb),
    onError:    (cb) => onEvent('vlm:error', cb),
    onResult:   (cb) => onEvent('vlm:result', cb)
  },

  // ===== OCR (Cup Final) =====
  // OCR_LATIN jersey / scoreboard reader. Same payload contract as vlm.caption.
  ocr: {
    read(dataUrlOrBufferBase64, opts) {
      if (typeof dataUrlOrBufferBase64 !== 'string' || dataUrlOrBufferBase64.length === 0) {
        throw new RangeError('image (data URL or base64) required')
      }
      if (dataUrlOrBufferBase64.length > 14 * 1024 * 1024) {
        throw new RangeError('image payload too large')
      }
      return writeMainAwait('ocr:read', { image: dataUrlOrBufferBase64, opts: opts || {} })
    },
    onLoading:  (cb) => onEvent('ocr:loading', cb),
    onLoaded:   (cb) => onEvent('ocr:loaded', cb),
    onProgress: (cb) => onEvent('ocr:progress', cb),
    onError:    (cb) => onEvent('ocr:error', cb),
    onResult:   (cb) => onEvent('ocr:result', cb)
  },

  // ===== DIAGNOSTICS (Cup Final) =====
  // Two-way bridge for the DiagnosticsPanel (Metrics + Logs). status() returns
  // { observabilityEnabled, promStarted, port, enabled, reason }; metrics()
  // returns { text|null } where `text` is the raw Prometheus exposition body.
  diagnostics: {
    status()  { return writeMainAwait('diagnostics:status', {}) },
    async metrics() {
      const res = await writeMainAwait('diagnostics:metrics', {})
      return (res && typeof res.text === 'string') ? res.text : null
    },
    onLog: (cb) => onEvent('diagnostics:log', cb),
    // wave-final QVAC depth F2: generate a full peer-side diagnostic report
    // via @qvac/diagnostics. Returns the serialized JSON string on success or
    // null on failure — DiagnosticsPanel handles both. Verified per
    // node_modules/@qvac/diagnostics/index.d.ts:132-159.
    async generateReport() {
      const res = await writeMainAwait('diagnostics:generate-report', {})
      if (res && res.ok === true && typeof res.json === 'string') return res.json
      return null
    }
  },

  // ===== SCOPED CHAT SYSTEM SEND (Cup Final) =====
  // Restricted to the coach + VLM + OCR system message types. Every other
  // system:* type must continue to be authored by its owning subsystem inside
  // the worker so this bridge never widens the trust surface.
  chat: {
    // Wave 3: Autobase checkpoint helpers. `getVersions` returns the last N
    // version markers; `historyAt` reads chat history rewound to a specific
    // version. Both are read-only surfaces on top of `chat.checkoutAt(...)`.
    getVersions({ limit = 32 } = {}) {
      const l = Math.min(200, Math.max(1, Number(limit) || 32))
      return writeMainAwait('chat:versions', { limit: l })
    },
    historyAt({ from = 0, limit = 100, at } = {}) {
      const f = Number.isFinite(Number(from)) && from >= 0 ? Number(from) : 0
      const lim = Math.min(500, Math.max(1, Number(limit) || 100))
      if (at === undefined || at === null) {
        return writeMainAwait('chat:history-at', { from: f, limit: lim })
      }
      const a = Number(at)
      if (!Number.isFinite(a) || a < 0) {
        throw new RangeError('at must be a non-negative number')
      }
      return writeMainAwait('chat:history-at', { from: f, limit: lim, at: a })
    },
    onVersionMarker: (cb) => onEvent('chat:version-marker', cb),

    async sendSystem(msg) {
      if (!msg || typeof msg !== 'object') throw new TypeError('msg required')
      const ALLOWED = new Set([
        'system:coach', 'system:vlm-caption', 'system:ocr-read',
        // Wave 3: ask-the-frame answer + goal-card structured extract.
        'system:ask-frame-answer', 'system:goal-card'
      ])
      if (!ALLOWED.has(msg.type)) {
        throw new RangeError('chat.sendSystem: type not in allowlist')
      }
      if (typeof msg.text !== 'string' || msg.text.length === 0) {
        throw new RangeError('text required')
      }
      const caps = {
        'system:coach': 800,
        'system:vlm-caption': 800,
        'system:ocr-read': 500,
        'system:ask-frame-answer': 800,
        'system:goal-card': 800
      }
      if (msg.text.length > caps[msg.type]) {
        throw new RangeError('text exceeds cap for ' + msg.type)
      }
      const matchTimeMs = Number(msg.match_time_ms ?? msg.matchTimeMs ?? 0)
      if (!Number.isFinite(matchTimeMs) || matchTimeMs < 0) {
        throw new RangeError('match_time_ms must be a non-negative number')
      }
      const clean = { type: msg.type, text: msg.text, match_time_ms: Math.floor(matchTimeMs) }
      if (msg.type === 'system:coach') {
        if (msg.kind !== undefined) {
          if (typeof msg.kind !== 'string' || msg.kind.length > 32) throw new RangeError('kind must be string <=32 chars')
          clean.kind = msg.kind
        }
        if (msg.stop_reason !== undefined) {
          if (typeof msg.stop_reason !== 'string' || msg.stop_reason.length > 32) throw new RangeError('stop_reason must be string <=32 chars')
          clean.stop_reason = msg.stop_reason
        }
        if (msg.tool_calls !== undefined) {
          if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length > 8) {
            throw new RangeError('tool_calls must be array (max 8)')
          }
          clean.tool_calls = msg.tool_calls
        }
      }
      return writeMain('chat:send-system', clean)
    }
  },

  // ===== WAVE 3: VOICE CLONE =====
  // Chatterbox voice-cloned commentator. Enroll a reference WAV once, then
  // speak() in EN or IT with the enrolled voice. Feature-flag gated behind
  // CURVA_VOICE_CLONE_ENABLED. Every method returns { ok, ... } shapes.
  voiceClone: {
    // Accept either { pcmBase64: string } OR { audioPath: string }. For the
    // renderer the PCM path is the primary path; audioPath is left in for
    // local dev tools and stays behind the same worker-side sanitizer.
    enroll(pcmOrPath) {
      if (pcmOrPath == null) throw new TypeError('pcm bytes or path required')
      const payload = {}
      if (typeof pcmOrPath === 'string') {
        // Treat as a filesystem path; the worker validates it lives in its dir.
        if (pcmOrPath.length === 0 || pcmOrPath.length > 1024) {
          throw new RangeError('audioPath length 1-1024 chars')
        }
        payload.audioPath = pcmOrPath
      } else if (pcmOrPath instanceof ArrayBuffer) {
        payload.pcmBase64 = toBase64(new Uint8Array(pcmOrPath))
      } else if (pcmOrPath instanceof Uint8Array || (Buffer.isBuffer && Buffer.isBuffer(pcmOrPath))) {
        payload.pcmBase64 = toBase64(pcmOrPath)
      } else {
        throw new TypeError('unsupported pcm type')
      }
      // 4 MiB reference cap mirrors bare/voiceClone.js MAX_REFERENCE_BYTES.
      if (payload.pcmBase64 && payload.pcmBase64.length > 6 * 1024 * 1024) {
        throw new RangeError('reference audio too large')
      }
      return writeMainAwait('voice-clone:enroll', payload)
    },
    speak({ text, locale = 'en' } = {}) {
      if (typeof text !== 'string' || text.length === 0) {
        throw new RangeError('text required')
      }
      if (text.length > 800) throw new RangeError('text too long (max 800)')
      const loc = String(locale).toLowerCase().slice(0, 2)
      // Chatterbox subset enforced worker-side; we allowlist EN/IT here for a
      // fast fail on obvious mistakes. Non-supported locales still return
      // { ok: false, code } from the worker for robustness.
      if (!['en', 'it'].includes(loc)) {
        throw new RangeError('locale must be en or it')
      }
      return writeMainAwait('voice-clone:speak', { text, locale: loc })
    },
    status() { return writeMainAwait('voice-clone:status', {}) },
    onEnrolled:   (cb) => onEvent('voiceClone:enrolled', cb),
    onSpeakStart: (cb) => onEvent('voiceClone:speak-start', cb),
    onSpeakDone:  (cb) => onEvent('voiceClone:speak-done', cb),
    onError:      (cb) => onEvent('voiceClone:error', cb)
  },

  // ===== F4 SEMIFINAL: VIP ROOM RESERVATION =====
  // x402 paid-resource on `POST /vip/reserve`. Peer signs an EIP-3009
  // transferWithAuthorization for 5 USDT to the sponsor address; backend
  // facilitator settles + writes reservation to Prisma with @unique slug and
  // @unique txHash. The wire is byte-identical to any other x402 route; see
  // backend/src/routes/vipRoutes.ts and pear-app/bare/x402Client.js.
  //
  // Slug shape: ^[a-z0-9-]{3,32}$ (server normalises via bare/x402Client.js
  // VIP_SLUG_RE). Fails open on backend outage; the reservation is a
  // signaling layer + directory hint, not P2P access control.
  vip: {
    reserve(slug) {
      if (typeof slug !== 'string' || slug.length === 0) throw new RangeError('slug required')
      if (slug.length > 32) throw new RangeError('slug too long (max 32)')
      return writeMainAwait('vip:reserve', { slug })
    },
    status(slug) {
      if (typeof slug !== 'string' || slug.length === 0) throw new RangeError('slug required')
      return writeMainAwait('vip:status', { slug })
    },
    onReserved: (cb) => onEvent('vip:reserved', cb),
    onError:    (cb) => onEvent('vip:error',    cb)
  },

  // ===== WAVE 3: GOAL CARD =====
  // LLM structured extraction (json_schema mode). Feed a scoreboard blob,
  // receive a { minute, scorer, team, assist } card. Feature-flag:
  // CURVA_GOAL_CARD_ENABLED.
  goalCard: {
    parse(text) {
      if (typeof text !== 'string' || text.length === 0) {
        throw new RangeError('text required')
      }
      if (text.length > 2000) throw new RangeError('text too long (max 2000)')
      return writeMainAwait('goal-card:parse', { text })
    },
    status() { return writeMainAwait('goal-card:status', {}) },
    onParsed: (cb) => onEvent('goalcard:parsed', cb),
    onError:  (cb) => onEvent('goalcard:error', cb)
  },

  // ===== WAVE 3: LANG DETECT =====
  // langdetect-text auto-routing over EN/IT/ID with a 0.6 confidence floor.
  // Feature-flag: CURVA_LANGDETECT_ENABLED.
  langDetect: {
    detect(text) {
      if (typeof text !== 'string' || text.length === 0) {
        throw new RangeError('text required')
      }
      if (text.length > 4000) throw new RangeError('text too long (max 4000)')
      return writeMainAwait('lang-detect:detect', { text })
    },
    status()   { return writeMainAwait('lang-detect:status', {}) },
    onDetected: (cb) => onEvent('langdetect:detected', cb)
  },

  // ===== WAVE 3: ASK THE FRAME =====
  // Combined VLM + RAG + LLM + optional TTS/MCP orchestration. `ask()` accepts
  // a data-URL / base64 image plus a question and returns the composed answer.
  // Feature-flag: CURVA_ASK_FRAME_ENABLED.
  askFrame: {
    ask({ image, question, matchTimeMs } = {}) {
      if (typeof image !== 'string' || image.length === 0) {
        throw new RangeError('image (data URL or base64) required')
      }
      if (image.length > 14 * 1024 * 1024) {
        throw new RangeError('image payload too large')
      }
      if (typeof question !== 'string' || question.length === 0) {
        throw new RangeError('question required')
      }
      if (question.length > 500) throw new RangeError('question too long (max 500)')
      const mtm = Number(matchTimeMs)
      const cleanMtm = Number.isFinite(mtm) && mtm >= 0 ? mtm : 0
      return writeMainAwait('ask-frame:ask', { image, question, matchTimeMs: cleanMtm })
    },
    status()      { return writeMainAwait('ask-frame:status', {}) },
    // wave-final QVAC depth F1: best-effort cancel of a streaming ask. Fire
    // and forget. Worker emits `askframe:cancelled` on success. Verified per
    // @qvac/sdk dist/client/api/cancel.d.ts:6-15.
    cancel()      { return writeMain('ask-frame:cancel', {}) },
    onStarted:    (cb) => onEvent('askframe:start', cb),
    onCaption:    (cb) => onEvent('askframe:caption', cb),
    onToken:      (cb) => onEvent('askframe:token', cb),
    onToolCall:   (cb) => onEvent('askframe:tool-call', cb),
    onDone:       (cb) => onEvent('askframe:done', cb),
    onCancelled:  (cb) => onEvent('askframe:cancelled', cb),
    onError:      (cb) => onEvent('askframe:error', cb)
  },

  // ===== WAVE 3: DIARIZATION =====
  // Parakeet Sortformer streaming diarized STT. Push PCM chunks, receive
  // per-turn speaker tags. Feature-flag: CURVA_DIARIZE_ENABLED.
  diarize: {
    start(opts) {
      const resetTable = !!(opts && opts.resetTable)
      return writeMainAwait('diarize:start', { resetTable })
    },
    push(pcm) {
      if (pcm == null) throw new TypeError('pcm chunk required')
      let bytes = null
      if (pcm instanceof ArrayBuffer) bytes = new Uint8Array(pcm)
      else if (pcm instanceof Uint8Array) bytes = pcm
      else if (pcm instanceof Int16Array || pcm instanceof Float32Array) {
        bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      } else if (Buffer.isBuffer && Buffer.isBuffer(pcm)) bytes = pcm
      else throw new TypeError('unsupported pcm chunk type')
      // Same 128 KB envelope as voiceCoach.pushAudio; ~2s of 16 kHz f32 mono.
      if (bytes.byteLength > 128 * 1024) {
        throw new RangeError('pcm chunk too large (>128KB)')
      }
      return writeMainAwait('diarize:push', { pcm: toBase64(bytes) })
    },
    end()   { return writeMainAwait('diarize:end', {}) },
    table() { return writeMainAwait('diarize:table', {}) },
    onTurn:         (cb) => onEvent('diarize:turn', cb),
    onSpeakerAdded: (cb) => onEvent('diarize:speaker-added', cb),
    onSessionDone:  (cb) => onEvent('diarize:session-ended', cb),
    onError:        (cb) => onEvent('diarize:error', cb)
  },

  // ===== WAVE 3: SEMANTIC SEARCH =====
  // In-memory embed()-backed vector search. Feature-flag: CURVA_SEMSEARCH_ENABLED.
  semSearch: {
    index({ id, text } = {}) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new RangeError('id required')
      }
      if (id.length > 128) throw new RangeError('id too long (max 128)')
      if (typeof text !== 'string' || text.length === 0) {
        throw new RangeError('text required')
      }
      if (text.length > 4000) throw new RangeError('text too long (max 4000)')
      return writeMainAwait('semsearch:index', { id, text })
    },
    search({ query, topK } = {}) {
      if (typeof query !== 'string' || query.length === 0) {
        throw new RangeError('query required')
      }
      if (query.length > 500) throw new RangeError('query too long (max 500)')
      const payload = { query }
      if (topK !== undefined) {
        const k = Number(topK)
        if (!Number.isFinite(k) || k < 1 || k > 50) {
          throw new RangeError('topK must be 1-50')
        }
        payload.topK = k | 0
      }
      return writeMainAwait('semsearch:search', payload)
    },
    remove({ id } = {}) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new RangeError('id required')
      }
      return writeMainAwait('semsearch:remove', { id })
    },
    onIndexed:  (cb) => onEvent('semsearch:indexed', cb),
    onSearched: (cb) => onEvent('semsearch:searched', cb),
    onError:    (cb) => onEvent('semsearch:error', cb)
  },

  // ===== WAVE 4B: MODEL REGISTRY =====
  // Bridge to bare/observability.js getModelSnapshot + sdk.unloadModel.
  // list() returns the current snapshot of every known model (KNOWN_MODELS in
  // workers/main.js). unload(modelId) sends the SDK a targeted unload; the
  // worker validates the id is currently loaded before calling.
  models: {
    list() { return writeMainAwait('models:list', {}) },
    unload(modelId) {
      if (typeof modelId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(modelId)) {
        throw new RangeError('modelId must match ^[A-Za-z0-9_-]{1,128}$')
      }
      return writeMainAwait('models:unload', { modelId })
    },
    // Wave 4 F2 addendum: per-model log tail. Opens sdk.loggingStream({id: modelId})
    // in the Bare worker (see workers/main.js models:tail-logs handler) and pipes
    // every entry back over the models:tail-log event stream. The DiagnosticsPanel
    // Models tab drilldown drawer consumes these events.
    // Docs: node_modules/@qvac/sdk/dist/client/api/logging-stream.d.ts:23
    tailLogs(modelId) {
      if (typeof modelId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(modelId)) {
        throw new RangeError('modelId must match ^[A-Za-z0-9_-]{1,128}$')
      }
      return writeMainAwait('models:tail-logs', { modelId })
    },
    stopTail(modelId) {
      if (typeof modelId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(modelId)) {
        throw new RangeError('modelId must match ^[A-Za-z0-9_-]{1,128}$')
      }
      return writeMainAwait('models:stop-tail', { modelId })
    },
    onList:        (cb) => onEvent('models:list', cb),
    onUnloaded:    (cb) => onEvent('models:unloaded', cb),
    onError:       (cb) => onEvent('models:error', cb),
    onTailLog:     (cb) => onEvent('models:tail-log', cb),
    onTailStarted: (cb) => onEvent('models:tail-started', cb),
    onTailStopped: (cb) => onEvent('models:tail-stopped', cb)
  },

  // ===== WAVE 4A: GOAL PIPELINE =====
  // Bridge to bare/goalPipeline.js. `trigger` runs OCR -> goalCard -> MCP
  // update -> translate -> streaming TTS -> chat append against a captured
  // frame. Feature-flag: CURVA_GOAL_PIPELINE_ENABLED. Every dep (ocr,
  // goalCard, mcp, translator, announcer, chat) must be available on the
  // worker side or the handler emits NOT_READY.
  goalPipeline: {
    trigger({ image, currentScore } = {}) {
      if (typeof image !== 'string' || image.length === 0) {
        throw new RangeError('image (data URL or base64) required')
      }
      // Match the VLM/OCR bridge cap: 14 MB base64 body (~10 MB raw). The
      // bare-side handlers also enforce this via decodeImagePayload upstream.
      if (image.length > 14 * 1024 * 1024) {
        throw new RangeError('image payload too large (max ~14 MB base64)')
      }
      const payload = { image }
      if (currentScore !== undefined && currentScore !== null) {
        if (typeof currentScore !== 'string' || currentScore.length > 128) {
          throw new RangeError('currentScore must be string (<=128 chars)')
        }
        payload.currentScore = currentScore
      }
      return writeMainAwait('goal-pipeline:trigger', payload)
    },
    status() { return writeMainAwait('goal-pipeline:status', {}) },
    onParsed:       (cb) => onEvent('goalpipe:parsed', cb),
    onTranslated:   (cb) => onEvent('goalpipe:translated', cb),
    onTtsOpen:      (cb) => onEvent('goalpipe:tts-open', cb),
    onTtsEnd:       (cb) => onEvent('goalpipe:tts-end', cb),
    onChatAppended: (cb) => onEvent('goalpipe:chat-append', cb),
    onError:        (cb) => onEvent('goalpipe:error', cb),
    onResult:       (cb) => onEvent('goalpipe:result', cb)
  },

  // ===== QVAC SHIP 3 F3: MATCH RECAP =====
  // Bridge to bare/matchRecap.js. `generate` reads the room's chat +
  // goal + tip history, produces a 60-word Qwen3 recap, per-locale
  // Bergamot translation + Chatterbox/Supertonic TTS, persists audio
  // as a Hyperblob, and appends a `system:match-recap` chat message.
  matchRecap: {
    generate({ audience } = {}) {
      const payload = {}
      if (audience !== undefined && audience !== null) {
        if (typeof audience !== 'object' || Array.isArray(audience)) {
          throw new TypeError('audience must be an object')
        }
        // Whitelist a single narrow field so a broken renderer can't smuggle
        // arbitrary state through this bridge. `focusTeam` is the only
        // audience filter matchRecap.bucketRows knows about.
        const focusTeam = typeof audience.focusTeam === 'string'
          ? audience.focusTeam.slice(0, 32) : null
        if (focusTeam) payload.audience = { focusTeam }
      }
      return writeMainAwait('match-recap:generate', payload)
    },
    status() { return writeMainAwait('match-recap:status', {}) },
    onGenerated:  (cb) => onEvent('recap:generated', cb),
    onText:       (cb) => onEvent('recap:text', cb),
    onLocale:     (cb) => onEvent('recap:locale', cb),
    onBucketed:   (cb) => onEvent('recap:bucketed', cb),
    onAppended:   (cb) => onEvent('recap:appended', cb),
    onError:      (cb) => onEvent('recap:error', cb),
    onDone:       (cb) => onEvent('recap:done', cb)
  },

  // ===== F6 ROOM SEARCH =====
  // Semantic search over the room's own applied chat log. All work runs
  // on-device via QVAC embed + ragSearch (see bare/roomSearch.js). Every
  // input is validated + length-capped at the preload boundary; the worker
  // re-validates as defense in depth.
  roomSearch: {
    async search({ query, k } = {}) {
      if (typeof query !== 'string') throw new TypeError('query must be a string')
      if (query.length === 0) return { hits: [], reason: 'EMPTY_QUERY' }
      if (query.length > 500) {
        throw new RangeError('query max 500 chars')
      }
      const payload = { query }
      if (k !== undefined && k !== null) {
        if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0 || k > 25) {
          throw new RangeError('k must be 1..25')
        }
        payload.k = Math.floor(k)
      }
      const res = await writeMainAwait('room-search:search', payload)
      return res || { hits: [] }
    },
    async status() {
      return writeMainAwait('room-search:status', {})
    },
    onResults: (cb) => onEvent('room-search:results', cb),
    onStatus:  (cb) => onEvent('room-search:status', cb),
    onReindexed: (cb) => onEvent('room-search:reindexed', cb)
  },
  // ===== END F6 ROOM SEARCH =====

  // ===== F8 NATIVE DESKTOP NOTIFICATIONS =====
  // Bridge to electron/notifications.js via ipcMain.handle('notify:show').
  // Renderer triggers a notification when window is unfocused and a
  // demo-relevant event fires (goal, tip, mention). Click routes back to
  // the renderer via curva.notifications.onFocusRoom.
  notifications: {
    async show({ kind, roomSlug, title, body, silent, urgency } = {}) {
      if (typeof kind !== 'string' || kind.length === 0 || kind.length > 32) {
        throw new RangeError('kind must be a non-empty short string')
      }
      if (typeof title !== 'string' || title.length === 0) {
        throw new RangeError('title required')
      }
      if (title.length > 200) throw new RangeError('title max 200 chars')
      if (body !== undefined && body !== null && (typeof body !== 'string' || body.length > 400)) {
        throw new RangeError('body must be string (max 400 chars)')
      }
      if (roomSlug !== undefined && roomSlug !== null) {
        if (typeof roomSlug !== 'string' || roomSlug.length === 0 || roomSlug.length > 128) {
          throw new RangeError('roomSlug max 128 chars')
        }
      }
      const payload = { kind, title }
      if (body) payload.body = body
      if (roomSlug) payload.roomSlug = roomSlug
      if (silent === true) payload.silent = true
      if (typeof urgency === 'string' && urgency.length <= 16) payload.urgency = urgency
      return ipcRenderer.invoke('notify:show', payload)
    },
    async status() {
      return ipcRenderer.invoke('notify:status')
    },
    // Subscribe to focus-room click routing. The Electron main process sends
    // 'curva:notification:focus-room' when the user clicks a notification.
    onFocusRoom(cb) {
      if (typeof cb !== 'function') throw new TypeError('cb must be a function')
      const wrap = (_evt, payload) => {
        if (!payload || typeof payload !== 'object') return
        cb(payload)
      }
      ipcRenderer.on('curva:notification:focus-room', wrap)
      return () => ipcRenderer.removeListener('curva:notification:focus-room', wrap)
    }
  },
  // ===== END F8 NOTIFICATIONS =====

  // ===== SHIP 3 F7 AUTO HIGHLIGHT =====
  // Bridge to bare/highlightPipeline.js. `tick` runs MobileNetV3 pre-filter
  // -> SmolVLM2 classify -> Qwen3 summariser -> debounce -> per-locale
  // translate + TTS -> chat append against a captured frame.
  // Feature flag: CURVA_AUTO_HIGHLIGHT_ENABLED. Every dep is checked worker-
  // side or NOT_READY is emitted.
  highlightPipeline: {
    tick({ image, currentScore, matchTimeMs } = {}) {
      if (typeof image !== 'string' || image.length === 0) {
        throw new RangeError('image (data URL or base64) required')
      }
      if (image.length > 14 * 1024 * 1024) {
        throw new RangeError('image payload too large (max ~14 MB base64)')
      }
      const p = { image }
      if (currentScore !== undefined && currentScore !== null) {
        if (typeof currentScore !== 'string' || currentScore.length > 128) {
          throw new RangeError('currentScore must be string (<=128 chars)')
        }
        p.currentScore = currentScore
      }
      if (matchTimeMs !== undefined && matchTimeMs !== null) {
        if (typeof matchTimeMs !== 'number' || !Number.isFinite(matchTimeMs) || matchTimeMs < 0) {
          throw new RangeError('matchTimeMs must be a non-negative number')
        }
        p.matchTimeMs = matchTimeMs
      }
      return writeMainAwait('highlight-pipeline:tick', p)
    },
    status() { return writeMainAwait('highlight-pipeline:status', {}) },
    onDetected:     (cb) => onEvent('highlight:detected', cb),
    onTranslated:   (cb) => onEvent('highlight:translated', cb),
    onTtsOpen:      (cb) => onEvent('highlight:tts-open', cb),
    onTtsEnd:       (cb) => onEvent('highlight:tts-end', cb),
    onChatAppended: (cb) => onEvent('highlight:chat-append', cb),
    onError:        (cb) => onEvent('highlight:error', cb),
    onResult:       (cb) => onEvent('highlight:result', cb),
    onDone:         (cb) => onEvent('highlight:done', cb)
  },
  // ===== END SHIP 3 F7 AUTO HIGHLIGHT =====

  // ===== F13 QVAC ASSET SEED MESH =====
  // Bridge to bare/qvacAssetSeed.js. Every peer holds a writable Hyperdrive of
  // QVAC assets they have downloaded and joins a well-known DHT topic per
  // asset so other peers can discover them. resolveAsset returns a loopback
  // blob-server URL when we already have the asset, else null (caller falls
  // back to download). All inputs are re-validated worker-side.
  qvacAssetSeed: {
    resolve({ assetId } = {}) {
      if (typeof assetId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(assetId)) {
        throw new RangeError('assetId must match ^[a-zA-Z0-9-]{1,64}$')
      }
      return writeMainAwait('qvac-asset:resolve', { assetId })
    },
    download({ assetId, registryUrl } = {}) {
      if (typeof assetId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(assetId)) {
        throw new RangeError('assetId must match ^[a-zA-Z0-9-]{1,64}$')
      }
      if (typeof registryUrl !== 'string' || registryUrl.length === 0 || registryUrl.length > 2048) {
        throw new RangeError('registryUrl must be a 1-2048 char string')
      }
      return writeMainAwait('qvac-asset:download', { assetId, registryUrl })
    },
    manifest() {
      return writeMainAwait('qvac-asset:manifest', {})
    },
    onProgress: (cb) => onEvent('qvac-asset:progress', cb),
    onSeeded:   (cb) => onEvent('qvac-asset:seeded', cb),
    onError:    (cb) => onEvent('qvac-asset:error', cb)
  }
  // ===== END F13 QVAC ASSET SEED MESH =====
})

// Allowlist for openExternal. Enforced on BOTH sides — the renderer preload
// checks the URL is https + allowlisted, then Electron main re-validates
// before shelling out. Never open arbitrary URLs the renderer requests.
const EXTERNAL_HOST_ALLOWLIST = new Set([
  'etherscan.io',
  'sepolia.etherscan.io',
  'arbiscan.io',
  'sepolia.arbiscan.io',
  'plasmascan.to',
  'sepolia.plasmascan.to'
])

function isAllowedExternal(url) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    return EXTERNAL_HOST_ALLOWLIST.has(u.hostname.toLowerCase())
  } catch { return false }
}

// Expose openExternal on the curva bridge (validated) so components can
// hand a user click off to the OS default browser.
;(function attachOpenExternal() {
  const curvaWorld = globalThis.curva || null
  // We add it to the curva object below via the same exposeInMainWorld
  // call, so this shim is a no-op — kept for readability.
  void curvaWorld
})()

contextBridge.exposeInMainWorld('bridge', {
  // Version and package info (safe: read from package.json, no secrets).
  // F20 semantic-scrubber jump: minimal playhead namespace exposing
  // scrubTo(matchTimeMs). Distinct from the top-level setPlayhead() which
  // takes a full state object; scrubTo is a single-shot seek shortcut used by
  // the F6 room-search click handler. Both routes end up at the same
  // 'playhead:set' IPC on the worker so there is no double-plumbing.
  playhead: {
    scrubTo(matchTimeMs) {
      if (typeof matchTimeMs !== 'number' || !Number.isFinite(matchTimeMs) || matchTimeMs < 0) {
        throw new RangeError('matchTimeMs must be a finite non-negative number')
      }
      return writeMain('playhead:scrub-to', { matchTimeMs })
    }
  },

  pkg() {
    return ipcRenderer.sendSync('pkg')
  },

  // Boot-time config (room slug, host flag, backend URL, version).
  bootConfig() {
    return ipcRenderer.sendSync('curva:boot-config')
  },

  // OTA update controls (template-provided).
  applyUpdate: () => ipcRenderer.invoke('pear:applyUpdate'),
  appAfterUpdate: () => ipcRenderer.invoke('app:afterUpdate'),

  // Worker lifecycle. `specifier` is a virtual path like '/workers/main.js'.
  startWorker: (specifier) => ipcRenderer.invoke('pear:startWorker', specifier),
  terminateWorker: (specifier) =>
    ipcRenderer.invoke('pear:terminateWorker', specifier),

  // Worker IPC subscriptions. Each returns an unsubscribe function.
  onWorkerStdout: (specifier, listener) => {
    const wrap = (_evt, data) => listener(toBuffer(data))
    ipcRenderer.on('pear:worker:stdout:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:stdout:' + specifier, wrap)
  },
  onWorkerStderr: (specifier, listener) => {
    const wrap = (_evt, data) => listener(toBuffer(data))
    ipcRenderer.on('pear:worker:stderr:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:stderr:' + specifier, wrap)
  },
  onWorkerIPC: (specifier, listener) => {
    const wrap = (_evt, data) => listener(toBuffer(data))
    ipcRenderer.on('pear:worker:ipc:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:ipc:' + specifier, wrap)
  },
  onWorkerExit: (specifier, listener) => {
    const wrap = (_evt, code) => listener(code)
    ipcRenderer.on('pear:worker:exit:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:exit:' + specifier, wrap)
  },

  // Send a JSON message (or string, or Uint8Array) to a Bare worker.
  writeWorkerIPC: (specifier, data) => {
    return ipcRenderer.invoke(
      'pear:worker:writeIPC:' + specifier,
      encodeMessage(data)
    )
  }
})
