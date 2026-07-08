// Curva RoomBrowser tests. We test the pure helper functions (slug
// sanitization, flag mapping, status labels, kickoff formatting) via a
// CommonJS helper module. The DOM component itself is browser-only ESM.
//
// This split lets us keep RoomBrowser.js as an ES module for the renderer,
// while brittle (which runs on Node CJS) tests the load-bearing logic.

const test = require('brittle')
const {
  sanitizeSlug,
  sanitizeSlugSoft,
  isValidSlug,
  sanitizeRoomName,
  statusLabel,
  kickoffLine,
  nameToFlag,
  iso2Flag,
  FLAG_ISO2
} = require('../renderer/components/roomBrowserHelpers.cjs.js')

test('sanitizeSlug: lowercases and strips unsafe chars', (t) => {
  t.is(sanitizeSlug('Curva Sud'), 'curva-sud')
  t.is(sanitizeSlug('Torino vs Jakarta!'), 'torino-vs-jakarta')
  t.is(sanitizeSlug('   spaced-out   '), 'spaced-out')
  t.is(sanitizeSlug('a---b'), 'a-b', 'collapses hyphens')
  t.is(sanitizeSlug(''), '')
  t.is(sanitizeSlug(null), '')
  t.is(sanitizeSlug(undefined), '')
})

test('sanitizeSlug: caps at 64 chars', (t) => {
  const long = 'a'.repeat(200)
  t.is(sanitizeSlug(long).length, 64)
})

test('sanitizeSlug: preserves alphanumerics and hyphens', (t) => {
  t.is(sanitizeSlug('wc-2026-r16-001'), 'wc-2026-r16-001')
})

test('statusLabel: maps common statuses to display strings', (t) => {
  t.is(statusLabel('in_progress'), 'LIVE')
  t.is(statusLabel('live'), 'LIVE')
  t.is(statusLabel('scheduled'), 'UPCOMING')
  t.is(statusLabel('upcoming'), 'UPCOMING')
  t.is(statusLabel('finished'), 'FT')
  t.is(statusLabel('completed'), 'FT')
  t.is(statusLabel('some_other'), 'SOME_OTHER')
  t.is(statusLabel(undefined), 'SCHEDULED')
})

test('kickoffLine: formats a valid date, returns "" for invalid', (t) => {
  const withDate = kickoffLine({ utcDate: '2026-07-15T20:00:00Z' })
  t.ok(typeof withDate === 'string' && withDate.length > 0, 'formatted string')
  t.is(kickoffLine({}), '', 'no date -> empty')
  t.is(kickoffLine({ kickoffAt: 'not-a-date' }), '', 'invalid -> empty')
  t.is(kickoffLine(undefined), '', 'undefined match -> empty')
})

test('iso2Flag: renders regional-indicator flag from ISO2', (t) => {
  t.is(iso2Flag('IT'), '🇮🇹')
  t.is(iso2Flag('ID'), '🇮🇩')
  t.is(iso2Flag('US'), '🇺🇸')
  t.is(iso2Flag(''), '🏳️', 'empty falls back')
  t.is(iso2Flag(null), '🏳️')
})

test('nameToFlag: known team names map to flags', (t) => {
  t.is(nameToFlag('Italy'), '🇮🇹')
  t.is(nameToFlag('Indonesia'), '🇮🇩')
  t.is(nameToFlag('England'), '🇬🇧')
  t.is(nameToFlag('USA'), '🇺🇸')
  t.is(nameToFlag('Unknown Team'), '🏳️', 'unknown falls back')
  t.is(nameToFlag(''), '🏳️')
  t.is(nameToFlag(null), '🏳️')
})

test('nameToFlag: case-insensitive and tolerant of punctuation', (t) => {
  t.is(nameToFlag('italy'), '🇮🇹')
  t.is(nameToFlag('ITALY!!'), '🇮🇹')
  t.is(nameToFlag('  italy  '), '🇮🇹')
})

test('FLAG_ISO2: has entries for demo teams', (t) => {
  t.is(FLAG_ISO2.italy, 'IT', 'italy present')
  t.is(FLAG_ISO2.indonesia, 'ID', 'indonesia present')
  t.is(FLAG_ISO2.england, 'GB', 'england present')
})

// -- Wave 17: isValidSlug + sanitizeRoomName ------------------------------

test('isValidSlug: accepts backend-compatible slugs', (t) => {
  // Matches SLUG_RE in backend/src/utils/curvaValidators.ts:8.
  t.ok(isValidSlug('wc26-final'), 'canonical demo slug is valid')
  t.ok(isValidSlug('torino-vs-jakarta'), 'multi-hyphen valid')
  t.ok(isValidSlug('room1234'), 'no-hyphen alnum valid')
  t.ok(isValidSlug('abcd'), 'minimum length 4 valid')
  t.ok(isValidSlug('a'.repeat(32)), 'maximum length 32 valid')
})

