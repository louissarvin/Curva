// Phase 2 brittle test: clips (Hyperdrive per peer + shared Hyperbee index).

const test = require('brittle')
const { EventEmitter } = require('node:events')
const Hyperbee = require('hyperbee')
const { makeStore } = require('./_helpers.js')
const { createClips, _internal } = require('../bare/clips.js')

// Fake spawn factory for ffmpeg-fallback tests. `behavior` controls what the
// fake child emits: 'enoent' -> synchronous ENOENT-style error event; 'exit1'
// -> non-zero exit; 'success' -> emits a minimal JPEG on stdout and exits 0;
// 'timeout' -> never exits (kill by test timeout).
function makeFakeSpawn(behavior) {
  return function fakeSpawn(_cmd, _args) {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => {
      if (behavior === 'enoent') {
        const err = new Error('spawn ffmpeg ENOENT')
        err.code = 'ENOENT'
        child.emit('error', err)
        return
      }
      if (behavior === 'exit1') {
        child.stderr.emit('data', Buffer.from('boom'))
        child.emit('close', 1, null)
        return
      }
      if (behavior === 'success') {
        // Minimal fake JPEG magic bytes; real ffmpeg output would be larger
        // but createClips only cares about non-empty Buffer + a Hyperblobs
        // put succeeding, both of which this satisfies.
        child.stdout.emit('data', Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]))
        child.emit('close', 0, null)
        return
      }
      // 'timeout' -> never emits close; test relies on internal timeout kicking in.
    })
    return child
  }
}

async function makeSharedIndex(store) {
  const core = store.namespace('curva/test/shared-index').get({ name: 'idx' })
  const bee = new Hyperbee(core, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await bee.ready()
  return bee
}

const myPubkey = 'aa'.repeat(32) // 64-char hex

test('createClips returns expected surface', async (t) => {
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx })

  t.is(typeof clips.addClip, 'function')
  t.is(typeof clips.listClips, 'function')
  t.is(typeof clips.getClip, 'function')
  t.is(typeof clips.publishMyDrive, 'function')
  t.is(typeof clips.trackPeerDrive, 'function')
  t.is(typeof clips.close, 'function')
  t.is(typeof clips.myDriveKey, 'string')
  t.is(clips.myDriveKey.length, 64, 'driveKey is 64-char hex')

  await clips.close()
  await idx.close()
  await cleanup()
})

test('addClip -> listClips -> getClip round trip', async (t) => {
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx })

  const payload = Buffer.from('fake mp4 bytes ' + 'x'.repeat(200))
  const added = await clips.addClip({
    buffer: payload,
    match_time_ms: 12345,
    caption: 'goal!'
  })

  t.ok(added.clipId, 'clipId present')
  t.is(added.driveKey, clips.myDriveKey)
  t.ok(added.path.startsWith('/clips/'))
  t.is(added.by_peer, myPubkey)
  t.is(added.caption, 'goal!')
  t.is(added.match_time_ms, 12345)

  const list = await clips.listClips()
  t.ok(list.length >= 1, 'list has clip')
  const first = list.find((c) => c.path === added.path)
  t.ok(first, 'clip visible in list')

  const fetched = await clips.getClip({ driveKey: added.driveKey, path: added.path })
  t.ok(Buffer.isBuffer(fetched) || fetched instanceof Uint8Array, 'buffer returned')
  t.is(fetched.length, payload.length, 'byte length matches')
  t.is(Buffer.from(fetched).toString('utf8'), payload.toString('utf8'), 'bytes match')

  await clips.close()
  await idx.close()
  await cleanup()
})

test('publishMyDrive writes drives/<peer> entry', async (t) => {
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx })

  await clips.publishMyDrive()

  const entry = await idx.get(`drives/${myPubkey}`)
  t.ok(entry, 'drive entry present')
  t.is(entry.value.driveKey, clips.myDriveKey)
  t.ok(typeof entry.value.registeredAt === 'number' && entry.value.registeredAt > 0)

  await clips.close()
  await idx.close()
  await cleanup()
})

