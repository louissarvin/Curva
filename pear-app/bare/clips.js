// Curva clips: per-peer Hyperdrive + shared Hyperbee index.
//
// Design (ARCHITECTURE.md Section 5.4):
//   - Each peer owns ONE writable Hyperdrive containing their own clips.
//   - A shared Hyperbee (host-owned; here we allow any writer for MVP) indexes
//     both drive keys and clip metadata across all peers.
//   - Other peers replicate a peer's drive read-only via the shared corestore.
//
// The Hyperdrive is created inside the caller-supplied Corestore; replication
// therefore rides on the same swarm-driven corestore replication path that
// Autobase / Hyperbee already use.
//
// Shared index namespaces:
//   drives/<peerKeyHex>       -> { driveKey: '<hex>', registeredAt: ms }
//   clips/<padded_ts>         -> { driveKey, path, match_time_ms, ts, by_peer, caption? }
//
// Cap: 50 clips per peer (MAX_CLIPS_PER_PEER). Attempts beyond throw
// ClipsCapExceeded, which the IPC layer surfaces as a 'clip:error' event.
//
// Security discipline:
//   - Path is always derived server-side (/clips/<ts>.mp4). Caller cannot
//     influence the on-disk filename.
//   - Buffer size cap 50 MiB (MAX_CLIP_BYTES).
//   - Caption sanitized: strip control chars, trim, cap at 200 chars.
//   - by_peer / driveKey validated as lowercase hex.

const Hyperdrive = require('hyperdrive')
const Hyperblobs = require('hyperblobs')
// hypercore-blob-server serves clip bytes over loopback HTTP with RFC 7233
// Range support. Constructor + getLink() signatures verified against
// https://github.com/holepunchto/hypercore-blob-server (index.js on main).
// Optional at load time so brittle tests without the module still boot the
// clips helpers; when missing, getClipLink returns a structured unavailable
// error instead of throwing at import.
let HypercoreBlobServer = null
try { HypercoreBlobServer = require('hypercore-blob-server') } catch { /* optional */ }
// Dual-runtime module resolution. Bare runtime resolves only `bare-*` names;
// Node (used by brittle tests) does not implement Bare's `require.addon` so
// loading bare-* modules in Node throws. Prefer bare-* at runtime, fall back
// to Node builtins for tests. Both fs+path+crypto+os are only invoked inside
// the ffmpeg thumbnail path; on Bare startup only the require needs to succeed.
function _tryRequire (bareId, nodeId) {
  try { return require(bareId) } catch { return require(nodeId) }
}
const { spawn } = _tryRequire('bare-subprocess', 'child_process')
const fs = _tryRequire('bare-fs', 'fs')
const os = _tryRequire('bare-os', 'os')
const path = _tryRequire('bare-path', 'path')
const crypto = _tryRequire('bare-crypto', 'crypto')

const MAX_CLIPS_PER_PEER = 50
const MAX_CLIP_BYTES = 50 * 1024 * 1024 // 50 MiB
const MAX_CAPTION_CHARS = 200

const THUMB_W = 128
const THUMB_H = 72
const FFMPEG_TIMEOUT_MS = 10_000
const FFMPEG_MAX_OUTPUT_BYTES = 512 * 1024 // 512 KiB is plenty for a 128x72 JPEG
const PLACEHOLDER_MAX_BYTES = 8 * 1024

/**
 * @param {Corestore} store  parent corestore (namespaced internally)
 * @param {{
 *   isHost: boolean,
 *   myPubkey: string,
 *   sharedIndex: import('hyperbee'),  // shared clip index; caller creates & passes
 * }} opts
 */
