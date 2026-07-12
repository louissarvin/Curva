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
  title.textContent = 'Watch-party rooms'

  const subtitle = document.createElement('p')
  subtitle.className = 'curva-browser__subtitle'
  subtitle.textContent = 'Open a room as host, or join one your friends have already published.'

  // Non-blocking banner shown when the backend is unreachable.
  const banner = document.createElement('div')
  banner.className = 'curva-browser__banner'
  banner.hidden = true

  // Wave 17: "Create new room" primary CTA + collapsible form. Sits above
  // the fixture list so the host's own room is the highest-affordance action
  // in the lobby. Everything below is discovery of other peers' rooms.
  //
  // Slug validation mirrors backend/src/utils/curvaValidators.ts SLUG_RE so
  // the form rejects at the client boundary before we ever hit /rooms.
  // Publish toggle default = ON because the primary demo path is "host
  // publishes, viewer joins from directory". Turn off if the host only wants
  // an invite-only room.
  const createSection = document.createElement('section')
  createSection.className = 'curva-browser__create'

  // Wave 17 v2: expose the create form inline all the time. The old expand/
  // collapse toggle button became a second "Create" button next to the form's
  // own submit button, which was the exact two-button trap we were trying to
  // remove. The form is short (three fields), so always showing it is cheap
  // and gives judges a single obvious action.
  const createHeading = document.createElement('h3')
  createHeading.className = 'curva-browser__create-heading'
  createHeading.textContent = 'Create a room'

  const createForm = document.createElement('form')
  createForm.className = 'curva-browser__create-form'
  createForm.setAttribute('aria-label', 'Create a new room')
  createForm.noValidate = true // handle validation ourselves for inline hints

  const slugField = document.createElement('label')
  slugField.className = 'curva-browser__field'
  const slugLabel = document.createElement('span')
  slugLabel.textContent = 'Room slug'
  const slugInput = document.createElement('input')
  slugInput.type = 'text'
  slugInput.placeholder = 'wc26-final'
  slugInput.autocomplete = 'off'
  slugInput.spellcheck = false
  slugInput.className = 'curva-browser__input'
  slugInput.setAttribute('aria-describedby', 'curva-browser-slug-hint')
  const slugHint = document.createElement('span')
  slugHint.className = 'curva-browser__hint'
  slugHint.id = 'curva-browser-slug-hint'
  slugHint.textContent = '4-32 chars. Lowercase letters, numbers and dashes. Must start and end with a letter or number.'
  slugField.appendChild(slugLabel)
  slugField.appendChild(slugInput)
  slugField.appendChild(slugHint)

  const nameField = document.createElement('label')
  nameField.className = 'curva-browser__field'
  const nameLabel = document.createElement('span')
  nameLabel.textContent = 'Room name (optional)'
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.placeholder = 'e.g. WC26 Final Watch Party'
  nameInput.autocomplete = 'off'
  nameInput.maxLength = 64
  nameInput.className = 'curva-browser__input'
  const nameHint = document.createElement('span')
  nameHint.className = 'curva-browser__hint'
  nameHint.textContent = 'Shown to your viewers. Falls back to the slug when empty.'
  nameField.appendChild(nameLabel)
  nameField.appendChild(nameInput)
  nameField.appendChild(nameHint)

  const publishRow = document.createElement('label')
  publishRow.className = 'curva-browser__field curva-browser__field--check'
  const publishCheck = document.createElement('input')
  publishCheck.type = 'checkbox'
  publishCheck.checked = true
  publishCheck.className = 'curva-browser__check'
  const publishText = document.createElement('span')
  publishText.textContent = 'Publish to the STADIUM directory so any peer can discover it'
  publishRow.appendChild(publishCheck)
  publishRow.appendChild(publishText)

  const errorLine = document.createElement('div')
  errorLine.className = 'curva-browser__error'
  errorLine.hidden = true
  errorLine.setAttribute('role', 'alert')

  const submitRow = document.createElement('div')
  submitRow.className = 'curva-browser__submit-row'
  const submitBtn = document.createElement('button')
  submitBtn.type = 'submit'
  submitBtn.className = 'curva-browser__btn curva-browser__btn--primary'
  submitBtn.textContent = 'Create room and enter as host'
  submitRow.appendChild(submitBtn)

  createForm.appendChild(slugField)
  createForm.appendChild(nameField)
  createForm.appendChild(publishRow)
  createForm.appendChild(errorLine)
  createForm.appendChild(submitRow)

  createSection.appendChild(createHeading)
  createSection.appendChild(createForm)

  slugInput.addEventListener('input', () => {
    // Live-normalise the character SET so users see only backend-legal chars
    // (lowercase, digits, dashes). Do NOT trim leading/trailing dashes here —
    // that would eat every dash the moment the user types it. Full sanitize +
    // isValidSlug run on submit.
    const before = slugInput.value
    const norm = sanitizeSlugSoft(before)
    if (before !== norm) {
      // Preserve caret position when we only lowercased or filtered chars,
      // since we didn't insert or delete anything net.
      const caret = slugInput.selectionStart
      slugInput.value = norm
      try { slugInput.setSelectionRange(caret, caret) } catch { /* noop */ }
    }
    if (!errorLine.hidden) {
      errorLine.hidden = true
      errorLine.textContent = ''
    }
  })

  function submitCreate (e) {
    e.preventDefault()
    const rawSlug = sanitizeSlug(slugInput.value)
    if (!isValidSlug(rawSlug)) {
      errorLine.textContent = 'Slug must be 4-32 characters, only a-z / 0-9 / dashes, and cannot start or end with a dash.'
      errorLine.hidden = false
      slugInput.focus()
      return
    }
    slugInput.value = rawSlug
    const displayName = String(nameInput.value || '').trim().slice(0, 64).replace(/[\x00-\x1f]/g, '')
    const publish = !!publishCheck.checked
    // Disable while the join fires so double-click doesn't stack calls.
    submitBtn.disabled = true
    onJoin(rawSlug, true, { publish, displayName })
  }
  createForm.addEventListener('submit', submitCreate)

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
  manualLabel.textContent = 'Know the slug? Join a room directly:'
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

  // F4 semifinal: VIP room reservation UI. Peer signs a 5 USDT EIP-3009
  // authorization off-chain; backend facilitator settles + writes the
  // reservation to Prisma. Fails open on backend outage - reservation is a
  // signaling layer + directory hint, not P2P access control. See
  // backend/src/routes/vipRoutes.ts and pear-app/bare/x402Client.js.
  const vipSection = document.createElement('section')
  vipSection.className = 'curva-browser__vip'
  vipSection.style.cssText = 'padding:14px;margin-top:12px;border:1px solid rgba(220,38,38,0.35);border-radius:10px;background:rgba(220,38,38,0.04);'
  const vipTitle = document.createElement('div')
  vipTitle.style.cssText = 'font-size:13px;font-weight:600;color:#fca5a5;margin-bottom:6px;'
  vipTitle.textContent = 'Reserve a VIP room slug (5 USDT via EIP-3009)'
  const vipHint = document.createElement('div')
  vipHint.style.cssText = 'font-size:12px;color:#b0b0b0;margin-bottom:10px;'
  vipHint.textContent = 'Second x402 paid-resource route. Signs a 5 USDT authorization to the sponsor address; backend facilitator settles on Sepolia. Reservation is public + on-chain; the slug appears in every peer\'s lobby with a VIP badge.'
  const vipForm = document.createElement('form')
  vipForm.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;'
  const vipInput = document.createElement('input')
  vipInput.type = 'text'
  vipInput.placeholder = 'kings-lounge'
  vipInput.maxLength = 32
  vipInput.className = 'curva-browser__input'
  vipInput.style.cssText = 'flex:1 1 160px;min-width:160px;padding:8px 10px;border-radius:6px;border:1px solid var(--curva-border);background:var(--curva-bg-elev);color:var(--curva-fg);font-size:13px;'
  const vipBtn = document.createElement('button')
  vipBtn.type = 'submit'
  vipBtn.className = 'curva-browser__btn curva-browser__btn--primary'
  vipBtn.textContent = 'Reserve for 5 USDT'
  const vipStatus = document.createElement('div')
  vipStatus.style.cssText = 'flex:1 1 100%;font-size:12px;color:#b0b0b0;margin-top:6px;'
  vipForm.appendChild(vipInput)
  vipForm.appendChild(vipBtn)
  vipForm.appendChild(vipStatus)
  vipSection.appendChild(vipTitle)
  vipSection.appendChild(vipHint)
  vipSection.appendChild(vipForm)
  vipForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!curva.vip || typeof curva.vip.reserve !== 'function') {
      vipStatus.textContent = 'VIP reservation not available in this build.'
      return
    }
    const raw = String(vipInput.value || '').toLowerCase().trim()
    const slug = raw.replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 32)
    if (slug.length < 3) {
      vipStatus.textContent = 'Slug must be 3-32 chars, lowercase a-z / 0-9 / dashes.'
      return
    }
    vipInput.value = slug
    vipBtn.disabled = true
    vipStatus.textContent = 'Signing EIP-3009 authorization for 5 USDT...'
    try {
      const res = await curva.vip.reserve(slug)
      if (res && res.ok && res.reservation) {
        const tx = res.reservation.txHash || res.reservation.paidTxHash || ''
        const url = tx ? ('https://sepolia.etherscan.io/tx/' + tx) : ''
        vipStatus.textContent = 'Reserved. txHash: ' + (tx || '(pending)') + (url ? '  |  ' + url : '')
        vipInput.value = ''
      } else {
        vipStatus.textContent = 'Reservation failed: ' + ((res && (res.message || res.code)) || 'unknown')
      }
    } catch (err) {
      vipStatus.textContent = 'Reservation failed: ' + (err?.message || err?.code || 'unknown')
    } finally {
      vipBtn.disabled = false
    }
  })

  container.appendChild(title)
  container.appendChild(subtitle)
  container.appendChild(createSection)
  container.appendChild(vipSection)
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
    if (matchesArrived) loading.hidden = true

    // Wave 17 v3: one card per ROOM (not per match). The old fixture-first
    // layout nested rooms inside "TBD vs TBD" wrappers which added visual
    // clutter for zero information (WC26 fixture data is all placeholder).
    // Each card now shows one room: slug as title, host handle, badge,
    // live peer count, big Join button. Rooms are ordered by public first
    // (STADIUM discovery is the primary demo path), then newest-created.
    const rooms = []
    for (const arr of roomsByMatchId.values()) {
      for (const r of arr) {
        if (!r || typeof r.slug !== 'string') continue
        rooms.push(r)
      }
    }

    // Always start each render with the empty state hidden. We only re-show
    // it in the two explicit end-states below (no data yet, or zero rooms).
    empty.hidden = true

    if (rooms.length === 0) {
      if (matchesArrived) {
        empty.hidden = false
        empty.textContent = backendFailed
          ? 'Backend unreachable. Create a room above to start hosting your own.'
          : 'No public rooms yet — create one above to start hosting.'
      }
      return
    }

    // Sort: STADIUM (public) first, then by createdAt desc (newest first).
    // Judges landing on the lobby should see the freshest public rooms up
    // top; private/invite-only rooms sink to the bottom.
    rooms.sort((a, b) => {
      const va = a.visibility === 'public' ? 0 : 1
      const vb = b.visibility === 'public' ? 0 : 1
      if (va !== vb) return va - vb
      const ta = new Date(a.createdAt || 0).getTime()
      const tb = new Date(b.createdAt || 0).getTime()
      return tb - ta
    })

    for (const room of rooms) {
      const hex = slugToTopicHex.get(room.slug)
      const liveCount = hex && livePeerCountsByHex.has(hex)
        ? livePeerCountsByHex.get(hex)
        : undefined
      const match = room.matchId ? matchesById.get(room.matchId) : null
      list.appendChild(renderRoomCard(room, match, onJoin, liveCount))
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

  // Load the closest upcoming scheduled matches. During the tournament this
  // includes today + the next few days automatically; on rest days between
  // rounds (or during demo runs) this still surfaces the next fixtures so the
  // lobby is never blank. Backend supports the `from` filter as an ISO 8601
  // string and sorts by kickoff ascending.
  const nowIso = new Date().toISOString()
  curva.loadMatches({ status: 'scheduled', from: nowIso, limit: 20 })
    .catch((err) => maybeMarkFailed(err?.message))
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

  // Wave 17 UX: the per-fixture "Create room" button is retired. Room creation
  // now flows through the single "+ Create a new room" primary CTA at the top
  // of the lobby (see mountRoomBrowser createSection). Reasons:
  //   1. Two "Create room" buttons on one screen made the flow ambiguous.
  //   2. The per-fixture button auto-generated a slug from `match.id + rand`
  //      which was worse UX than letting the host pick their own.
  //   3. The WC26 fixture data is all TBD placeholders today, so we would
  //      have been prompting hosts to create rooms tied to fictional matches.
  // Fixture cards now only show Join buttons for existing rooms; if a fixture
  // has zero rooms attached AND is TBD, the outer filter in renderList() hides
  // the whole card so the lobby doesn't render dead cards.

  for (const r of rooms.slice(0, 3)) {
    const roomRow = document.createElement('span')
    roomRow.className = 'curva-browser__room-row'

    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'curva-browser__btn'
    b.textContent = 'Join ' + (r.slug || '(unnamed)')
    b.addEventListener('click', () => onJoin(String(r.slug), false))
    roomRow.appendChild(b)

    // Tier 4: STADIUM badge for public spectator rooms.
    // textContent only — visibility field from backend is controlled data
    // but we still guard it through the exact-match check below.
    if (r.visibility === 'public') {
      const badge = document.createElement('span')
      badge.className = 'curva-browser__badge curva-browser__badge--stadium'
      badge.textContent = 'STADIUM'
      badge.title = 'Public spectator room. Anyone can watch; invited peers can chat.'
      roomRow.appendChild(badge)
    }

    actions.appendChild(roomRow)
  }

  li.appendChild(head)
  li.appendChild(meta)
  li.appendChild(actions)
  return li
}

