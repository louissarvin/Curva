// F13 tests for bare/qvacAssetSeed.js
//
// Coverage:
//   - Feature flag off -> noop surface (resolveAsset null, downloadAndSeed throws FEATURE_DISABLED)
//   - Sanitizer rejects malformed assetId + registryUrl
//   - resolveAsset returns local URL when asset is in the manifest
//   - resolveAsset returns null when neither local nor swarm has the asset
//   - downloadAndSeed calls sdk.downloadAsset with { seed: true }
//   - downloadAndSeed persists a manifest entry after a successful download
//   - downloadAndSeed joins the DHT topic as server after seeding
//   - downloadAndSeed rethrows a wrapped error when sdk.downloadAsset throws
//   - getLocalManifest returns a deep copy (mutations do not leak back)

const test = require('brittle')
const {
  createQvacAssetSeed,
  _internal
} = require('../bare/qvacAssetSeed.js')

// ---- fakes -----------------------------------------------------------------

function makeFakeDrive () {
  const store = new Map()
  const key = Buffer.alloc(32, 0xab)
  return {
    key,
    async ready () {},
    async put (path, value) { store.set(path, Buffer.from(value)) },
    async get (path) { return store.has(path) ? store.get(path) : null },
    async close () {},
    __store: store
  }
}

function makeFakeDriveClass () {
  const instances = []
  class FakeDrive {
    constructor (_ns) {
      const inst = makeFakeDrive()
      Object.assign(this, inst)
      instances.push(this)
    }
  }
  return { FakeDrive, instances }
}

function makeFakeCorestore () {
  return {
    namespace () {
      return { get () { return { key: Buffer.alloc(32, 0xcd) } } }
    }
  }
}

function makeFakeSwarm () {
  const joins = []
  const leaves = []
  return {
    join (topic, opts) {
      joins.push({ topic: Buffer.from(topic).toString('hex'), opts })
      return {
        async flushed () {},
        async destroy () {}
      }
    },
    async leave (topic) {
      leaves.push(Buffer.from(topic).toString('hex'))
    },
    __joins: joins,
    __leaves: leaves
  }
}

function makeFakeBlobServer () {
  return {
    token: 'test-token-1234',
    async listen () {},
    async close () {},
    getLink (driveKey, { filename }) {
      const hex = Buffer.from(driveKey).toString('hex').slice(0, 8)
      return `http://127.0.0.1:49999${filename}?drive=${hex}&token=test-token-1234`
    }
  }
}

function makeFakeSdk ({ throwOnDownload = false, bytes = null } = {}) {
  const calls = []
  return {
    downloadAsset (opts) {
      calls.push(opts)
      const requestId = 'req-' + Math.random().toString(36).slice(2, 10)
      let promise
      if (throwOnDownload) {
        const err = new Error('boom-sdk')
        err.code = 'DOWNLOAD_FAILED'
        promise = Promise.reject(err)
      } else {
        // Fire onProgress once for coverage.
        if (typeof opts?.onProgress === 'function') {
          try { opts.onProgress({ percentage: 100, downloaded: 1, total: 1 }) } catch { /* noop */ }
        }
        promise = Promise.resolve('sdk-asset-id-' + requestId)
      }
      promise.requestId = requestId
      return promise
    },
    async __lastBytes () { return bytes },
    __calls: calls
  }
}

const TMP_DIR = require('os').tmpdir()

// ---- tests -----------------------------------------------------------------

test('flag off -> noop factory (feature disabled)', async (t) => {
  const seed = await createQvacAssetSeed({
    corestore: makeFakeCorestore(),
    swarm: makeFakeSwarm(),
    storageDir: TMP_DIR,
    sdk: makeFakeSdk(),
    enabled: false
  })
  t.is(await seed.resolveAsset('anything'), null)
  await t.exception(() => seed.downloadAndSeed('bergamot-en-id', 'https://example.com/model.bin'))
  t.alike(seed.getLocalManifest(), { assets: {} })
  await seed.close()
})

test('sanitizer rejects malformed assetId', (t) => {
  const { isValidAssetId } = _internal
  t.ok(isValidAssetId('bergamot-en-id'))
  t.ok(isValidAssetId('Whisper-Tiny-v2'))
  t.absent(isValidAssetId(''))
  t.absent(isValidAssetId('has spaces'))
  t.absent(isValidAssetId('../../etc/passwd'))
  t.absent(isValidAssetId('a/b'))
  t.absent(isValidAssetId('name.with.dots'))
  t.absent(isValidAssetId('x'.repeat(65)))
  t.absent(isValidAssetId(null))
  t.absent(isValidAssetId(undefined))
})