async function createClips(store, opts) {
  if (!store) throw new TypeError('store is required')
  if (!opts || typeof opts !== 'object') throw new TypeError('opts required')
  const { isHost = false, myPubkey, sharedIndex, spawnImpl } = opts
  const spawnFn = typeof spawnImpl === 'function' ? spawnImpl : spawn
  // Env flag: 'auto' (default) tries ffmpeg then falls back; 'off' forces
  // placeholder. Anything else is treated as 'auto'.
  const thumbMode = (process.env.CURVA_CLIP_THUMBS_FFMPEG || 'auto').toLowerCase() === 'off'
    ? 'off'
    : 'auto'
  if (typeof myPubkey !== 'string' || myPubkey.length === 0) {
    throw new RangeError('myPubkey must be a non-empty string')
  }
  if (!sharedIndex) throw new TypeError('sharedIndex (Hyperbee) is required')

  const namespaced = store.namespace('curva/clips/' + myPubkey.slice(0, 16))
  const myDrive = new Hyperdrive(namespaced)
  await myDrive.ready()
  const myDriveKeyHex = myDrive.key.toString('hex')

  // Task 7: shared Hyperblobs for clip thumbnails. Sits alongside my drive
  // in the same namespaced store. Peers replicate the underlying core via
  // the same corestore replicate() hook the drive uses.
  const myThumbBlobs = new Hyperblobs(namespaced.get({ name: 'clip-thumbs' }))
  await myThumbBlobs.core.ready()
  const myThumbCoreKeyHex = myThumbBlobs.core.key.toString('hex')

  // Peer thumbnail cores we've opened for read.
  const trackedThumbCores = new Map()
  trackedThumbCores.set(myThumbCoreKeyHex, myThumbBlobs)

  // hypercore-blob-server: one instance per corestore, bound to loopback,
  // token-gated. Docs verified against holepunchto/hypercore-blob-server
  // (constructor defaults: host 127.0.0.1, port 49833, anyPort:true, sandbox:true,
  // token = crypto.randomBytes(32) z32-encoded). The token rides on the query
  // string of every URL getLink() returns; it rotates only on process/room
  // lifecycle boundaries (there is no built-in refresh API).
  let blobServer = null
  let blobServerToken = null
  let blobServerReady = false
  if (HypercoreBlobServer) {
    try {
      blobServer = new HypercoreBlobServer(store, {
        host: '127.0.0.1',
        port: 49833,
        anyPort: true,
        sandbox: true
      })
      await blobServer.listen()
      blobServerReady = true
      blobServerToken = blobServer.token
    } catch (err) {
      // Do NOT propagate: the legacy IPC clip:get path still works. Log once.
      console.log(JSON.stringify({
        level: 'warn',
        source: 'curva.clips',
        event: 'blob_server_listen_failed',
        code: err?.code || 'UNKNOWN',
        message: err?.message || 'blob server listen failed'
      }))
      blobServer = null
    }
  }

  // Track peer drives we've opened for read-only access. Key is
  // driveKeyHex; value is the Hyperdrive instance in the SAME store.
  const trackedDrives = new Map()
  trackedDrives.set(myDriveKeyHex, myDrive)

  let myClipCount = 0
  // Count local clips at boot (walking the drive is cheap enough for 50 max).
  try {
    for await (const _entry of myDrive.list('/clips')) {
      myClipCount++
    }
  } catch { /* fresh drive, no /clips yet */ }

  async function publishMyDrive() {
    const key = `drives/${myPubkey}`
    const value = { driveKey: myDriveKeyHex, registeredAt: Date.now() }
    await sharedIndex.put(key, value)
    return value
  }

  /**
   * Register a peer's drive so we can `getClip` from it later. Idempotent.
   * @param {string} peerPubkeyHex
   * @param {string} driveKeyHex
   */
  function trackPeerDrive(peerPubkeyHex, driveKeyHex) {
    if (!isHexOfLen(peerPubkeyHex, 64)) {
      throw new RangeError('peerPubkeyHex must be 64-char hex')
    }
    if (!isHexOfLen(driveKeyHex, 64)) {
      throw new RangeError('driveKeyHex must be 64-char hex')
    }
    if (trackedDrives.has(driveKeyHex)) return trackedDrives.get(driveKeyHex)
    const drive = new Hyperdrive(store.namespace('curva/clips/' + peerPubkeyHex.slice(0, 16)), Buffer.from(driveKeyHex, 'hex'))
    // Fix Wave A T3: signal to Hyperdrive that we are still discovering peers.
    // Without this, drive.get() may return null before ANY peer connects
    // (holepunchto/hyperdrive docs: "requests will be on hold until this is
    // done"). We clear the token asynchronously (fire-and-forget) via a short
    // deferred timeout matching the swarm cold-start budget; the swarm-driven
    // close is opportunistic — the important thing is that findingPeers() is
    // ACTIVE at the moment get() is called after opening the drive.
    try {
      const done = drive.findingPeers()
      setTimeout(() => { try { done() } catch { /* noop */ } }, 5000)
    } catch { /* older hyperdrive without findingPeers */ }
    trackedDrives.set(driveKeyHex, drive)
    return drive
  }

  /**
   * Add a clip: writes bytes to my drive AND writes shared index entry.
   * @param {{ buffer: Buffer|Uint8Array|string, match_time_ms: number, caption?: string }} args
   * @returns {Promise<{ clipId: string, driveKey: string, path: string, ts: number, match_time_ms: number, by_peer: string, caption?: string }>}
   */
  async function addClip({ buffer, match_time_ms, caption } = {}) {
    if (myClipCount >= MAX_CLIPS_PER_PEER) {
      const err = new Error(`clip cap reached (${MAX_CLIPS_PER_PEER})`)
      err.code = 'CLIPS_CAP_EXCEEDED'
      throw err
    }
    if (typeof match_time_ms !== 'number' || match_time_ms < 0) {
      throw new RangeError('match_time_ms must be a non-negative number')
    }
    const buf = coerceBuffer(buffer)
    if (buf.length === 0) throw new RangeError('buffer is empty')
    if (buf.length > MAX_CLIP_BYTES) {
      throw new RangeError(`buffer too large (${buf.length} > ${MAX_CLIP_BYTES})`)
    }
    const cleanCaption = caption ? sanitizeCaption(caption) : undefined

    const ts = Date.now()
    const clipDrivePath = `/clips/${ts}.mp4`

    await myDrive.put(clipDrivePath, buf)

    // Task 7: derive a thumbnail. Preferred path is a real 128x72 JPEG
    // extracted with ffmpeg. When ffmpeg is unavailable, disabled by env,
    // or fails, we fall back to a first-8-KiB placeholder blob so the
    // shared index shape stays consistent across peers.
    let thumbBytes = null
    let thumbMimeType = null
    if (thumbMode !== 'off') {
      try {
        const jpeg = await extractThumbnailFromBuffer(buf, spawnFn)
        if (jpeg && jpeg.length > 0) {
          thumbBytes = jpeg
          thumbMimeType = 'image/jpeg'
        }
      } catch (err) {
        // Single structured warning per failure, then fall through to
        // placeholder. Do NOT rethrow: thumbnails are best-effort polish.
        console.log(JSON.stringify({
          level: 'warn',
          source: 'curva.clips',
          event: 'ffmpeg_thumb_failed',
          code: err?.code || 'UNKNOWN',
          message: err?.message || 'ffmpeg thumbnail extraction failed'
        }))
      }
    }
    if (!thumbBytes) {
      thumbBytes = buf.slice(0, Math.min(PLACEHOLDER_MAX_BYTES, buf.length))
      thumbMimeType = 'application/octet-stream'
    }

    let thumbBlobId = null
    try {
      thumbBlobId = await myThumbBlobs.put(thumbBytes)
    } catch (err) {
      console.log('[Curva] thumbnail put failed:', err?.message)
    }

    const paddedTs = String(ts).padStart(16, '0')
    const key = `clips/${paddedTs}`
    const value = {
      driveKey: myDriveKeyHex,
      path: clipDrivePath,
      match_time_ms: Math.floor(match_time_ms),
      ts,
      by_peer: myPubkey
    }
    if (cleanCaption) value.caption = cleanCaption
    if (thumbBlobId) {
      value.thumb = {
        blobId: thumbBlobId,
        coreKey: myThumbCoreKeyHex,
        bytes: thumbBytes.length,
        mimeType: thumbMimeType
      }
    }

    // Fix Wave A T7: Hyperbee batch keeps the clip index write (and any
    // future coupled writes such as the peer-drive registration entry)
    // atomic against concurrent readers. Even a single-op batch is
    // preferable to a bare put because it commits with a single Merkle-tree
    // append and gives us a clean seam to add more puts (e.g., thumbnail
    // metadata mirrors) without introducing torn writes later.
    const idxBatch = sharedIndex.batch()
    try {
      await idxBatch.put(key, value)
      await idxBatch.flush()
    } catch (err) {
      // Best-effort revert if flush ever fails; do NOT increment clipCount
      // in that case so the caller can retry safely.
      try { if (typeof idxBatch.destroy === 'function') await idxBatch.destroy() } catch { /* noop */ }
      throw err
    }

    myClipCount++
    return { clipId: paddedTs, ...value }
  }

  /**
   * List all known clips (mine + peers') via the shared index.
   * @param {{ limit?: number }} [opts]
   */
  async function listClips({ limit = 200 } = {}) {
    const out = []
    let stream
    try {
      stream = sharedIndex.createReadStream({
        gt: 'clips/',
        lt: 'clips0',
        limit
      })
    } catch (err) {
      return out
    }
    try {
      for await (const entry of stream) {
        if (!entry?.value) continue
        // Defensive validation: reducer output should already be well-formed,
        // but peers can push arbitrary bytes; we discard malformed rows.
        const v = entry.value
        if (!isHexOfLen(v.driveKey, 64)) continue
        if (typeof v.path !== 'string' || !v.path.startsWith('/clips/')) continue
        if (typeof v.ts !== 'number' || v.ts <= 0) continue
        out.push({
          clipId: entry.key.split('/')[1],
          ...v
        })
      }
    } catch (err) { /* stream errored — return what we have */ }
    return out
  }

  /**
   * Fetch clip bytes by driveKey + path. Opens a read-only drive if we haven't
   * seen it before.
   * @param {{ driveKey: string, path: string, byPeer?: string }} args
   * @returns {Promise<Buffer>}
   */
  async function getClip({ driveKey, path, byPeer } = {}) {
    if (!isHexOfLen(driveKey, 64)) throw new RangeError('driveKey must be 64-char hex')
    if (typeof path !== 'string' || !path.startsWith('/clips/')) {
      throw new RangeError('path must start with /clips/')
    }

    let drive = trackedDrives.get(driveKey)
    if (!drive) {
      // Opportunistically open — caller may have missed the trackPeerDrive
      // hook. Use `byPeer` if provided for namespacing, else derive from key.
      const nsHint = byPeer && isHexOfLen(byPeer, 64) ? byPeer.slice(0, 16) : driveKey.slice(0, 16)
      drive = new Hyperdrive(store.namespace('curva/clips/' + nsHint), Buffer.from(driveKey, 'hex'))
      // Fix Wave A T3: WITHOUT findingPeers(), drive.get() below may return
      // null on the first request before any peer has connected. See
      // https://github.com/holepunchto/hyperdrive - the pattern is to hold the
      // discovery token until swarm.flush() resolves, but at this level we
      // only see the drive (not the swarm), so we clear after a bounded
      // timeout matching cold-start expectations.
      try {
        const done = drive.findingPeers()
        setTimeout(() => { try { done() } catch { /* noop */ } }, 5000)
      } catch { /* older hyperdrive without findingPeers */ }
      trackedDrives.set(driveKey, drive)
    }
    await drive.ready()
    const buf = await drive.get(path)
    if (!buf) {
      const err = new Error('clip not found')
      err.code = 'CLIP_NOT_FOUND'
      throw err
    }
    return buf
  }

  /**
   * Task 7: fetch a clip thumbnail's raw bytes. Uses the coreKey stored on
   * the clip index entry to open a read-only Hyperblobs instance if we
   * haven't already.
   *
   * @param {{ coreKey: string, blobId: object }} args
   * @returns {Promise<Buffer|null>}
   */
  async function getClipThumb({ coreKey, blobId } = {}) {
    if (!isHexOfLen(coreKey, 64)) throw new RangeError('coreKey must be 64-char hex')
    if (!blobId || typeof blobId !== 'object') throw new RangeError('blobId required')
    let blobs = trackedThumbCores.get(coreKey)
    if (!blobs) {
      const ns = store.namespace('curva/clips/' + coreKey.slice(0, 16))
      blobs = new Hyperblobs(ns.get({ name: 'clip-thumbs', key: Buffer.from(coreKey, 'hex') }))
      await blobs.core.ready()
      trackedThumbCores.set(coreKey, blobs)
    }
    try { return await blobs.get(blobId) } catch { return null }
  }

  /**
   * Feature 1 (WC reel): publish a local file buffer to the shared drive at
   * /wc-reel/<filename>. Only called by the host peer at room open so all
   * joining peers can replicate and stream via their own blobServer.
   *
   * @param {Buffer} buf       raw bytes of the reel file
   * @param {string} filename  safe filename, e.g. 'reel.mp4' (no path traversal)
   * @returns {Promise<string>} the drive path, e.g. '/wc-reel/reel.mp4'
   */
  async function publishReel(buf, filename) {
    if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) {
      throw new TypeError('publishReel: buf must be a Buffer')
    }
    if (typeof filename !== 'string' || filename.length === 0 || filename.length > 64) {
      throw new RangeError('publishReel: filename must be 1-64 chars')
    }
    // Prevent path traversal: only allow [A-Za-z0-9._-]
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
      throw new RangeError('publishReel: filename contains disallowed characters')
    }
    const drivePath = '/wc-reel/' + filename
    await myDrive.put(drivePath, buf)
    return drivePath
  }

  /**
   * Build an HTTP link the renderer can drop into <video src>. Range-friendly.
   * Verified against getLink() in holepunchto/hypercore-blob-server (main).
   * Returns an unavailable error object when the blob server failed to start
   * or the module was not present in node_modules.
   *
   * @param {string} driveKeyHex - 64-char lowercase hex Hyperdrive key
   * @param {string} blobPath    - drive path, e.g. `/clips/1720290000000.mp4`
   * @returns {{ url: string, token: string, expiresMs: number|null, port: number, host: string }}
   */
  function getClipLink(driveKeyHex, blobPath) {
    if (!isHexOfLen(driveKeyHex, 64)) throw new RangeError('driveKey must be 64-char hex')
    if (typeof blobPath !== 'string' || !blobPath.startsWith('/clips/')) {
      throw new RangeError('path must start with /clips/')
    }
    if (!blobServer || !blobServerReady) {
      const err = new Error('blob server unavailable')
      err.code = 'BLOB_SERVER_UNAVAILABLE'
      throw err
    }
    // Docs pattern: getLink(driveKey, { filename }) resolves the underlying
    // blob core internally and appends &token=<current>. Never expose the raw
    // token separately; it is embedded in the URL query string.
    const url = blobServer.getLink(Buffer.from(driveKeyHex, 'hex'), {
      filename: blobPath,
      mimetype: 'video/mp4'
    })
    return {
      url,
      token: blobServerToken,
      // No built-in expiry inside a session; the token dies with the room.
      expiresMs: null,
      port: blobServer.port,
      host: blobServer.host
    }
  }

  /**
   * Feature 1 (WC reel): build an HTTP link for a /wc-reel/ path on any drive.
   * Same as getClipLink but accepts /wc-reel/ prefix so the path guard doesn't
   * reject it. Only called after publishReel or trackPeerDrive for a reel host.
   *
   * @param {string} driveKeyHex - 64-char lowercase hex key of the publishing drive
   * @param {string} reelPath    - drive path, must start with /wc-reel/
   */
  function getReelLink(driveKeyHex, reelPath) {
    if (!isHexOfLen(driveKeyHex, 64)) throw new RangeError('driveKey must be 64-char hex')
    if (typeof reelPath !== 'string' || !reelPath.startsWith('/wc-reel/')) {
      throw new RangeError('reelPath must start with /wc-reel/')
    }
    if (!blobServer || !blobServerReady) {
      const err = new Error('blob server unavailable')
      err.code = 'BLOB_SERVER_UNAVAILABLE'
      throw err
    }
    const url = blobServer.getLink(Buffer.from(driveKeyHex, 'hex'), {
      filename: reelPath,
      mimetype: 'video/mp4'
    })
    return {
      url,
      token: blobServerToken,
      expiresMs: null,
      port: blobServer.port,
      host: blobServer.host
    }
  }

  async function close() {
    const errs = []
    // Close blob server FIRST so it stops accepting new sockets, then drives.
    // Rotates the in-memory token: the next room open mints a fresh one.
    if (blobServer) {
      try { await blobServer.close() } catch (err) { errs.push(err) }
      blobServer = null
      blobServerToken = null
      blobServerReady = false
    }
    for (const [_k, drive] of trackedDrives) {
      try { await drive.close() } catch (err) { errs.push(err) }
    }
    trackedDrives.clear()
    for (const [_k, blobs] of trackedThumbCores) {
      try { await blobs.core.close() } catch (err) { errs.push(err) }
    }
    trackedThumbCores.clear()
    if (errs.length > 0) {
      const first = errs[0]
      console.log('[Curva] clips close errors:', first?.message)
    }
  }

  return {
    addClip,
    listClips,
    getClip,
    getClipThumb,
    getClipLink,
    getReelLink,
    publishReel,
    publishMyDrive,
    trackPeerDrive,
    myDriveKey: myDriveKeyHex,
    myThumbCoreKey: myThumbCoreKeyHex,
    get blobServerPort() { return blobServer ? blobServer.port : null },
    get blobServerToken() { return blobServerToken },
    get blobServerReady() { return blobServerReady },
    close,
    _internal: {
      getClipCount: () => myClipCount,
      getBlobServer: () => blobServer
    }
  }
}

