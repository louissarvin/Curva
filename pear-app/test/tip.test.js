// Phase 3 brittle test: tip service orchestration.
//
// We stub the wallet, backend client, and Hyperbee to verify that:
// - proposeTip writes a pre-broadcast pending row
// - it calls wallet.signEip3009 with the right (chainId, tokenAddress, to, value)
// - it calls backend.submitFacilitator with the whole EIP-3009 payload
// - it rewrites the row with the real txHash on success
// - it marks failed on any downstream error
// - amount validation catches negatives, zero, and > demo cap
// - nonces don't collide across rapid taps
// - state transitions fire in the right order

const test = require('brittle')
const { createTipService, TipError, MAX_DEMO_AMOUNT_BASE } = require('../bare/tip.js')
const { SEPOLIA } = require('../bare/wallet/eip3009.js')

// -- fake Hyperbee ---------------------------------------------------------

function makeFakeBee() {
  const data = new Map()
  return {
    _data: data,
    async put(k, v) { data.set(k, JSON.parse(JSON.stringify(v))) },
    async del(k) { data.delete(k) },
    async get(k) {
      const v = data.get(k)
      return v ? { key: k, value: v } : null
    },
    async close() {},
    createReadStream({ gt, lt, limit } = {}) {
      const keys = [...data.keys()].sort()
      const filtered = keys.filter((k) => {
        if (gt && k <= gt) return false
        if (lt && k >= lt) return false
        return true
      })
      const trimmed = typeof limit === 'number' ? filtered.slice(0, limit) : filtered
      return (async function* () {
        for (const k of trimmed) yield { key: k, value: data.get(k) }
      })()
    }
  }
}

// -- fake wallet -----------------------------------------------------------

function makeFakeWallet({ ownerAddress, sigOverride, userOpOverride, includeUserOpMethod = true } = {}) {
  const calls = []
  const userOpCalls = []
  const wallet = {
    calls,
    userOpCalls,
    async signEip3009(msg) {
      calls.push(msg)
      if (sigOverride?.throw) throw sigOverride.throw
      return {
        v: 27,
        r: '0x' + 'aa'.repeat(32),
        s: '0x' + 'bb'.repeat(32),
        from: ownerAddress || '0x1111111111111111111111111111111111111111',
        nonce: msg.nonce,
        validAfter: msg.validAfter ?? 0,
        validBefore: msg.validBefore ?? Math.floor(Date.now() / 1000) + 900,
        typedData: { placeholder: true }
      }
    },
    getInfo() {
      return {
        initialized: true,
        smartAddress: '0x3333333333333333333333333333333333333333',
        ownerAddress: ownerAddress || '0x1111111111111111111111111111111111111111',
        chainId: SEPOLIA.chainId
      }
    }
  }
  if (includeUserOpMethod) {
    wallet.sendUsdtViaAccountTransfer = async function ({ recipient, amount }) {
      userOpCalls.push({ recipient, amount })
      if (userOpOverride?.throw) throw userOpOverride.throw
      return userOpOverride?.result || {
        txHash: '0x' + 'ee'.repeat(32),
        userOpHash: '0x' + 'ee'.repeat(32),
        fee: '150000'
      }
    }
  }
  return wallet
}

// -- fake backend ----------------------------------------------------------

function makeFakeBackend({ response, throwErr } = {}) {
  const calls = []
  return {
    calls,
    baseUrl: 'http://fake',
    async submitFacilitator(body) {
      calls.push(body)
      if (throwErr) throw throwErr
      return response || {
        ok: true,
        data: { txHash: '0x' + 'cc'.repeat(32), reservationId: 'res-1' }
      }
    }
  }
}

// -- constructor validation ------------------------------------------------

