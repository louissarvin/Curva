#!/usr/bin/env node
// Postinstall fix for tinyld (transitive dep of @qvac/sdk via
// @qvac/langdetect-text) whose package.json ships engines with a whitespace
// after the operator: `"node": ">= 12.10.0"`.
//
// bare-semver's Range parser does not accept whitespace between the operator
// and the version. `bare-module-resolve.validateEngines` funnels the range
// through `Range.parse`, which delegates to `Version.parse`, which throws:
//   INVALID_VERSION: Unexpected token ' ' in '>= 12.10.0' at position 2
// The failure kills `import('@qvac/sdk')` inside the Bare worker, so the
// translator's `resolveEngine` silently returns null and the whole
// on-device Bergamot translation feature reports ENGINE_UNAVAILABLE.
//
// The bare/wallet/semverPatch.js monkey-patch runs in the worker context but
// does not reach the sidecar's bundled bare-semver instance, which is what
// bare-module-resolve actually uses during import(). So a runtime patch is
// insufficient — we normalize the engines.node value at rest.
//
// Strategy: match the existing noble-engines-fix.js pattern. Delete
// engines.node entirely. bare-module-resolve's validateEngines skips any
// package.json without engines.node, which is the cleanest unblock. tinyld
// works identically on Bare and modern Node so the missing engines.node is
// functionally correct.
//
// Idempotent. Run automatically via the `postinstall` hook.

const fs = require('fs')
const path = require('path')

const TARGETS = [
  'node_modules/tinyld/package.json',
  'node_modules/@qvac/langdetect-text/node_modules/tinyld/package.json'
]

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
    console.warn('[tinyld-engines-fix] parse failed:', rel, err.message)
    continue
  }
  if (!pkg.engines || typeof pkg.engines.node !== 'string') { skipped++; continue }
  delete pkg.engines.node
  if (Object.keys(pkg.engines).length === 0) delete pkg.engines
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n')
  patched++
}

console.log(`[tinyld-engines-fix] patched=${patched} skipped=${skipped}`)
