// Phase 3 brittle test: wallet worklet + EIP-3009 typed-data helpers.
//
// We test the pure signing helpers directly (buildTypedData, splitSignature,
// randomNonce) and exercise the wallet adapter using stub WDK dependencies
// so no real network / RPC / bundler / seed is involved.
//
// Rationale (per Phase 3 spec): the wallet worklet has heavy runtime deps
// (WDK + wdk-wallet-evm-erc-4337 + wdk-secret-manager) that we do NOT want
// to boot in unit tests. Extracted pure helpers make the signature construction
// verifiable in isolation.

const test = require('brittle')
const {
  buildTypedData,
  randomNonce,
  splitSignature,
  SEPOLIA,
  DEMO_AMOUNT_BASE_UNITS
} = require('../bare/wallet/eip3009.js')
const { createWalletAdapter, WalletError } = require('../bare/wallet/worklet.js')

// -- buildTypedData --------------------------------------------------------

test('buildTypedData returns EIP-712 shape matching F11 facilitator', (t) => {
  const td = buildTypedData({
    chainId: 11155111,
    tokenAddress: '0xd077a400968890eacc75cdc901f0356c943e4fdb',
    tokenName: 'USDT',
    tokenVersion: '1',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: '1000000',
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 900,
    nonce: '0x' + 'ab'.repeat(32)
  })

  t.is(td.primaryType, 'TransferWithAuthorization')
  t.is(td.domain.name, 'USDT')
  t.is(td.domain.version, '1')
  t.is(td.domain.chainId, 11155111)
  t.is(td.domain.verifyingContract, '0xd077a400968890eacc75cdc901f0356c943e4fdb')

  // Types object matches backend/src/lib/evm/eip3009.ts EXACTLY (field order + names).
  const fields = td.types.TransferWithAuthorization.map((f) => f.name + ':' + f.type)
  t.alike(fields, [
    'from:address',
    'to:address',
    'value:uint256',
    'validAfter:uint256',
    'validBefore:uint256',
    'nonce:bytes32'
  ])

  // Message addresses lowercased for canonical form.
  t.is(td.message.from, '0x1111111111111111111111111111111111111111')
  t.is(td.message.to, '0x2222222222222222222222222222222222222222')
  t.is(td.message.value, '1000000')
})

test('buildTypedData rejects invalid inputs', (t) => {
  t.exception.all(() => buildTypedData(null), 'null opts')
  t.exception.all(
    () => buildTypedData({
      chainId: 0,
      tokenAddress: '0xd077a400968890eacc75cdc901f0356c943e4fdb',
      tokenName: 'USDT',
      tokenVersion: '1',
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '1000000',
      validAfter: 0,
      validBefore: 1000,
      nonce: '0x' + 'ab'.repeat(32)
    }),
    'chainId=0 rejected'
  )
  t.exception.all(
    () => buildTypedData({
      chainId: 11155111,
      tokenAddress: 'not-hex',
      tokenName: 'USDT',
      tokenVersion: '1',
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '1000000',
      validAfter: 0,
      validBefore: 1000,
      nonce: '0x' + 'ab'.repeat(32)
    }),
    'non-hex tokenAddress rejected'
  )
  t.exception.all(
    () => buildTypedData({
      chainId: 11155111,
      tokenAddress: '0xd077a400968890eacc75cdc901f0356c943e4fdb',
      tokenName: 'USDT',
      tokenVersion: '1',
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '-1',
      validAfter: 0,
      validBefore: 1000,
      nonce: '0x' + 'ab'.repeat(32)
    }),
    'negative value rejected'
  )
  t.exception.all(
    () => buildTypedData({
      chainId: 11155111,
      tokenAddress: '0xd077a400968890eacc75cdc901f0356c943e4fdb',
      tokenName: 'USDT',
      tokenVersion: '1',
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '0',
      validAfter: 0,
      validBefore: 1000,
      nonce: '0x' + 'ab'.repeat(32)
    }),
    'zero value rejected'
  )
  t.exception.all(
    () => buildTypedData({
      chainId: 11155111,
      tokenAddress: '0xd077a400968890eacc75cdc901f0356c943e4fdb',
      tokenName: 'USDT',
      tokenVersion: '1',
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '1',
      validAfter: 100,
      validBefore: 50,
      nonce: '0x' + 'ab'.repeat(32)
    }),
    'validBefore <= validAfter rejected'
  )
  t.exception.all(
    () => buildTypedData({
      chainId: 11155111,
      tokenAddress: '0xd077a400968890eacc75cdc901f0356c943e4fdb',
      tokenName: 'USDT',
      tokenVersion: '1',
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '1',
      validAfter: 0,
      validBefore: 1000,
      nonce: '0xdeadbeef' // too short
    }),
    'short nonce rejected'
  )
})