test('createTipService requires wallet, roomStateBee, hostSmartAddr', (t) => {
  t.exception.all(
    () => createTipService({ roomStateBee: makeFakeBee(), hostSmartAddr: '0x' + '1'.repeat(40) }),
    'no wallet -> rejects'
  )
  t.exception.all(
    () => createTipService({ wallet: makeFakeWallet(), hostSmartAddr: '0x' + '1'.repeat(40) }),
    'no roomStateBee -> rejects'
  )
  t.exception.all(
    () => createTipService({
      wallet: makeFakeWallet(),
      roomStateBee: makeFakeBee(),
      hostSmartAddr: 'not-an-address'
    }),
    'bad hostSmartAddr -> rejects'
  )
})

// -- amount validation -----------------------------------------------------

test('proposeTip rejects invalid amounts', async (t) => {
  const tip = createTipService({
    wallet: makeFakeWallet(),
    backend: makeFakeBackend(),
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40)
  })
  await t.exception.all(() => tip.proposeTip({ amount: '0' }), 'zero rejected')
  await t.exception.all(() => tip.proposeTip({ amount: '-1' }), 'negative rejected')
  await t.exception.all(() => tip.proposeTip({ amount: '1.5' }), 'non-integer rejected')
  await t.exception.all(() => tip.proposeTip({ amount: 1000000 }), 'non-string rejected')
  await t.exception.all(
    () => tip.proposeTip({ amount: String(MAX_DEMO_AMOUNT_BASE + 1n) }),
    'over demo cap rejected'
  )
  await t.exception.all(() => tip.proposeTip({}), 'missing amount rejected')
})

test('proposeTip rejects invalid note', async (t) => {
  const tip = createTipService({
    wallet: makeFakeWallet(),
    backend: makeFakeBackend(),
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40)
  })
  await t.exception.all(
    () => tip.proposeTip({ amount: '1000000', note: 123 }),
    'non-string note rejected'
  )
  await t.exception.all(
    () => tip.proposeTip({ amount: '1000000', note: 'x'.repeat(200) }),
    'oversized note rejected'
  )
})

// -- happy path ------------------------------------------------------------

test('proposeTip writes pending row and calls wallet + facilitator in order', async (t) => {
  const bee = makeFakeBee()
  const wallet = makeFakeWallet({ ownerAddress: '0x' + '1'.repeat(40) })
  const backend = makeFakeBackend()

  const kinds = []
  const tip = createTipService({
    wallet,
    backend,
    roomStateBee: bee,
    hostSmartAddr: '0x' + '2'.repeat(40),
    tipperPubkey: 'aa'.repeat(32),
    onStateChange: (kind, row) => kinds.push([kind, row.status])
  })

  const row = await tip.proposeTip({ amount: '1000000', note: 'grazie' })

  t.is(row.status, 'submitted')
  t.is(row.tx_hash, '0x' + 'cc'.repeat(32))
  t.is(row.amount, '1000000')
  t.is(row.token, SEPOLIA.usdtAddress)
  t.is(row.to_address, '0x' + '2'.repeat(40))
  t.is(row.from_address, '0x' + '1'.repeat(40))
  t.is(row.note, 'grazie')

  // wallet was invoked with the right message.
  t.is(wallet.calls.length, 1)
  t.is(wallet.calls[0].chainId, SEPOLIA.chainId)
  t.is(wallet.calls[0].tokenAddress, SEPOLIA.usdtAddress)
  t.is(wallet.calls[0].to, '0x' + '2'.repeat(40))
  t.is(wallet.calls[0].value, '1000000')
  t.ok(/^0x[0-9a-f]{64}$/.test(wallet.calls[0].nonce), 'nonce is bytes32 hex')

  // facilitator was invoked with the full payload.
  t.is(backend.calls.length, 1)
  const body = backend.calls[0]
  t.is(body.chainId, SEPOLIA.chainId)
  t.is(body.tokenAddress, SEPOLIA.usdtAddress)
  t.is(body.from, '0x' + '1'.repeat(40))
  t.is(body.to, '0x' + '2'.repeat(40))
  t.is(body.value, '1000000')
  t.is(body.v, 27)
  t.ok(/^0x[0-9a-f]{64}$/.test(body.r))
  t.ok(/^0x[0-9a-f]{64}$/.test(body.s))
  t.ok(/^0x[0-9a-f]{64}$/.test(body.nonce))
  t.ok(Number.isInteger(body.validAfter))
  t.ok(Number.isInteger(body.validBefore))

  // Bee holds the final row (real tx hash key), no pending-* leftover.
  const beeKeys = [...bee._data.keys()]
  const pendingLeftover = beeKeys.find((k) => k.includes('pending-'))
  t.absent(pendingLeftover, 'pending-* key cleaned up')
  const finalKey = beeKeys.find((k) => k.includes('0x' + 'cc'.repeat(32)))
  t.ok(finalKey, 'final key by real tx hash exists')

  // State machine fired in expected order.
  const kindsOnly = kinds.map((k) => k[0])
  t.alike(kindsOnly, ['pending', 'signing', 'submitting', 'submitted'])
})