// Wave 17 v3: single-room card. Room is the first-class entity; match data
// only decorates it when present. All string inputs pass through textContent
// (XSS-safe) — slug/hostHandle/team names come from the backend but they're
// still peer-supplied at creation time so no innerHTML anywhere.
function renderRoomCard(room, match, onJoin, liveCount) {
  const li = document.createElement('li')
  li.className = 'curva-browser__card curva-browser__card--room'

  const head = document.createElement('div')
  head.className = 'curva-browser__card-head'

  // Title = room slug. When the backend gains a `title` field we swap in
  // room.title || room.slug.
  const titleEl = document.createElement('span')
  titleEl.className = 'curva-browser__room-title'
  titleEl.textContent = room.slug || '(unnamed room)'

  const badge = document.createElement('span')
  badge.className = 'curva-browser__badge curva-browser__badge--stadium'
  badge.textContent = room.visibility === 'public' ? 'STADIUM' : 'PRIVATE'
  badge.title = room.visibility === 'public'
    ? 'Public room in the STADIUM directory. Any peer with the Curva app can discover and join.'
    : 'Private room. Only peers with the slug can join.'
  if (room.visibility !== 'public') {
    badge.classList.add('curva-browser__badge--private')
  }

  head.appendChild(titleEl)
  head.appendChild(badge)

  // Sub-line: host handle + optional match/kickoff.
  const meta = document.createElement('div')
  meta.className = 'curva-browser__card-meta'
  const metaParts = []
  if (room.hostHandle) metaParts.push('host: ' + String(room.hostHandle))
  const home = match ? teamName(match.homeTeam) : null
  const away = match ? teamName(match.awayTeam) : null
  if (match && home && away && !(home === 'TBD' && away === 'TBD')) {
    metaParts.push(home + ' vs ' + away)
    metaParts.push(statusLabel(match.status))
    const k = kickoffLine(match)
    if (k) metaParts.push(k)
  }
  if (typeof liveCount === 'number') {
    metaParts.push(liveCount + ' peers on DHT (live)')
  } else if (Number(room.peerCount) > 0) {
    metaParts.push(room.peerCount + ' fans watching')
  }
  meta.textContent = metaParts.join(' • ')

  const actions = document.createElement('div')
  actions.className = 'curva-browser__card-actions'

  const joinBtn = document.createElement('button')
  joinBtn.type = 'button'
  joinBtn.className = 'curva-browser__btn curva-browser__btn--primary curva-browser__btn--join'
  joinBtn.textContent = 'Join room'
  joinBtn.addEventListener('click', () => onJoin(String(room.slug), false))
  actions.appendChild(joinBtn)

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

// Live-input variant used by the "Create room" form. Preserves leading and
// trailing dashes so the user can type `wc26-final` one character at a time;
// the full sanitizeSlug + isValidSlug run on submit. Mirrored in
// roomBrowserHelpers.cjs.js so brittle tests bind to the same regex.
function sanitizeSlugSoft(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64)
}

// Mirror of backend/src/utils/curvaValidators.ts SLUG_RE. Length 4-32.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{2,30})[a-z0-9]$/

function isValidSlug(input) {
  if (typeof input !== 'string') return false
  if (input.length < 4 || input.length > 32) return false
  return SLUG_RE.test(input)
}

function slugify(input) {
  return sanitizeSlug(input)
}

// Note: pure helpers (sanitizeSlug, isValidSlug, statusLabel, kickoffLine,
// nameToFlag, iso2Flag, FLAG_ISO2) are duplicated in ./roomBrowserHelpers.cjs.js
// so brittle tests can require() them without an ESM/CJS interop dance. Any
// change here MUST be mirrored in that file.
