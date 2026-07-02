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

contextBridge.exposeInMainWorld('curva', {
  // Room lifecycle.
  joinRoom(slug, isHost) {
    if (typeof slug !== 'string' || slug.length === 0 || slug.length > 64) {
      throw new RangeError('slug must be 1-64 chars')
    }
    return writeMain('room:join', { slug, isHost: !!isHost })
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
    return writeMain('translate:text', { text, from: from.toLowerCase(), to: to.toLowerCase() })
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
    }
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
    onError:     (cb) => onEvent('commentary:error', cb)
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
  }
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