// -- randomNonce -----------------------------------------------------------

test('randomNonce produces 0x-prefixed 32-byte hex, non-repeating', (t) => {
  const a = randomNonce()
  const b = randomNonce()
  t.ok(/^0x[0-9a-f]{64}$/.test(a), 'valid hex format A')
  t.ok(/^0x[0-9a-f]{64}$/.test(b), 'valid hex format B')
  t.not(a, b, 'two nonces differ (with overwhelming probability)')

  // 100 nonces MUST all differ.
  const seen = new Set()
  for (let i = 0; i < 100; i++) seen.add(randomNonce())
  t.is(seen.size, 100, 'no collisions across 100 draws')
})

// -- splitSignature --------------------------------------------------------

test('splitSignature parses 65-byte hex into (v,r,s)', (t) => {
  const r = 'aa'.repeat(32)
  const s = 'bb'.repeat(32)
  const vByte = '1c' // 28
  const parsed = splitSignature('0x' + r + s + vByte)
  t.is(parsed.v, 28)
  t.is(parsed.r, '0x' + r)
  t.is(parsed.s, '0x' + s)
})

test('splitSignature normalizes v=0/1 to 27/28', (t) => {
  const r = 'cc'.repeat(32)
  const s = 'dd'.repeat(32)
  const parsed0 = splitSignature('0x' + r + s + '00')
  const parsed1 = splitSignature('0x' + r + s + '01')
  t.is(parsed0.v, 27, 'v=0 -> 27')
  t.is(parsed1.v, 28, 'v=1 -> 28')
})

test('splitSignature rejects malformed input', (t) => {
  t.exception.all(() => splitSignature('not-hex'), 'garbage rejected')
  t.exception.all(() => splitSignature('0x1234'), 'short input rejected')
  t.exception.all(() => splitSignature(null), 'null rejected')
})

// -- Sepolia chain config sanity check -------------------------------------

test('SEPOLIA config points at the right USDT contract + chainId', (t) => {
  t.is(SEPOLIA.chainId, 11155111)
  t.is(SEPOLIA.usdtAddress, '0xd077a400968890eacc75cdc901f0356c943e4fdb')
  t.is(SEPOLIA.tokenName, 'USDT')
  t.is(SEPOLIA.tokenVersion, '1')
  t.is(DEMO_AMOUNT_BASE_UNITS, '1000000')
  // Fix Wave B / T2: WDK on-chain attribution marker.
  // Docs: https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/configuration/
  t.is(SEPOLIA.onChainIdentifier, 'curva', 'onChainIdentifier set for Tether traffic attribution')
})

// -- Wallet adapter: init requires passcode + WDK deps ---------------------

test('createWalletAdapter.init rejects missing passcode', async (t) => {
  const w = createWalletAdapter({
    storageDir: '/tmp/curva-fake',
    chain: SEPOLIA
  })
  await t.exception.all(
    () => w.init({ storageDir: '/tmp/curva-fake' }),
    'no passcode -> rejects'
  )
  await t.exception.all(
    () => w.init({ passcode: 'x', storageDir: '/tmp/curva-fake' }),
    'too-short passcode rejected'
  )
})

test('createWalletAdapter.init rejects missing storageDir', async (t) => {
  const w = createWalletAdapter({ chain: SEPOLIA })
  await t.exception.all(
    () => w.init({ passcode: 'dev-passcode' }),
    'no storageDir -> rejects'
  )
})

test('createWalletAdapter.init rejects missing WalletFactory', async (t) => {
  const stubSecret = class {
    constructor() {}
    async init() {}
    async get() { return null }
    async set() {}
  }
  const stubWDK = { getRandomSeedPhrase: (n) => Array(n).fill('word').join(' ') }
  const w = createWalletAdapter({
    SecretManager: stubSecret,
    WDK: stubWDK,
    storageDir: '/tmp',
    passcode: 'testpasscode',
    chain: SEPOLIA
  })
  await t.exception.all(
    () => w.init({ passcode: 'testpasscode', storageDir: '/tmp' }),
    'no WalletFactory -> rejects'
  )
})

