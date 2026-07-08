// Curva RoomBrowser pure helpers, CommonJS. The DOM component in
// RoomBrowser.js re-exports these; brittle tests require() this file directly
// to avoid the ESM/CJS loader mismatch (see test/room-browser.test.js).

const FLAG_ISO2 = {
  italy: 'IT', 'italy 🇮🇹': 'IT',
  indonesia: 'ID',
  england: 'GB', 'united kingdom': 'GB', uk: 'GB',
  spain: 'ES',
  germany: 'DE',
  brazil: 'BR',
  argentina: 'AR',
  france: 'FR',
  portugal: 'PT',
  netherlands: 'NL',
  belgium: 'BE',
  croatia: 'HR',
  morocco: 'MA',
  mexico: 'MX',
  'united states': 'US', usa: 'US', us: 'US',
  canada: 'CA',
  japan: 'JP',
  'south korea': 'KR', korea: 'KR',
  australia: 'AU'
}

function iso2Flag(iso2) {
  if (!iso2 || iso2.length !== 2) return '🏳️'
  const A = 0x1F1E6
  const cp = (c) => A + (c.charCodeAt(0) - 65)
  return String.fromCodePoint(cp(iso2[0]), cp(iso2[1]))
}

function nameToFlag(name) {
  if (typeof name !== 'string') return '🏳️'
  const key = name.trim().toLowerCase().replace(/[^a-z\s]/g, '').trim()
  const iso2 = FLAG_ISO2[key]
  if (iso2) return iso2Flag(iso2)
  return '🏳️'
}

function statusLabel(s) {
  if (s === 'in_progress' || s === 'live') return 'LIVE'
  if (s === 'scheduled' || s === 'upcoming') return 'UPCOMING'
  if (s === 'finished' || s === 'completed') return 'FT'
  return String(s || 'scheduled').toUpperCase()
}

function kickoffLine(match) {
  const raw = match?.utcDate || match?.kickoffAt
  if (!raw) return ''
  const t = new Date(raw)
  if (isNaN(t.getTime())) return ''
  return t.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function sanitizeSlug(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
}

// Live-input sanitizer for the "Create room" form. Does the SAME character
// filtering + lowercasing as sanitizeSlug, but PRESERVES leading and trailing
// dashes so the user can still type `wc26-final` one character at a time.
// The full sanitizeSlug runs on submit (and on isValidSlug), which trims the
// dashes at that boundary.
function sanitizeSlugSoft(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64)
}

// Mirror of backend/src/utils/curvaValidators.ts SLUG_RE.
// Length: >= 4 and <= 32. Pattern: lower-alnum start, [a-z0-9-] middle (2-30
// chars), lower-alnum end. Both endpoint constraints match the backend.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{2,30})[a-z0-9]$/

function isValidSlug(input) {
  if (typeof input !== 'string') return false
  if (input.length < 4 || input.length > 32) return false
  return SLUG_RE.test(input)
}

// Human-readable room title. Backend accepts a free-form matchId today; we
// use the display name only in the local UI, not on the /rooms payload.
// Length capped at 64 to match the field's tooltip contract.
function sanitizeRoomName(input) {
  const s = String(input || '').trim().slice(0, 64)
  // Strip C0 control chars (matches backend host handle guard).
  return s.replace(/[\x00-\x1f]/g, '')
}

module.exports = {
  FLAG_ISO2,
  iso2Flag,
  nameToFlag,
  statusLabel,
  kickoffLine,
  sanitizeSlug,
  sanitizeSlugSoft,
  isValidSlug,
  sanitizeRoomName
}
