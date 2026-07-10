// F8 native notifications brittle tests.
//
// Exercises electron/notifications.js via an injected fake electron module.
// The fake exposes a stub Notification constructor + isSupported() so the
// module runs without a live Electron app.
//
// Docs verified (fetched 2026-07-10):
//   https://www.electronjs.org/docs/latest/api/notification

const test = require('brittle')
const {
  createNotifier,
  sanitizeShortString,
  RATE_LIMIT_WINDOW_MS
} = require('../electron/notifications.js')

function makeFakeElectron ({ supported = true } = {}) {
  const shown = []
  const listeners = new Map() // notification instance -> {click, close}
  class FakeNotification {
    constructor (opts) {
      this._opts = opts
      this._listeners = { click: null, close: null }
      listeners.set(this, this._listeners)
    }
    static isSupported () { return supported }
    on (evt, cb) { this._listeners[evt] = cb }
    show () { shown.push(this) }
    close () { if (this._listeners.close) try { this._listeners.close() } catch { /* noop */ } }
    // Test helper: simulate a click
    _fireClick () { if (this._listeners.click) this._listeners.click() }
  }
  return { Notification: FakeNotification, _peek: { shown, listeners } }
}

// ---- sanitizeShortString ----------------------------------------------------

test('F8: sanitizeShortString collapses control chars + caps length', (t) => {
  t.is(sanitizeShortString('hi\x00there', 100), 'hithere')
  t.is(sanitizeShortString('  a\nb\rc  ', 100), 'a b c')
  t.is(sanitizeShortString('Ａgoal', 100), 'Agoal', 'NFKC applied')
  const long = 'x'.repeat(500)
  t.is(sanitizeShortString(long, 10).length, 10, 'capped at max')
  t.is(sanitizeShortString(null, 100), '', 'null -> empty')
})

// ---- UNSUPPORTED branch -----------------------------------------------------

test('F8: notify returns UNSUPPORTED when Notification.isSupported() is false', (t) => {
  const electron = makeFakeElectron({ supported: false })
  const n = createNotifier({
    electron,
    focusWindow: () => {},
    isWindowFocused: () => false
  })
  const res = n.notify({
    kind: 'goal',
    roomSlug: 'demo',
    title: 'GOAL',
    body: 'Jamal scored'
  })
  t.absent(res.ok, 'not ok')
  t.is(res.code, 'UNSUPPORTED')
  t.is(n.status().supported, false)
  t.is(electron._peek.shown.length, 0, 'no notification shown')
})

// ---- happy path -------------------------------------------------------------

test('F8: notify shows the notification when supported + window unfocused', (t) => {
  const electron = makeFakeElectron({ supported: true })
  const n = createNotifier({
    electron,
    focusWindow: () => {},
    isWindowFocused: () => false
  })
  const res = n.notify({
    kind: 'goal',
    roomSlug: 'demo',
    title: 'GOAL: 1-0',
    body: 'Jamal in the 47th'
  })
  t.ok(res.ok)
  t.ok(res.shown, 'shown=true')
  t.is(electron._peek.shown.length, 1, 'exactly one native notification')
  const inst = electron._peek.shown[0]
  t.is(inst._opts.title, 'GOAL: 1-0')
  t.is(inst._opts.body, 'Jamal in the 47th')
})

// ---- focus suppression ------------------------------------------------------

test('F8: notify SKIPS when window is focused', (t) => {
  const electron = makeFakeElectron({ supported: true })
  const n = createNotifier({
    electron,
    focusWindow: () => {},
    isWindowFocused: () => true // window is focused
  })
  const res = n.notify({ kind: 'goal', title: 'GOAL', roomSlug: 'demo' })
  t.ok(res.ok, 'still ok')
  t.absent(res.shown, 'not shown')
  t.is(res.reason, 'window-focused')
  t.is(electron._peek.shown.length, 0, 'no native notification emitted')
  t.is(n.status().counters.suppressedFocus, 1)
})

// ---- rate limit -------------------------------------------------------------

