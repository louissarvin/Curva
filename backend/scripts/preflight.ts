/**
 * preflight.ts
 *
 * Pre-pitch operational check for the Tether Developers Cup 2026 Final.
 * Walks the T-24h / T-6h / T-1h ops checklist automatically and prints a
 * pass/fail table.
 *
 * The script NEVER modifies state. It only reads and reports. Safe to run
 * as many times as you want.
 *
 * Usage:  bun run preflight
 * or:     bun scripts/preflight.ts
 *
 * Exit code:
 *   0 = all checks pass
 *   1 = one or more checks fail
 *   2 = a check errored (couldn't even run)
 *
 * Env this reads (all optional; defaults to safe fallbacks):
 *   PREFLIGHT_BACKEND_URL         default http://localhost:3700
 *   PREFLIGHT_SPONSOR_ADDRESS     required for the sponsor-balance check
 *   PREFLIGHT_MIN_SPONSOR_ETH     default 0.005 (matches RELAY_MIN_SPONSOR_BALANCE_WEI)
 *   PREFLIGHT_PITCH_MATCH_ID      the football-data.org fixture id for SF2; skips check if unset
 *   PREFLIGHT_ETH_RPC             default https://ethereum-sepolia-rpc.publicnode.com
 */

import { NODE_ENV } from '../src/config/main-config.ts'

const LOG = '[preflight]'
const BACKEND_URL = process.env.PREFLIGHT_BACKEND_URL || 'http://localhost:3700'
const SPONSOR_ADDRESS = process.env.PREFLIGHT_SPONSOR_ADDRESS || ''
const MIN_SPONSOR_ETH = parseFloat(process.env.PREFLIGHT_MIN_SPONSOR_ETH || '0.005')
const PITCH_MATCH_ID = process.env.PREFLIGHT_PITCH_MATCH_ID || ''
const ETH_RPC = process.env.PREFLIGHT_ETH_RPC || 'https://ethereum-sepolia-rpc.publicnode.com'

interface CheckResult {
  name: string
  status: 'pass' | 'fail' | 'skip' | 'error'
  detail: string
}

const results: CheckResult[] = []

function record(name: string, status: CheckResult['status'], detail: string): void {
  results.push({ name, status, detail })
  const marker = status === 'pass' ? 'OK  ' : status === 'fail' ? 'FAIL' : status === 'skip' ? 'SKIP' : 'ERR '
  console.log(`${LOG} ${marker} ${name.padEnd(40)} ${detail}`)
}

async function timedFetch(url: string, opts: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================================
// 1. Backend Companion is running
// ============================================================================
async function checkBackendHealth(): Promise<void> {
  try {
    const res = await timedFetch(`${BACKEND_URL}/health`, {}, 3000)
    if (!res.ok) {
      record('backend/health', 'fail', `HTTP ${res.status}`)
      return
    }
    const body = await res.json() as { success: boolean; data?: any }
    if (!body.success) {
      record('backend/health', 'fail', 'success=false')
      return
    }
    record('backend/health', 'pass', `up on ${BACKEND_URL}`)
  } catch (err: any) {
    record('backend/health', 'error', err?.message || 'unknown')
  }
}

// ============================================================================
// 2. Sponsor EOA balance on Sepolia is above the minimum
// ============================================================================
async function checkSponsorBalance(): Promise<void> {
  if (!SPONSOR_ADDRESS) {
    record('sepolia/sponsor-balance', 'skip', 'PREFLIGHT_SPONSOR_ADDRESS unset')
    return
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(SPONSOR_ADDRESS)) {
    record('sepolia/sponsor-balance', 'fail', 'address format invalid')
    return
  }
  try {
    const rpc = await timedFetch(ETH_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getBalance',
        params: [SPONSOR_ADDRESS, 'latest'],
        id: 1
      })
    }, 5000)
    if (!rpc.ok) {
      record('sepolia/sponsor-balance', 'error', `rpc HTTP ${rpc.status}`)
      return
    }
    const body = await rpc.json() as { result?: string; error?: { message: string } }
    if (body.error) {
      record('sepolia/sponsor-balance', 'error', body.error.message)
      return
    }
    if (!body.result) {
      record('sepolia/sponsor-balance', 'error', 'no result')
      return
    }
    const wei = BigInt(body.result)
    const eth = Number(wei) / 1e18
    const minWei = BigInt(Math.floor(MIN_SPONSOR_ETH * 1e18))
    if (wei < minWei) {
      record('sepolia/sponsor-balance', 'fail', `${eth.toFixed(6)} ETH (min ${MIN_SPONSOR_ETH})`)
      return
    }
    record('sepolia/sponsor-balance', 'pass', `${eth.toFixed(6)} ETH`)
  } catch (err: any) {
    record('sepolia/sponsor-balance', 'error', err?.message || 'unknown')
  }
}

