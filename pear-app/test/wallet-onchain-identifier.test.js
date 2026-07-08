// C3.a: WDK on-chain attribution marker. Verifies that the wallet worklet
// passes the object-form onChainIdentifier to the WalletFactory constructor,
// with the CLOSED platform enum value 'Widget' (NOT 'Pear-runtime', which
// would be silently bucketed as 'unknown' by any downstream Tether analytics).
//
// Docs:
//   https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/configuration/
// Local memo:
//   memory/impl_onchain_identifier.md

const test = require('brittle')
const { SEPOLIA } = require('../bare/wallet/eip3009.js')
const { createWalletAdapter } = require('../bare/wallet/worklet.js')

test('worklet exports include createWalletAdapter', (t) => {
  t.is(typeof createWalletAdapter, 'function', 'factory exported')
})

test('WalletFactory receives object-form onChainIdentifier', async (t) => {
  const stubSecret = class {
    constructor() { this.data = new Map() }
    async init() {}
    async get(k) { return this.data.get(k) || null }
    async set(k, v) { this.data.set(k, v) }
  }
  const stubWDK = {
    // Well-known BIP-39 test phrase; NEVER used with real funds.
    getRandomSeedPhrase() {
      return 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
    }
  }
  const captured = []
  const stubWalletFactory = function (seed, cfg) {
    captured.push({ seed, cfg })
    return {
      async getAccount() {
        return {
          async getAddress() { return '0x' + 'ab'.repeat(20) },
          async getTokenBalance() { return 0n },
          async signTypedData() { return '0x' + 'aa'.repeat(32) + 'bb'.repeat(32) + '1c' }
        }
      }
    }
  }
  let ethers
  try { ethers = require('ethers') } catch {
    t.comment('ethers not installed; skipping HD derivation')
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
  await w.init({ passcode: 'testpasscode', storageDir: '/tmp' })

  t.is(captured.length, 1, 'WalletFactory constructed once')
  const oci = captured[0].cfg.onChainIdentifier
  t.ok(oci, 'onChainIdentifier present in factory options')
  t.is(typeof oci, 'object', 'onChainIdentifier is object, not string')
  t.absent(Array.isArray(oci), 'onChainIdentifier is a plain object')
  t.is(oci.project, 'curva', "project = 'curva'")

  // CLOSED enum per docs at
  // https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/configuration/
  // Values: 'Web' | 'Mobile' | 'Safe App' | 'Widget'. 'Pear-runtime' is NOT in
  // the enum and would be silently bucketed as unknown by Tether analytics.
  t.is(oci.platform, 'Widget', "platform = 'Widget' (NOT 'Pear-runtime')")
  t.not(oci.platform, 'Pear-runtime', 'platform is not the invalid value')
  const allowed = new Set(['Web', 'Mobile', 'Safe App', 'Widget'])
  t.ok(allowed.has(oci.platform), 'platform is in the closed enum')

  t.is(oci.tool, 'curva-wallet', "tool = 'curva-wallet' (Pear identity lives here)")
  t.is(oci.toolVersion, '0.1.0', 'toolVersion = 0.1.0')
})
