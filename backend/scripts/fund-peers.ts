/**
 * fund-peers.ts
 *
 * Sends Sepolia USDT from the sponsor EOA (RELAY_SPONSOR_PK) to one or more
 * peer smart-account addresses so the Pear app can demo tipping without
 * requiring each peer to hit a faucet manually.
 *
 * This is a demo helper. In production, peers fund their own wallets.
 *
 * Usage:
 *   bun run scripts/fund-peers.ts <address> [address ...] [--amount 100]
 *
 * Or via package.json:
 *   bun run fund:peers -- 0xPeerA 0xPeerB --amount 100
 *
 * Env this reads:
 *   RELAY_SPONSOR_PK           sponsor EOA private key (required)
 *   SEPOLIA_RPC_URLS           comma-separated RPCs, first reachable wins
 *   SEPOLIA_USDT_ADDRESS       ERC-20 USDT contract on Sepolia
 *
 * Exit codes:
 *   0  = every transfer landed
 *   1  = at least one transfer reverted or config missing
 *   2  = no reachable RPC / bad env
 */

import { ethers } from 'ethers'
import '../dotenv.ts'

const LOG = '[fund:peers]'
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 value) returns (bool)'
]

interface Args {
  addresses: string[]
  amount: string
}

function parseArgs(argv: string[]): Args {
  const addresses: string[] = []
  let amount = '100'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--amount' || a === '-a') {
      amount = argv[++i]
      continue
    }
    if (a.startsWith('0x') && a.length === 42) {
      addresses.push(ethers.getAddress(a))
    }
  }
  return { addresses, amount }
}

function pickRpc(urls: string[]): string {
  for (const u of urls) {
    if (u && u.trim().length > 0) return u.trim()
  }
  return 'https://ethereum-sepolia-rpc.publicnode.com'
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2)
  const { addresses, amount } = parseArgs(raw)

  if (addresses.length === 0) {
    console.error(`${LOG} pass one or more 0x-prefixed peer smart addresses`)
    console.error(`${LOG} example: bun run scripts/fund-peers.ts 0xPeerA 0xPeerB --amount 100`)
    process.exit(1)
  }

  const pk = process.env.RELAY_SPONSOR_PK?.trim()
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error(`${LOG} RELAY_SPONSOR_PK missing or not a 0x-prefixed 32-byte hex`)
    process.exit(1)
  }

  const usdtAddress = (process.env.SEPOLIA_USDT_ADDRESS || '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238').trim()
  const rpcList = (process.env.SEPOLIA_RPC_URLS || 'https://ethereum-sepolia-rpc.publicnode.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const rpc = pickRpc(rpcList)
  // publicnode + drpc free tiers reject batched requests, so disable batching.
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 })
  try {
    await provider.getBlockNumber()
  } catch (err: any) {
    console.error(`${LOG} rpc ${rpc} unreachable: ${err?.message}`)
    process.exit(2)
  }

  const sponsor = new ethers.Wallet(pk, provider)
  const usdt = new ethers.Contract(usdtAddress, ERC20_ABI, sponsor)
  const [sym, decimals] = await Promise.all([usdt.symbol(), usdt.decimals()])
  const decNum = Number(decimals)
  const amountBase = ethers.parseUnits(amount, decNum)

  const [sponsorEth, sponsorTok] = await Promise.all([
    provider.getBalance(sponsor.address),
    usdt.balanceOf(sponsor.address)
  ])

  console.log(`${LOG} rpc:      ${rpc}`)
  console.log(`${LOG} token:    ${sym} @ ${usdtAddress} (decimals=${decNum})`)
  console.log(`${LOG} sponsor:  ${sponsor.address}`)
  console.log(`${LOG}   ETH:    ${ethers.formatEther(sponsorEth)}`)
  console.log(`${LOG}   ${sym}:   ${ethers.formatUnits(sponsorTok, decNum)}`)
  console.log(`${LOG} plan:     send ${amount} ${sym} to each of ${addresses.length} peer(s)`)

  const needed = amountBase * BigInt(addresses.length)
  if (sponsorTok < needed) {
    console.error(`${LOG} sponsor balance ${ethers.formatUnits(sponsorTok, decNum)} ${sym} < required ${ethers.formatUnits(needed, decNum)} ${sym}`)
    process.exit(1)
  }
  if (sponsorEth === 0n) {
    console.error(`${LOG} sponsor has 0 ETH; cannot pay gas`)
    process.exit(1)
  }

  let failed = 0
  for (const to of addresses) {
    try {
      console.log('')
      console.log(`${LOG} -> ${to}`)
      const before = await usdt.balanceOf(to)
      console.log(`${LOG}    balance before: ${ethers.formatUnits(before, decNum)} ${sym}`)
      const tx = await usdt.transfer(to, amountBase)
      console.log(`${LOG}    tx sent: ${tx.hash}`)
      console.log(`${LOG}    explorer: https://sepolia.etherscan.io/tx/${tx.hash}`)
      const rc = await tx.wait()
      if (!rc || rc.status !== 1) {
        console.error(`${LOG}    reverted`)
        failed++
        continue
      }
      const after = await usdt.balanceOf(to)
      console.log(`${LOG}    balance after:  ${ethers.formatUnits(after, decNum)} ${sym}`)
    } catch (err: any) {
      console.error(`${LOG}    transfer failed: ${err?.shortMessage || err?.message || err}`)
      failed++
    }
  }

  console.log('')
  if (failed > 0) {
    console.error(`${LOG} done with ${failed} failure(s) out of ${addresses.length}`)
    process.exit(1)
  }
  console.log(`${LOG} all ${addresses.length} transfer(s) confirmed`)
  process.exit(0)
}

main().catch((err) => {
  console.error(`${LOG} aborted:`, err?.shortMessage || err?.message || err)
  process.exit(2)
})
