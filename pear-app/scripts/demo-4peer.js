#!/usr/bin/env node
// Wave 7 Zone C: convenience launcher for the 4-peer split-screen demo.
//
// Usage:
//   npm run demo:4peer          # default; leaves .demo-store/ intact
//   npm run demo:4peer -- --clean  # wipe .demo-store/{a,b,c,d} first
//
// Internally spawns `electron-forge start` with `--no-updates --demo=4`.
// This keeps the demo path aligned with how contributors run the app
// day-to-day (no separate binary, no hidden env, no `pear` global).

const { spawn } = require('node:child_process')
const path = require('node:path')

const args = process.argv.slice(2)
const clean = args.includes('--clean')

// Peer count. Read from --peers=N CLI arg or CURVA_DEMO env var (default 4).
// Supported: 2 (side-by-side full-height) or 4 (2x2 grid).
let peerCount = 4
const peerArg = args.find((a) => a.startsWith('--peers='))
if (peerArg) peerCount = Number(peerArg.split('=')[1]) || 4
else if (process.env.CURVA_DEMO) peerCount = Number(process.env.CURVA_DEMO) || 4
if (peerCount !== 2 && peerCount !== 4) peerCount = 4

const forgeArgs = [
  'electron-forge',
  'start',
  '--',
  '--no-updates',
  '--demo=' + peerCount
]
if (clean) forgeArgs.push('--clean')

// Demo-time feature flags. Everything Curva ships is gated behind a per-feature
// env flag so production installs stay opt-in. The 4-peer demo path forces them
// all on so the judges see every pillar detonate without touching env files.
// Callers can still override by exporting the flag before running the script.
const demoFlags = {
  CURVA_QVAC_COMMENTATOR_ENABLED: 'true',
  CURVA_QVAC_STT_ENABLED: 'true',
  CURVA_QVAC_TTS_ENABLED: 'true',
  CURVA_PREDICTIONS_ENABLED: 'true',
  CURVA_ATTENDANCE_ENABLED: 'true',
  CURVA_BLIND_PEERING_ENABLED: 'true',
  CURVA_DELEGATED_INFERENCE_ENABLED: 'true',
  // Master demo mode. When true, attendance auto-issue and prediction
  // auto-open fire at their playhead-hook thresholds (0ms and 2000ms).
  CURVA_DEMO_MODE: 'true',
  CURVA_ATTENDANCE_AUTOISSUE: 'true',
  CURVA_PREDICTIONS_AUTOOPEN: 'true',
  // Tier 3 and 4 features that default to opt-in in production.
  CURVA_LIVE_MINUTE_OVERLAY_ENABLED: 'true',
  CURVA_ASSETS_BRANDING_ENABLED: 'true',
  CURVA_TACTICAL_ENABLED: 'true',
  // Demo timeline button (top-left) that runs the scripted 3-minute pitch.
  CURVA_DEMO_AUTOMATION_ENABLED: 'true',
  // Skip the per-window "Unlock your Curva wallet" passcode prompt. The 4-peer
  // demo path bakes a well-known dev passcode so all four wallets unlock
  // automatically on boot. Do NOT copy this pattern to production. workers/
  // main.js reads process.env.DEV_WALLET_PASSCODE as the fallback when the
  // renderer submits an empty passcode.
  DEV_WALLET_PASSCODE: 'curva-dev-pw',
  // Blind-peering server public key (z-base-32). This is a live blind-peer-cli
  // instance running locally that persistently seeds room state so a peer can
  // rejoin and receive the full playhead + chat history even if the host
  // disconnected. When absent, bare/blindPeering.js:127 no-ops. To rotate:
  // 1) `blind-peer --storage ./.blind-peer-storage --max-storage 4096`
  // 2) copy the "Listening at <key>" line
  // 3) paste here + restart the demo
  CURVA_BLIND_PEER_KEY: 'nm5j8618j8jhbc5rrjtemkixqjes4ngzc36nc9pf1jop8u4kt1fy',
  // Feature 3 (HUD overlay): show the live primitives status panel.
  CURVA_DEMO_HUD_ENABLED: 'true'
}
const demoEnv = { ...process.env }
for (const [k, v] of Object.entries(demoFlags)) {
  if (!demoEnv[k]) demoEnv[k] = v
}

const child = spawn('npx', forgeArgs, {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
  env: demoEnv
})

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('[demo:4peer] failed to spawn electron-forge:', err.message)
  process.exit(1)
})
