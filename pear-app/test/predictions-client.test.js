// Wave 11: brittle tests for bare/predictions.js (client-side pool logic).
//
// Coverage:
//   * openPool happy path (mock backend + wallet)
//   * openPool rejects when non-host caller
//   * openPool rejects when feature-flag disabled
//   * submitPrediction signs EIP-3009 and posts to backend
//   * publishResult rejects if not host
//   * getPoolStatus caches for 60s (single backend hit on repeat call)
//   * feature-flag off -> all methods reject FEATURE_DISABLED
//   * signed messages match the exact contract the backend expects
//
// The client uses `fetch` via opts.fetch injection so we do not need a real
// HTTP server. Wallet is a plain object stub returning canned signatures.

const test = require('brittle')
const {
  createPredictionsClient,
  PredictionsError,
  buildOpenMessage,
  buildResultMessage
} = require('../bare/predictions.js')

// A valid CUID2-shaped id (backend validator: /^c[0-9a-z]{24}$/).
const VALID_CUID = 'c' + '0123456789abcdefghijklmn'
const VALID_POOL_ADDR = '0x' + 'ab'.repeat(20)
const VALID_TOKEN = '0x' + 'cd'.repeat(20)
const VALID_TX = '0x' + 'ef'.repeat(32)

// --- Stubs ------------------------------------------------------------------

function mkBackendStub() {
  return { baseUrl: 'https://backend.test', lang: 'en' }
}

function mkChatStub() {
  const appended = []
  return {
    appended,
    async sendSystem(msg) { appended.push(msg); return msg }
  }
}

function mkWalletStub({ owner = '0x' + '11'.repeat(20) } = {}) {
  return {
    getInfo() { return { ownerAddress: owner, smartAddress: '0x' + '22'.repeat(20), chainId: 11155111 } },
    async signMessage(text) {
      return { signature: '0x' + '11'.repeat(65), signer: owner, text }
    },
    async signEip3009({ chainId, tokenAddress, to, value }) {
      return {
        v: 27,
        r: '0x' + 'aa'.repeat(32),
        s: '0x' + 'bb'.repeat(32),
        from: owner,
        nonce: '0x' + 'cc'.repeat(32),
        validAfter: 1,
        validBefore: 999999999999,
        typedData: null,
        chainId,
        tokenAddress,
        to,
        value
      }
    }
  }
}

// Fetch stub factory. `handler(url, init) -> { status, jsonBody }`. Every call
// is recorded on `calls`.
function mkFetch(handler) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url, init })
    const { status = 200, jsonBody = { success: true, data: {} } } = handler(url, init) || {}
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return jsonBody }
    }
  }
  fn.calls = calls
  return fn
}

// --- Signed-message contracts ----------------------------------------------

test('buildOpenMessage matches the backend contract exactly', (t) => {
  const s = buildOpenMessage('room-torino-ita', VALID_CUID, 1234567890)
  t.is(s, `curva-predictions-open:room-torino-ita:${VALID_CUID}:1234567890`)
})

test('buildResultMessage matches the backend contract exactly', (t) => {
  const s = buildResultMessage(VALID_CUID, 'HOME', 2, 1)
  t.is(s, `curva-predictions-result:${VALID_CUID}:HOME:2:1`)
})

// --- Feature flag ----------------------------------------------------------

test('feature flag off: openPool rejects with FEATURE_DISABLED', async (t) => {
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat: mkChatStub(),
    wallet: mkWalletStub(),
    roomSlug: 'room-a',
    isHost: true,
    myPubkey: 'aa'.repeat(32),
    enabled: false,
    fetch: mkFetch(() => ({}))
  })
  await t.exception.all(
    () => client.openPool({ matchId: VALID_CUID, mode: 'winner-only', deadlineMs: Date.now() + 3_600_000 }),
    /FEATURE_DISABLED|disabled/i
  )
})

test('feature flag off: submitPrediction rejects with FEATURE_DISABLED', async (t) => {
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat: mkChatStub(),
    wallet: mkWalletStub(),
    roomSlug: 'room-a',
    isHost: false,
    myPubkey: 'bb'.repeat(32),
    enabled: false,
    fetch: mkFetch(() => ({}))
  })
  await t.exception.all(
    () => client.submitPrediction({
      poolId: VALID_CUID,
      winner: 'HOME',
      stakeAtomic: '1000000',
      poolAddress: VALID_POOL_ADDR,
      chainId: 11155111,
      stakeToken: VALID_TOKEN,
      mode: 'winner-only'
    }),
    /FEATURE_DISABLED|disabled/i
  )
})

test('feature flag off: publishResult rejects with FEATURE_DISABLED', async (t) => {
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat: mkChatStub(),
    wallet: mkWalletStub(),
    roomSlug: 'room-a',
    isHost: true,
    myPubkey: 'aa'.repeat(32),
    enabled: false,
    fetch: mkFetch(() => ({}))
  })
  await t.exception.all(
    () => client.publishResult({ poolId: VALID_CUID, winner: 'HOME', homeGoals: 1, awayGoals: 0 }),
    /FEATURE_DISABLED|disabled/i
  )
})