test('addClip rejects empty buffer', async (t) => {
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx })

  await t.exception.all(
    () => clips.addClip({ buffer: Buffer.alloc(0), match_time_ms: 0 }),
    'empty buffer rejected'
  )

  await clips.close()
  await idx.close()
  await cleanup()
})

test('addClip rejects negative match_time_ms', async (t) => {
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx })

  await t.exception.all(
    () => clips.addClip({ buffer: Buffer.from('x'), match_time_ms: -1 }),
    'negative match_time_ms rejected'
  )

  await clips.close()
  await idx.close()
  await cleanup()
})

test('addClip rejects oversized buffer', async (t) => {
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx })

  // 50 MiB + 1 byte should be rejected.
  const oversized = Buffer.alloc(_internal.MAX_CLIP_BYTES + 1, 0x41)
  await t.exception.all(
    () => clips.addClip({ buffer: oversized, match_time_ms: 0 }),
    'oversized buffer rejected'
  )

  await clips.close()
  await idx.close()
  await cleanup()
})

test('trackPeerDrive rejects malformed keys', async (t) => {
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx })

  t.exception.all(
    () => { clips.trackPeerDrive('not-hex', 'aa'.repeat(32)) },
    'non-hex peer rejected'
  )
  t.exception.all(
    () => { clips.trackPeerDrive('bb'.repeat(32), 'nope') },
    'non-hex driveKey rejected'
  )

  await clips.close()
  await idx.close()
  await cleanup()
})

test('getClip rejects malformed inputs', async (t) => {
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx })

  await t.exception.all(
    () => clips.getClip({ driveKey: 'nope', path: '/clips/1.mp4' }),
    'bad driveKey rejected'
  )
  await t.exception.all(
    () => clips.getClip({ driveKey: 'aa'.repeat(32), path: '/etc/passwd' }),
    'path outside /clips/ rejected'
  )

  await clips.close()
  await idx.close()
  await cleanup()
})

test('sanitizeCaption strips control chars and caps length', (t) => {
  const dirty = 'goal' + String.fromCharCode(0) + '!!!'
  t.is(_internal.sanitizeCaption(dirty), 'goal!!!')

  const long = 'x'.repeat(500)
  t.is(_internal.sanitizeCaption(long).length, _internal.MAX_CAPTION_CHARS)

  t.is(_internal.sanitizeCaption('   '), undefined, 'empty after sanitization returns undefined')
})

test('isHexOfLen validates lowercase hex only', (t) => {
  t.ok(_internal.isHexOfLen('aa'.repeat(32), 64))
  t.absent(_internal.isHexOfLen('AA'.repeat(32), 64), 'uppercase rejected')
  t.absent(_internal.isHexOfLen('nothex', 64))
  t.absent(_internal.isHexOfLen('a'.repeat(63), 64), 'wrong length rejected')
})

test('coerceBuffer handles Buffer, Uint8Array, and string', (t) => {
  const b = _internal.coerceBuffer(Buffer.from('hi'))
  t.is(Buffer.isBuffer(b), true)
  const u = _internal.coerceBuffer(new Uint8Array([104, 105]))
  t.is(Buffer.isBuffer(u), true)
  t.is(u.toString('utf8'), 'hi')
  const s = _internal.coerceBuffer('hi')
  t.is(s.toString('utf8'), 'hi')
  t.exception.all(() => _internal.coerceBuffer(42), 'number rejected')
})