// -- helpers ---------------------------------------------------------------

function isHexOfLen(str, len) {
  return typeof str === 'string' && str.length === len && /^[0-9a-f]+$/.test(str)
}

function coerceBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input)
  if (typeof input === 'string') return Buffer.from(input, 'utf8')
  if (input && typeof input === 'object' && typeof input.byteLength === 'number') {
    return Buffer.from(input)
  }
  throw new TypeError('buffer must be Buffer / Uint8Array / string')
}

function sanitizeCaption(text) {
  if (typeof text !== 'string') return undefined
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code === 0x0A || code === 0x0D || code === 0x09) { out += ' '; continue }
    if (code < 0x20) continue
    if (code >= 0x80 && code <= 0x9F) continue
    if (code === 0xFEFF) continue
    out += ch
  }
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length > MAX_CAPTION_CHARS) out = out.slice(0, MAX_CAPTION_CHARS)
  return out.length > 0 ? out : undefined
}

/**
 * Extract a 128x72 JPEG thumbnail from a clip buffer via ffmpeg.
 * Writes the buffer to a randomly-named temp file (ffmpeg cannot seek stdin,
 * and `-ss` before `-i` needs a seekable source), runs ffmpeg, reads stdout
 * into a Buffer, and unlinks the temp file no matter what.
 *
 * Fails (rejects) on:
 *   - spawn ENOENT (ffmpeg not on PATH) — caller falls back to placeholder
 *   - non-zero exit code
 *   - 10s wall-clock timeout
 *   - stdout exceeding FFMPEG_MAX_OUTPUT_BYTES (defensive)
 *
 * @param {Buffer} buf         raw clip bytes (already size-capped upstream)
 * @param {typeof spawn} spawnFn  injectable spawn for tests
 * @returns {Promise<Buffer>}  128x72 JPEG bytes
 */
