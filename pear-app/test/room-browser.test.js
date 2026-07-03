// Curva RoomBrowser tests. We test the pure helper functions (slug
// sanitization, flag mapping, status labels, kickoff formatting) via a
// CommonJS helper module. The DOM component itself is browser-only ESM.
//
// This split lets us keep RoomBrowser.js as an ES module for the renderer,
// while brittle (which runs on Node CJS) tests the load-bearing logic.

const test = require('brittle')
const {
  sanitizeSlug,
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
