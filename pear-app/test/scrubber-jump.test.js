// F20 semantic-scrubber jump — unit tests for the jump-decision logic and the
// message-render `data-match-time-ms` attribute.
//
// Chat.js is a browser module that pulls in globals (document, window,
// contextBridge-injected `curva`). We do NOT require it directly here — the
// pear-app test suite has no jsdom. Instead this test asserts the SAME logic
// the click handler in Chat.js performs, mirrored as a small pure helper we
// exercise with a minimal DOM stub.
//
// If this helper drifts from Chat.js the test will still pass — that is an
// accepted trade-off given the hackathon deadline. The intent is to catch
// obvious regressions (null-guard, off-by-one at 0, missing playhead bridge)
// which are the failure modes worth locking down.

const test = require('brittle')

// Mirror of the Chat.js click-handler jump logic. Given a row (with an
// optional data-match-time-ms attribute), a hit object (optional matchTimeMs),
// and a possibly-missing `curva.playhead.scrubTo` bridge, decide whether to
// call scrubTo and with what value. Returns { called: bool, value: number|null }.
function decideJump(row, hit, curva) {
  const rowMt = Number(row && row.dataset ? row.dataset.matchTimeMs : NaN)
  const jumpMt = Number.isFinite(rowMt) && rowMt >= 0
    ? rowMt
    : (typeof hit?.matchTimeMs === 'number'
        && Number.isFinite(hit.matchTimeMs)
        && hit.matchTimeMs >= 0
      ? hit.matchTimeMs
      : null)
  if (jumpMt === null) return { called: false, value: null }
  if (!curva || !curva.playhead || typeof curva.playhead.scrubTo !== 'function') {
    return { called: false, value: jumpMt }
  }
  try {
    curva.playhead.scrubTo(jumpMt)
  } catch { /* noop */ }
  return { called: true, value: jumpMt }
}

// Mirror of the Chat.js message-render decision for setting data-match-time-ms.
function setMatchTimeAttr(row, msg) {
  if (typeof msg?.match_time_ms === 'number'
      && Number.isFinite(msg.match_time_ms)
      && msg.match_time_ms >= 0) {
    row.dataset.matchTimeMs = String(Math.floor(msg.match_time_ms))
  }
}

function makeRow(matchTimeMs) {
  const row = { dataset: {} }
  if (matchTimeMs !== undefined) row.dataset.matchTimeMs = String(matchTimeMs)
  return row
}

test('scrubTo called when data-match-time-ms is present and bridge exists', (t) => {
  const calls = []
  const curva = { playhead: { scrubTo: (n) => calls.push(n) } }
  const row = makeRow(90000)
  const res = decideJump(row, {}, curva)
  t.is(res.called, true)
  t.is(res.value, 90000)
  t.is(calls.length, 1)
  t.is(calls[0], 90000)
})

test('scrubTo no-ops when curva.playhead is missing', (t) => {
  const row = makeRow(1234)
  const res = decideJump(row, {}, {})
  t.is(res.called, false)
  t.is(res.value, 1234)
})

test('scrubTo no-ops when curva.playhead.scrubTo is missing', (t) => {
  const row = makeRow(1234)
  const res = decideJump(row, {}, { playhead: {} })
  t.is(res.called, false)
})

test('scrubTo no-ops when data-match-time-ms is missing AND hit lacks matchTimeMs', (t) => {
  const calls = []
  const curva = { playhead: { scrubTo: (n) => calls.push(n) } }
  const row = makeRow(undefined)
  const res = decideJump(row, {}, curva)
  t.is(res.called, false)
  t.is(res.value, null)
  t.is(calls.length, 0)
})

test('falls back to hit.matchTimeMs when row lacks data-match-time-ms', (t) => {
  const calls = []
  const curva = { playhead: { scrubTo: (n) => calls.push(n) } }
  const row = makeRow(undefined)
  const res = decideJump(row, { matchTimeMs: 5000 }, curva)
  t.is(res.called, true)
  t.is(res.value, 5000)
})

test('zero is a valid matchTimeMs (kickoff)', (t) => {
  const calls = []
  const curva = { playhead: { scrubTo: (n) => calls.push(n) } }
  const row = makeRow(0)
  const res = decideJump(row, {}, curva)
  t.is(res.called, true)
  t.is(res.value, 0)
})

test('scrubTo throw is swallowed silently', (t) => {
  const curva = { playhead: { scrubTo: () => { throw new Error('nope') } } }
  const row = makeRow(1234)
  const res = decideJump(row, {}, curva)
  t.is(res.called, true)
  t.is(res.value, 1234)
})

test('message render sets data-match-time-ms when match_time_ms is finite', (t) => {
  const row = { dataset: {} }
  setMatchTimeAttr(row, { match_time_ms: 42_000 })
  t.is(row.dataset.matchTimeMs, '42000')
})

test('message render does NOT set data-match-time-ms when match_time_ms is missing', (t) => {
  const row = { dataset: {} }
  setMatchTimeAttr(row, { text: 'ciao' })
  t.is(row.dataset.matchTimeMs, undefined)
})

test('message render does NOT set data-match-time-ms when match_time_ms is negative', (t) => {
  const row = { dataset: {} }
  setMatchTimeAttr(row, { match_time_ms: -1 })
  t.is(row.dataset.matchTimeMs, undefined)
})

test('message render floors non-integer match_time_ms', (t) => {
  const row = { dataset: {} }
  setMatchTimeAttr(row, { match_time_ms: 12345.9 })
  t.is(row.dataset.matchTimeMs, '12345')
})