async function extractThumbnailFromBuffer(buf, spawnFn) {
  const tmpPath = path.join(
    os.tmpdir(),
    `curva-clip-${process.pid}-${crypto.randomBytes(8).toString('hex')}.bin`
  )
  await fs.promises.writeFile(tmpPath, buf)
  try {
    return await extractThumbnailFromClipPath(tmpPath, spawnFn)
  } finally {
    fs.promises.unlink(tmpPath).catch(() => { /* noop */ })
  }
}

/**
 * ffmpeg args:
 *   -y                       overwrite output (n/a for pipe, keeps ffmpeg quiet)
 *   -ss 00:00:01             seek 1s in before decoding (fast, keyframe-accurate)
 *   -i <input>               local temp file
 *   -vframes 1               grab exactly one frame
 *   -vf "scale=...,pad=..."  fit inside 128x72 preserving aspect ratio,
 *                            then letterbox to exactly 128x72 with black bars
 *   -q:v 3                   JPEG quality (2-5 is high-quality, 3 is a good default)
 *   -f mjpeg pipe:1          write JPEG bytes to stdout
 */
function extractThumbnailFromClipPath(pathToLocalClipFile, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-ss', '00:00:01',
      '-i', pathToLocalClipFile,
      '-vframes', '1',
      '-vf', `scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=decrease,pad=${THUMB_W}:${THUMB_H}:(ow-iw)/2:(oh-ih)/2:color=black`,
      '-q:v', '3',
      '-f', 'mjpeg',
      'pipe:1'
    ]

    let child
    try {
      child = spawnFn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      // Some spawn stubs may throw synchronously; treat as ENOENT-class.
      const e = new Error(err?.message || 'spawn ffmpeg failed')
      e.code = err?.code || 'FFMPEG_SPAWN_FAILED'
      return reject(e)
    }

    let stdoutBytes = 0
    const stdoutChunks = []
    let stderrText = ''
    let settled = false
    let timedOut = false

    const done = (err, val) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) return reject(err)
      resolve(val)
    }

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* noop */ }
      const e = new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`)
      e.code = 'FFMPEG_TIMEOUT'
      done(e)
    }, FFMPEG_TIMEOUT_MS)

    child.on('error', (err) => {
      // ENOENT (ffmpeg not installed) lands here per node:child_process docs.
      const e = new Error(err?.message || 'ffmpeg spawn error')
      e.code = err?.code || 'FFMPEG_SPAWN_ERROR'
      done(e)
    })

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > FFMPEG_MAX_OUTPUT_BYTES) {
        try { child.kill('SIGKILL') } catch { /* noop */ }
        const e = new Error(`ffmpeg stdout exceeded ${FFMPEG_MAX_OUTPUT_BYTES} bytes`)
        e.code = 'FFMPEG_OUTPUT_TOO_LARGE'
        return done(e)
      }
      stdoutChunks.push(chunk)
    })

    child.stderr.on('data', (chunk) => {
      // Keep only the tail of stderr, we only need it for the error message.
      stderrText = (stderrText + chunk.toString('utf8')).slice(-2048)
    })

    child.on('close', (code, signal) => {
      if (timedOut) return // already rejected
      if (code === 0) {
        const out = Buffer.concat(stdoutChunks)
        if (out.length === 0) {
          const e = new Error('ffmpeg produced empty output')
          e.code = 'FFMPEG_EMPTY_OUTPUT'
          return done(e)
        }
        return done(null, out)
      }
      const e = new Error(`ffmpeg exited with code=${code} signal=${signal}`)
      e.code = 'FFMPEG_NONZERO_EXIT'
      e.stderr = stderrText
      done(e)
    })
  })
}

module.exports = {
  createClips,
  _internal: {
    isHexOfLen,
    sanitizeCaption,
    coerceBuffer,
    extractThumbnailFromClipPath,
    extractThumbnailFromBuffer,
    MAX_CLIPS_PER_PEER,
    MAX_CLIP_BYTES,
    MAX_CAPTION_CHARS,
    THUMB_W,
    THUMB_H,
    FFMPEG_TIMEOUT_MS
  }
}
