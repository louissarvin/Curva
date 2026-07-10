// Curva native desktop notifications (F8).
//
// Docs verified (fetched 2026-07-10):
//   https://www.electronjs.org/docs/latest/api/notification
//     - Constructor: new Notification([options])
//         options: { title, body, subtitle?, silent?, urgency?, ... }
//     - Static: Notification.isSupported()
//     - Instance: notification.show(), notification.close(), notification.on('click', fn)
//   https://www.electronjs.org/docs/latest/api/browser-window
//     - win.show() / win.focus() / win.isFocused() / win.restore()
//
// Design goal: when the Electron window is unfocused/minimized AND a demo-
// relevant event fires (goal, tip received, chat mention), show a native
// OS notification. Click hooks into the caller-supplied focusWindow(slug)
// so the renderer can navigate to the right room.
//
// Rate limit: per-kind global limiter, 1 notification per RATE_LIMIT_WINDOW_MS
// per kind. Avoids notification spam when goals fire rapidly.
//
// Focus check: caller supplies isWindowFocused(). We do NOT emit when the
// window is focused because the peer is already looking at the chat.
//
// Linux Wayland caveat: Electron's Notification.isSupported() returns true
// on many Wayland desktops that then silently drop notifications. We can't
// detect that gracefully; we emit anyway and the OS decides.
//
// Style: CommonJS + no em-dashes.

const RATE_LIMIT_WINDOW_MS = 5000
const KNOWN_KINDS = new Set(['goal', 'tip', 'mention', 'match-start', 'match-end'])
const MAX_TITLE = 128
const MAX_BODY = 256
const MAX_SLUG = 128

function sanitizeShortString (raw, max) {
  if (typeof raw !== 'string') return ''
  let s
  try { s = raw.normalize('NFKC') } catch { s = raw }
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (code === 0x0A || code === 0x0D || code === 0x09) { out += ' '; continue }
    if (code < 0x20) continue
    if (code === 0x7F) continue
    if (code >= 0x80 && code <= 0x9F) continue
    if (code === 0xFEFF) continue
    out += ch
  }
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length > max) out = out.slice(0, max)
  return out
}

/**
 * @param {{
 *   electron?: { Notification?: any },   // test seam; defaults to require('electron')
 *   focusWindow?: (slug:string) => void, // hook that raises + navigates renderer
 *   isWindowFocused?: () => boolean,     // returns true if window should suppress notify
 *   log?: (level:string, msg:string, extra?:any) => void,
 *   now?: () => number
 * }} opts
 */
function createNotifier (opts = {}) {
  const {
    electron = null,
    focusWindow = () => {},
    isWindowFocused = () => false,
    log = () => {},
    now = () => Date.now()
  } = opts

  const el = electron || (function tryRequire () {
    try { return require('electron') } catch { return {} }
  })()
  const NotificationCtor = el && el.Notification ? el.Notification : null

  const state = {
    supported: false,
    lastByKind: new Map(),
    counters: { shown: 0, suppressedFocus: 0, suppressedRate: 0, errors: 0, unsupported: 0 },
    activeNotifications: new Set(),
    closed: false
  }

  try {
    state.supported = !!NotificationCtor && typeof NotificationCtor.isSupported === 'function'
      ? !!NotificationCtor.isSupported()
      : false
  } catch { state.supported = false }

  function status () {
    return {
      supported: state.supported,
      hasNotificationCtor: !!NotificationCtor,
      lastByKind: Object.fromEntries(state.lastByKind),
      counters: { ...state.counters },
      active: state.activeNotifications.size,
      closed: state.closed
    }
  }

  /**
   * Emit a native notification.
   * @param {{ kind:string, roomSlug?:string, title:string, body?:string, silent?:boolean, urgency?:string }} args
   * @returns {{ok:boolean, shown?:boolean, reason?:string, code?:string}}
   */
  function notify (args = {}) {
    if (state.closed) return { ok: false, code: 'CLOSED' }
    if (!state.supported || !NotificationCtor) {
      state.counters.unsupported += 1
      return { ok: false, code: 'UNSUPPORTED' }
    }

    const kind = typeof args.kind === 'string' ? args.kind : ''
    if (!kind || !KNOWN_KINDS.has(kind)) {
      return { ok: false, code: 'BAD_KIND' }
    }

    const title = sanitizeShortString(args.title, MAX_TITLE)
    if (title.length === 0) {
      return { ok: false, code: 'BAD_TITLE' }
    }
    const body = sanitizeShortString(args.body || '', MAX_BODY)
    const roomSlug = typeof args.roomSlug === 'string' && args.roomSlug.length > 0
      ? sanitizeShortString(args.roomSlug, MAX_SLUG)
      : null

    // Suppress when the window is focused: the peer is already looking at it.
    let focused = false
    try { focused = !!isWindowFocused() } catch { focused = false }
    if (focused) {
      state.counters.suppressedFocus += 1
      return { ok: true, shown: false, reason: 'window-focused' }
    }

    // Per-kind rate limit. A missing entry means "first time this kind has
    // fired" -> always allow, otherwise compare against the last-shown time.
    const t = now()
    const last = state.lastByKind.has(kind) ? state.lastByKind.get(kind) : null
    if (last !== null && t - last < RATE_LIMIT_WINDOW_MS) {
      state.counters.suppressedRate += 1
      return { ok: true, shown: false, reason: 'rate-limited' }
    }

    // Build the notification. Electron's constructor accepts { silent, urgency }.
    // urgency is Linux-only per docs, but Electron silently ignores unknown
    // fields on other platforms.
    const nOpts = { title, body }
    if (args.silent === true) nOpts.silent = true
    if (typeof args.urgency === 'string') nOpts.urgency = args.urgency
    let n
    try {
      n = new NotificationCtor(nOpts)
    } catch (err) {
      state.counters.errors += 1
      log('warn', 'notification ctor threw', { message: err && err.message })
      return { ok: false, code: 'CTOR_FAILED' }
    }

    // Wire click -> focusWindow(roomSlug). Always subscribe so a stale
    // notification cannot re-trigger focus after close (Electron cleans up
    // internal listeners on notification.close()).
    try {
      n.on('click', () => {
        try { focusWindow(roomSlug || null) } catch (err) {
          log('warn', 'focusWindow threw on click', { message: err && err.message })
        }
      })
    } catch { /* older builds may not support .on; ignore */ }

    try {
      n.on('close', () => { state.activeNotifications.delete(n) })
    } catch { /* noop */ }

    try {
      n.show()
    } catch (err) {
      state.counters.errors += 1
      log('warn', 'notification show threw', { message: err && err.message })
      return { ok: false, code: 'SHOW_FAILED' }
    }

    state.lastByKind.set(kind, t)
    state.counters.shown += 1
    state.activeNotifications.add(n)
    return { ok: true, shown: true, kind, roomSlug }
  }

  function close () {
    state.closed = true
    for (const n of state.activeNotifications) {
      try { n.close && n.close() } catch { /* noop */ }
    }
    state.activeNotifications.clear()
  }

  return {
    notify,
    status,
    close,
    // Test-only surface
    _internal: { state, sanitizeShortString }
  }
}

module.exports = {
  createNotifier,
  sanitizeShortString,
  RATE_LIMIT_WINDOW_MS,
  KNOWN_KINDS,
  MAX_TITLE,
  MAX_BODY,
  MAX_SLUG
}
