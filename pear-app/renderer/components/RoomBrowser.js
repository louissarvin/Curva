// Curva RoomBrowser: pre-room match + room discovery.
// Vanilla ES module (ADR-001). textContent only. Peer strings untrusted.
//
// Phase 4 polish (R16):
//   - Distinct loading / empty / error states.
//   - Match cards show flag emojis, local-time kickoff, peer count, hover.
//   - Backend-unreachable banner is non-blocking; slug fallback always renders.
//
// Wave 8B additions:
//   - Two-phase peer count: backend-reported (Phase 1) then DHT-live (Phase 2).
//   - "Seeding to N peers" chip populated from curva.getSeederStats() every 30s.

const FLAG_ISO2 = {
  // A small ISO-3166 lookup for team/country names we expect in the fixture.
  // We deliberately keep this tiny — non-matches fall back to a generic globe.
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

export function mountRoomBrowser({ container, curva, onJoin } = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva bridge is required')
  if (typeof onJoin !== 'function') throw new TypeError('onJoin required')

  container.textContent = ''
  container.classList.add('curva-browser')

  const title = document.createElement('h2')
  title.className = 'curva-browser__title'
  title.textContent = 'Live and upcoming matches'

  const subtitle = document.createElement('p')
  subtitle.className = 'curva-browser__subtitle'
  subtitle.textContent = 'pick a match to join or create a watch-party room.'

  // Non-blocking banner shown when the backend is unreachable.
  const banner = document.createElement('div')
  banner.className = 'curva-browser__banner'
  banner.hidden = true

  const list = document.createElement('ul')
  list.className = 'curva-browser__list'

  const loading = document.createElement('div')
  loading.className = 'curva-browser__loading'
  const spinner = document.createElement('span')
  spinner.className = 'curva-spinner'
  spinner.textContent = ''
  const loadingText = document.createElement('span')
  loadingText.textContent = 'World Cup schedule loading...'
  loading.appendChild(spinner)
  loading.appendChild(loadingText)

  const empty = document.createElement('div')
  empty.className = 'curva-browser__empty'
  empty.textContent = 'Be the first — create a room for tonight\'s match.'
  empty.hidden = true

  const manual = document.createElement('div')
  manual.className = 'curva-browser__manual'
  const manualLabel = document.createElement('label')
  manualLabel.textContent = 'Or join a custom room by slug:'
  const manualInput = document.createElement('input')
  manualInput.type = 'text'
  manualInput.placeholder = 'room-slug (e.g. torino-vs-jakarta)'
  manualInput.className = 'curva-browser__manual-input'
  manualInput.autocomplete = 'off'
  const manualBtn = document.createElement('button')
  manualBtn.type = 'button'
  manualBtn.className = 'curva-browser__btn curva-browser__btn--primary'
  manualBtn.textContent = 'Join'
  manualBtn.addEventListener('click', () => {
    const slug = sanitizeSlug(manualInput.value)
    if (slug) onJoin(slug, false)
  })
  manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const slug = sanitizeSlug(manualInput.value)
      if (slug) onJoin(slug, false)
    }
  })
  manual.appendChild(manualLabel)
  manual.appendChild(manualInput)
  manual.appendChild(manualBtn)

  // Wave 8B T2: seeder chip. Shown in the browser header when the in-process
  // seeder daemon is enabled (PEAR_APP_KEY set). Renderer polls every 30s.
  const seederChip = document.createElement('div')
  seederChip.className = 'curva-browser__seeder'
  seederChip.style.cssText = 'font-size:11px;color:#86efac;padding:4px 8px;border-radius:6px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);margin-bottom:12px;'
  seederChip.hidden = true

  container.appendChild(title)
  container.appendChild(subtitle)
  container.appendChild(banner)
  container.appendChild(seederChip)
  container.appendChild(loading)
  container.appendChild(empty)
  container.appendChild(list)
  container.appendChild(manual)

  // State: matches indexed by id, rooms indexed by matchId.
  const matchesById = new Map()
  const roomsByMatchId = new Map()
  let matchesArrived = false
  let backendFailed = false
  // Wave 8B T3: live DHT peer counts. Keyed by topicHex. Values are numbers.
  // Slug -> topicHex mapping is maintained in `slugToTopicHex` so we can
  // annotate cards during re-render.
  const livePeerCountsByHex = new Map()
  const slugToTopicHex = new Map()

  function setBackendUnreachable(reason) {
    backendFailed = true
    banner.hidden = false
    banner.textContent = 'Backend unreachable. Showing local room browser only. ' +
      (reason ? '(' + String(reason).slice(0, 80) + ')' : '')
    loading.hidden = true
  }

  function renderList() {
    list.textContent = ''
    const ids = [...matchesById.keys()]
    if (matchesArrived) loading.hidden = true

    if (ids.length === 0) {
      if (matchesArrived) {
        empty.hidden = false
        empty.textContent = backendFailed
          ? 'Backend unreachable. Join a custom room by slug below.'
          : 'Be the first — create a room for tonight\'s match.'
      }
      return
    }
    empty.hidden = true

    // Sort: live > upcoming (soonest first) > finished
    ids.sort((a, b) => {
      const ma = matchesById.get(a)
      const mb = matchesById.get(b)
      const orderStatus = (s) => {
        if (s === 'in_progress' || s === 'live') return 0
        if (s === 'scheduled' || s === 'upcoming') return 1
        return 2
      }
      const sa = orderStatus(ma?.status)
      const sb = orderStatus(mb?.status)
      if (sa !== sb) return sa - sb
      const ta = new Date(ma?.utcDate || ma?.kickoffAt || 0).getTime()
      const tb = new Date(mb?.utcDate || mb?.kickoffAt || 0).getTime()
      return ta - tb
    })

    for (const id of ids) {
      const match = matchesById.get(id)
      const rooms = roomsByMatchId.get(id) || []
      // Wave 8B T3 Phase 2: replace backend-reported count with live DHT
      // count if we have one for any of this match's room slugs. `liveCount`
      // is undefined until the DHT lookup returns for at least one slug.
      let liveCount
      for (const r of rooms) {
        const hex = slugToTopicHex.get(r.slug)
        if (hex && livePeerCountsByHex.has(hex)) {
          const c = livePeerCountsByHex.get(hex)
          liveCount = (liveCount || 0) + c
        }
      }
      list.appendChild(renderMatchCard(match, rooms, onJoin, liveCount))
    }
  }

  const offMatches = curva.onMatches(({ matches, error }) => {
    matchesArrived = true
    cancelFailBanner()
    loading.hidden = true
    if (error) {
      setBackendUnreachable(error)
    }
    matchesById.clear()
    for (const m of Array.isArray(matches) ? matches : []) {
      if (m && m.id) matchesById.set(m.id, m)
    }
    renderList()
  })

  const offRooms = curva.onRooms(({ rooms, error }) => {
    if (error && !backendFailed) {
      // Rooms failed but matches may still land; keep loading spinner alive
      // only if matches haven't arrived yet.
    }
    roomsByMatchId.clear()
    for (const r of Array.isArray(rooms) ? rooms : []) {
      if (!r?.matchId) continue
      let arr = roomsByMatchId.get(r.matchId)
      if (!arr) { arr = []; roomsByMatchId.set(r.matchId, arr) }
      arr.push(r)
    }
    renderList()

    // Wave 8B T3: kick off a batched live peer-count lookup for every room
    // slug we know about. The Bare worker enforces 10-concurrent + 60s TTL
    // so this is safe to call on every rooms update. `topicHexForSlug` is a
    // pure preload helper (verified against bare/topics.js).
    if (typeof curva.getLivePeerCountsForSlugs === 'function') {
      const slugs = []
      for (const arr of roomsByMatchId.values()) {
        for (const r of arr) {
          if (typeof r?.slug !== 'string') continue
          slugs.push(r.slug)
          if (typeof curva.topicHexForSlug === 'function') {
            const hex = curva.topicHexForSlug(r.slug)
            if (hex) slugToTopicHex.set(r.slug, hex.toLowerCase())
          }
        }
      }
      if (slugs.length > 0) {
        curva.getLivePeerCountsForSlugs(slugs).catch(() => { /* noop */ })
      }
    }
  })

  // Wave 8B T3: subscribe to live DHT peer counts before the initial fetch,
  // so we don't miss the reply. Payload is a Map<topicHex, number>.
  const offLive = typeof curva.onLivePeerCounts === 'function'
    ? curva.onLivePeerCounts((countsMap) => {
        if (!countsMap || typeof countsMap.forEach !== 'function') return
        countsMap.forEach((count, hex) => {
          livePeerCountsByHex.set(String(hex).toLowerCase(), Number(count) || 0)
        })
        renderList()
      })
    : (() => {})

  // Wave 8B T2: seeder stats poll. Fires immediately and then every 30s.
  // Purely observational — a stalled poll never blocks the browser.
  let seederTimer = null
  const offSeederStats = typeof curva.onSeederStats === 'function'
    ? curva.onSeederStats((snap) => {
        if (!snap) return
        if (!snap.seederEnabled) { seederChip.hidden = true; return }
        seederChip.hidden = false
        const bytes = Number(snap.bytesReplicated) || 0
        const kb = bytes >= 1024 * 1024
          ? (bytes / (1024 * 1024)).toFixed(1) + ' MB'
          : (bytes / 1024).toFixed(1) + ' KB'
        seederChip.textContent =
          'Seeding to ' + (snap.activePeers || 0) + ' peer' +
          ((snap.activePeers === 1) ? '' : 's') +
          ' • ' + (snap.totalPeersLastHour || 0) + ' unique/hr' +
          ' • ' + kb + ' replicated'
      })
    : (() => {})
  function pollSeeder() {
    if (typeof curva.getSeederStats === 'function') {
      curva.getSeederStats().catch(() => { /* noop */ })
    }
  }
  pollSeeder()
  if (typeof curva.getSeederStats === 'function') {
    seederTimer = setInterval(pollSeeder, 30_000)
  }

  // Kick off initial fetch. If BOTH loads reject before responding we mark
  // backend unreachable so the banner appears immediately.
  // Debounce the "Backend unreachable" banner: only show it if BOTH requests
  // fail AND at least 3 seconds have elapsed. This prevents a false positive
  // on startup when the backend is still binding its port.
  let pendingLoads = 2
  let firstFailReason = null
  let failBannerTimer = null

  const maybeMarkFailed = (reason) => {
    pendingLoads -= 1
    if (!firstFailReason) firstFailReason = reason
    if (pendingLoads <= 0 && !matchesArrived) {
      // 3-second grace period before showing the banner.
      failBannerTimer = setTimeout(() => {
        if (!matchesArrived || backendFailed) return
        setBackendUnreachable(firstFailReason)
        matchesArrived = true
        renderList()
      }, 3000)
    }
  }

  // Cancel the pending fail banner if data actually arrives.
  const cancelFailBanner = () => {
    if (failBannerTimer) {
      clearTimeout(failBannerTimer)
      failBannerTimer = null
    }
  }

  curva.loadMatchesToday().catch((err) => maybeMarkFailed(err?.message))
  curva.loadRooms({ activeOnly: true, limit: 50 }).catch((err) => maybeMarkFailed(err?.message))

  // Hard cutoff: if nothing arrives in 12s, show empty state.
  const timeout = setTimeout(() => {
    if (!matchesArrived) {
      matchesArrived = true
      cancelFailBanner()
      loading.hidden = true
      renderList()
    }
  }, 12_000)

  function destroy() {
    clearTimeout(timeout)
    cancelFailBanner()
    if (seederTimer) clearInterval(seederTimer)
    try { offLive() } catch { /* noop */ }
    try { offSeederStats() } catch { /* noop */ }
    offMatches()
    offRooms()
    container.textContent = ''
  }

  return { destroy }
}

