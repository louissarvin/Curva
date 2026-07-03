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

const child = spawn('npx', forgeArgs, {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env }
})

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('[demo:4peer] failed to spawn electron-forge:', err.message)
  process.exit(1)
})
