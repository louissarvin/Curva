// Bare-semver LHS-tolerance patch.
//
// Root cause (2026-07-01):
//   `@noble/hashes` and `@noble/curves` — transitive deps of `ethers` under
//   `@tetherto/wdk-wallet-evm-erc-4337` — declare
//     "engines": { "node": "^14.21.3 || >=16" }
//   in their package.json. During module resolution, bare-module-resolve
//   calls `satisfies(version, range)` from `bare-semver`. That path funnels
//   through `Version.parse` on BOTH arguments in certain code paths, and
//   `Version.parse` is strict: it rejects any leading operator ('^', '~',
//   '>=', ' ', '||', etc). The result is that requiring the WDK bundle
//   throws:
//     INVALID_VERSION: Unexpected token '^' in '^14.21.3 || >=16'
//                      at position 0, expected /[0-9]/
//   which kills `wallet:init` at the try/catch in workers/main.js,
//   blocking tips + prediction-pool signing entirely.
//
// Why patch here:
//   * Bare-semver is deep in the Bare runtime resolver chain — patching
//     upstream (patch-package on @noble/*, or on bare-module-resolve) is
//     brittle across `bun install` and would need to be re-applied per
//     nested tetherto copy of @noble/hashes.
//   * The resolver's `validateEngines` only fires when the current runtime
//     advertises the matching engine key. Bare's `Bare.versions` has NO
//     `node` key (only `bare`, `uv`, `v8`), so a resolver that respected
//     that guard would never even reach the failing call. The offending
//     path is calling `Version.parse` on a RANGE string regardless — that
//     is the actual bug we need to neutralize.
//   * The fix must not weaken `Version.parse` for real single-version
//     inputs used elsewhere (comparators, prerelease ordering, etc). So we
//     wrap it: if the input parses cleanly with the original parser we
//     return that result unchanged; only if the original throws do we try
//     to extract the range's lower bound as a fallback Version. That keeps
//     the strict behavior for every existing correct caller and only
//     rescues the specific "range slipped into a version slot" bug.
//
// Strategy B (monkey-patch at boot) chosen over C (patch-package on
// node_modules) because Curva has multiple nested copies of @noble/*
// through tetherto sub-deps, and patch-package would need to track each
// one across `bun install` cycles.
//
// Safety notes:
//   * Idempotent: applying twice is a no-op (guarded by a Symbol tag on
//     the module exports).
//   * Scoped: touches only `require('bare-semver').Version.parse`. Does
//     not shadow `satisfies`, `Range.parse`, or any comparator ordering.
//   * The fallback lower-bound Version is used only for validateEngines
//     equality/inequality tests; it never leaks back into ordering data
//     because Version.parse callers that hand it a real range are the
//     bug, not consumers of the returned object.
//
// Reference:
//   node_modules/bare-semver/lib/version.js:53 (Version.parse throws)
//   node_modules/bare-module-resolve/index.js:459-473 (validateEngines)

const APPLIED = Symbol.for('curva.bare-semver.range-tolerant-patch')

function applyPatch() {
  let semver
  try {
    semver = require('bare-semver')
  } catch (err) {
    console.log('[semverPatch] bare-semver require failed:', err && err.message)
    return { applied: false, reason: 'bare-semver-not-present' }
  }
  console.log('[semverPatch] bare-semver loaded, has APPLIED tag:', !!semver[APPLIED])
  if (semver[APPLIED]) {
    return { applied: false, reason: 'already-patched' }
  }
  const Version = semver.Version
  if (!Version || typeof Version.parse !== 'function') {
    console.log('[semverPatch] Unexpected semver shape:', typeof Version, Version && typeof Version.parse)
    return { applied: false, reason: 'unexpected-shape' }
  }
  console.log('[semverPatch] applying patch to Version.parse')

  const origParse = Version.parse

  // Extract a bare version substring from a range-like input. Handles the
  // subset actually seen in the wild:
  //   '^14.21.3 || >=16'  -> '14.21.3'
  //   '>=14.0.0'          -> '14.0.0'
  //   '~1.2.3'            -> '1.2.3'
  //   '14.21.3 || 16.0.0' -> '14.21.3'
  // We take the first token that begins with a digit and strip any leading
  // operator characters. If we can't find one, we return null so the
  // fallback re-throws the original error (preserving observability of
  // truly malformed strings).
  function extractFirstVersion(input) {
    if (typeof input !== 'string') return null
    // Split on '||' or spaces, take pieces, strip leading '^~<>=v' and
    // whitespace, and return the first that starts with a digit.
    const parts = input.split(/\|\||\s+/)
    for (const raw of parts) {
      const cleaned = raw.replace(/^[\^~<>=vV\s]+/, '')
      if (cleaned && cleaned[0] >= '0' && cleaned[0] <= '9') {
        // Truncate at anything that isn't a semver-legal char to avoid
        // dragging in trailing garbage.
        const m = cleaned.match(/^[0-9A-Za-z.\-+]+/)
        if (m) return m[0]
      }
    }
    return null
  }

  function patchedParse(input, state) {
    try {
      return origParse.call(this, input, state)
    } catch (err) {
      if (err && err.code === 'INVALID_VERSION') {
        const rescue = extractFirstVersion(input)
        if (rescue && rescue !== input) {
          try {
            // Parse the rescued single version with a fresh state so we
            // don't corrupt the caller's parser position.
            return origParse.call(this, rescue)
          } catch {
            // fall through and rethrow the original
          }
        }
      }
      throw err
    }
  }

  Version.parse = patchedParse
  Object.defineProperty(semver, APPLIED, { value: true, enumerable: false })
  return { applied: true }
}

module.exports = { applyPatch }