function renderMatchCard(match, rooms, onJoin, liveCount) {
  const li = document.createElement('li')
  li.className = 'curva-browser__card'
  if (match.status === 'in_progress' || match.status === 'live') {
    li.classList.add('curva-browser__card--live')
  }

  const head = document.createElement('div')
  head.className = 'curva-browser__card-head'

  const teams = document.createElement('span')
  teams.className = 'curva-browser__teams'
  const home = teamName(match?.homeTeam)
  const away = teamName(match?.awayTeam)
  teams.textContent = `${nameToFlag(home)}  ${home}  vs  ${nameToFlag(away)}  ${away}`

  const status = document.createElement('span')
  status.className = 'curva-browser__status'
  status.textContent = statusLabel(match?.status)

  head.appendChild(teams)
  head.appendChild(status)

  const meta = document.createElement('div')
  meta.className = 'curva-browser__card-meta'
  const kickoff = kickoffLine(match)
  const peers = rooms.reduce((sum, r) => sum + (Number(r.peerCount) || 0), 0)
  const parts = []
  if (kickoff) parts.push(kickoff)
  if (rooms.length) parts.push(`${rooms.length} room${rooms.length === 1 ? '' : 's'}`)
  // Wave 8B T3: prefer live DHT count when available; otherwise fall back
  // to the backend-reported count (Phase 1 render). A "live" annotation
  // signals to the user that the number came from the DHT, not the backend.
  if (typeof liveCount === 'number') {
    parts.push(`${liveCount} peers on DHT (live)`)
  } else if (peers > 0) {
    parts.push(`${peers} fans watching`)
  }
  meta.textContent = parts.join(' • ')

  const actions = document.createElement('div')
  actions.className = 'curva-browser__card-actions'

  const createBtn = document.createElement('button')
  createBtn.type = 'button'
  createBtn.className = 'curva-browser__btn curva-browser__btn--primary'
  createBtn.textContent = 'Create room'
  createBtn.addEventListener('click', () => {
    const slug = slugify(match.id + '-' + Math.random().toString(36).slice(2, 6))
    onJoin(slug, true)
  })
  actions.appendChild(createBtn)

  for (const r of rooms.slice(0, 3)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'curva-browser__btn'
    b.textContent = 'Join ' + (r.slug || '(unnamed)')
    b.addEventListener('click', () => onJoin(String(r.slug), false))
    actions.appendChild(b)
  }

  li.appendChild(head)
  li.appendChild(meta)
  li.appendChild(actions)
  return li
}

function teamName(t) {
  if (typeof t === 'string') return t
  if (t?.name) return String(t.name)
  return '?'
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
  // Local time zone is intentional: judges see their own time.
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

function slugify(input) {
  return sanitizeSlug(input)
}

// Note: pure helpers (sanitizeSlug, statusLabel, kickoffLine, nameToFlag,
// iso2Flag, FLAG_ISO2) are duplicated in ./roomBrowserHelpers.cjs.js so
// brittle tests can require() them without an ESM/CJS interop dance. Any
// change here MUST be mirrored in that file.
