#!/usr/bin/env node
// Postinstall fix for @noble/hashes and @noble/curves engines fields.
//
// Root cause (see bare/wallet/semverPatch.js for the full writeup):
//   Those packages ship `"engines": { "node": "^14.21.3 || >=16" }`. The
//   bare-semver Range parser used inside bare-module-resolve.validateEngines
//   accepts ranges, but the specific code path that fires during PearRuntime
//   worker module resolution funnels the range string through Version.parse
//   (which rejects any leading operator or '||') and surfaces as
//   INVALID_VERSION at boot, killing wallet:init.
//
// The runtime monkey-patch at bare/wallet/semverPatch.js catches this for the
// Node worker path, but the resolver used by Bare workers spawned via
// pear-runtime uses its own bare-semver instance which the monkey-patch does
// not reach. Strategy C is to normalize the engines field at the source.
//
// Fix v3 (2026-07-05): deleting engines.node entirely rather than setting a
// value. Reason: bare-semver's Range parser rejects both operator-prefixed
// ranges (`^14.21.3`) AND wildcard `*` because its Version.parse fallback
// only accepts numeric leads. Deleting the field means bare-module-resolve's
// validateEngines loop skips this package entirely, which is the cleanest
// unblock. @noble/hashes and @noble/curves work identically on Bare and
// modern Node so the missing engines.node is functionally correct anyway.
//
// This script is idempotent. It rewrites only the `engines.node` value; every
// other field is preserved. Run automatically via the `postinstall` hook.

const fs = require('fs')
const path = require('path')

const TARGETS = [
  'node_modules/@noble/hashes/package.json',
  'node_modules/@noble/curves/package.json',
  'node_modules/@noble/secp256k1/package.json',
  'node_modules/ethers/node_modules/@noble/hashes/package.json',
  'node_modules/ethers/node_modules/@noble/curves/package.json',
  'node_modules/@tetherto/wdk-wallet-evm-erc-4337/node_modules/@noble/hashes/package.json',
  'node_modules/@tetherto/wdk-wallet-evm-erc-4337/node_modules/@noble/curves/package.json',
  // Semifinal (2026-07-12): wdk-wallet-evm (NOT wdk-wallet-evm-erc-4337)
  // has its own nested @noble/hashes + @noble/curves copies that were
  // missing from this list. Peer boot showed:
  //   [Curva] ERROR WDK dependencies unavailable: INVALID_VERSION:
  //   Unexpected token '^' in '^14.21.3 || >=16'
  // Diagnostic panel showed `WDK wallet: error`. Verified via
  //   grep -rE "14.21.3.*>=16" pear-app/node_modules/
  // that these three paths still had the compound range.
  'node_modules/@tetherto/wdk-wallet-evm/node_modules/@noble/hashes/package.json',
  'node_modules/@tetherto/wdk-wallet-evm/node_modules/@noble/curves/package.json',
  'node_modules/@tetherto/wdk-wallet-evm/node_modules/ethers/node_modules/@noble/hashes/package.json',
  'node_modules/@tetherto/wdk-wallet-evm/node_modules/ethers/node_modules/@noble/curves/package.json',
  // abstractionkit (@tetherto/wdk-wallet-evm-erc-4337 transitive dep) also
  // nests its own @noble/curves.
  'node_modules/abstractionkit/node_modules/@noble/hashes/package.json',
  'node_modules/abstractionkit/node_modules/@noble/curves/package.json',
  // Semifinal follow-up (2026-07-12): bip39 has its own @noble/hashes copy,
  // and @tetherto/wdk-wallet-evm-erc-4337 has a nested ethers with its own
  // @noble/hashes. Both were still tripping WDK boot with INVALID_VERSION
  // after the first postinstall pass.
  'node_modules/bip39/node_modules/@noble/hashes/package.json',
  'node_modules/@tetherto/wdk-wallet-evm-erc-4337/node_modules/ethers/node_modules/@noble/hashes/package.json'
]

const REPLACEMENT = null // null = delete the engines.node field
const projectRoot = path.resolve(__dirname, '..')

let patched = 0
let skipped = 0

for (const rel of TARGETS) {
  const p = path.join(projectRoot, rel)
  if (!fs.existsSync(p)) { skipped++; continue }
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) {
    console.warn('[noble-engines-fix] parse failed:', rel, err.message)
    continue
  }
  if (!pkg.engines || typeof pkg.engines.node !== 'string') { skipped++; continue }
  // Delete engines.node so bare-module-resolve.validateEngines skips this
  // package's engines check entirely. Preserve other engines keys if any.
  delete pkg.engines.node
  if (Object.keys(pkg.engines).length === 0) delete pkg.engines
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n')
  patched++
}

console.log(`[noble-engines-fix] patched=${patched} skipped=${skipped}`)
