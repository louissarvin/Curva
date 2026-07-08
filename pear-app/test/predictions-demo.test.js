// D2: prediction pool demo mode + playhead hook tests.
//
// Coverage:
//   1. enableDemoMode() flips the flag and does NOT auto-open the pool by
//      itself (the playhead hook is what opens it).
//   2. attachPlayhead: crossing match_time_ms >= 2000 with demo mode on and
//      isHost=true triggers openPool exactly once.
//   3. attachPlayhead: crossing match_time_ms >= 5_400_000 triggers the
//      settlement path (publishResult) exactly once.
//   4. Stake submission emits `system:prediction-stake` on the chat Autobase
//      (not the old plain `msg` prefix).
//
// Docs verified via WebFetch on 2026-07-06:
//   - https://eips.ethereum.org/EIPS/eip-3009 confirms one EIP-712 signature
//     covers exactly one TransferWithAuthorization. The signMessage / signEip3009
//     wallet stubs below produce a single signature per stake, mirroring the
//     production wallet worklet.

const test = require('brittle')
const { createPredictionsClient } = require('../bare/predictions.js')

const VALID_CUID = 'c' + '0123456789abcdefghijklmn'
const VALID_POOL_ADDR = '0x' + 'ab'.repeat(20)
const VALID_TOKEN = '0x' + 'cd'.repeat(20)

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
    async signMessage(text) { return { signature: '0x' + '11'.repeat(65), signer: owner, text } },
    async signEip3009({ chainId, tokenAddress, to, value }) {
      return {
        v: 27,
        r: '0x' + 'aa'.repeat(32),
        s: '0x' + 'bb'.repeat(32),
        from: owner,
        nonce: '0x' + 'cc'.repeat(32),
        validAfter: 1,
        validBefore: 999_999_999_999,
        typedData: null,
        chainId, tokenAddress, to, value
      }
    }
  }
}

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

// Minimal playhead stub matching bare/playhead.js's onUpdate contract:
// `onUpdate(cb) -> unsubscribe`. `fire(state)` synchronously calls all
// listeners in insertion order.
function mkPlayheadStub() {
  const listeners = new Set()
  return {
    onUpdate(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    async fire(state) {
      for (const cb of Array.from(listeners)) {
        await cb(state)
      }
    },
    listenerCount() { return listeners.size }
  }
}

// -----------------------------------------------------------------------------

test('enableDemoMode: sets flags but does NOT auto-open the pool', async (t) => {
  const chat = mkChatStub()
  const wallet = mkWalletStub()
  const fetchCalls = mkFetch(() => ({ status: 200, jsonBody: { success: true, data: {} } }))
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat, wallet,
    roomSlug: 'demo-room',
    isHost: true,
    myPubkey: '1'.repeat(64),
    fetch: fetchCalls
  })
  const cfg = client.enableDemoMode({ poolWindowMs: 10 * 60_000, entryAmountUsdt: 1 })
  t.is(client.isDemoMode(), true)
  t.is(cfg.entryStakeAtomic, '1000000')
  t.ok(cfg.poolWindowMs >= 60_000)
  // No fetches yet, no chat rows: enable is passive.
  t.is(fetchCalls.calls.length, 0, 'no HTTP calls fired by enableDemoMode alone')
  t.is(chat.appended.length, 0, 'no autobase rows appended by enableDemoMode alone')
})