test('createWalletAdapter.init succeeds with stub deps + returns addresses', async (t) => {
  const capturedSeeds = []
  const stubSecret = class {
    constructor(opts) { this.opts = opts; this.data = new Map() }
    async init() {}
    async get(k) { return this.data.get(k) || null }
    async set(k, v) { this.data.set(k, v); capturedSeeds.push('<redacted>') }
  }
  const stubWDK = {
    getRandomSeedPhrase(n) {
      // Use a valid BIP-39-shaped 24-word phrase so ethers.HDNodeWallet accepts it.
      // Well-known test phrase (NEVER used with real funds).
      return 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
    }
  }
  const constructorArgs = []
  const stubWalletFactory = function (seed, cfg) {
    constructorArgs.push({ seedLen: seed.split(' ').length, cfg })
    return {
      async getAccount(idx) {
        return {
          async getAddress() { return '0xAaAaaAAaaaAAaaaaaaAAaaAAaaAAAAaAAAAaaaAa' },
          async getTokenBalance() { return 0n },
          async signTypedData() { return '0x' + 'aa'.repeat(32) + 'bb'.repeat(32) + '1c' }
        }
      }
    }
  }
  let ethers
  try {
    ethers = require('ethers')
  } catch {
    t.comment('ethers not installed in test env; skipping HD derivation portion')
    return
  }
  const w = createWalletAdapter({
    SecretManager: stubSecret,
    WDK: stubWDK,
    WalletFactory: stubWalletFactory,
    ethers,
    storageDir: '/tmp',
    passcode: 'testpasscode',
    chain: SEPOLIA
  })
  const info = await w.init({ passcode: 'testpasscode', storageDir: '/tmp' })
  t.ok(info.smartAddress, 'smartAddress returned')
  t.is(info.smartAddress, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'lowercased smart addr')
  t.ok(info.ownerAddress, 'ownerAddress derived from seed')
  t.ok(/^0x[0-9a-f]{40}$/.test(info.ownerAddress), 'ownerAddress is valid EVM address')
  t.is(info.chainId, 11155111)
  t.is(constructorArgs.length, 1, 'WalletFactory constructor called once')
  t.is(constructorArgs[0].cfg.chainId, 11155111)
  t.is(constructorArgs[0].cfg.paymasterToken.address, SEPOLIA.usdtAddress)
  // C3.a: onChainIdentifier is passed as an OBJECT (not a string) so the
  // platform enum can be set correctly. `platform` must be one of the closed
  // enum values: 'Web' | 'Mobile' | 'Safe App' | 'Widget'. We use 'Widget' for
  // the Pear runtime and stash the Pear identity in `tool`.
  const oci = constructorArgs[0].cfg.onChainIdentifier
  t.is(typeof oci, 'object', 'onChainIdentifier is object form')
  t.is(oci.project, 'curva', 'project = curva')
  t.is(oci.platform, 'Widget', "platform = 'Widget' (NOT 'Pear-runtime' — enum closed)")
  t.is(oci.tool, 'curva-wallet', 'tool = curva-wallet')
  t.is(oci.toolVersion, '0.1.0', 'toolVersion = 0.1.0')

  // signEip3009 should return a v/r/s tuple whose `from` matches ownerAddress.
  const sig = await w.signEip3009({
    to: '0x2222222222222222222222222222222222222222',
    value: '1000000'
  })
  t.ok(Number.isInteger(sig.v), 'v is integer')
  t.ok(/^0x[0-9a-f]{64}$/.test(sig.r), 'r is bytes32 hex')
  t.ok(/^0x[0-9a-f]{64}$/.test(sig.s), 's is bytes32 hex')
  t.is(sig.from, info.ownerAddress, 'signer address == owner EOA')
  t.ok(sig.typedData, 'typedData returned for auditing')
  t.is(sig.typedData.domain.chainId, 11155111)

  // Signature must recover to the owner address using ethers.verifyTypedData.
  const flat = { ...sig.typedData.types }
  const recovered = ethers.verifyTypedData(
    sig.typedData.domain,
    flat,
    sig.typedData.message,
    ethers.Signature.from({ v: sig.v, r: sig.r, s: sig.s }).serialized
  )
  t.is(recovered.toLowerCase(), info.ownerAddress, 'ecrecover == owner EOA (F11 will accept)')

  w.dispose()
  const post = w.getInfo()
  t.is(post.initialized, false, 'post-dispose initialized=false')
  t.is(post.smartAddress, null, 'post-dispose secrets cleared')
})