test('F8: notify is rate-limited on rapid successive calls of the same kind', (t) => {
  const electron = makeFakeElectron({ supported: true })
  let now = 1000
  const n = createNotifier({
    electron,
    focusWindow: () => {},
    isWindowFocused: () => false,
    now: () => now
  })
  const r1 = n.notify({ kind: 'goal', title: 'A', roomSlug: 'demo' })
  t.ok(r1.shown, 'first goal shown')

  // Same kind within the window: rate-limited.
  now += 1000
  const r2 = n.notify({ kind: 'goal', title: 'B', roomSlug: 'demo' })
  t.absent(r2.shown, 'second goal within window suppressed')
  t.is(r2.reason, 'rate-limited')

  // Different kind still lands within the window.
  const r3 = n.notify({ kind: 'tip', title: 'C', roomSlug: 'demo' })
  t.ok(r3.shown, 'different kind not rate-limited by goal timer')

  // After the window elapses, goal is allowed again.
  now += RATE_LIMIT_WINDOW_MS + 1
  const r4 = n.notify({ kind: 'goal', title: 'D', roomSlug: 'demo' })
  t.ok(r4.shown, 'goal shown again after window elapses')

  t.is(electron._peek.shown.length, 3, 'exactly three native notifications')
})

// ---- click routing ----------------------------------------------------------

test('F8: click callback fires focusWindow with the correct roomSlug', (t) => {
  const electron = makeFakeElectron({ supported: true })
  let focused = null
  const n = createNotifier({
    electron,
    focusWindow: (slug) => { focused = slug },
    isWindowFocused: () => false
  })
  const res = n.notify({
    kind: 'mention',
    roomSlug: 'my-room',
    title: 'You were mentioned'
  })
  t.ok(res.shown)
  const inst = electron._peek.shown[0]
  inst._fireClick()
  t.is(focused, 'my-room', 'focusWindow received the roomSlug from the notify args')
})

// ---- kind allowlist ---------------------------------------------------------

test('F8: kinds are honored (goal/tip/mention) + unknown kinds rejected', (t) => {
  const electron = makeFakeElectron({ supported: true })
  const n = createNotifier({ electron, isWindowFocused: () => false, focusWindow: () => {} })
  t.ok(n.notify({ kind: 'goal', title: 'g' }).shown, 'goal accepted')
  // Reset rate window using a slug variance is not needed; different kinds have
  // independent limiters.
  t.ok(n.notify({ kind: 'tip', title: 't' }).shown, 'tip accepted')
  t.ok(n.notify({ kind: 'mention', title: 'm' }).shown, 'mention accepted')
  const bad = n.notify({ kind: 'random-thing', title: 'nope' })
  t.absent(bad.ok, 'unknown kind rejected')
  t.is(bad.code, 'BAD_KIND')
})

test('F8: notify rejects empty title', (t) => {
  const electron = makeFakeElectron({ supported: true })
  const n = createNotifier({ electron, isWindowFocused: () => false, focusWindow: () => {} })
  const r = n.notify({ kind: 'goal', title: '' })
  t.absent(r.ok)
  t.is(r.code, 'BAD_TITLE')
})

// ---- status reporting -------------------------------------------------------

test('F8: status() reports counters + last-by-kind timings', (t) => {
  const electron = makeFakeElectron({ supported: true })
  let now = 100
  const n = createNotifier({
    electron,
    isWindowFocused: () => false,
    focusWindow: () => {},
    now: () => now
  })
  n.notify({ kind: 'goal', title: 'G1' })
  now += RATE_LIMIT_WINDOW_MS + 1
  n.notify({ kind: 'goal', title: 'G2' })
  const s = n.status()
  t.is(s.supported, true)
  t.is(s.counters.shown, 2)
  t.ok(s.lastByKind.goal >= 100)
})

// ---- close ------------------------------------------------------------------

test('F8: close() drops references + notify becomes CLOSED', (t) => {
  const electron = makeFakeElectron({ supported: true })
  const n = createNotifier({ electron, isWindowFocused: () => false, focusWindow: () => {} })
  n.notify({ kind: 'goal', title: 'g' })
  n.close()
  const r = n.notify({ kind: 'goal', title: 'g' })
  t.absent(r.ok)
  t.is(r.code, 'CLOSED')
  t.is(n.status().active, 0)
})