test('sanitizer rejects malformed registry URL', (t) => {
  const { sanitizeRegistryUrl } = _internal
  t.is(sanitizeRegistryUrl('https://example.com/model.bin'), 'https://example.com/model.bin')
  t.is(sanitizeRegistryUrl('http://cdn.example/x'), 'http://cdn.example/x')
  t.ok(sanitizeRegistryUrl('pear://key123/model.gguf'))
  t.is(sanitizeRegistryUrl('file:///etc/passwd'), null)
  t.is(sanitizeRegistryUrl('javascript:alert(1)'), null)
  t.is(sanitizeRegistryUrl(''), null)
  t.is(sanitizeRegistryUrl('not a url'), null)
  t.is(sanitizeRegistryUrl('x'.repeat(2100)), null)
})

test('resolveAsset returns local URL when asset is in manifest', async (t) => {
  const { FakeDrive } = makeFakeDriveClass()
  const seed = await createQvacAssetSeed({
    corestore: makeFakeCorestore(),
    swarm: makeFakeSwarm(),
    storageDir: TMP_DIR,
    sdk: makeFakeSdk({ bytes: Buffer.from('model-bytes') }),
    blobServer: makeFakeBlobServer(),
    HyperdriveClass: FakeDrive,
    enabled: true
  })

  await seed.downloadAndSeed('bergamot-en-id', 'https://example.com/bergamot.bin')
  const url = await seed.resolveAsset('bergamot-en-id')
  t.ok(typeof url === 'string' && url.length > 0, 'returns a URL')
  t.ok(url.startsWith('http://127.0.0.1'), 'URL is loopback')
  t.ok(url.includes('token='), 'URL carries a token')
  await seed.close()
})

test('resolveAsset returns null when no local and no swarm hit', async (t) => {
  const { FakeDrive } = makeFakeDriveClass()
  const seed = await createQvacAssetSeed({
    corestore: makeFakeCorestore(),
    swarm: makeFakeSwarm(),
    storageDir: TMP_DIR,
    sdk: makeFakeSdk(),
    blobServer: makeFakeBlobServer(),
    HyperdriveClass: FakeDrive,
    enabled: true
  })
  const url = await seed.resolveAsset('whisper-tiny')
  t.is(url, null)
  await seed.close()
})

test('resolveAsset throws INVALID_ASSET_ID on bad input', async (t) => {
  const { FakeDrive } = makeFakeDriveClass()
  const seed = await createQvacAssetSeed({
    corestore: makeFakeCorestore(),
    swarm: makeFakeSwarm(),
    storageDir: TMP_DIR,
    sdk: makeFakeSdk(),
    blobServer: makeFakeBlobServer(),
    HyperdriveClass: FakeDrive,
    enabled: true
  })
  await t.exception(() => seed.resolveAsset('../evil'), /invalid assetId/)
  await seed.close()
})

test('downloadAndSeed calls sdk.downloadAsset with seed:true', async (t) => {
  const { FakeDrive } = makeFakeDriveClass()
  const sdk = makeFakeSdk({ bytes: Buffer.from('abc123') })
  const seed = await createQvacAssetSeed({
    corestore: makeFakeCorestore(),
    swarm: makeFakeSwarm(),
    storageDir: TMP_DIR,
    sdk,
    blobServer: makeFakeBlobServer(),
    HyperdriveClass: FakeDrive,
    enabled: true
  })
  const res = await seed.downloadAndSeed('bergamot-en-id', 'https://example.com/model.bin')
  t.is(sdk.__calls.length, 1)
  t.is(sdk.__calls[0].seed, true)
  t.is(sdk.__calls[0].assetSrc, 'https://example.com/model.bin')
  t.ok(typeof sdk.__calls[0].onProgress === 'function')
  t.ok(typeof res.blobKey === 'string' && res.blobKey.length === 64)
  t.is(res.sizeBytes, 6)
  await seed.close()
})

test('downloadAndSeed updates manifest after successful download', async (t) => {
  const { FakeDrive } = makeFakeDriveClass()
  const seed = await createQvacAssetSeed({
    corestore: makeFakeCorestore(),
    swarm: makeFakeSwarm(),
    storageDir: TMP_DIR,
    sdk: makeFakeSdk({ bytes: Buffer.from('model-bytes-payload') }),
    blobServer: makeFakeBlobServer(),
    HyperdriveClass: FakeDrive,
    enabled: true
  })
  await seed.downloadAndSeed('bergamot-en-id', 'https://example.com/bergamot.bin')
  const mf = seed.getLocalManifest()
  t.ok(mf.assets['bergamot-en-id'], 'manifest has entry')
  t.is(mf.assets['bergamot-en-id'].sourceUrl, 'https://example.com/bergamot.bin')
  t.ok(typeof mf.assets['bergamot-en-id'].seededAt === 'number')
  await seed.close()
})

