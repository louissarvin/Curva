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

const forgeArgs = [
  'electron-forge',
  'start',
  '--',
  '--no-updates',
  '--demo=4'
]
if (clean) forgeArgs.push('--clean')

// Demo-time feature flags. Everything Curva ships is gated behind a per-feature
// env flag so production installs stay opt-in. The 4-peer demo path forces them
// all on so the judges see every pillar detonate without touching env files.
// Callers can still override by exporting the flag before running the script.
const demoFlags = {
  CURVA_QVAC_COMMENTATOR_ENABLED: 'true',
  CURVA_QVAC_STT_ENABLED: 'true',
  CURVA_PREDICTIONS_ENABLED: 'true',
  CURVA_ATTENDANCE_ENABLED: 'true',
  CURVA_BLIND_PEERING_ENABLED: 'true',
  CURVA_DELEGATED_INFERENCE_ENABLED: 'true'
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
