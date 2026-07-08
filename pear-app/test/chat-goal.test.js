// F3 Hyperbee goal shard: `match/goals/<paddedMinute>/<goalId>` tests.
//
// Covers:
//   - paddedMinute format ("005", "127", boundary clamping)
//   - appendGoal writes to the correct root-bee key layout
//   - listGoals returns entries in minute order (lex order == numeric order
//     thanks to zero-padded width)
//   - non-host writer cannot append system:goal (apply reducer drops it)
//   - base.on('update') pipeline emits new goals as `message` events with
//     type === 'system:goal', so the existing renderer subscription picks
//     them up unchanged
//   - stableGoalId is deterministic across identical inputs (idempotent
//     under autobase rebase)
//
// Test setup mirrors the existing chat.test.js pattern (makeStore + waitFor).

const test = require('brittle')
const { makeStore } = require('./_helpers.js')
const { createChat, _internal } = require('../bare/chat.js')

test('paddedMinute: 3-digit zero-pad across 0..130', (t) => {
  t.is(_internal.paddedMinute(0), '000')
  t.is(_internal.paddedMinute(5), '005')
  t.is(_internal.paddedMinute(34), '034')
  t.is(_internal.paddedMinute(90), '090')
  t.is(_internal.paddedMinute(127), '127')
  t.is(_internal.paddedMinute(130), '130')
})

test('paddedMinute: clamps out-of-range values', (t) => {
  t.is(_internal.paddedMinute(-1), '000', 'negative clamps to 000')
  t.is(_internal.paddedMinute(999), '130', 'over-max clamps to MAX_GOAL_MINUTE')
  t.is(_internal.paddedMinute(NaN), '000', 'NaN clamps to 000')
  t.is(_internal.paddedMinute(undefined), '000', 'undefined clamps to 000')
})

test('paddedMinute: lex order matches numeric order across full range', (t) => {
  const samples = [0, 5, 9, 10, 45, 90, 91, 99, 100, 120, 130]
  const keys = samples.map((m) => _internal.paddedMinute(m))
  const sorted = [...keys].sort()
  t.alike(keys, sorted, 'zero-padded 3-digit keys sort by numeric minute')
})

test('goalKey format: match/goals/<paddedMinute>/<goalId>', (t) => {
  const k = _internal.goalKey({ minute: 34, goalId: 'sf2-034-messi01' })
  t.is(k, 'match/goals/034/sf2-034-messi01')
  const k2 = _internal.goalKey({ minute: 5, goalId: 'x' })
  t.is(k2, 'match/goals/005/x')
})

test('goalKey sanitizes goalId charset', (t) => {
  const k = _internal.goalKey({ minute: 45, goalId: 'evil/../key with spaces!' })
  // slashes, dots, spaces, and `!` stripped; alnum + `-` + `_` preserved.
  t.is(k, 'match/goals/045/evilkeywithspaces')
})

test('stableGoalId is deterministic for the same tuple', (t) => {
  const a = _internal.stableGoalId({ matchId: 'sf2', minute: 34, scorer: 'Messi', team: 'home' })
  const b = _internal.stableGoalId({ matchId: 'sf2', minute: 34, scorer: 'Messi', team: 'home' })
  t.is(a, b, 'identical inputs -> identical id')
  const c = _internal.stableGoalId({ matchId: 'sf2', minute: 34, scorer: 'Ronaldo', team: 'home' })
  t.not(a, c, 'different scorer -> different id')
  const d = _internal.stableGoalId({ matchId: 'sf2', minute: 35, scorer: 'Messi', team: 'home' })
  t.not(a, d, 'different minute -> different id')
})

test('isValidSystemGoal: accepts a well-formed goal', (t) => {
  const ok = {
    type: 'system:goal',
    by_peer: 'host',
    match_time_ms: 34 * 60_000,
    wall_clock_ms: Date.now(),
    matchId: 'wc-sf2',
    goalId: 'wc-sf2-034-messi',
    minute: 34,
    team: 'home',
    homeScore: 1,
    awayScore: 0,
    scorer: 'Messi'
  }
  t.ok(_internal.isValidSystemGoal(ok), 'valid shape accepted')
  t.ok(_internal.isValidMessage(ok), 'dispatch routes to isValidSystemGoal')
})

