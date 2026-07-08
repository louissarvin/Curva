// Tier 4: ERC-4337 batch tip tests.
//
// Covers both layers of the batch feature:
//   - worklet: signAndSendBatch composes the correct txs array, encodes
//     ERC-20 transfer calldata with the 0xa9059cbb selector + padded address
//     + padded uint256, and enforces size + total caps.
//   - tip service: tipBatch normalizes recipients, writes pending + submitted
//     rows to the Hyperbee, and emits batch-pending / batch-confirmed events
//     with the expected shape.
//
// Uses the same brittle test framework and Hyperbee/wallet stubs as tip.test.js.

const test = require('brittle')
const { createWalletAdapter } = require('../bare/wallet/worklet.js')
const { createTipService, TipError } = require('../bare/tip.js')
const { SEPOLIA } = require('../bare/wallet/eip3009.js')

// ethers is present in the pear-app tree (used by the wallet worklet for the
// EIP-712 fallback signer). We re-use the real Interface here so the calldata
// checks below assert against ethers' own encoder, not against a hand-rolled
// mock.
let ethers
try { ethers = require('ethers') } catch { ethers = null }

// -- fake Hyperbee ---------------------------------------------------------

function makeFakeBee() {
  const data = new Map()
  return {
    _data: data,
    async put(k, v) { data.set(k, JSON.parse(JSON.stringify(v, (_, val) => typeof val === 'bigint' ? val.toString() : val))) },
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

// -- direct worklet exercise via injected fake WDK -------------------------
//
// createWalletAdapter is factored so we can inject a fake WalletFactory /
// SecretManager / WDK. This lets us assert exactly what account.sendTransaction
// was called with, without touching the real Safe 4337 SDK.

function makeFakeWorkletDeps({ sendTransactionSpy, sendTransactionResult, sendTransactionThrow } = {}) {
  const account = {
    async getAddress() { return '0x' + '3'.repeat(40) },
    async getTokenBalance() { return 0n },
    async signTypedData() { return '0x' + '00'.repeat(65) },
    async sign() { return '0x' + '00'.repeat(65) },
    async sendTransaction(txs) {
      if (sendTransactionSpy) sendTransactionSpy(txs)
      if (sendTransactionThrow) throw sendTransactionThrow
      return sendTransactionResult || {
        hash: '0x' + 'ab'.repeat(32),
        fee: 123456n
      }
    }
  }
  class FakeWalletFactory {
    constructor(_seed, _opts) {}
    async getAccount(_i) { return account }
  }
  const SecretManager = class {
    constructor() {}
    async init() {}
    async get() { return 'test seed phrase test seed phrase test seed phrase test seed phrase test seed phrase test seed phrase' }
    async set() {}
  }
  const WDK = { getRandomSeedPhrase: () => 'test seed' }
  return { WalletFactory: FakeWalletFactory, SecretManager, WDK, account }
}

async function makeInitializedAdapter(overrides = {}) {
  const deps = makeFakeWorkletDeps(overrides)
  const adapter = createWalletAdapter({
    WalletFactory: deps.WalletFactory,
    SecretManager: deps.SecretManager,
    WDK: deps.WDK,
    ethers,
    storageDir: '/tmp/curva-batch-test-nonexistent',
    passcode: 'test-pass',
    chain: SEPOLIA
  })
  await adapter.init({ passcode: 'test-pass', storageDir: '/tmp/curva-batch-test-nonexistent' })
  return { adapter, account: deps.account }
}

// -- worklet: signAndSendBatch --------------------------------------------

test('signAndSendBatch composes correct txs for 3 recipients', async (t) => {
  if (!ethers) { t.pass('ethers unavailable; skipping'); return }
  let seen = null
  const { adapter } = await makeInitializedAdapter({
    sendTransactionSpy: (txs) => { seen = txs }
  })
  const recipients = [
    { address: '0x' + 'aa'.repeat(20), amountAtomicUsdt: '1000000' },
    { address: '0x' + 'bb'.repeat(20), amountAtomicUsdt: '2000000' },
    { address: '0x' + 'cc'.repeat(20), amountAtomicUsdt: '3000000' }
  ]
  const res = await adapter.signAndSendBatch(recipients)

  t.ok(Array.isArray(seen), 'account.sendTransaction called with an array')
  t.is(seen.length, 3, 'array has one entry per recipient')
  for (let i = 0; i < 3; i++) {
    t.is(seen[i].to, SEPOLIA.usdtAddress, `tx[${i}].to is USDT contract`)
    t.is(seen[i].value, 0n, `tx[${i}].value is 0n (ERC-20 has no native value)`)
    t.ok(typeof seen[i].data === 'string', `tx[${i}].data is a string`)
  }
  t.is(res.userOpHash, '0x' + 'ab'.repeat(32))
  t.is(res.fee, '123456')
  t.is(res.recipientCount, 3)
  t.is(res.totalAtomic, '6000000')
})

test('signAndSendBatch calldata is 0xa9059cbb + padded address + padded uint256', async (t) => {
  if (!ethers) { t.pass('ethers unavailable; skipping'); return }
  let seen = null
  const { adapter } = await makeInitializedAdapter({
    sendTransactionSpy: (txs) => { seen = txs }
  })
  const rcpt = '0x' + 'aa'.repeat(20)
  const amount = '1000000' // 1 USDT with 6 decimals
  await adapter.signAndSendBatch([
    { address: rcpt, amountAtomicUsdt: amount },
    { address: '0x' + 'bb'.repeat(20), amountAtomicUsdt: '2000000' }
  ])
  const data = seen[0].data
  t.is(data.slice(0, 10), '0xa9059cbb', 'selector is ERC-20 transfer(address,uint256)')
  // The calldata is: selector (4 bytes) + address padded to 32 bytes + uint256.
  // Total 4 + 32 + 32 = 68 bytes = 136 hex chars + 0x prefix.
  t.is(data.length, 2 + 8 + 64 + 64, 'calldata length matches selector + 2 * 32-byte args')
  // Address is right-padded to the low 20 bytes of the 32-byte slot, so the
  // first 12 bytes (24 hex chars) after the selector are zero.
  const addrSlot = data.slice(10, 10 + 64)
  t.is(addrSlot.slice(0, 24), '0'.repeat(24), 'address slot has 12 leading zero bytes')
  t.is(addrSlot.slice(24).toLowerCase(), 'aa'.repeat(20), 'address slot low 20 bytes match recipient')
  // uint256 amount is big-endian; 1_000_000 = 0xF4240 = right-aligned in 32 bytes.
  const amtSlot = data.slice(10 + 64)
  t.is(BigInt('0x' + amtSlot), 1_000000n, 'amount slot decodes to 1_000_000n atomic')
})

test('signAndSendBatch rejects total > 15 USDT', async (t) => {
  if (!ethers) { t.pass('ethers unavailable; skipping'); return }
  const { adapter } = await makeInitializedAdapter()
  // 5 x 4 USDT = 20 USDT total, over the 15 USDT cap.
  const recipients = Array.from({ length: 5 }, (_, i) => ({
    address: '0x' + String(i + 1).repeat(40).slice(0, 40),
    amountAtomicUsdt: '4000000'
  }))
  // Guard: use unique addresses to avoid clashes with other validators.
  const seen = new Set()
  for (const r of recipients) {
    if (seen.has(r.address)) r.address = '0x' + Math.random().toString(16).slice(2, 42).padEnd(40, '0')
    seen.add(r.address)
  }
  await t.exception.all(
    async () => { await adapter.signAndSendBatch(recipients) },
    /BATCH_TOTAL_EXCEEDED|exceeds cap/i,
    'total > 15 USDT is rejected'
  )
})

test('signAndSendBatch rejects size < 2 or > 5', async (t) => {
  if (!ethers) { t.pass('ethers unavailable; skipping'); return }
  const { adapter } = await makeInitializedAdapter()
  const one = [{ address: '0x' + 'aa'.repeat(20), amountAtomicUsdt: '1000000' }]
  const six = Array.from({ length: 6 }, (_, i) => ({
    address: '0x' + String.fromCharCode(97 + i).repeat(40),
    amountAtomicUsdt: '100000'
  }))
  await t.exception.all(
    async () => { await adapter.signAndSendBatch(one) },
    /BATCH_SIZE_INVALID|2\.\.5/i
  )
  await t.exception.all(
    async () => { await adapter.signAndSendBatch(six) },
    /BATCH_SIZE_INVALID|2\.\.5/i
  )
})

test('signAndSendBatch rejects invalid address format', async (t) => {
  if (!ethers) { t.pass('ethers unavailable; skipping'); return }
  const { adapter } = await makeInitializedAdapter()
  await t.exception.all(
    async () => { await adapter.signAndSendBatch([
      { address: 'not-an-address', amountAtomicUsdt: '1000000' },
      { address: '0x' + 'bb'.repeat(20), amountAtomicUsdt: '1000000' }
    ]) },
    /BATCH_INVALID_RECIPIENT|20-byte hex/i
  )
  await t.exception.all(
    async () => { await adapter.signAndSendBatch([
      { address: '0x' + 'aa'.repeat(20), amountAtomicUsdt: '0' },
      { address: '0x' + 'bb'.repeat(20), amountAtomicUsdt: '1000000' }
    ]) },
    /BATCH_INVALID_AMOUNT|positive integer/i,
    'zero amount rejected'
  )
  await t.exception.all(
    async () => { await adapter.signAndSendBatch([
      { address: '0x' + 'aa'.repeat(20), amountAtomicUsdt: '01' },
      { address: '0x' + 'bb'.repeat(20), amountAtomicUsdt: '1000000' }
    ]) },
    /BATCH_INVALID_AMOUNT|positive integer/i,
    'leading-zero amount rejected'
  )
})

// -- tip service: tipBatch -------------------------------------------------

function makeFakeBatchWallet({ batchOverride } = {}) {
  const calls = []
  return {
    calls,
    async signEip3009() { throw new Error('not used in batch tests') },
    async signAndSendBatch(pairs) {
      calls.push(pairs)
      if (batchOverride?.throw) throw batchOverride.throw
      return batchOverride?.result || {
        userOpHash: '0x' + 'ee'.repeat(32),
        fee: '150000',
        recipientCount: pairs.length,
        totalAtomic: String(pairs.reduce((s, p) => s + BigInt(p.amountAtomicUsdt), 0n))
      }
    }
  }
}

test('tipBatch validates recipients array size', async (t) => {
  const tip = createTipService({
    wallet: makeFakeBatchWallet(),
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40)
  })
  async function assertBatchSize(fn) {
    try { await fn(); t.fail('expected throw'); return }
    catch (err) {
      t.is(err.code, 'BATCH_SIZE_INVALID', 'code is BATCH_SIZE_INVALID')
    }
  }
  await assertBatchSize(() => tip.tipBatch({ recipients: [] }))
  await assertBatchSize(() => tip.tipBatch({ recipients: [
    { address: '0x' + 'aa'.repeat(20), amountAtomicUsdt: '1000000' }
  ] }))
  await assertBatchSize(() => tip.tipBatch({ recipients: Array.from({ length: 6 }, (_, i) => ({
    address: '0x' + String.fromCharCode(97 + i).repeat(40),
    amountAtomicUsdt: '100000'
  })) }))
})

test('tipBatch happy path emits batch-pending + batch-confirmed and calls wallet with array', async (t) => {
  const bee = makeFakeBee()
  const wallet = makeFakeBatchWallet()
  const kinds = []
  const payloads = []
  const tip = createTipService({
    wallet,
    roomStateBee: bee,
    hostSmartAddr: '0x' + '2'.repeat(40),
    tipperPubkey: 'aa'.repeat(32),
    onStateChange: (kind, row) => {
      kinds.push(kind)
      payloads.push({ kind, row })
    }
  })

  const recipients = [
    { address: '0x' + 'aa'.repeat(20), handle: 'alice', amountAtomicUsdt: '1000000' },
    { address: '0x' + 'bb'.repeat(20), handle: 'bob',   amountAtomicUsdt: '2000000' },
    { address: '0x' + 'cc'.repeat(20), handle: 'carol', amountAtomicUsdt: '3000000' }
  ]
  const row = await tip.tipBatch({ recipients })

  t.is(row.status, 'submitted')
  t.is(row.tx_hash, '0x' + 'ee'.repeat(32))
  t.is(row.user_op_hash, '0x' + 'ee'.repeat(32))
  t.is(row.route, 'erc4337-batch')
  t.is(row.total_base, '6000000')
  t.is(row.recipients.length, 3)

  // wallet.signAndSendBatch received an ARRAY of exactly 3 entries.
  t.is(wallet.calls.length, 1)
  t.ok(Array.isArray(wallet.calls[0]), 'wallet called with an array')
  t.is(wallet.calls[0].length, 3)
  for (const p of wallet.calls[0]) {
    t.ok(/^0x[0-9a-f]{40}$/.test(p.address), 'address is lowercased 0x + 20 bytes')
    t.ok(/^[1-9][0-9]*$/.test(p.amountAtomicUsdt), 'amount is positive integer string')
  }

  // State events fired in expected order.
  t.alike(kinds, ['batch-pending', 'batch-confirmed'])
  const confirmed = payloads[1].row
  t.is(confirmed.userOpHash, '0x' + 'ee'.repeat(32))
  t.is(confirmed.count, 3)
  t.is(confirmed.totalAtomic, '6000000')
  t.is(confirmed.etherscanUrl, 'https://sepolia.etherscan.io/tx/' + '0x' + 'ee'.repeat(32))
})

test('tipBatch enforces 15 USDT total cap', async (t) => {
  const tip = createTipService({
    wallet: makeFakeBatchWallet(),
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40)
  })
  // 4 x 4 USDT = 16 USDT total, over cap.
  const recipients = [
    { address: '0x' + 'aa'.repeat(20), amountAtomicUsdt: '4000000' },
    { address: '0x' + 'bb'.repeat(20), amountAtomicUsdt: '4000000' },
    { address: '0x' + 'cc'.repeat(20), amountAtomicUsdt: '4000000' },
    { address: '0x' + 'dd'.repeat(20), amountAtomicUsdt: '4000000' }
  ]
  await t.exception.all(
    () => tip.tipBatch({ recipients }),
    /BATCH_TOTAL_EXCEEDED|15 USDT/
  )
})

