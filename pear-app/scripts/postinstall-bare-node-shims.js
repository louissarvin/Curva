#!/usr/bin/env node
// Postinstall shim: create shadow node_modules/{http,https,zlib,net} that
// re-export the Bare-native equivalents.
//
// Root cause:
//   ethers/lib.commonjs/utils/geturl.js and provider-ipcsocket.js do
//     require('http') / require('https') / require('zlib') / require('net')
//   Bare's resolver treats these as unknown built-ins and throws
//     MODULE_NOT_FOUND: Cannot find module 'http' imported from ethers/...
//   which kills wallet:init at the WDK boot path in workers/main.js.
//
// Why shadow node_modules:
//   * Bare's resolver falls back to node_modules for unknown built-in names.
//     Placing a real package at node_modules/http means every ethers file
//     (current AND future) automatically routes through the bare-native
//     implementation. One-place fix, no per-file patching.
//   * Node.js (Electron main + Node worker) always prefers its own
//     built-in modules over node_modules. Verified against the Node module
//     resolution algorithm: core modules win before node_modules lookup.
//     So this shim is invisible to non-Bare runtimes.
//
// Idempotent: overwrites index.js + package.json each run so bun/npm
// installs don't stale the shim.
//
// Mapping (verified against installed bare-* module names):
//   http  -> bare-http1
//   https -> bare-https
//   zlib  -> bare-zlib
//   net   -> bare-net

const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const nodeModules = path.join(projectRoot, 'node_modules')

const SHIMS = [
  { name: 'http', bare: 'bare-http1' },
  { name: 'https', bare: 'bare-https' },
  { name: 'zlib', bare: 'bare-zlib' },
  { name: 'net', bare: 'bare-net' },
  { name: 'crypto', bare: 'bare-crypto' }
]

let created = 0
let updated = 0
let skipped = 0

for (const { name, bare } of SHIMS) {
  const barePath = path.join(nodeModules, bare)
  if (!fs.existsSync(barePath)) {
    console.warn(`[bare-node-shims] missing ${bare}, skipping ${name}`)
    skipped++
    continue
  }

  const shimDir = path.join(nodeModules, name)
  const pkgPath = path.join(shimDir, 'package.json')
  const indexPath = path.join(shimDir, 'index.js')

  const pkg = {
    name,
    version: '1.0.0',
    private: true,
    description: `Bare-runtime shim that re-exports ${bare} as '${name}'. Created by scripts/postinstall-bare-node-shims.js.`,
    main: 'index.js'
  }

  // Re-export from bare-* module. Node.js built-in will always win over this
  // shim in real Node; Bare falls into node_modules resolution for these
  // names and picks up the shim.
  const index = `'use strict'\nmodule.exports = require('${bare}')\n`

  const existed = fs.existsSync(shimDir)
  if (!existed) fs.mkdirSync(shimDir, { recursive: true })
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  fs.writeFileSync(indexPath, index)
  if (existed) updated++
  else created++
}

console.log(`[bare-node-shims] created=${created} updated=${updated} skipped=${skipped}`)