// -- Fix Wave B / T3: dynamic token-domain fetch at init -------------------

test('createWalletAdapter.init fetches token domain from backend when configured', async (t) => {
  const stubSecret = class {
    constructor() { this.data = new Map() }
    async init() {}
    async get(k) { return this.data.get(k) || null }
    async set(k, v) { this.data.set(k, v) }
  }
  const stubWDK = {
    getRandomSeedPhrase() {
      return 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
    }
  }
  const stubWalletFactory = function () {
    return {
      async getAccount() {
        return {
          async getAddress() { return '0xAaAaaAAaaaAAaaaaaaAAaaAAaaAAAAaAAAAaaaAa' },
          async getTokenBalance() { return 0n },
          async signTypedData() { return '0x' + 'aa'.repeat(32) + 'bb'.repeat(32) + '1c' }
        }
      }
    }
  }
  let ethers
  try {
    ethers = require('ethers')
  } catch {
    t.comment('ethers not installed; skipping')
    return
  }
  const fetchCalls = []
  const fakeFetch = async (url) => {
    fetchCalls.push(url)
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          error: null,
          data: {
            chainId: 11155111,
            tokenAddress: SEPOLIA.usdtAddress,
            name: 'Tether USD',
            version: '2',
            fetchedAt: new Date().toISOString()
          }
        }
      }
    }
  }
  const w = createWalletAdapter({
    SecretManager: stubSecret,
    WDK: stubWDK,
    WalletFactory: stubWalletFactory,
    ethers,
    storageDir: '/tmp',
    passcode: 'testpasscode',
    backendBaseUrl: 'http://localhost:3700',
    fetch: fakeFetch,
    chain: SEPOLIA
  })
  const info = await w.init({ passcode: 'testpasscode', storageDir: '/tmp' })
  t.is(fetchCalls.length, 1, 'backend probe hit once')
  t.ok(fetchCalls[0].includes('/wdk/token-domain'), 'called the right endpoint')
  t.ok(fetchCalls[0].includes('chainId=11155111'), 'chainId in query')
  t.is(info.tokenName, 'Tether USD', 'init returns dynamic name')
  t.is(info.tokenVersion, '2', 'init returns dynamic version')

  // signEip3009 should now use the dynamic domain, not the hardcoded 'USDT'/'1'.
  const sig = await w.signEip3009({
    to: '0x2222222222222222222222222222222222222222',
    value: '1000000'
  })
  t.is(sig.typedData.domain.name, 'Tether USD', 'digest uses probed name')
  t.is(sig.typedData.domain.version, '2', 'digest uses probed version')
  w.dispose()
})

test('createWalletAdapter.init falls back to chain defaults when probe fails', async (t) => {
  const stubSecret = class {
    constructor() { this.data = new Map() }
    async init() {}
    async get(k) { return this.data.get(k) || null }
    async set(k, v) { this.data.set(k, v) }
  }
  const stubWDK = {
    getRandomSeedPhrase() {
      return 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
    }
  }
  const stubWalletFactory = function () {
    return {
      async getAccount() {
        return {
          async getAddress() { return '0xAaAaaAAaaaAAaaaaaaAAaaAAaaAAAAaAAAAaaaAa' },
          async getTokenBalance() { return 0n },
          async signTypedData() { return '0x' + 'aa'.repeat(32) + 'bb'.repeat(32) + '1c' }
        }
      }
    }
  }
  let ethers
  try {
    ethers = require('ethers')
  } catch {
    t.comment('ethers not installed; skipping')
    return
  }
  const fakeFetch = async () => { throw new Error('network down') }
  const w = createWalletAdapter({
    SecretManager: stubSecret,
    WDK: stubWDK,
    WalletFactory: stubWalletFactory,
    ethers,
    storageDir: '/tmp',
    passcode: 'testpasscode',
    backendBaseUrl: 'http://localhost:3700',
    fetch: fakeFetch,
    chain: SEPOLIA
  })
  const info = await w.init({ passcode: 'testpasscode', storageDir: '/tmp' })
  // Fallback: hardcoded chain defaults.
  t.is(info.tokenName, SEPOLIA.tokenName, 'fallback to hardcoded tokenName')
  t.is(info.tokenVersion, SEPOLIA.tokenVersion, 'fallback to hardcoded tokenVersion')
  const sig = await w.signEip3009({
    to: '0x2222222222222222222222222222222222222222',
    value: '1000000'
  })
  t.is(sig.typedData.domain.name, 'USDT', 'digest uses fallback name')
  t.is(sig.typedData.domain.version, '1', 'digest uses fallback version')
  w.dispose()
})