// -- failure paths ---------------------------------------------------------

test('proposeTip marks failed on wallet.signEip3009 error', async (t) => {
  const bee = makeFakeBee()
  const wallet = makeFakeWallet({ sigOverride: { throw: new Error('user rejected') } })
  const backend = makeFakeBackend()
  const kinds = []
  const tip = createTipService({
    wallet,
    backend,
    roomStateBee: bee,
    hostSmartAddr: '0x' + '2'.repeat(40),
    onStateChange: (kind) => kinds.push(kind)
  })

  const row = await tip.proposeTip({ amount: '1000000' })

  t.is(row.status, 'failed')
  t.is(row.error.code, 'WALLET_SIGN_FAILED')
  t.is(row.error.message, 'user rejected')
  t.is(backend.calls.length, 0, 'facilitator NOT called after sign failure')
  t.alike(kinds, ['pending', 'signing', 'failed'])
})

test('proposeTip marks failed on facilitator error response', async (t) => {
  const bee = makeFakeBee()
  const backend = makeFakeBackend({
    response: { ok: false, error: { code: 'CHAIN_UNSUPPORTED', message: 'nope' } }
  })
  const tip = createTipService({
    wallet: makeFakeWallet(),
    backend,
    roomStateBee: bee,
    hostSmartAddr: '0x' + '2'.repeat(40)
  })
  const row = await tip.proposeTip({ amount: '1000000' })
  t.is(row.status, 'failed')
  t.is(row.error.code, 'CHAIN_UNSUPPORTED')
  t.is(row.error.message, 'nope')
})

test('proposeTip marks failed when facilitator returns no txHash', async (t) => {
  const backend = makeFakeBackend({ response: { ok: true, data: {} } })
  const tip = createTipService({
    wallet: makeFakeWallet(),
    backend,
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40)
  })
  const row = await tip.proposeTip({ amount: '1000000' })
  t.is(row.status, 'failed')
  t.is(row.error.code, 'FACILITATOR_BAD_RESPONSE')
})

test('proposeTip marks failed when backend is missing AND fallback disabled', async (t) => {
  // Wave 8C: with fallback disabled, missing backend still hard-fails.
  const tip = createTipService({
    wallet: makeFakeWallet(),
    // backend intentionally omitted
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40),
    erc4337Fallback: false
  })
  const row = await tip.proposeTip({ amount: '1000000' })
  t.is(row.status, 'failed')
  t.is(row.error.code, 'BACKEND_UNAVAILABLE')
})

test('proposeTip falls back to UserOp when backend is missing AND fallback enabled', async (t) => {
  // Wave 8C: with fallback enabled (default), missing backend triggers
  // the ERC-4337 UserOp path — this is the desired behavior for a demo
  // where the backend is optional Companion infrastructure.
  const wallet = makeFakeWallet()
  const tip = createTipService({
    wallet,
    // backend intentionally omitted
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40),
    erc4337Fallback: true
  })
  const row = await tip.proposeTip({ amount: '1000000' })
  t.is(row.status, 'submitted', 'fallback saved the tip')
  t.is(row.route, 'erc4337')
  t.is(row.facilitator_error.code, 'BACKEND_UNAVAILABLE')
  t.is(wallet.userOpCalls.length, 1)
})