test('attachPlayhead: match_time_ms >= 2000 auto-opens the pool exactly once', async (t) => {
  const chat = mkChatStub()
  const wallet = mkWalletStub()
  const fetchStub = mkFetch((url) => {
    if (url.endsWith('/predictions/open')) {
      return {
        status: 200,
        jsonBody: {
          success: true,
          data: {
            id: VALID_CUID,
            poolAddress: VALID_POOL_ADDR,
            chainId: 11155111,
            stakeToken: VALID_TOKEN,
            entryStakeAtomic: '1000000',
            mode: 'winner-only',
            deadlineMs: Date.now() + 20 * 60_000,
            status: 'open'
          }
        }
      }
    }
    return { status: 200, jsonBody: { success: true, data: {} } }
  })
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat, wallet,
    roomSlug: 'demo-room',
    isHost: true,
    myPubkey: '1'.repeat(64),
    fetch: fetchStub
  })
  client.enableDemoMode({ entryAmountUsdt: 1 })

  const playhead = mkPlayheadStub()
  const scoreCalls = []
  const off = client.attachPlayhead(playhead, {
    matchId: VALID_CUID,
    mode: 'winner-only',
    getLiveScore: async () => {
      scoreCalls.push(1)
      return { winner: 'HOME', homeGoals: 2, awayGoals: 1 }
    }
  })
  t.is(typeof off, 'function')
  t.is(playhead.listenerCount(), 1)

  // Sub-2000ms: no fire.
  await playhead.fire({ match_time_ms: 0, wall_clock_ms: Date.now(), lamport: 1, by_peer: 'a', type: 'play' })
  await playhead.fire({ match_time_ms: 1_500, wall_clock_ms: Date.now(), lamport: 2, by_peer: 'a', type: 'play' })
  t.is(fetchStub.calls.filter((c) => c.url.endsWith('/predictions/open')).length, 0,
    'no open call yet under 2s')

  // Cross 2000ms.
  await playhead.fire({ match_time_ms: 2_100, wall_clock_ms: Date.now(), lamport: 3, by_peer: 'a', type: 'play' })

  const openCalls = fetchStub.calls.filter((c) => c.url.endsWith('/predictions/open'))
  t.is(openCalls.length, 1, 'openPool fired exactly once at t>=2000ms')

  // Re-crossing does not re-fire.
  await playhead.fire({ match_time_ms: 5_000, wall_clock_ms: Date.now(), lamport: 4, by_peer: 'a', type: 'play' })
  const openCalls2 = fetchStub.calls.filter((c) => c.url.endsWith('/predictions/open'))
  t.is(openCalls2.length, 1, 'openPool still exactly one call after replay')

  off()
  t.is(playhead.listenerCount(), 0)
})

test('attachPlayhead: match_time_ms >= 5_400_000 fires settlement path', async (t) => {
  const chat = mkChatStub()
  const wallet = mkWalletStub()
  const fetchStub = mkFetch((url) => {
    if (url.endsWith('/predictions/open')) {
      return {
        status: 200,
        jsonBody: {
          success: true,
          data: {
            id: VALID_CUID,
            poolAddress: VALID_POOL_ADDR,
            chainId: 11155111,
            stakeToken: VALID_TOKEN,
            entryStakeAtomic: '1000000',
            mode: 'winner-only',
            deadlineMs: Date.now() + 20 * 60_000,
            status: 'open'
          }
        }
      }
    }
    if (url.endsWith('/predictions/result')) {
      return {
        status: 200,
        jsonBody: {
          success: true,
          data: {
            id: VALID_CUID,
            status: 'settled',
            resultWinner: 'HOME',
            resultHomeGoals: 2,
            resultAwayGoals: 1
          }
        }
      }
    }
    return { status: 200, jsonBody: { success: true, data: {} } }
  })

  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat, wallet,
    roomSlug: 'demo-room',
    isHost: true,
    myPubkey: '1'.repeat(64),
    fetch: fetchStub
  })
  client.enableDemoMode({ entryAmountUsdt: 1 })

  const playhead = mkPlayheadStub()
  let scoreFetches = 0
  client.attachPlayhead(playhead, {
    matchId: VALID_CUID,
    mode: 'winner-only',
    getLiveScore: async () => {
      scoreFetches++
      return { winner: 'HOME', homeGoals: 2, awayGoals: 1 }
    }
  })

  // Open the pool via the 2s crossing.
  await playhead.fire({ match_time_ms: 2_500, wall_clock_ms: Date.now(), lamport: 1, by_peer: 'a', type: 'play' })

  // Fast-forward to 90 minutes.
  await playhead.fire({ match_time_ms: 5_400_100, wall_clock_ms: Date.now(), lamport: 2, by_peer: 'a', type: 'seek' })

  const resultCalls = fetchStub.calls.filter((c) => c.url.endsWith('/predictions/result'))
  t.is(resultCalls.length, 1, 'publishResult fired exactly once at t>=90m')
  t.is(scoreFetches, 1, 'live score was fetched once for settlement')

  // Sanity: replay the 90-min tick, no second fire.
  await playhead.fire({ match_time_ms: 5_500_000, wall_clock_ms: Date.now(), lamport: 3, by_peer: 'a', type: 'seek' })
  const resultCalls2 = fetchStub.calls.filter((c) => c.url.endsWith('/predictions/result'))
  t.is(resultCalls2.length, 1)
})