// -- WalletError shape -----------------------------------------------------

test('WalletError has code', (t) => {
  const e = new WalletError('WALLET_LOCKED', 'wrong passcode')
  t.is(e.code, 'WALLET_LOCKED')
  t.is(e.message, 'wrong passcode')
  t.ok(e instanceof Error)
})

// -- Wave 8C: sendUsdtViaAccountTransfer ----------------------------------
//
// account.transfer() docs say the return shape is { hash, fee }, but we adapt
// hash / userOpHash / txHash for forward-compat with other WDK builds.

function makeWalletWithTransferStub({ transferResult, transferThrows } = {}) {
  const stubSecret = class {
    constructor() { this.data = new Map() }
    async init() {}
    async get(k) { return this.data.get(k) || null }
    async set(k, v) { this.data.set(k, v) }
  }
  const stubWDK = {
    getRandomSeedPhrase() {
      return 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
    }
  }
  const transferCalls = []
  const stubWalletFactory = function () {
    return {
      async getAccount() {
        return {
          async getAddress() { return '0xAaAaaAAaaaAAaaaaaaAAaaAAaaAAAAaAAAAaaaAa' },
          async getTokenBalance() { return 42n },
          async signTypedData() { return '0x' + 'aa'.repeat(32) + 'bb'.repeat(32) + '1c' },
          async transfer(opts) {
            transferCalls.push(opts)
            if (transferThrows) throw transferThrows
            return transferResult
          }
        }
      }
    }
  }
  let ethers
  try { ethers = require('ethers') } catch { ethers = null }
  const w = createWalletAdapter({
    SecretManager: stubSecret,
    WDK: stubWDK,
    WalletFactory: stubWalletFactory,
    ethers,
    storageDir: '/tmp',
    passcode: 'testpasscode',
    chain: SEPOLIA
  })
  return { w, transferCalls }
}

test('sendUsdtViaAccountTransfer normalizes docs-shaped {hash,fee} return', async (t) => {
  const { w, transferCalls } = makeWalletWithTransferStub({
    transferResult: { hash: '0x' + 'aa'.repeat(32), fee: 123456n }
  })
  await w.init({ passcode: 'testpasscode', storageDir: '/tmp' })
  const res = await w.sendUsdtViaAccountTransfer({
    recipient: '0x' + '2'.repeat(40),
    amount: '1000000'
  })
  t.is(res.txHash, '0x' + 'aa'.repeat(32), 'txHash filled from hash')
  t.is(res.userOpHash, '0x' + 'aa'.repeat(32), 'userOpHash filled from hash')
  t.is(res.fee, '123456', 'bigint fee stringified')
  t.is(transferCalls.length, 1)
  t.is(transferCalls[0].token, SEPOLIA.usdtAddress)
  t.is(transferCalls[0].recipient, '0x' + '2'.repeat(40))
  t.is(transferCalls[0].amount, 1_000_000n, 'amount cast to BigInt per docs')
  w.dispose()
})

test('sendUsdtViaAccountTransfer adapts alt userOpHash field', async (t) => {
  const { w } = makeWalletWithTransferStub({
    transferResult: { userOpHash: '0x' + 'bb'.repeat(32) }
  })
  await w.init({ passcode: 'testpasscode', storageDir: '/tmp' })
  const res = await w.sendUsdtViaAccountTransfer({
    recipient: '0x' + '2'.repeat(40),
    amount: '1000000'
  })
  t.is(res.txHash, '0x' + 'bb'.repeat(32))
  t.is(res.userOpHash, '0x' + 'bb'.repeat(32))
  t.is(res.fee, null)
  w.dispose()
})

