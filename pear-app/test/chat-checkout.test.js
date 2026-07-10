// F1 Wave 3: brittle tests for the Autobase view.checkout(version) chat
// scrubber. Ensures that:
//   1. `getVersions({limit})` returns a bounded set of markers observed on the
//      live view as messages land.
//   2. `history({at})` reads from a hyperbee checkout at the pinned version
//      and does NOT include messages written AFTER that version.
//   3. `checkoutAt(v)` returns a read-only handle whose write surface throws
//      `CheckoutReadOnly`.
//   4. `onVersionMarker` fires on the marker cadence and delivers the same
//      marker shape returned by `getVersions`.
//
// Docs consulted (2026-07-10):
//   * https://docs.pears.com/reference/building-blocks/hyperbee/#beecheckoutversion
//   * pear-app/node_modules/hyperbee/index.js:762 checkout()
//   * pear-app/node_modules/autobase/index.js:187 base.view

const test = require('brittle')
const { makeStore } = require('./_helpers.js')
const { createChat, CheckoutReadOnly, _internal } = require('../bare/chat.js')

// Wait for the async 'update' emitter path to publish N messages into the
// hyperbee view. `history` reads the view; when it returns >= expected we
// know apply() + emitNew() have run.
async function waitForHistory(chat, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await chat.history({ from: 0, limit: 1000 })
    if (rows.length >= expected) return rows
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('waitForHistory: expected ' + expected + ' messages')
}

test('F1: checkoutAt returns a read-only handle; writes throw CheckoutReadOnly', async (t) => {
  const { store, cleanup } = await makeStore()
  const chat = await createChat(store, { myPubkey: 'aa'.repeat(32) })

  await chat.send({ text: 'kickoff', match_time_ms: 0 })
  await waitForHistory(chat, 1)

  // Force at least one marker to exist before we checkout.
  const versions = chat.getVersions({ limit: 8 })
  t.ok(versions.length >= 1, 'at least one version marker seeded')

  const v = versions[versions.length - 1].version
  const co = chat.checkoutAt(v)
  t.is(co.version, v, 'checkout version echoes input')
  t.is(typeof co.history, 'function')

  await t.exception(() => co.send({ text: 'nope', match_time_ms: 0 }), 'send throws')
  await t.exception(() => co.sendSystem({ type: 'system:tip', amount: '1', tx_hash: '0x' + '1'.repeat(64), match_time_ms: 0, wall_clock_ms: Date.now() }), 'sendSystem throws')
  await t.exception(() => co.appendGoal({ minute: 0, matchId: 'm', team: 'home', score: { home: 1, away: 0 } }), 'appendGoal throws')

  // The generic Error instance-check via .code works even if the caller uses
  // a shim (defense-in-depth for the renderer).
  try {
    co.send({ text: 'x' })
  } catch (err) {
    t.is(err.name, 'CheckoutReadOnly')
    t.is(err.code, 'CHECKOUT_READONLY')
    t.ok(err instanceof CheckoutReadOnly)
  }

  await co.close()
  await chat.close()
  await cleanup()
})

test('F1: checkoutAt reads a snapshot that ignores later writes', async (t) => {
  const { store, cleanup } = await makeStore()
  const chat = await createChat(store, { myPubkey: 'bb'.repeat(32) })

  // Push enough messages to force at least two marker boundaries. Because the
  // marker interval is 10, we send 12 so a mid-scrub target actually exists.
  const N = 12
  for (let i = 0; i < N; i++) {
    await chat.send({ text: 'msg-' + i, match_time_ms: i * 1000 })
  }
  const live = await waitForHistory(chat, N)
  t.is(live.length, N, 'live view has all N messages')

  const versions = chat.getVersions({ limit: 32 })
  t.ok(versions.length >= 2, 'multiple markers recorded')

  // Pin to the earliest marker (after the FIRST message applied). All later
  // writes should be invisible when we scrub back to that version.
  const earliest = versions[0]
  const co = chat.checkoutAt(earliest.version)
  const snapshotRows = await co.history({ from: 0, limit: 100 })
  t.ok(snapshotRows.length >= 1, 'snapshot has at least the first message')
  t.ok(snapshotRows.length < N, 'snapshot has FEWER rows than the live view')
  t.is(snapshotRows[0].text, 'msg-0', 'snapshot begins with kickoff message')

  // Live view still sees all N even though checkout is pinned.
  const liveAfter = await chat.history({ from: 0, limit: 100 })
  t.is(liveAfter.length, N, 'live view untouched by checkout')

  await co.close()
  await chat.close()
  await cleanup()
})

test('F1: history({at}) reads from checkout without needing checkoutAt', async (t) => {
  const { store, cleanup } = await makeStore()
  const chat = await createChat(store, { myPubkey: 'cc'.repeat(32) })

  for (let i = 0; i < 5; i++) {
    await chat.send({ text: 'row-' + i, match_time_ms: i * 500 })
  }
  await waitForHistory(chat, 5)

  const versions = chat.getVersions({ limit: 16 })
  const earliest = versions[0]
  const rowsAt = await chat.history({ from: 0, limit: 100, at: earliest.version })
  t.ok(rowsAt.length >= 1, 'history({at}) returns non-empty snapshot')
  t.ok(rowsAt.every((m) => typeof m.text === 'string' && m.text.startsWith('row-')))

  await chat.close()
  await cleanup()
})

test('F1: onVersionMarker fires on marker cadence', async (t) => {
  const { store, cleanup } = await makeStore()
  const chat = await createChat(store, { myPubkey: 'dd'.repeat(32) })

  const observed = []
  const off = chat.onVersionMarker((m) => observed.push(m))

  await chat.send({ text: 'kickoff', match_time_ms: 100 })
  await waitForHistory(chat, 1)

  t.ok(observed.length >= 1, 'first message triggers a marker')
  t.is(typeof observed[0].version, 'number')
  t.is(observed[0].matchTimeMs, 100)

  off()

  await chat.close()
  await cleanup()
})

test('F1: getVersions returns bounded markers ordered by version', async (t) => {
  const { store, cleanup } = await makeStore()
  const chat = await createChat(store, { myPubkey: 'ee'.repeat(32) })

  for (let i = 0; i < 25; i++) {
    await chat.send({ text: 'm-' + i, match_time_ms: i * 1000 })
  }
  await waitForHistory(chat, 25)

  const all = chat.getVersions({ limit: 100 })
  t.ok(all.length >= 2, 'multiple markers recorded')
  for (let i = 1; i < all.length; i++) {
    t.ok(all[i].version >= all[i - 1].version, 'markers monotonic')
  }
  // The tail marker should be at or near the current view version.
  const base = chat.getBase()
  t.ok(all[all.length - 1].version <= base.view.version, 'tail marker within view')

  // Limit is respected.
  const three = chat.getVersions({ limit: 3 })
  t.ok(three.length <= 3, 'limit truncates the head, keeps the tail')
  t.is(three[three.length - 1].version, all[all.length - 1].version)

  await chat.close()
  await cleanup()
})

test('F1: exports constants + CheckoutReadOnly class', (t) => {
  t.is(typeof _internal.APPLY_MARKER_INTERVAL, 'number')
  t.is(typeof _internal.VERSION_MARKER_CAP, 'number')
  t.ok(_internal.VERSION_MARKER_CAP > 0)
  t.is(typeof CheckoutReadOnly, 'function')
})