test('submitPrediction: emits system:prediction-stake, NOT plain msg', async (t) => {
  const chat = mkChatStub()
  const wallet = mkWalletStub()
  const fetchStub = mkFetch((url) => {
    if (url.endsWith('/predictions/entry')) {
      return {
        status: 200,
        jsonBody: {
          success: true,
          data: {
            id: 'c' + 'entry000000000000000000a',
            poolId: VALID_CUID,
            txHash: '0x' + 'ef'.repeat(32),
            status: 'submitted',
            winner: 'HOME',
            homeGoals: null,
            awayGoals: null,
            stakeAtomic: '1000000'
          }
        }
      }
    }
    return { status: 200, jsonBody: { success: true, data: {} } }
  })
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat, wallet,
    roomSlug: 'demo-room',
    isHost: false,
    myPubkey: '2'.repeat(64),
    myHandle: 'alice',
    fetch: fetchStub
  })
  await client.submitPrediction({
    poolId: VALID_CUID,
    winner: 'HOME',
    stakeAtomic: '1000000',
    poolAddress: VALID_POOL_ADDR,
    chainId: 11155111,
    stakeToken: VALID_TOKEN,
    mode: 'winner-only'
  })
  t.is(chat.appended.length, 1)
  const row = chat.appended[0]
  t.is(row.type, 'system:prediction-stake', 'stake message type must be system:prediction-stake')
  t.not(row.type, 'msg', 'must NOT be the old msg-prefix fallback')
  t.is(row.peerHandle, 'alice')
  t.is(row.winner, 'HOME')
  t.is(row.stakeAtomic, '1000000')
  t.ok(/^0x[0-9a-f]{64}$/.test(row.txHash))
})

test('publishSettlement: emits system:prediction-settle with sanitized rows', async (t) => {
  const chat = mkChatStub()
  const wallet = mkWalletStub()
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat, wallet,
    roomSlug: 'demo-room',
    isHost: true,
    myPubkey: '3'.repeat(64),
    fetch: mkFetch(() => ({ status: 200, jsonBody: { success: true, data: {} } }))
  })
  const res = await client.publishSettlement({
    poolId: VALID_CUID,
    winners: [
      { handle: 'alice', address: '0x' + '11'.repeat(20), amountAtomic: '2000000' }
    ],
    losers: [
      { handle: 'bob', address: '0x' + '22'.repeat(20) }
    ],
    tx: '0x' + 'ef'.repeat(32),
    matchId: VALID_CUID
  })
  t.is(res.poolId, VALID_CUID)
  t.is(res.winners, 1)
  t.is(res.losers, 1)
  t.is(chat.appended.length, 1)
  const row = chat.appended[0]
  t.is(row.type, 'system:prediction-settle')
  t.is(row.winners.length, 1)
  t.is(row.winners[0].handle, 'alice')
  t.is(row.winners[0].address, '0x' + '11'.repeat(20))
  t.is(row.losers.length, 1)
  t.is(row.losers[0].handle, 'bob')
  t.ok(/^0x[0-9a-f]{64}$/.test(row.txHash))
})

test('attachPlayhead: non-host returns a no-op unsubscribe', async (t) => {
  const chat = mkChatStub()
  const wallet = mkWalletStub()
  const fetchStub = mkFetch(() => ({ status: 200, jsonBody: { success: true, data: {} } }))
  const client = createPredictionsClient({
    backend: mkBackendStub(),
    chat, wallet,
    roomSlug: 'demo-room',
    isHost: false,
    myPubkey: '4'.repeat(64),
    fetch: fetchStub
  })
  client.enableDemoMode({ entryAmountUsdt: 1 })
  const playhead = mkPlayheadStub()
  const off = client.attachPlayhead(playhead, {
    matchId: VALID_CUID,
    getLiveScore: async () => ({ winner: 'HOME', homeGoals: 1, awayGoals: 0 })
  })
  t.is(typeof off, 'function')
  t.is(playhead.listenerCount(), 0, 'peer never subscribed to the playhead')
  await playhead.fire({ match_time_ms: 5_500_000, wall_clock_ms: Date.now(), lamport: 1, by_peer: 'a', type: 'seek' })
  t.is(fetchStub.calls.length, 0, 'peer produces no auto-open / auto-settle calls')
})
