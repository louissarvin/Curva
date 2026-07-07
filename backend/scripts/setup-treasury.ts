/**
 * setup-treasury.ts
 *
 * Derives the Curva sponsor / facilitator EOA address from either
 * `WDK_SEED` (a 12 or 24-word BIP-39 mnemonic, matches the legwork and
 * WDK-official pattern) or `RELAY_SPONSOR_PK` (a raw 0x-prefixed 32-byte
 * hex private key, the legacy Curva pattern).
 *
 * When both are set, WDK_SEED wins. If neither is set, the script
 * generates a fresh 24-word mnemonic (via ethers.Mnemonic.entropyToPhrase,
 * cryptographically equivalent to `WDK.getRandomSeedPhrase(24)` since both
 * use the BIP-39 standard) and prints it once for the operator to save.
 *
 * The script NEVER modifies .env. It only reads and reports. The operator
 * pastes the printed seed / instructions manually. This matches the ops
 * posture of `generate-secrets.ts` in the same folder.
 *
 * Usage:
 *   bun run treasury:setup
 *
 * Env this reads:
 *   WDK_SEED               12 or 24-word BIP-39 phrase (preferred)
 *   RELAY_SPONSOR_PK       0x-prefixed 32-byte hex (legacy fallback)
 *   SEPOLIA_RPC_URLS       first URL used for balance check
 *   RELAY_MIN_SPONSOR_BALANCE_WEI  minimum ETH balance (default 0.005 ETH)
 *
 * Exit codes:
 *   0 = treasury derived, balance above minimum
 *   1 = under-funded, funding instructions printed
 *   2 = configuration error (bad seed, bad pk, no RPC reachable)
 */

import { ethers } from 'ethers'
import '../dotenv.ts'

const LOG = '[treasury:setup]'
const BIP44_ETH_PATH = "m/44'/60'/0'/0/0"
// Circle USDC on Sepolia (FiatTokenV2 proxy). Prior deployment 0xd077a400968890eacc75cdc901f0356c943e4fdb
// did not implement EIP-3009 transferWithAuthorization, so the gasless tip flow required a switch.
const SEPOLIA_USDT = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'
const MIN_ETH_WEI = BigInt(process.env.RELAY_MIN_SPONSOR_BALANCE_WEI || String(5_000_000_000_000_000n))
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']

interface Derived {
  source: 'seed' | 'pk' | 'generated'
  address: string
  privateKey: string
  mnemonic: string | null
}

function firstRpc(): string {
  const list = (process.env.SEPOLIA_RPC_URLS || 'https://ethereum-sepolia-rpc.publicnode.com').split(',').map((s) => s.trim()).filter(Boolean)
  return list[0]
}

function isValidMnemonic(phrase: string): boolean {
  try {
    const wordCount = phrase.trim().split(/\s+/).length
    if (wordCount !== 12 && wordCount !== 24) return false
    const m = ethers.Mnemonic.fromPhrase(phrase.trim().toLowerCase())
    return !!m
  } catch {
    return false
  }
}

function isValidPk(hex: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(hex)
}

function deriveFromMnemonic(phrase: string, source: 'seed' | 'generated'): Derived {
  const normalized = phrase.trim().toLowerCase()
  const mnemonic = ethers.Mnemonic.fromPhrase(normalized)
  const hd = ethers.HDNodeWallet.fromMnemonic(mnemonic, BIP44_ETH_PATH)
  return {
    source,
    address: hd.address,
    privateKey: hd.privateKey,
    mnemonic: normalized
  }
}

function deriveFromPk(pk: string): Derived {
  const wallet = new ethers.Wallet(pk)
  return {
    source: 'pk',
    address: wallet.address,
    privateKey: pk,
    mnemonic: null
  }
}

async function fetchBalances(address: string): Promise<{ eth: bigint; usdt: bigint } | null> {
  const rpc = firstRpc()
  try {
    const provider = new ethers.JsonRpcProvider(rpc)
    const eth = await provider.getBalance(address)
    let usdt = 0n
    try {
      const contract = new ethers.Contract(SEPOLIA_USDT, ERC20_ABI, provider)
      usdt = await contract.balanceOf(address)
    } catch (err: any) {
      console.log(`${LOG} usdt balance check failed: ${err?.message}`)
    }
    return { eth, usdt }
  } catch (err: any) {
    console.error(`${LOG} rpc ${rpc} unreachable: ${err?.message}`)
    return null
  }
}

function printSection(title: string): void {
  console.log('')
  console.log(`--- ${title} ---`)
}