// -- nonce uniqueness ------------------------------------------------------

test('two rapid tips get distinct nonces', async (t) => {
  const wallet = makeFakeWallet()
  const tip = createTipService({
    wallet,
    backend: makeFakeBackend({
      response: { ok: true, data: { txHash: '0x' + 'cc'.repeat(32) } }
    }),
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40)
  })
  const [r1, r2] = await Promise.all([
    tip.proposeTip({ amount: '1000000' }),
    tip.proposeTip({ amount: '1000000' })
  ])
  t.ok(r1.nonce)
  t.ok(r2.nonce)
  t.not(r1.nonce, r2.nonce, 'nonces MUST differ (EIP-3009 replay protection)')
  t.is(wallet.calls.length, 2)
  t.not(wallet.calls[0].nonce, wallet.calls[1].nonce, 'wallet saw distinct nonces')
})

// -- listTips + markConfirmed ---------------------------------------------

test('markConfirmed updates a submitted row -> confirmed', async (t) => {
  const bee = makeFakeBee()
  const kinds = []
  const tip = createTipService({
    wallet: makeFakeWallet(),
    backend: makeFakeBackend({
      response: { ok: true, data: { txHash: '0x' + 'cc'.repeat(32) } }
    }),
    roomStateBee: bee,
    hostSmartAddr: '0x' + '2'.repeat(40),
    onStateChange: (k) => kinds.push(k)
  })
  await tip.proposeTip({ amount: '1000000' })
  const updated = await tip.markConfirmed('0x' + 'cc'.repeat(32), { block: 12345 })
  t.ok(updated)
  t.is(updated.status, 'confirmed')
  t.is(updated.block, 12345)
  t.ok(kinds.includes('confirmed'))
})

test('markConfirmed no-ops on unknown txHash', async (t) => {
  const tip = createTipService({
    wallet: makeFakeWallet(),
    backend: makeFakeBackend(),
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40)
  })
  const res = await tip.markConfirmed('0x' + 'dd'.repeat(32))
  t.is(res, null)
})

test('markConfirmed ignores malformed txHash', async (t) => {
  const tip = createTipService({
    wallet: makeFakeWallet(),
    backend: makeFakeBackend(),
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40)
  })
  t.is(await tip.markConfirmed('nope'), null)
  t.is(await tip.markConfirmed(null), null)
  t.is(await tip.markConfirmed(''), null)
})

test('listTips returns tips in Hyperbee order', async (t) => {
  const bee = makeFakeBee()
  const tip = createTipService({
    wallet: makeFakeWallet(),
    backend: makeFakeBackend({
      response: { ok: true, data: { txHash: '0x' + 'cc'.repeat(32) } }
    }),
    roomStateBee: bee,
    hostSmartAddr: '0x' + '2'.repeat(40)
  })
  await tip.proposeTip({ amount: '1000000' })
  const tips = await tip.listTips()
  t.is(tips.length, 1)
  t.is(tips[0].amount, '1000000')
})

// -- close -----------------------------------------------------------------

test('proposeTip rejects after close()', async (t) => {
  const tip = createTipService({
    wallet: makeFakeWallet(),
    backend: makeFakeBackend(),
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40)
  })
  tip.close()
  await t.exception.all(
    () => tip.proposeTip({ amount: '1000000' }),
    'closed service rejects new tips'
  )
})

test('TipError carries a code field', (t) => {
  const e = new TipError('VALIDATION_ERROR', 'oops')
  t.is(e.code, 'VALIDATION_ERROR')
  t.ok(e instanceof Error)
})

// -- getter surface --------------------------------------------------------

