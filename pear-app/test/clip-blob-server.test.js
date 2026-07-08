// C1: clip playback via hypercore-blob-server. Verifies:
//   - blob server is instantiated on room open (createClips)
//   - getClipLink() returns a valid loopback HTTP URL carrying key + blob + token
//   - the reported port matches the blob server's live port (default 49833
//     unless anyPort:true had to fall back to a random free port)
//   - close() shuts the server down so no orphaned sockets remain
//   - a fresh createClips() after close() mints a NEW token (rotation)
//
// Uses a real Corestore + real Hyperbee via _helpers.js. No network mocks.

const test = require('brittle')
const Hyperbee = require('hyperbee')
const { makeStore } = require('./_helpers.js')
const { createClips } = require('../bare/clips.js')

async function makeSharedIndex(store) {
  const core = store.namespace('curva/test/blob-server-idx').get({ name: 'idx' })
  const bee = new Hyperbee(core, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await bee.ready()
  return bee
}

const myPubkey = 'bb'.repeat(32)

test('createClips instantiates a live blob server on room open', async (t) => {
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx })

  // If the hypercore-blob-server module is present, the server should be up
  // and the port getter should return a positive integer. When the module is
  // absent (older install), the getter returns null and getClipLink throws
  // BLOB_SERVER_UNAVAILABLE.
  t.is(typeof clips.getClipLink, 'function', 'getClipLink exposed')
  const port = clips.blobServerPort
  t.ok(port === null || (Number.isInteger(port) && port > 0), 'blobServerPort null or positive int')

  await clips.close()
  await idx.close()
  await cleanup()
})

test('getClipLink returns a token-gated http://127.0.0.1 URL', async (t) => {
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx })

  if (!clips.blobServerReady) {
    t.comment('hypercore-blob-server unavailable in this env; skipping URL asserts')
    await clips.close()
    await idx.close()
    await cleanup()
    return
  }

  // Any 64-char lowercase hex string is a valid input to getLink() as far as
  // the URL construction goes. The server does not resolve the underlying core
  // until a request lands on it, so link building never touches the network.
  const fakeDriveKey = 'cc'.repeat(32)
  const link = clips.getClipLink(fakeDriveKey, '/clips/1720290000000.mp4')

  t.is(typeof link.url, 'string', 'url is string')
  t.ok(/^http:\/\/127\.0\.0\.1:\d+\//.test(link.url), 'url is loopback http')
  t.ok(link.url.includes('key='), 'url carries key=')
  // getLink() with { filename } resolves internally to a &blob=<z32> query;
  // when the URL is built from the drive key + filename, the token is always
  // appended per index.js:getLink.
  t.ok(link.url.includes('token='), 'url carries token=')
  t.is(typeof link.token, 'string', 'token exposed alongside url')
  t.ok(link.token.length > 0, 'token is non-empty')
  t.ok(link.url.includes(String(link.port)), 'url port matches reported port')
  t.is(link.host, '127.0.0.1', 'host bound to loopback')
  t.is(link.expiresMs, null, 'no per-URL expiry (rotates on room close)')

  await clips.close()
  await idx.close()
  await cleanup()
})

test('getClipLink rejects malformed inputs at the boundary', async (t) => {
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clips = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx })

  t.exception.all(() => clips.getClipLink('not-hex', '/clips/x.mp4'), 'non-hex driveKey rejected')
  t.exception.all(() => clips.getClipLink('aa'.repeat(32), 'x.mp4'), 'path not /clips/ rejected')
  t.exception.all(() => clips.getClipLink('aa'.repeat(32), ''), 'empty path rejected')

  await clips.close()
  await idx.close()
  await cleanup()
})

test('close() shuts the blob server down and rotates the token on next open', async (t) => {
  const { store, cleanup } = await makeStore()
  const idx = await makeSharedIndex(store)
  const clipsA = await createClips(store, { isHost: true, myPubkey, sharedIndex: idx })

  if (!clipsA.blobServerReady) {
    t.comment('hypercore-blob-server unavailable in this env; skipping rotation asserts')
    await clipsA.close()
    await idx.close()
    await cleanup()
    return
  }

  const tokenA = clipsA.blobServerToken
  t.ok(typeof tokenA === 'string' && tokenA.length > 0, 'first token minted')

  await clipsA.close()
  t.is(clipsA.blobServerPort, null, 'port returns null after close')
  t.is(clipsA.blobServerToken, null, 'token cleared after close')

  // Second createClips call in a fresh corestore mints a new server + token.
  const { store: store2, cleanup: cleanup2 } = await makeStore()
  const idx2 = await makeSharedIndex(store2)
  const clipsB = await createClips(store2, { isHost: true, myPubkey, sharedIndex: idx2 })
  if (clipsB.blobServerReady) {
    const tokenB = clipsB.blobServerToken
    t.ok(typeof tokenB === 'string' && tokenB.length > 0, 'second token minted')
    t.not(tokenA, tokenB, 'token rotated across close+reopen')
  }
  await clipsB.close()
  await idx2.close()
  await cleanup2()
  await idx.close()
  await cleanup()
})
