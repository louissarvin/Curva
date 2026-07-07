// Wave 13B - brittle tests for bare/x402Client.js.
//
// Coverage:
//   * 200 first hop returns body directly (no payment loop)
//   * 402 -> promptUser -> signEip3009 -> 200 with resource
//   * 402 -> promptUser cancel -> USER_CANCELLED
//   * 402 -> retry HTTP error -> classified X402Error with backend code
//   * challenge parser accepts body OR X-Payment-Required header
//   * challenge parser rejects malformed nonce / asset / value

const test = require('brittle')
const { createX402Client, X402Error, parseX402Challenge } = require('../bare/x402Client.js')

const CHAIN_ID = 11155111
const TOKEN = '0x6F51d2428AD208eb1cdE38e5CF7C0D7E2c5E7739'
const PAY_TO = '0x' + '77'.repeat(20)
const OWNER = '0x' + 'aa'.repeat(20)

function makeChallenge(overrides = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    scheme: 'exact',
    network: `eip155:${CHAIN_ID}`,
    maxAmountRequired: '1000000',
    asset: TOKEN,
    resource: 'premium-translations',
    payTo: PAY_TO,
    validAfter: 0,
    validBefore: now + 900,
    nonce: '0x' + 'cc'.repeat(32),
    ...overrides
  }
}

function makeResp(status, body, headers = {}) {
  return {
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase()
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === key) return v
        }
        return null
      }
    },
    text: async () => (body === null || body === undefined) ? '' : JSON.stringify(body)
  }
}

function makeWallet() {
  return {
    async signEip3009({ chainId, tokenAddress, to, value, nonce, validAfter, validBefore }) {
      return {
        v: 27,
        r: '0x' + 'dd'.repeat(32),
        s: '0x' + 'ee'.repeat(32),
        from: OWNER,
        nonce,
        validAfter,
        validBefore
      }
    }
  }
}

test('parseX402Challenge: accepts a well-formed body payload', (t) => {
  const parsed = parseX402Challenge({ x402Version: 1, accepts: [makeChallenge()] }, null)
  t.ok(parsed)
  t.is(parsed.chainId, CHAIN_ID)
  t.is(parsed.asset, TOKEN.toLowerCase())
  t.is(parsed.payTo, PAY_TO.toLowerCase())
  t.is(parsed.maxAmountRequired, '1000000')
})

test('parseX402Challenge: accepts header-only shape', (t) => {
  const parsed = parseX402Challenge(null, makeChallenge())
  t.ok(parsed)
  t.is(parsed.chainId, CHAIN_ID)
})

test('parseX402Challenge: rejects malformed nonce', (t) => {
  const parsed = parseX402Challenge({ accepts: [makeChallenge({ nonce: '0xnope' })] }, null)
  t.absent(parsed)
})

test('parseX402Challenge: rejects malformed asset', (t) => {
  const parsed = parseX402Challenge({ accepts: [makeChallenge({ asset: 'bad' })] }, null)
  t.absent(parsed)
})

test('fetchPaid: returns body directly on 200 first hop (no payment needed)', async (t) => {
  const events = []
  const fetchImpl = async (url) => makeResp(200, { data: { hello: 'world' } })
  const client = createX402Client({
    wallet: makeWallet(),
    fetch: fetchImpl,
    emit: (name, payload) => events.push({ name, payload })
  })
  const result = await client.fetchPaid('https://example.test/x402/premium-translations')
  t.is(result.status, 200)
  t.is(result.body.data.hello, 'world')
  t.is(events.length, 0, 'no paywall event when no 402')
})

test('fetchPaid: 402 -> approved prompt -> retry with signed payment header succeeds', async (t) => {
  const events = []
  const requests = []
  const challenge = makeChallenge()
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init?.headers || {} })
    if (requests.length === 1) {
      return makeResp(402, { x402Version: 1, accepts: [challenge] }, {
        'X-Payment-Required': JSON.stringify(challenge)
      })
    }
    return makeResp(200, { success: true, data: { models: [1, 2] } }, {
      'X-Payment-Response': JSON.stringify({ success: true, txHash: '0x' + '11'.repeat(32), replay: false })
    })
  }
  const client = createX402Client({
    wallet: makeWallet(),
    fetch: fetchImpl,
    emit: (name, payload) => events.push({ name, payload }),
    promptUser: async () => true
  })
  const result = await client.fetchPaid('https://example.test/x402/premium-translations')
  t.is(result.status, 200)
  t.is(result.body.data.models.length, 2)
  t.is(result.txHash, '0x' + '11'.repeat(32))
  t.absent(result.replay)
  t.is(requests.length, 2, 'exactly 2 HTTP hops')
  t.ok(requests[1].headers['X-Payment'], 'second request carried X-Payment header')
  const paymentHeader = JSON.parse(requests[1].headers['X-Payment'])
  t.is(paymentHeader.nonce, challenge.nonce)
  t.is(paymentHeader.from, OWNER.toLowerCase())
  t.is(paymentHeader.value, '1000000')
  t.is(events.length, 1)
  t.is(events[0].name, 'x402:paywall')
})

test('fetchPaid: 402 -> user cancels -> USER_CANCELLED', async (t) => {
  const fetchImpl = async () => makeResp(402, { x402Version: 1, accepts: [makeChallenge()] })
  const client = createX402Client({
    wallet: makeWallet(),
    fetch: fetchImpl,
    promptUser: async () => false
  })
  try {
    await client.fetchPaid('https://example.test/x402/premium-translations')
    t.fail('expected throw')
  } catch (err) {
    t.ok(err instanceof X402Error)
    t.is(err.code, 'USER_CANCELLED')
  }
})

test('fetchPaid: 402 -> retry HTTP 409 -> throws with NONCE_USED code', async (t) => {
  let hop = 0
  const fetchImpl = async () => {
    hop++
    if (hop === 1) return makeResp(402, { x402Version: 1, accepts: [makeChallenge()] })
    return makeResp(409, { success: false, error: { code: 'NONCE_USED', message: 'reused' } })
  }
  const client = createX402Client({
    wallet: makeWallet(),
    fetch: fetchImpl,
    promptUser: async () => true
  })
  try {
    await client.fetchPaid('https://example.test/x402/premium-translations')
    t.fail('expected throw')
  } catch (err) {
    t.ok(err instanceof X402Error)
    t.is(err.code, 'NONCE_USED')
    t.is(err.status, 409)
  }
})

test('fetchPaid: 402 with no valid challenge -> BAD_CHALLENGE', async (t) => {
  const fetchImpl = async () => makeResp(402, { garbage: true })
  const client = createX402Client({
    wallet: makeWallet(),
    fetch: fetchImpl,
    promptUser: async () => true
  })
  try {
    await client.fetchPaid('https://example.test/x402/premium-translations')
    t.fail('expected throw')
  } catch (err) {
    t.is(err.code, 'BAD_CHALLENGE')
  }
})

test('fetchPaid: no promptUser configured -> PAYWALL_REQUIRED thrown so caller can drive UI', async (t) => {
  const fetchImpl = async () => makeResp(402, { x402Version: 1, accepts: [makeChallenge()] })
  const client = createX402Client({ wallet: makeWallet(), fetch: fetchImpl })
  try {
    await client.fetchPaid('https://example.test/x402/premium-translations')
    t.fail('expected throw')
  } catch (err) {
    t.is(err.code, 'PAYWALL_REQUIRED')
    t.ok(err.challenge, 'challenge attached for renderer to prompt')
  }
})