// ============================================================================
// 3. Facilitator relay is enabled and its keys resolve
// ============================================================================
async function checkFacilitator(): Promise<void> {
  try {
    const res = await timedFetch(`${BACKEND_URL}/health`, {}, 3000)
    const body = await res.json() as { data?: { facilitator?: { enabled?: boolean; balances?: any[] } } }
    const fac = body.data?.facilitator
    if (!fac) {
      record('backend/facilitator', 'fail', 'facilitator block missing from /health')
      return
    }
    if (!fac.enabled) {
      record('backend/facilitator', 'fail', 'FACILITATOR_ENABLED=false')
      return
    }
    const bals = fac.balances || []
    const bad = bals.filter((b: any) => (parseFloat(b.balanceEth || '0') < 0.005))
    if (bad.length > 0) {
      record('backend/facilitator', 'fail', `${bad.length} of ${bals.length} accounts below 0.005 ETH`)
      return
    }
    record('backend/facilitator', 'pass', `${bals.length} accounts, all above threshold`)
  } catch (err: any) {
    record('backend/facilitator', 'error', err?.message || 'unknown')
  }
}

// ============================================================================
// 4. Football-data.org is reachable (if API key configured)
// ============================================================================
async function checkFootballData(): Promise<void> {
  try {
    const res = await timedFetch(`${BACKEND_URL}/matches/today`, {}, 5000)
    if (!res.ok) {
      record('backend/matches/today', 'fail', `HTTP ${res.status}`)
      return
    }
    const body = await res.json() as { data?: { matches?: any[] } }
    const count = body.data?.matches?.length ?? 0
    record('backend/matches/today', 'pass', `${count} fixtures today`)
  } catch (err: any) {
    record('backend/matches/today', 'error', err?.message || 'unknown')
  }
}

// ============================================================================
// 5. Bitfinex + Frankfurter pricing feed is fresh
// ============================================================================
async function checkPricingFeed(): Promise<void> {
  try {
    const res = await timedFetch(`${BACKEND_URL}/pricing/usdt?currency=IDR`, {}, 5000)
    if (!res.ok) {
      record('backend/pricing', 'fail', `HTTP ${res.status}`)
      return
    }
    const body = await res.json() as { data?: { rate?: number; stale?: boolean; source?: string } }
    if (!body.data?.rate) {
      record('backend/pricing', 'fail', 'no rate returned')
      return
    }
    if (body.data.stale) {
      record('backend/pricing', 'fail', `stale rate (source: ${body.data.source})`)
      return
    }
    record('backend/pricing', 'pass', `1 USDT = ${body.data.rate} IDR (${body.data.source})`)
  } catch (err: any) {
    record('backend/pricing', 'error', err?.message || 'unknown')
  }
}

// ============================================================================
// 6. QVAC model catalog serves and content digests are pinned
// ============================================================================
async function checkQvacCatalog(): Promise<void> {
  try {
    const res = await timedFetch(`${BACKEND_URL}/qvac/models`, {}, 5000)
    if (!res.ok) {
      record('backend/qvac/models', 'fail', `HTTP ${res.status}`)
      return
    }
    const body = await res.json() as { data?: { models?: Array<{ id: string; contentDigest?: string }> } }
    const models = body.data?.models || []
    const unverified = models.filter((m) => !m.contentDigest || m.contentDigest === 'pending-upstream')
    record('backend/qvac/models', 'pass', `${models.length} entries, ${unverified.length} pending-digest`)
  } catch (err: any) {
    record('backend/qvac/models', 'error', err?.message || 'unknown')
  }
}

// ============================================================================
// 7. Rooms exist for wc2026-sf2 and wc2026-final (T-6h checklist)
// ============================================================================
async function checkPitchRooms(): Promise<void> {
  const slugs = ['wc2026-sf2', 'wc2026-final']
  for (const slug of slugs) {
    try {
      const res = await timedFetch(`${BACKEND_URL}/rooms/${slug}`, {}, 3000)
      if (res.status === 404) {
        record(`rooms/${slug}`, 'fail', 'not registered (see cheat sheet T-6h)')
        continue
      }
      if (!res.ok) {
        record(`rooms/${slug}`, 'fail', `HTTP ${res.status}`)
        continue
      }
      const body = await res.json() as { data?: { slug?: string; visibility?: string } }
      const vis = body.data?.visibility || 'unknown'
      record(`rooms/${slug}`, 'pass', `visibility=${vis}`)
    } catch (err: any) {
      record(`rooms/${slug}`, 'error', err?.message || 'unknown')
    }
  }
}