test('isValidSystemGoal: rejects malformed shapes', (t) => {
  const base = {
    type: 'system:goal',
    by_peer: 'host',
    match_time_ms: 0,
    wall_clock_ms: 1,
    matchId: 'x',
    goalId: 'g',
    minute: 0,
    team: 'home',
    homeScore: 0,
    awayScore: 0,
    scorer: null
  }
  t.absent(_internal.isValidSystemGoal({ ...base, team: 'draw' }), 'bad team')
  t.absent(_internal.isValidSystemGoal({ ...base, minute: 131 }), 'over-max minute')
  t.absent(_internal.isValidSystemGoal({ ...base, minute: -1 }), 'negative minute')
  t.absent(_internal.isValidSystemGoal({ ...base, minute: 3.5 }), 'fractional minute')
  t.absent(_internal.isValidSystemGoal({ ...base, homeScore: 40 }), 'score over cap')
  t.absent(_internal.isValidSystemGoal({ ...base, matchId: '' }), 'empty matchId')
  t.absent(_internal.isValidSystemGoal({ ...base, goalId: '' }), 'empty goalId')
  t.absent(_internal.isValidSystemGoal({ ...base, scorer: 42 }), 'non-string scorer')
})

test('appendGoal writes to match/goals/<paddedMinute>/<goalId>', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'host' })
  // Bind the local writer key as the host so the reducer treats appendGoal as
  // authorized. The existing setHostWriter + getWriterKey pattern comes from
  // Wave 7 T1 (see bare/chat.js).
  const writerKey = c.getWriterKey()
  t.ok(writerKey, 'chat exposes local writer key')
  c.setHostWriter(writerKey)

  const g = await c.appendGoal({
    matchId: 'wc-sf2',
    goalId: 'wc-sf2-034-messi',
    minute: 34,
    team: 'home',
    scorer: 'Messi',
    score: { home: 1, away: 0 }
  })
  t.is(g.type, 'system:goal')
  t.is(g.minute, 34)
  t.is(g.homeScore, 1)
  t.is(g.awayScore, 0)

  // Poll listGoals until the reducer has flushed the put.
  const goals = await waitFor(
    () => c.listGoals({ fromMinute: 0, toMinute: 130 }),
    (arr) => Array.isArray(arr) && arr.length >= 1
  )
  t.is(goals.length, 1, 'one goal stored')
  t.is(goals[0].scorer, 'Messi')
  t.is(goals[0].team, 'home')

  await c.close()
  await cleanup()
})

test('listGoals returns entries in minute order', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'host' })
  c.setHostWriter(c.getWriterKey())

  // Append out-of-order to prove sorting is driven by the key layout, not
  // insertion order.
  await c.appendGoal({
    matchId: 'wc-sf2', goalId: 'g-90', minute: 90, team: 'away', scorer: 'Late',
    score: { home: 1, away: 1 }
  })
  await c.appendGoal({
    matchId: 'wc-sf2', goalId: 'g-5', minute: 5, team: 'home', scorer: 'Early',
    score: { home: 1, away: 0 }
  })
  await c.appendGoal({
    matchId: 'wc-sf2', goalId: 'g-45', minute: 45, team: 'home', scorer: 'Mid',
    score: { home: 2, away: 0 }
  })

  const goals = await waitFor(
    () => c.listGoals({ fromMinute: 0, toMinute: 130 }),
    (arr) => Array.isArray(arr) && arr.length >= 3
  )
  t.is(goals.length, 3)
  t.is(goals[0].minute, 5, 'minute 5 first')
  t.is(goals[1].minute, 45, 'minute 45 second')
  t.is(goals[2].minute, 90, 'minute 90 last')

  await c.close()
  await cleanup()
})

test('listGoals respects fromMinute / toMinute bounds', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'host' })
  c.setHostWriter(c.getWriterKey())

  await c.appendGoal({
    matchId: 'm', goalId: 'g-5', minute: 5, team: 'home', scorer: 'A',
    score: { home: 1, away: 0 }
  })
  await c.appendGoal({
    matchId: 'm', goalId: 'g-45', minute: 45, team: 'away', scorer: 'B',
    score: { home: 1, away: 1 }
  })
  await c.appendGoal({
    matchId: 'm', goalId: 'g-90', minute: 90, team: 'home', scorer: 'C',
    score: { home: 2, away: 1 }
  })

  // Wait for all three to land.
  await waitFor(
    () => c.listGoals({ fromMinute: 0, toMinute: 130 }),
    (arr) => arr.length >= 3
  )

  const secondHalf = await c.listGoals({ fromMinute: 46, toMinute: 130 })
  t.is(secondHalf.length, 1, 'only 90-minute goal in [46..130]')
  t.is(secondHalf[0].minute, 90)

  const firstHalf = await c.listGoals({ fromMinute: 0, toMinute: 45 })
  t.is(firstHalf.length, 2, 'minutes 5 and 45 in [0..45]')
  t.is(firstHalf[0].minute, 5)
  t.is(firstHalf[1].minute, 45)

  await c.close()
  await cleanup()
})