// --- Host-only guards ------------------------------------------------------

test('non-host openPool rejects with NOT_HOST', async (t) => {
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat: mkChatStub(),
    wallet: mkWalletStub(),
    roomSlug: 'room-a',
    isHost: false,
    myPubkey: 'aa'.repeat(32),
    fetch: mkFetch(() => ({}))
  })
  await t.exception.all(
    () => client.openPool({ matchId: VALID_CUID, mode: 'winner-only', deadlineMs: Date.now() + 3_600_000 }),
    /NOT_HOST|host/i
  )
})

test('non-host publishResult rejects with NOT_HOST', async (t) => {
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat: mkChatStub(),
    wallet: mkWalletStub(),
    roomSlug: 'room-a',
    isHost: false,
    myPubkey: 'aa'.repeat(32),
    fetch: mkFetch(() => ({}))
  })
  await t.exception.all(
    () => client.publishResult({ poolId: VALID_CUID, winner: 'HOME', homeGoals: 1, awayGoals: 0 }),
    /NOT_HOST|host/i
  )
})

// --- openPool happy path ---------------------------------------------------

test('openPool posts signed message and appends system:pool-opened to chat', async (t) => {
  const chat = mkChatStub()
  const wallet = mkWalletStub()
  const fetchFn = mkFetch((url, init) => {
    t.ok(url.endsWith('/predictions/open'), 'hits /predictions/open')
    t.is(init.method, 'POST')
    const body = JSON.parse(init.body)
    t.is(body.roomSlug, 'room-a')
    t.is(body.matchId, VALID_CUID)
    t.is(body.mode, 'winner-only')
    t.is(body.signature, '0x' + '11'.repeat(65))
    return {
      status: 201,
      jsonBody: {
        success: true,
        data: {
          id: VALID_CUID,
          roomSlug: 'room-a',
          matchId: VALID_CUID,
          poolAddress: VALID_POOL_ADDR,
          chainId: 11155111,
          stakeToken: VALID_TOKEN,
          entryStakeAtomic: '1000000',
          mode: 'winner-only',
          deadlineMs: '9999999999999',
          status: 'open'
        }
      }
    }
  })
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat,
    wallet,
    roomSlug: 'room-a',
    isHost: true,
    myPubkey: 'aa'.repeat(32),
    fetch: fetchFn
  })
  const res = await client.openPool({
    matchId: VALID_CUID,
    mode: 'winner-only',
    deadlineMs: Date.now() + 3_600_000
  })
  t.is(res.poolId, VALID_CUID)
  t.is(res.poolAddress, VALID_POOL_ADDR)
  t.is(chat.appended.length, 1, 'one chat row appended')
  t.is(chat.appended[0].type, 'system:pool-opened')
  t.is(chat.appended[0].matchId, VALID_CUID)
  t.is(fetchFn.calls.length, 1)
})

test('openPool surfaces backend error codes', async (t) => {
  const fetchFn = mkFetch(() => ({
    status: 409,
    jsonBody: { success: false, error: { code: 'POOL_ALREADY_EXISTS', message: 'already open' } }
  }))
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat: mkChatStub(),
    wallet: mkWalletStub(),
    roomSlug: 'room-a',
    isHost: true,
    myPubkey: 'aa'.repeat(32),
    fetch: fetchFn
  })
  await t.exception.all(
    () => client.openPool({ matchId: VALID_CUID, mode: 'winner-only', deadlineMs: Date.now() + 3_600_000 }),
    /already open|POOL_ALREADY_EXISTS/
  )
})

// --- submitPrediction ------------------------------------------------------

test('submitPrediction signs EIP-3009 and posts full auth body', async (t) => {
  const chat = mkChatStub()
  const wallet = mkWalletStub()
  const fetchFn = mkFetch((url, init) => {
    t.ok(url.endsWith('/predictions/entry'))
    const body = JSON.parse(init.body)
    t.is(body.poolId, VALID_CUID)
    t.is(body.winner, 'HOME')
    t.is(body.to, VALID_POOL_ADDR.toLowerCase())
    t.is(body.value, '1000000')
    t.is(body.v, 27)
    t.ok(/^0x[0-9a-f]{64}$/.test(body.nonce))
    return {
      status: 200,
      jsonBody: { success: true, data: { id: 'p' + '0'.repeat(24), poolId: VALID_CUID, txHash: VALID_TX, status: 'confirmed', winner: 'HOME', homeGoals: null, awayGoals: null, stakeAtomic: '1000000' } }
    }
  })
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat,
    wallet,
    roomSlug: 'room-a',
    isHost: false,
    myPubkey: 'bb'.repeat(32),
    fetch: fetchFn
  })
  const res = await client.submitPrediction({
    poolId: VALID_CUID,
    winner: 'HOME',
    stakeAtomic: '1000000',
    poolAddress: VALID_POOL_ADDR,
    chainId: 11155111,
    stakeToken: VALID_TOKEN,
    mode: 'winner-only'
  })
  t.is(res.txHash, VALID_TX)
  t.is(res.status, 'confirmed')
  t.is(fetchFn.calls.length, 1)
  t.is(chat.appended.length, 1, 'one chat row appended for prediction display')
})