test('downloadAndSeed joins DHT topic as server after seeding', async (t) => {
  const { FakeDrive } = makeFakeDriveClass()
  const swarm = makeFakeSwarm()
  const seed = await createQvacAssetSeed({
    corestore: makeFakeCorestore(),
    swarm,
    storageDir: TMP_DIR,
    sdk: makeFakeSdk({ bytes: Buffer.from('x') }),
    blobServer: makeFakeBlobServer(),
    HyperdriveClass: FakeDrive,
    enabled: true
  })
  await seed.downloadAndSeed('bergamot-en-id', 'https://example.com/x')
  const serverJoins = swarm.__joins.filter((j) => j.opts?.server === true)
  t.ok(serverJoins.length >= 1, 'joined as server')
  t.ok(seed._internal.isJoinedAsServer('bergamot-en-id'))
  await seed.close()
})

test('downloadAndSeed wraps sdk failure as DOWNLOAD_FAILED', async (t) => {
  const { FakeDrive } = makeFakeDriveClass()
  const seed = await createQvacAssetSeed({
    corestore: makeFakeCorestore(),
    swarm: makeFakeSwarm(),
    storageDir: TMP_DIR,
    sdk: makeFakeSdk({ throwOnDownload: true }),
    blobServer: makeFakeBlobServer(),
    HyperdriveClass: FakeDrive,
    enabled: true
  })
  await t.exception(() => seed.downloadAndSeed('bergamot-en-id', 'https://example.com/x'))
  const mf = seed.getLocalManifest()
  t.absent(mf.assets['bergamot-en-id'], 'no manifest entry when sdk fails')
  await seed.close()
})

test('downloadAndSeed rejects malformed registryUrl', async (t) => {
  const { FakeDrive } = makeFakeDriveClass()
  const seed = await createQvacAssetSeed({
    corestore: makeFakeCorestore(),
    swarm: makeFakeSwarm(),
    storageDir: TMP_DIR,
    sdk: makeFakeSdk(),
    blobServer: makeFakeBlobServer(),
    HyperdriveClass: FakeDrive,
    enabled: true
  })
  await t.exception(() => seed.downloadAndSeed('bergamot-en-id', 'javascript:alert(1)'))
  await t.exception(() => seed.downloadAndSeed('bergamot-en-id', 'file:///etc/passwd'))
  await seed.close()
})

test('downloadAndSeed rejects malformed assetId', async (t) => {
  const { FakeDrive } = makeFakeDriveClass()
  const seed = await createQvacAssetSeed({
    corestore: makeFakeCorestore(),
    swarm: makeFakeSwarm(),
    storageDir: TMP_DIR,
    sdk: makeFakeSdk(),
    blobServer: makeFakeBlobServer(),
    HyperdriveClass: FakeDrive,
    enabled: true
  })
  await t.exception(() => seed.downloadAndSeed('../etc/passwd', 'https://example.com/x'))
  await t.exception(() => seed.downloadAndSeed('bad id with spaces', 'https://example.com/x'))
  await seed.close()
})

test('getLocalManifest returns a deep copy', async (t) => {
  const { FakeDrive } = makeFakeDriveClass()
  const seed = await createQvacAssetSeed({
    corestore: makeFakeCorestore(),
    swarm: makeFakeSwarm(),
    storageDir: TMP_DIR,
    sdk: makeFakeSdk({ bytes: Buffer.from('x') }),
    blobServer: makeFakeBlobServer(),
    HyperdriveClass: FakeDrive,
    enabled: true
  })
  await seed.downloadAndSeed('bergamot-en-id', 'https://example.com/x')
  const mf1 = seed.getLocalManifest()
  mf1.assets['bergamot-en-id'].sourceUrl = 'MUTATED'
  const mf2 = seed.getLocalManifest()
  t.is(mf2.assets['bergamot-en-id'].sourceUrl, 'https://example.com/x')
  await seed.close()
})

test('topic derivation is deterministic + collision-resistant', (t) => {
  const { topicForAsset } = _internal
  const a = topicForAsset('bergamot-en-id')
  const b = topicForAsset('bergamot-en-id')
  const c = topicForAsset('whisper-tiny')
  t.is(a.length, 32)
  t.ok(a.equals(b))
  t.absent(a.equals(c))
})