test('tip service exposes read-only host + chain accessors', (t) => {
  const tip = createTipService({
    wallet: makeFakeWallet(),
    backend: makeFakeBackend(),
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40),
    hostOwnerAddr: '0x' + '4'.repeat(40)
  })
  t.is(tip.hostSmartAddr, '0x' + '2'.repeat(40))
  t.is(tip.hostOwnerAddr, '0x' + '4'.repeat(40))
  t.is(tip.chainId, SEPOLIA.chainId)
  t.is(tip.tokenAddress, SEPOLIA.usdtAddress)
})

// -- Wave 8C: ERC-4337 UserOp fallback ------------------------------------

test('happy path sets route=eip3009 (facilitator succeeds, no fallback)', async (t) => {
  const bee = makeFakeBee()
  const wallet = makeFakeWallet()
  const tip = createTipService({
    wallet,
    backend: makeFakeBackend(),
    roomStateBee: bee,
    hostSmartAddr: '0x' + '2'.repeat(40),
    erc4337Fallback: true
  })
  const row = await tip.proposeTip({ amount: '1000000' })
  t.is(row.status, 'submitted')
  t.is(row.route, 'eip3009', 'facilitator path recorded on row')
  t.is(wallet.userOpCalls.length, 0, 'fallback NOT triggered on success')
})

test('fallback triggers when facilitator returns 503 FACILITATOR_DISABLED', async (t) => {
  const bee = makeFakeBee()
  const wallet = makeFakeWallet()
  const backend = makeFakeBackend({
    response: { ok: false, error: { code: 'FACILITATOR_DISABLED', message: 'sponsor pk unset' } }
  })
  const tip = createTipService({
    wallet,
    backend,
    roomStateBee: bee,
    hostSmartAddr: '0x' + '2'.repeat(40),
    erc4337Fallback: true
  })
  const row = await tip.proposeTip({ amount: '1000000' })
  t.is(row.status, 'submitted', 'succeeded via fallback')
  t.is(row.route, 'erc4337')
  t.is(row.tx_hash, '0x' + 'ee'.repeat(32))
  t.is(row.user_op_hash, '0x' + 'ee'.repeat(32))
  t.is(row.userop_fee, '150000')
  t.is(row.facilitator_error.code, 'FACILITATOR_DISABLED', 'reason preserved on row')
  t.is(wallet.userOpCalls.length, 1, 'fallback invoked once')
  t.is(wallet.userOpCalls[0].recipient, '0x' + '2'.repeat(40))
  t.is(wallet.userOpCalls[0].amount, '1000000')
})

test('fallback triggers when facilitator is unreachable (network error)', async (t) => {
  const wallet = makeFakeWallet()
  const backend = makeFakeBackend({
    response: { ok: false, error: { code: 'BACKEND_UNREACHABLE', message: 'ECONNREFUSED' } }
  })
  const tip = createTipService({
    wallet,
    backend,
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40),
    erc4337Fallback: true
  })
  const row = await tip.proposeTip({ amount: '1000000' })
  t.is(row.status, 'submitted')
  t.is(row.route, 'erc4337')
  t.is(row.facilitator_error.code, 'BACKEND_UNREACHABLE')
})

test('fallback triggers when facilitator times out', async (t) => {
  const wallet = makeFakeWallet()
  const backend = makeFakeBackend({
    response: { ok: false, error: { code: 'BACKEND_TIMEOUT', message: 'aborted' } }
  })
  const tip = createTipService({
    wallet,
    backend,
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40),
    erc4337Fallback: true
  })
  const row = await tip.proposeTip({ amount: '1000000' })
  t.is(row.status, 'submitted')
  t.is(row.route, 'erc4337')
})

test('fallback does NOT trigger on business errors (bad signature, chain unsupported)', async (t) => {
  const wallet = makeFakeWallet()
  const backend = makeFakeBackend({
    response: { ok: false, error: { code: 'CHAIN_UNSUPPORTED', message: 'nope' } }
  })
  const tip = createTipService({
    wallet,
    backend,
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40),
    erc4337Fallback: true
  })
  const row = await tip.proposeTip({ amount: '1000000' })
  t.is(row.status, 'failed', 'business error is surfaced, not silently retried')
  t.is(row.error.code, 'CHAIN_UNSUPPORTED')
  t.is(wallet.userOpCalls.length, 0, 'fallback NOT engaged on non-infra error')
})