test('CURVA_CLIP_THUMBS_FFMPEG=off uses placeholder (octet-stream)', async (t) => {
  const prev = process.env.CURVA_CLIP_THUMBS_FFMPEG
  process.env.CURVA_CLIP_THUMBS_FFMPEG = 'off'
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  // Spawn stub that would throw if called; proves 'off' short-circuits.
  const boom = () => { throw new Error('spawn must not be called when flag is off') }
  const clips = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx, spawnImpl: boom })

  const added = await clips.addClip({ buffer: Buffer.from('x'.repeat(1024)), match_time_ms: 100 })
  t.ok(added.clipId)

  const list = await clips.listClips()
  const row = list.find((c) => c.clipId === added.clipId)
  t.ok(row?.thumb, 'thumb entry present')
  t.is(row.thumb.mimeType, 'application/octet-stream', 'placeholder mime')
  t.ok(row.thumb.bytes > 0 && row.thumb.bytes <= 8 * 1024, 'placeholder bytes <= 8 KiB')

  await clips.close()
  await idx.close()
  await cleanup()
  if (prev === undefined) delete process.env.CURVA_CLIP_THUMBS_FFMPEG
  else process.env.CURVA_CLIP_THUMBS_FFMPEG = prev
})

test('ffmpeg ENOENT falls back to placeholder', async (t) => {
  const prev = process.env.CURVA_CLIP_THUMBS_FFMPEG
  process.env.CURVA_CLIP_THUMBS_FFMPEG = 'auto'
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, {
    isHost: true,
    myPubkey,
    sharedIndex: idx,
    spawnImpl: makeFakeSpawn('enoent')
  })

  const added = await clips.addClip({ buffer: Buffer.from('y'.repeat(2048)), match_time_ms: 200 })
  const list = await clips.listClips()
  const row = list.find((c) => c.clipId === added.clipId)
  t.ok(row?.thumb, 'thumb entry present')
  t.is(row.thumb.mimeType, 'application/octet-stream', 'ENOENT -> placeholder')

  await clips.close()
  await idx.close()
  await cleanup()
  if (prev === undefined) delete process.env.CURVA_CLIP_THUMBS_FFMPEG
  else process.env.CURVA_CLIP_THUMBS_FFMPEG = prev
})

test('ffmpeg success path stores image/jpeg thumb', async (t) => {
  const prev = process.env.CURVA_CLIP_THUMBS_FFMPEG
  process.env.CURVA_CLIP_THUMBS_FFMPEG = 'auto'
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, {
    isHost: true,
    myPubkey,
    sharedIndex: idx,
    spawnImpl: makeFakeSpawn('success')
  })

  const added = await clips.addClip({ buffer: Buffer.from('z'.repeat(2048)), match_time_ms: 300 })
  const list = await clips.listClips()
  const row = list.find((c) => c.clipId === added.clipId)
  t.ok(row?.thumb, 'thumb entry present')
  t.is(row.thumb.mimeType, 'image/jpeg', 'ffmpeg success -> image/jpeg')
  t.is(row.thumb.bytes, 6, 'stored the fake JPEG bytes verbatim')

  await clips.close()
  await idx.close()
  await cleanup()
  if (prev === undefined) delete process.env.CURVA_CLIP_THUMBS_FFMPEG
  else process.env.CURVA_CLIP_THUMBS_FFMPEG = prev
})

test('extractThumbnailFromClipPath rejects on non-zero exit', async (t) => {
  await t.exception(
    () => _internal.extractThumbnailFromClipPath('/does/not/matter', makeFakeSpawn('exit1')),
    'non-zero exit rejects'
  )
})

test('50-clip cap: 51st add throws CLIPS_CAP_EXCEEDED', async (t) => {
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx })

  for (let i = 0; i < _internal.MAX_CLIPS_PER_PEER; i++) {
    await clips.addClip({ buffer: Buffer.from('clip-' + i), match_time_ms: i })
  }

  let caught = null
  try {
    await clips.addClip({ buffer: Buffer.from('one-too-many'), match_time_ms: 999 })
  } catch (err) {
    caught = err
  }
  t.ok(caught, '51st add throws')
  t.is(caught?.code, 'CLIPS_CAP_EXCEEDED', 'error code is CLIPS_CAP_EXCEEDED')

  await clips.close()
  await idx.close()
  await cleanup()
})