test('sendUsdtViaAccountTransfer adapts alt txHash field', async (t) => {
  const { w } = makeWalletWithTransferStub({
    transferResult: { txHash: '0x' + 'cc'.repeat(32), fee: '99' }
  })
  await w.init({ passcode: 'testpasscode', storageDir: '/tmp' })
  const res = await w.sendUsdtViaAccountTransfer({
    recipient: '0x' + '2'.repeat(40),
    amount: '1000000'
  })
  t.is(res.txHash, '0x' + 'cc'.repeat(32))
  t.is(res.fee, '99', 'string fee passes through')
  w.dispose()
})

test('sendUsdtViaAccountTransfer surfaces balance error clearly', async (t) => {
  const { w } = makeWalletWithTransferStub({
    transferThrows: new Error('insufficient token balance for transfer + paymaster fee')
  })
  await w.init({ passcode: 'testpasscode', storageDir: '/tmp' })
  try {
    await w.sendUsdtViaAccountTransfer({
      recipient: '0x' + '2'.repeat(40),
      amount: '1000000'
    })
    t.fail('expected throw')
  } catch (err) {
    t.is(err.code, 'USEROP_INSUFFICIENT_BALANCE')
    t.ok(err instanceof WalletError)
  }
  w.dispose()
})

test('sendUsdtViaAccountTransfer surfaces fee-exceeded error clearly', async (t) => {
  const { w } = makeWalletWithTransferStub({
    transferThrows: new Error('fee exceeds transferMaxFee')
  })
  await w.init({ passcode: 'testpasscode', storageDir: '/tmp' })
  try {
    await w.sendUsdtViaAccountTransfer({ recipient: '0x' + '2'.repeat(40), amount: '1000000' })
    t.fail('expected throw')
  } catch (err) {
    t.is(err.code, 'USEROP_FEE_EXCEEDED')
  }
  w.dispose()
})

test('sendUsdtViaAccountTransfer rejects garbage inputs before hitting WDK', async (t) => {
  const { w, transferCalls } = makeWalletWithTransferStub({
    transferResult: { hash: '0x' + 'aa'.repeat(32) }
  })
  await w.init({ passcode: 'testpasscode', storageDir: '/tmp' })
  await t.exception.all(
    () => w.sendUsdtViaAccountTransfer({ recipient: 'nope', amount: '1000000' }),
    'bad recipient rejected'
  )
  await t.exception.all(
    () => w.sendUsdtViaAccountTransfer({ recipient: '0x' + '2'.repeat(40), amount: '-1' }),
    'negative amount rejected'
  )
  await t.exception.all(
    () => w.sendUsdtViaAccountTransfer({ recipient: '0x' + '2'.repeat(40), amount: '0' }),
    'zero amount rejected'
  )
  await t.exception.all(
    () => w.sendUsdtViaAccountTransfer({ recipient: '0x' + '2'.repeat(40), amount: '1.5' }),
    'non-integer amount rejected'
  )
  t.is(transferCalls.length, 0, 'WDK never touched on invalid input')
  w.dispose()
})

test('sendUsdtViaAccountTransfer rejects when WDK returns hash-less result', async (t) => {
  const { w } = makeWalletWithTransferStub({ transferResult: { fee: 1n } })
  await w.init({ passcode: 'testpasscode', storageDir: '/tmp' })
  try {
    await w.sendUsdtViaAccountTransfer({ recipient: '0x' + '2'.repeat(40), amount: '1000000' })
    t.fail('expected throw')
  } catch (err) {
    t.is(err.code, 'USEROP_BAD_RESPONSE')
  }
  w.dispose()
})

test('warmSmartAccount primes address + balance without deploying', async (t) => {
  const { w } = makeWalletWithTransferStub({ transferResult: { hash: '0x' + 'aa'.repeat(32) } })
  await w.init({ passcode: 'testpasscode', storageDir: '/tmp' })
  const info = await w.warmSmartAccount()
  t.ok(info.warmed, 'warmed=true')
  t.is(info.smartAddress, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  t.is(info.tokenBalance, '42')
  w.dispose()
})