test('isValidSlug: rejects invalid slugs the backend would 400', (t) => {
  t.absent(isValidSlug(''), 'empty rejected')
  t.absent(isValidSlug('abc'), 'below min length rejected')
  t.absent(isValidSlug('a'.repeat(33)), 'above max length rejected')
  t.absent(isValidSlug('-abcd'), 'leading dash rejected')
  t.absent(isValidSlug('abcd-'), 'trailing dash rejected')
  t.absent(isValidSlug('ABCD'), 'uppercase rejected')
  t.absent(isValidSlug('room!'), 'punctuation rejected')
  t.absent(isValidSlug('room name'), 'spaces rejected')
  t.absent(isValidSlug(null), 'null rejected')
  t.absent(isValidSlug(42), 'non-string rejected')
})

test('isValidSlug: middle segment length matches backend regex bounds', (t) => {
  // SLUG_RE requires a 2-30 char middle segment plus start+end alnum, so
  // total goes 4-32. Rejecting a 3-char slug proves that middle bound.
  t.absent(isValidSlug('abc'), 'total 3 rejected (middle < 2)')
  t.ok(isValidSlug('abcd'), 'total 4 accepted (middle == 2)')
})

test('sanitizeRoomName: strips control chars and trims to 64 chars', (t) => {
  t.is(sanitizeRoomName('  hello world  '), 'hello world', 'trims whitespace')
  t.is(sanitizeRoomName('a'.repeat(80)).length, 64, 'caps at 64')
  t.is(sanitizeRoomName('hello\x00world'), 'helloworld', 'strips null byte')
  t.is(sanitizeRoomName('room\x1fname'), 'roomname', 'strips ANSI CSI byte')
  t.is(sanitizeRoomName(null), '', 'null coerces to empty')
  t.is(sanitizeRoomName(undefined), '', 'undefined coerces to empty')
})

test('sanitize pipeline: user input -> valid slug', (t) => {
  // Live-normalising input should feed straight into isValidSlug for the
  // create-room submit path.
  const raw = '  WC26 Final!! '
  const normalised = sanitizeSlug(raw)
  t.is(normalised, 'wc26-final')
  t.ok(isValidSlug(normalised), 'normalised slug passes backend rule')
})

// -- Wave 17 fix: live-input variant preserves in-progress dashes --------

test('sanitizeSlugSoft: preserves trailing dash so user can type wc26-final', (t) => {
  // Simulates keystroke-by-keystroke live input handling.
  t.is(sanitizeSlugSoft('w'), 'w')
  t.is(sanitizeSlugSoft('wc'), 'wc')
  t.is(sanitizeSlugSoft('wc26'), 'wc26')
  t.is(sanitizeSlugSoft('wc26-'), 'wc26-', 'trailing dash preserved live')
  t.is(sanitizeSlugSoft('wc26-f'), 'wc26-f')
  t.is(sanitizeSlugSoft('wc26-final'), 'wc26-final')
})

test('sanitizeSlugSoft: preserves leading dash', (t) => {
  t.is(sanitizeSlugSoft('-abc'), '-abc', 'leading dash preserved (submit rejects)')
})

test('sanitizeSlugSoft: still filters unsafe chars and lowercases', (t) => {
  t.is(sanitizeSlugSoft('WC26 Final!!'), 'wc26-final-')
  t.is(sanitizeSlugSoft('Torino vs Jakarta'), 'torino-vs-jakarta')
})

test('sanitizeSlugSoft: collapses consecutive dashes', (t) => {
  t.is(sanitizeSlugSoft('a---b'), 'a-b')
  t.is(sanitizeSlugSoft('room  name'), 'room-name')
})

test('live -> submit pipeline: dashes survive typing then trim on submit', (t) => {
  // User types "wc26-final" one key at a time; live handler never eats the
  // dash; submit handler runs full sanitizeSlug + isValidSlug.
  const live = sanitizeSlugSoft('wc26-final')
  t.is(live, 'wc26-final')
  const onSubmit = sanitizeSlug(live)
  t.is(onSubmit, 'wc26-final')
  t.ok(isValidSlug(onSubmit), 'passes backend rule')
})

test('live -> submit pipeline: trailing dash gets trimmed by submit', (t) => {
  // User typed but never finished the word.
  const live = sanitizeSlugSoft('abc-')
  t.is(live, 'abc-', 'live preserves the dash for further typing')
  const onSubmit = sanitizeSlug(live)
  t.is(onSubmit, 'abc', 'submit trims trailing dash')
  t.absent(isValidSlug(onSubmit), 'too short after trim -> rejected by backend rule')
})