test('erc4337Fallback=false hard-fails on facilitator down', async (t) => {
  const wallet = makeFakeWallet()
  const backend = makeFakeBackend({
    response: { ok: false, error: { code: 'FACILITATOR_DISABLED', message: 'sponsor pk unset' } }
  })
  const tip = createTipService({
    wallet,
    backend,
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40),
    erc4337Fallback: false
  })
  const row = await tip.proposeTip({ amount: '1000000' })
  t.is(row.status, 'failed', 'fallback disabled -> hard fail')
  t.is(row.error.code, 'FACILITATOR_DISABLED')
  t.is(wallet.userOpCalls.length, 0)
})

test('fallback surfaces USEROP_INSUFFICIENT_BALANCE from wallet clearly', async (t) => {
  const wallet = makeFakeWallet({
    userOpOverride: {
      throw: Object.assign(new Error('smart account has insufficient balance for transfer + fee'), {
        code: 'USEROP_INSUFFICIENT_BALANCE'
      })
    }
  })
  const backend = makeFakeBackend({
    response: { ok: false, error: { code: 'FACILITATOR_DISABLED', message: 'down' } }
  })
  const tip = createTipService({
    wallet,
    backend,
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40),
    erc4337Fallback: true
  })
  const row = await tip.proposeTip({ amount: '1000000' })
  t.is(row.status, 'failed', 'unfunded smart-account still fails, but with a clear code')
  t.is(row.error.code, 'USEROP_INSUFFICIENT_BALANCE')
  t.is(row.route, 'erc4337', 'route field recorded so ops know fallback was tried')
})

test('fallback disabled when wallet lacks sendUsdtViaAccountTransfer', async (t) => {
  const wallet = makeFakeWallet({ includeUserOpMethod: false })
  const backend = makeFakeBackend({
    response: { ok: false, error: { code: 'FACILITATOR_DISABLED', message: 'down' } }
  })
  const tip = createTipService({
    wallet,
    backend,
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40),
    erc4337Fallback: true
  })
  const row = await tip.proposeTip({ amount: '1000000' })
  t.is(row.status, 'failed', 'no fallback method -> surface original error')
  t.is(row.error.code, 'FACILITATOR_DISABLED')
})

test('system:tip chat carries route=eip3009 on happy path', async (t) => {
  const chat = { sent: [], async sendSystem(msg) { this.sent.push(msg) } }
  const wallet = makeFakeWallet()
  const tip = createTipService({
    wallet,
    backend: makeFakeBackend(),
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40),
    chat,
    tipperPubkey: 'aa'.repeat(32),
    erc4337Fallback: true
  })
  await tip.proposeTip({ amount: '1000000' })
  const tipMsg = chat.sent.find((m) => m.type === 'system:tip')
  t.ok(tipMsg, 'system:tip appended')
  t.is(tipMsg.route, 'eip3009', 'route reported to chat')
})

test('system:tip chat carries route=erc4337 on fallback path', async (t) => {
  const chat = { sent: [], async sendSystem(msg) { this.sent.push(msg) } }
  const wallet = makeFakeWallet()
  const backend = makeFakeBackend({
    response: { ok: false, error: { code: 'FACILITATOR_DISABLED', message: 'down' } }
  })
  const tip = createTipService({
    wallet,
    backend,
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40),
    chat,
    tipperPubkey: 'aa'.repeat(32),
    erc4337Fallback: true
  })
  await tip.proposeTip({ amount: '1000000' })
  const tipMsg = chat.sent.find((m) => m.type === 'system:tip')
  t.ok(tipMsg, 'system:tip appended')
  t.is(tipMsg.route, 'erc4337', 'route reported to chat')
})