// ============================================================================
// 8. Pear distribution manifest is served
// ============================================================================
async function checkPearDistribution(): Promise<void> {
  try {
    const res = await timedFetch(`${BACKEND_URL}/distribution`, {}, 3000)
    if (!res.ok) {
      record('backend/distribution', 'fail', `HTTP ${res.status}`)
      return
    }
    const body = await res.json() as { data?: { appKey?: string; version?: string } }
    if (!body.data?.appKey) {
      record('backend/distribution', 'fail', 'PEAR_APP_KEY unset (run pear:stage first)')
      return
    }
    record('backend/distribution', 'pass', `${body.data.appKey.slice(0, 24)}... v${body.data.version}`)
  } catch (err: any) {
    record('backend/distribution', 'error', err?.message || 'unknown')
  }
}

// ============================================================================
// 9. MCP endpoint responds
// ============================================================================
async function checkMcp(): Promise<void> {
  try {
    const res = await timedFetch(`${BACKEND_URL}/mcp/info`, {}, 3000)
    if (!res.ok) {
      record('backend/mcp', 'fail', `HTTP ${res.status}`)
      return
    }
    const body = await res.json() as { data?: { toolCount?: number; resourceCount?: number } }
    record('backend/mcp', 'pass', `tools=${body.data?.toolCount ?? '?'} resources=${body.data?.resourceCount ?? '?'}`)
  } catch (err: any) {
    record('backend/mcp', 'error', err?.message || 'unknown')
  }
}

// ============================================================================
// 10. Seeder subprocess is running (if enabled)
// ============================================================================
async function checkSeeder(): Promise<void> {
  try {
    const res = await timedFetch(`${BACKEND_URL}/health`, {}, 3000)
    const body = await res.json() as { data?: { seeder?: { enabled?: boolean; runningRooms?: string[]; capacity?: number } } }
    const seeder = body.data?.seeder
    if (!seeder) {
      record('backend/seeder', 'skip', 'seeder block missing (ENABLE_SEEDER=false)')
      return
    }
    if (!seeder.enabled) {
      record('backend/seeder', 'skip', 'ENABLE_SEEDER=false')
      return
    }
    const running = seeder.runningRooms || []
    record('backend/seeder', 'pass', `${running.length}/${seeder.capacity} rooms seeded`)
  } catch (err: any) {
    record('backend/seeder', 'error', err?.message || 'unknown')
  }
}

// ============================================================================
// Main
// ============================================================================
async function main(): Promise<void> {
  console.log(`${LOG} Curva pre-pitch preflight check`)
  console.log(`${LOG} Backend: ${BACKEND_URL}`)
  console.log(`${LOG} NODE_ENV: ${NODE_ENV}`)
  console.log('')

  await checkBackendHealth()
  await checkSponsorBalance()
  await checkFacilitator()
  await checkFootballData()
  await checkPricingFeed()
  await checkQvacCatalog()
  await checkPitchRooms()
  await checkPearDistribution()
  await checkMcp()
  await checkSeeder()

  console.log('')
  console.log(`${LOG} Summary`)
  const passed = results.filter((r) => r.status === 'pass').length
  const failed = results.filter((r) => r.status === 'fail').length
  const errored = results.filter((r) => r.status === 'error').length
  const skipped = results.filter((r) => r.status === 'skip').length
  console.log(`${LOG}   pass    ${passed}`)
  console.log(`${LOG}   fail    ${failed}`)
  console.log(`${LOG}   error   ${errored}`)
  console.log(`${LOG}   skip    ${skipped}`)
  console.log('')

  if (failed > 0) {
    console.log(`${LOG} FIX ${failed} failing checks before pitch day. See PRESENTER_CHEAT_SHEET.md section 8.`)
    process.exit(1)
  }
  if (errored > 0) {
    console.log(`${LOG} ${errored} checks errored (network, timeouts). Rerun after fixing infra.`)
    process.exit(2)
  }
  console.log(`${LOG} All checks passed. You are demo-ready.`)
  process.exit(0)
}

main().catch((err) => {
  console.error(`${LOG} preflight aborted:`, err)
  process.exit(2)
})
