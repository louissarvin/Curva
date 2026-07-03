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

module.exports = {
  FLAG_ISO2,
  iso2Flag,
  nameToFlag,
  statusLabel,
  kickoffLine,
  sanitizeSlug
}