function printFundingInstructions(address: string, ethBalance: bigint): void {
  const shortfall = MIN_ETH_WEI - ethBalance
  const shortfallEth = Number(shortfall) / 1e18

  printSection('Funding Instructions')
  console.log(`  Copy this address:`)
  console.log(`    ${address}`)
  console.log('')
  console.log(`  Send at least ${shortfallEth.toFixed(4)} ETH (0.05 ETH recommended) via any Sepolia faucet:`)
  console.log(`    https://cloud.google.com/application/web3/faucet/ethereum/sepolia`)
  console.log(`    https://sepolia-faucet.pk910.de`)
  console.log(`    https://www.alchemy.com/faucets/ethereum-sepolia`)
  console.log('')
  console.log(`  After funding, verify on Etherscan:`)
  console.log(`    https://sepolia.etherscan.io/address/${address}`)
  console.log('')
  console.log(`  Then re-run this script or run 'bun run preflight' to verify.`)
}

async function main(): Promise<void> {
  console.log(`${LOG} Curva sponsor / facilitator treasury setup`)
  console.log('')

  const seed = process.env.WDK_SEED?.trim()
  const pk = process.env.RELAY_SPONSOR_PK?.trim()

  let derived: Derived

  if (seed && seed.length > 0) {
    if (!isValidMnemonic(seed)) {
      console.error(`${LOG} WDK_SEED is set but is not a valid 12 or 24-word BIP-39 phrase`)
      process.exit(2)
    }
    derived = deriveFromMnemonic(seed, 'seed')
    console.log(`${LOG} source: WDK_SEED (recommended, matches legwork + WDK docs)`)
  } else if (pk && pk.length > 0) {
    if (!isValidPk(pk)) {
      console.error(`${LOG} RELAY_SPONSOR_PK is set but is not a valid 0x-prefixed 32-byte hex`)
      process.exit(2)
    }
    derived = deriveFromPk(pk)
    console.log(`${LOG} source: RELAY_SPONSOR_PK (legacy Curva pattern, still supported)`)
  } else {
    console.log(`${LOG} source: NONE. Generating a fresh 24-word mnemonic.`)
    console.log(`${LOG} This is cryptographically equivalent to WDK.getRandomSeedPhrase(24) per BIP-39.`)
    console.log('')
    const entropy = ethers.randomBytes(32)
    const freshPhrase = ethers.Mnemonic.entropyToPhrase(entropy)
    derived = deriveFromMnemonic(freshPhrase, 'generated')
    printSection('New Mnemonic Generated')
    console.log(`  Save this seed phrase somewhere safe. It appears ONCE.`)
    console.log(`  Paste it into backend/.env as:`)
    console.log('')
    console.log(`    WDK_SEED="${derived.mnemonic}"`)
    console.log('')
    console.log(`  Then set:`)
    console.log(`    RELAY_SPONSOR_ENABLED=true`)
    console.log(`    FACILITATOR_ENABLED=true`)
    console.log('')
    console.log(`  You can also set RELAY_SPONSOR_PK if the backend needs a raw private key`)
    console.log(`  (facilitator.ts currently reads RELAY_SPONSOR_PK). The derived PK for this`)
    console.log(`  seed is printed below.`)
  }

  printSection('Derived Treasury / Sponsor EOA')
  console.log(`  Address:      ${derived.address}`)
  console.log(`  Etherscan:    https://sepolia.etherscan.io/address/${derived.address}`)
  if (derived.mnemonic) {
    console.log(`  BIP-44 path:  ${BIP44_ETH_PATH}`)
  }
  if (derived.source !== 'seed') {
    console.log(`  Private key:  ${derived.privateKey}`)
    console.log(`  (paste this as RELAY_SPONSOR_PK in .env if the facilitator uses PK)`)
  }

  printSection('Sepolia Balance Check')
  const balances = await fetchBalances(derived.address)
  if (!balances) {
    console.error(`${LOG} could not reach Sepolia RPC; balance unknown`)
    process.exit(2)
  }

  const ethAmount = Number(balances.eth) / 1e18
  const usdtAmount = Number(balances.usdt) / 1e6
  console.log(`  ETH:          ${ethAmount.toFixed(6)} ETH  (min ${(Number(MIN_ETH_WEI) / 1e18).toFixed(4)})`)
  console.log(`  USDT:         ${usdtAmount.toFixed(6)} USDT (Sepolia contract: ${SEPOLIA_USDT})`)

  if (balances.eth < MIN_ETH_WEI) {
    printFundingInstructions(derived.address, balances.eth)
    process.exit(1)
  }

  printSection('Ready')
  console.log(`  Treasury is funded above minimum. You can start the backend:`)
  console.log(`    bun run dev`)
  console.log('')
  console.log(`  Or verify all ops preflight checks:`)
  console.log(`    bun run preflight`)
  console.log('')
  process.exit(0)
}

main().catch((err) => {
  console.error(`${LOG} setup aborted:`, err?.message || err)
  process.exit(2)
})