test('tipBatch marks failed on wallet.signAndSendBatch error and emits batch-failed', async (t) => {
  const wallet = makeFakeBatchWallet({
    batchOverride: { throw: Object.assign(new Error('bundler rejected'), { code: 'BATCH_INSUFFICIENT_BALANCE' }) }
  })
  const kinds = []
  const tip = createTipService({
    wallet,
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40),
    onStateChange: (kind) => kinds.push(kind)
  })
  const row = await tip.tipBatch({ recipients: [
    { address: '0x' + 'aa'.repeat(20), amountAtomicUsdt: '1000000' },
    { address: '0x' + 'bb'.repeat(20), amountAtomicUsdt: '1000000' }
  ] })
  t.is(row.status, 'failed')
  t.is(row.error.code, 'BATCH_INSUFFICIENT_BALANCE')
  // Error message MUST NOT leak the wallet-internal message.
  t.absent(/bundler rejected/i.test(row.error.message || ''), 'wallet-internal message is not leaked')
  t.alike(kinds, ['batch-pending', 'batch-failed'])
})

test('tipBatch rejects invalid address format', async (t) => {
  const tip = createTipService({
    wallet: makeFakeBatchWallet(),
    roomStateBee: makeFakeBee(),
    hostSmartAddr: '0x' + '2'.repeat(40)
  })
  try {
    await tip.tipBatch({ recipients: [
      { address: 'not-an-address', amountAtomicUsdt: '1000000' },
      { address: '0x' + 'bb'.repeat(20), amountAtomicUsdt: '1000000' }
    ] })
    t.fail('expected throw')
  } catch (err) {
    t.is(err.code, 'BATCH_INVALID_RECIPIENT', 'code is BATCH_INVALID_RECIPIENT')
  }
})
