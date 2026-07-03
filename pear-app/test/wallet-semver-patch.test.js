// Regression test for the bare-semver LHS-tolerance patch.
//
// Context: @noble/hashes / @noble/curves (transitive via ethers under
// @tetherto/wdk-wallet-evm-erc-4337) declare `engines.node: "^14.21.3 || >=16"`.
// Under Bare, bare-module-resolve's validateEngines funnels that string through
// bare-semver's strict Version.parse, which crashes with INVALID_VERSION and
// bubbles up as WALLET_DEPS_MISSING at workers/main.js. The patch wraps
// Version.parse so a range LHS is retried against its lower-bound version
// instead of throwing. See bare/wallet/semverPatch.js.

const test = require('brittle')
const path = require('path')

function freshSemver() {
  // Force a fresh require so each test starts from an unpatched module.
  const p = require.resolve('bare-semver')
  delete require.cache[p]
  // Also clear the patch module so applyPatch's idempotency guard resets.
  const patchP = require.resolve('../bare/wallet/semverPatch.js')
  delete require.cache[patchP]
  return {
    semver: require('bare-semver'),
    applyPatch: require('../bare/wallet/semverPatch.js').applyPatch
  }
}

test('unpatched Version.parse rejects range strings (baseline)', (t) => {
  const { semver } = freshSemver()
  t.exception(
    () => semver.Version.parse('^14.21.3 || >=16'),
    /INVALID_VERSION|Unexpected token/
  )
})

test('patched Version.parse recovers the lower bound of a caret+or range', (t) => {
  const { semver, applyPatch } = freshSemver()
  const res = applyPatch()
  t.ok(res.applied, 'patch applied')
  const v = semver.Version.parse('^14.21.3 || >=16')
  t.is(v.major, 14)
  t.is(v.minor, 21)
  t.is(v.patch, 3)
})

test('patched Version.parse handles other common range shapes', (t) => {
  const { semver, applyPatch } = freshSemver()
  applyPatch()
  const cases = [
    { input: '>=14.0.0', major: 14, minor: 0, patch: 0 },
    { input: '~1.2.3', major: 1, minor: 2, patch: 3 },
    { input: '>= 16.5.1', major: 16, minor: 5, patch: 1 },
    { input: '14.21.3 || 16.0.0', major: 14, minor: 21, patch: 3 }
  ]
  for (const c of cases) {
    const v = semver.Version.parse(c.input)
    t.is(v.major, c.major, c.input + ' major')
    t.is(v.minor, c.minor, c.input + ' minor')
    t.is(v.patch, c.patch, c.input + ' patch')
  }
})

test('patched Version.parse preserves strict parsing for real versions', (t) => {
  const { semver, applyPatch } = freshSemver()
  applyPatch()
  const v = semver.Version.parse('1.2.3')
  t.is(v.major, 1)
  t.is(v.minor, 2)
  t.is(v.patch, 3)
})

test('patched Version.parse still throws on truly malformed input', (t) => {
  const { semver, applyPatch } = freshSemver()
  applyPatch()
  t.exception(
    () => semver.Version.parse('not-a-version-at-all'),
    /INVALID_VERSION/
  )
})

test('satisfies() through the patched module works for the failing case', (t) => {
  const { semver, applyPatch } = freshSemver()
  applyPatch()
  // Real single version LHS + range RHS: this always worked and must still work.
  t.is(semver.satisfies('20.10.0', '^14.21.3 || >=16'), true)
  t.is(semver.satisfies('12.0.0', '^14.21.3 || >=16'), false)
  // Range LHS (the pathological case that bare-module-resolve was hitting) now
  // parses instead of crashing. The comparison result is not semantically
  // meaningful for a range LHS — we only care that it does not throw.
  t.execution(() => semver.satisfies('^14.21.3 || >=16', '>=1'))
})

test('applyPatch is idempotent', (t) => {
  const { applyPatch } = freshSemver()
  const first = applyPatch()
  t.is(first.applied, true)
  const second = applyPatch()
  t.is(second.applied, false)
  t.is(second.reason, 'already-patched')
})