test('submitPrediction rejects when winner does not match exact-score goals', async (t) => {
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat: mkChatStub(),
    wallet: mkWalletStub(),
    roomSlug: 'room-a',
    isHost: false,
    myPubkey: 'bb'.repeat(32),
    fetch: mkFetch(() => ({}))
  })
  await t.exception.all(
    () => client.submitPrediction({
      poolId: VALID_CUID,
      winner: 'AWAY',    // inconsistent with 2-1
      homeGoals: 2,
      awayGoals: 1,
      stakeAtomic: '1000000',
      poolAddress: VALID_POOL_ADDR,
      chainId: 11155111,
      stakeToken: VALID_TOKEN,
      mode: 'exact-score'
    }),
    /VALIDATION_ERROR|match/i
  )
})

// --- publishResult ---------------------------------------------------------

test('publishResult posts signed result message and appends match-result to chat', async (t) => {
  const chat = mkChatStub()
  const fetchFn = mkFetch((url, init) => {
    t.ok(url.endsWith('/predictions/result'))
    const body = JSON.parse(init.body)
    t.is(body.poolId, VALID_CUID)
    t.is(body.winner, 'HOME')
    t.is(body.homeGoals, 2)
    t.is(body.awayGoals, 1)
    return {
      status: 200,
      jsonBody: {
        success: true,
        data: { id: VALID_CUID, status: 'locked', resultWinner: 'HOME', resultHomeGoals: 2, resultAwayGoals: 1 }
      }
    }
  })
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat,
    wallet: mkWalletStub(),
    roomSlug: 'room-a',
    isHost: true,
    myPubkey: 'aa'.repeat(32),
    fetch: fetchFn
  })
  const res = await client.publishResult({
    poolId: VALID_CUID,
    winner: 'HOME',
    homeGoals: 2,
    awayGoals: 1,
    matchId: VALID_CUID
  })
  t.is(res.status, 'locked')
  t.is(chat.appended.length, 1)
  t.is(chat.appended[0].type, 'system:match-result')
})

// --- getPoolStatus caching -------------------------------------------------

test('getPoolStatus caches within TTL and force-refresh bypasses cache', async (t) => {
  let hits = 0
  const fetchFn = mkFetch((url) => {
    hits++
    t.ok(url.includes('/predictions/pool/'))
    return {
      status: 200,
      jsonBody: {
        success: true,
        data: { id: VALID_CUID, roomSlug: 'room-a', matchId: VALID_CUID, status: 'open', predictions: [] }
      }
    }
  })
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat: mkChatStub(),
    wallet: mkWalletStub(),
    roomSlug: 'room-a',
    isHost: false,
    myPubkey: 'aa'.repeat(32),
    fetch: fetchFn
  })
  await client.getPoolStatus({ matchId: VALID_CUID })
  await client.getPoolStatus({ matchId: VALID_CUID })
  await client.getPoolStatus({ matchId: VALID_CUID })
  t.is(hits, 1, 'three calls -> one backend hit (60s TTL)')

  await client.getPoolStatus({ matchId: VALID_CUID, forceRefresh: true })
  t.is(hits, 2, 'forceRefresh bypasses the cache')
})

test('getPoolStatus swallows POOL_NOT_FOUND and returns exists:false', async (t) => {
  const fetchFn = mkFetch(() => ({
    status: 404,
    jsonBody: { success: false, error: { code: 'POOL_NOT_FOUND', message: 'no pool' } }
  }))
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat: mkChatStub(),
    wallet: mkWalletStub(),
    roomSlug: 'room-a',
    isHost: false,
    myPubkey: 'aa'.repeat(32),
    fetch: fetchFn
  })
  const snap = await client.getPoolStatus({ matchId: VALID_CUID })
  t.is(snap.exists, false)
})

// --- Constructor validation -----------------------------------------------

test('createPredictionsClient throws when required deps missing', (t) => {
  t.exception.all(() => createPredictionsClient({}), /backend/)
  t.exception.all(() => createPredictionsClient({ backend: mkBackendStub() }), /chat/)
  t.exception.all(() => createPredictionsClient({ backend: mkBackendStub(), chat: mkChatStub() }), /wallet/)
})

test('PredictionsError carries code + message', (t) => {
  const e = new PredictionsError('X_CODE', 'x message')
  t.is(e.code, 'X_CODE')
  t.is(e.message, 'x message')
  t.is(e.name, 'PredictionsError')
})