test('base.on("update") pipeline emits new goals as message events', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'host' })
  c.setHostWriter(c.getWriterKey())

  const seen = []
  c.onMessage((msg) => {
    if (msg?.type === 'system:goal') seen.push(msg)
  })

  await c.appendGoal({
    matchId: 'wc-sf2', goalId: 'g-34', minute: 34, team: 'home', scorer: 'Messi',
    score: { home: 1, away: 0 }
  })

  await waitFor(() => seen.length, (n) => n >= 1)

  t.is(seen.length, 1, 'one goal event emitted')
  t.is(seen[0].type, 'system:goal', 'type preserved on emit path')
  t.is(seen[0].minute, 34)
  t.is(seen[0].scorer, 'Messi')

  await c.close()
  await cleanup()
})

test('non-host writer cannot append system:goal (reducer drops it)', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'peer' })
  // Bind a DIFFERENT writer as the host, so this chat instance's local writer
  // is treated as non-host by the apply reducer. sendSystem then goes through
  // as-if from a non-host, and the reducer must silently drop the block.
  c.setHostWriter('deadbeef'.repeat(8)) // 64 hex chars, not our writer key

  // sendSystem builds a well-formed system:goal payload; the reducer's
  // host-only gate is what rejects it. We deliberately go through sendSystem
  // (not appendGoal) so we drive the raw base.append path.
  await c.sendSystem({
    type: 'system:goal',
    matchId: 'wc-sf2',
    goalId: 'forged-g-34',
    minute: 34,
    team: 'home',
    homeScore: 5,
    awayScore: 0,
    scorer: 'Forger'
  })

  // Give the reducer a moment; then confirm listGoals returns empty.
  await waitMs(300)
  const goals = await c.listGoals({ fromMinute: 0, toMinute: 130 })
  t.is(goals.length, 0, 'forged goal was dropped by the host-only gate')

  await c.close()
  await cleanup()
})

test('appendGoal input validation: rejects malformed args synchronously', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'host' })
  c.setHostWriter(c.getWriterKey())

  await t.exception.all(
    () => c.appendGoal({ matchId: '', minute: 10, team: 'home', score: { home: 1, away: 0 } }),
    'empty matchId rejected'
  )
  await t.exception.all(
    () => c.appendGoal({ matchId: 'm', minute: 999, team: 'home', score: { home: 1, away: 0 } }),
    'over-range minute rejected'
  )
  await t.exception.all(
    () => c.appendGoal({ matchId: 'm', minute: 10, team: 'nope', score: { home: 1, away: 0 } }),
    'bad team rejected'
  )
  await t.exception.all(
    () => c.appendGoal({ matchId: 'm', minute: 10, team: 'home', score: null }),
    'missing score rejected'
  )

  await c.close()
  await cleanup()
})

test('appendGoal derives stableGoalId when caller omits it', async (t) => {
  const { store, cleanup } = await makeStore()
  const c = await createChat(store, { myPubkey: 'host' })
  c.setHostWriter(c.getWriterKey())

  const g = await c.appendGoal({
    matchId: 'wc-sf2', minute: 77, team: 'away', scorer: 'Mbappe',
    score: { home: 2, away: 1 }
    // goalId omitted
  })
  t.ok(g.goalId && g.goalId.length > 0, 'derived goalId present')

  const goals = await waitFor(
    () => c.listGoals({ fromMinute: 0, toMinute: 130 }),
    (arr) => arr.length >= 1
  )
  t.is(goals[0].goalId, g.goalId, 'stored goalId matches derived')

  // Idempotency: derived id for the same tuple is stable, so a rebase replay
  // would write the same key. We check the property directly via the helper.
  const again = _internal.stableGoalId({
    matchId: 'wc-sf2', minute: 77, scorer: 'Mbappe', team: 'away'
  })
  t.is(g.goalId, again, 'stableGoalId is deterministic')

  await c.close()
  await cleanup()
})

// -- helpers ---------------------------------------------------------------

async function waitFor(fn, pred, { timeoutMs = 3000, intervalMs = 30 } = {}) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeoutMs) {
    last = await fn()
    if (pred(last)) return last
    await waitMs(intervalMs)
  }
  return last
}

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
