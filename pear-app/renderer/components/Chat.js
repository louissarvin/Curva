// Curva Chat: message list + input row. Vanilla ES module (ADR-001).
//
// Security discipline:
//   - Every peer-supplied string (text, by_peer, handle) is inserted via
//     .textContent. NEVER innerHTML. This is the primary XSS guard because
//     peer messages are fully untrusted. Translated strings are treated with
//     the same discipline — the QVAC model output is arbitrary text.
//   - Character count is enforced at input time (280 hard cap) and again at
//     the reducer side.
//
// Goal cluster: onGoalCluster arrives with a messageIds array. Each id maps
// to the Hyperbee key we stashed on the DOM row; we highlight matches with a
// red glow.
//
// Phase 3.5: QVAC translation cameo. Opt-in per-user via the "Read as:" picker
// at the top. When a language is chosen we call curva.initTranslation and, as
// translations stream in via curva.onChatTranslated, we render them below the
// original in a lighter shade. Translation NEVER blocks message rendering.

const MAX_CHARS = 280
const MAX_SEARCH_QUERY = 500
const MAX_INDEX_TEXT = 4000
const LANG_LABELS = {
  en: { flag: 'EN', name: 'English' },
  it: { flag: 'IT', name: 'Italiano' },
  id: { flag: 'ID', name: 'Bahasa' }
}

export function mountChat({ container, curva, tier = 'writer' } = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva bridge is required')

  container.textContent = ''
  container.classList.add('curva-chat')

  const header = document.createElement('div')
  header.className = 'curva-chat__header'
  const title = document.createElement('span')
  title.className = 'curva-chat__title'
  title.textContent = 'chat'
  const count = document.createElement('span')
  count.className = 'curva-chat__count'
  count.textContent = '0 msgs'

  // F1: history scrubber toggle button
  const historyToggleBtn = document.createElement('button')
  historyToggleBtn.type = 'button'
  historyToggleBtn.className = 'curva-chat__header-btn'
  historyToggleBtn.title = 'Browse history'
  historyToggleBtn.setAttribute('aria-label', 'Toggle history scrubber')
  historyToggleBtn.textContent = 'hist'

  // F4: semantic search toggle button
  const searchToggleBtn = document.createElement('button')
  searchToggleBtn.type = 'button'
  searchToggleBtn.className = 'curva-chat__header-btn'
  searchToggleBtn.title = 'Semantic search'
  searchToggleBtn.setAttribute('aria-label', 'Toggle semantic search')
  searchToggleBtn.textContent = 'srch'

  header.appendChild(title)
  header.appendChild(count)
  header.appendChild(searchToggleBtn)
  header.appendChild(historyToggleBtn)

  // F1: History scrubber bar. Hidden until the user toggles it open.
  const scrubberBar = document.createElement('div')
  scrubberBar.className = 'curva-chat__scrubber'
  scrubberBar.hidden = true

  const scrubberSlider = document.createElement('input')
  scrubberSlider.type = 'range'
  scrubberSlider.className = 'curva-chat__scrubber-slider'
  scrubberSlider.min = '0'
  scrubberSlider.max = '0'
  scrubberSlider.value = '0'
  scrubberSlider.setAttribute('aria-label', 'History position')

  const scrubberLabel = document.createElement('span')
  scrubberLabel.className = 'curva-chat__scrubber-label'
  scrubberLabel.textContent = ''

  const scrubberLiveBtn = document.createElement('button')
  scrubberLiveBtn.type = 'button'
  scrubberLiveBtn.className = 'curva-chat__scrubber-live'
  scrubberLiveBtn.textContent = 'live'

  scrubberBar.appendChild(scrubberSlider)
  scrubberBar.appendChild(scrubberLabel)
  scrubberBar.appendChild(scrubberLiveBtn)

  // F1: history-mode overlay banner on the message list
  const historyBanner = document.createElement('div')
  historyBanner.className = 'curva-chat__history-banner'
  historyBanner.hidden = true

  // F4: Semantic search bar. Hidden until user toggles open.
  const searchBar = document.createElement('div')
  searchBar.className = 'curva-chat__search-bar'
  searchBar.hidden = true

  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.className = 'curva-chat__search-input'
  searchInput.placeholder = 'Search chat semantically...'
  searchInput.maxLength = MAX_SEARCH_QUERY + 10
  searchInput.setAttribute('aria-label', 'Semantic search')

  const searchResults = document.createElement('ul')
  searchResults.className = 'curva-chat__search-results'
  searchResults.hidden = true

  searchBar.appendChild(searchInput)
  searchBar.appendChild(searchResults)

  // Phase 3.5: language picker + translation status banner.
  const translationBar = document.createElement('div')
  translationBar.className = 'curva-chat__translation'
  translationBar.hidden = false

  const readAs = document.createElement('span')
  readAs.className = 'curva-chat__translation-label'
  readAs.textContent = 'Read as:'
  translationBar.appendChild(readAs)

  const langButtons = {}
  for (const code of ['en', 'it', 'id']) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'curva-chat__lang'
    btn.dataset.lang = code
    btn.textContent = LANG_LABELS[code].flag + ' ' + LANG_LABELS[code].name
    btn.setAttribute('aria-pressed', 'false')
    btn.addEventListener('click', () => selectLang(code, { persist: true }))
    translationBar.appendChild(btn)
    langButtons[code] = btn
  }

  // Auto-pick language from a prior session or the OS locale, but do not
  // block chat rendering while translation init spins up. Order:
  //   1. localStorage `curva.userLang` (previous explicit choice)
  //   2. navigator.language, first 2 chars, allowlisted to en/it/id/es/pt/de/fr
  //      (we only kick off setLang for pairs the app catalogues; en/it/id
  //      always land, others silently no-op until F10 lands more models).
  const AUTO_LANG_ALLOW = new Set(['en', 'it', 'id', 'es', 'pt', 'de', 'fr'])
  const SUPPORTED_UI_LANGS = new Set(['en', 'it', 'id'])
  function pickInitialLang() {
    try {
      const saved = localStorage.getItem('curva.userLang')
      if (saved && SUPPORTED_UI_LANGS.has(saved)) return saved
    } catch { /* localStorage disabled/private mode */ }
    try {
      const raw = typeof navigator !== 'undefined' ? navigator.language : ''
      if (typeof raw === 'string') {
        const code = raw.slice(0, 2).toLowerCase()
        if (AUTO_LANG_ALLOW.has(code) && SUPPORTED_UI_LANGS.has(code)) return code
      }
    } catch { /* noop */ }
    return null
  }
  // Defer so we do not race with the initial render pass.
  setTimeout(() => {
    const initial = pickInitialLang()
    if (initial) selectLang(initial, { persist: false })
  }, 0)

  const originalToggle = document.createElement('button')
  originalToggle.type = 'button'
  originalToggle.className = 'curva-chat__original-toggle'
  originalToggle.textContent = 'Hide originals'
  originalToggle.title = 'Toggle showing the original message text'
  originalToggle.hidden = true
  translationBar.appendChild(originalToggle)

  const translationStatus = document.createElement('div')
  translationStatus.className = 'curva-chat__translation-status'
  translationStatus.hidden = true

  const list = document.createElement('ul')
  list.className = 'curva-chat__list'

  const form = document.createElement('form')
  form.className = 'curva-chat__form'

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'curva-chat__input'
  input.placeholder = 'say something (<= 280)'
  input.maxLength = MAX_CHARS + 20 // give a bit of overflow room; sanitizer will trim
  input.autocomplete = 'off'

  const charCount = document.createElement('span')
  charCount.className = 'curva-chat__charcount'
  charCount.textContent = '0 / ' + MAX_CHARS

  const sendBtn = document.createElement('button')
  sendBtn.type = 'submit'
  sendBtn.className = 'curva-chat__send'
  sendBtn.textContent = 'send'

  form.appendChild(input)
  form.appendChild(charCount)
  form.appendChild(sendBtn)

  // Tier 4: reader-tier gate. Keep the form in the DOM (hidden) so a host
  // upgrade can reveal it without a re-mount. The note is textContent-only.
  if (tier === 'reader') {
    form.hidden = true
  }
  const readerNote = document.createElement('div')
  readerNote.className = 'curva-chat__reader-note'
  readerNote.hidden = tier !== 'reader'
  readerNote.textContent = 'Spectator view. Chat is invite-only.'

  container.appendChild(header)
  // F6 room-search bar. Distinct from F4 semSearch (which searches VLM clip
  // captions). This bar hits bare/roomSearch.js which indexes the room's own
  // applied chat log via QVAC RAG. The bar is hidden entirely when the
  // roomSearch feature flag is off; feature-flag probe fires once at mount.
  const roomSearchBar = document.createElement('div')
  roomSearchBar.className = 'curva-chat__room-search'
  const roomSearchIcon = document.createElement('span')
  roomSearchIcon.className = 'curva-chat__room-search-icon'
  roomSearchIcon.setAttribute('aria-hidden', 'true')
  roomSearchIcon.textContent = 'q' // magnifying-glass glyph substitute; CSS renders visual
  const roomSearchInput = document.createElement('input')
  roomSearchInput.type = 'search'
  roomSearchInput.className = 'curva-chat__room-search-input'
  roomSearchInput.placeholder = 'Search chat...'
  roomSearchInput.maxLength = 500
  roomSearchInput.setAttribute('aria-label', 'Semantic room chat search')
  const roomSearchOverlay = document.createElement('ul')
  roomSearchOverlay.className = 'curva-chat__room-search-results'
  roomSearchOverlay.hidden = true
  roomSearchBar.appendChild(roomSearchIcon)
  roomSearchBar.appendChild(roomSearchInput)
  roomSearchBar.appendChild(roomSearchOverlay)
  // Hidden by default until we know the feature flag state; probe async.
  roomSearchBar.hidden = true
  container.appendChild(roomSearchBar)
  container.appendChild(scrubberBar)
  container.appendChild(searchBar)
  container.appendChild(translationBar)
  container.appendChild(translationStatus)
  container.appendChild(historyBanner)
  container.appendChild(list)
  container.appendChild(form)
  container.appendChild(readerNote)

  // -- track state ----------------------------------------------------------

  // Map from stable key (wall_clock_ms + '/' + by_peer.slice(0,8)) to <li>.
  const rowsByKey = new Map()
  // Translation-specific state.
  const translationsByKey = new Map() // key -> { translatedText, sourceLang }
  let userLang = null // null = translations off
  let showOriginals = true
  let msgCount = 0

  let autoScroll = true
  list.addEventListener('scroll', () => {
    const nearBottom = list.scrollHeight - (list.scrollTop + list.clientHeight) < 40
    autoScroll = nearBottom
  })

  // F1: scrubber state
  let scrubberOpen = false
  let historyMode = false // true while viewing a past version
  let versionMarkers = [] // [{version, matchTimeMs}] sorted oldest -> newest
  let scrubDebounce = null

  function formatAgo(matchTimeMs) {
    if (typeof matchTimeMs !== 'number' || matchTimeMs <= 0) return ''
    const m = Math.floor(matchTimeMs / 60000)
    const s = Math.floor((matchTimeMs % 60000) / 1000)
    return m + ':' + String(s).padStart(2, '0')
  }

  function renderHistorySnapshot(messages) {
    // Clear DOM state while staying in history mode
    for (const key of rowsByKey.keys()) {
      rowsByKey.delete(key)
    }
    list.textContent = ''
    if (!Array.isArray(messages)) return
    for (const m of messages) {
      addMessage(m)
    }
  }

  function enterHistoryMode(version, matchTimeMs) {
    historyMode = true
    historyBanner.hidden = false
    historyBanner.textContent = 'Reading history · v' + version + (matchTimeMs > 0 ? ' · ' + formatAgo(matchTimeMs) : '')
    list.classList.add('curva-chat__list--history')
    if (typeof curva.chat?.historyAt === 'function') {
      curva.chat.historyAt({ from: 0, limit: 200, at: version })
        .then((result) => {
          const msgs = result?.messages || result || []
          renderHistorySnapshot(Array.isArray(msgs) ? msgs : [])
        })
        .catch(() => {})
    }
  }

  function exitHistoryMode() {
    historyMode = false
    historyBanner.hidden = true
    list.classList.remove('curva-chat__list--history')
    // Re-render from live historyCache
    for (const key of rowsByKey.keys()) rowsByKey.delete(key)
    list.textContent = ''
    msgCount = 0
    count.textContent = '0 msgs'
    for (const m of historyCache) addMessage(m)
    autoScroll = true
    list.scrollTop = list.scrollHeight
  }

  function openScrubber() {
    scrubberOpen = true
    scrubberBar.hidden = false
    historyToggleBtn.classList.add('curva-chat__header-btn--active')
    // Load version markers
    if (typeof curva.chat?.getVersions === 'function') {
      curva.chat.getVersions({ limit: 32 })
        .then((markers) => {
          if (!Array.isArray(markers) || markers.length === 0) return
          versionMarkers = markers
          scrubberSlider.min = '0'
          scrubberSlider.max = String(markers.length - 1)
          scrubberSlider.value = String(markers.length - 1)
          updateScrubberLabel(markers.length - 1)
        })
        .catch(() => {})
    }
  }

  function closeScrubber() {
    scrubberOpen = false
    scrubberBar.hidden = true
    historyToggleBtn.classList.remove('curva-chat__header-btn--active')
    if (historyMode) exitHistoryMode()
  }

  function updateScrubberLabel(idx) {
    const marker = versionMarkers[idx]
    if (!marker) { scrubberLabel.textContent = ''; return }
    scrubberLabel.textContent = 'v' + marker.version +
      (marker.matchTimeMs > 0 ? ' · ' + formatAgo(marker.matchTimeMs) : '')
  }

  historyToggleBtn.addEventListener('click', () => {
    if (scrubberOpen) closeScrubber()
    else openScrubber()
  })

  scrubberSlider.addEventListener('input', () => {
    const idx = Number(scrubberSlider.value)
    updateScrubberLabel(idx)
    if (scrubDebounce) clearTimeout(scrubDebounce)
    scrubDebounce = setTimeout(() => {
      const marker = versionMarkers[idx]
      if (!marker) return
      const isLast = idx === versionMarkers.length - 1
      if (isLast) {
        if (historyMode) exitHistoryMode()
      } else {
        enterHistoryMode(marker.version, marker.matchTimeMs || 0)
      }
    }, 300)
  })

  scrubberLiveBtn.addEventListener('click', () => {
    scrubberSlider.value = scrubberSlider.max
    if (versionMarkers.length > 0) updateScrubberLabel(versionMarkers.length - 1)
    if (historyMode) exitHistoryMode()
  })

  // Subscribe to new version markers (best-effort; older workers won't have this)
  if (typeof curva.chat?.onVersionMarker === 'function') {
    curva.chat.onVersionMarker((marker) => {
      if (!marker || typeof marker.version === 'undefined') return
      versionMarkers.push(marker)
      if (versionMarkers.length > 32) versionMarkers.shift()
      if (scrubberOpen && !historyMode) {
        const max = versionMarkers.length - 1
        scrubberSlider.max = String(max)
        scrubberSlider.value = String(max)
        updateScrubberLabel(max)
      }
    })
  }

  // F4: semantic search state
  let searchOpen = false
  let searchDebounce = null

  function openSearch() {
    searchOpen = true
    searchBar.hidden = false
    searchToggleBtn.classList.add('curva-chat__header-btn--active')
    searchInput.value = ''
    searchResults.hidden = true
    searchResults.textContent = ''
    setTimeout(() => searchInput.focus(), 0)
  }

  function closeSearch() {
    searchOpen = false
    searchBar.hidden = true
    searchToggleBtn.classList.remove('curva-chat__header-btn--active')
    searchResults.hidden = true
    searchResults.textContent = ''
  }

  function runSearch(query) {
    if (!query || query.length === 0) {
      searchResults.hidden = true
      searchResults.textContent = ''
      return
    }
    const safeQuery = query.slice(0, MAX_SEARCH_QUERY)
    if (typeof curva.semSearch?.search !== 'function') {
      searchResults.hidden = false
      searchResults.textContent = ''
      const noApi = document.createElement('li')
      noApi.className = 'curva-chat__search-empty'
      noApi.textContent = 'semantic search unavailable'
      searchResults.appendChild(noApi)
      return
    }
    curva.semSearch.search({ query: safeQuery, topK: 8 })
      .then((hits) => {
        searchResults.textContent = ''
        if (!Array.isArray(hits) || hits.length === 0) {
          searchResults.hidden = false
          const empty = document.createElement('li')
          empty.className = 'curva-chat__search-empty'
          empty.textContent = 'no matches — try a different phrase'
          searchResults.appendChild(empty)
          return
        }
        searchResults.hidden = false
        for (const hit of hits) {
          const id = typeof hit.id === 'string' ? hit.id : String(hit.id || '')
          const li = document.createElement('li')
          li.className = 'curva-chat__search-hit'

          const idEl = document.createElement('span')
          idEl.className = 'curva-chat__search-hit-id'
          // Show last 16 chars of id to fit narrow layout
          idEl.textContent = id.length > 16 ? '...' + id.slice(-16) : id

          const jumpBtn = document.createElement('button')
          jumpBtn.type = 'button'
          jumpBtn.className = 'curva-chat__search-jump'
          jumpBtn.textContent = 'jump'
          // Use a closure to capture the safe id string
          const safeId = id.slice(0, 200) // cap for safety
          jumpBtn.addEventListener('click', () => {
            // Scroll the matching row into view if still in the DOM
            const row = rowsByKey.get(safeId)
            if (row) {
              row.scrollIntoView({ behavior: 'smooth', block: 'center' })
              row.classList.add('curva-chat__msg--search-highlight')
              setTimeout(() => row.classList.remove('curva-chat__msg--search-highlight'), 1500)
            }
          })

          li.appendChild(idEl)
          li.appendChild(jumpBtn)
          searchResults.appendChild(li)
        }
      })
      .catch(() => {
        searchResults.textContent = ''
        searchResults.hidden = false
        const err = document.createElement('li')
        err.className = 'curva-chat__search-empty'
        err.textContent = 'search error — try again'
        searchResults.appendChild(err)
      })
  }

  searchToggleBtn.addEventListener('click', () => {
    if (searchOpen) closeSearch()
    else openSearch()
  })

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSearch(); return }
    if (e.key === 'Enter') {
      if (searchDebounce) clearTimeout(searchDebounce)
      runSearch(searchInput.value.trim())
    }
  })

  searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      runSearch(searchInput.value.trim())
    }, 400)
  })

  // -- F6 room-search wiring -----------------------------------------------
  // Distinct from F4 semSearch. Uses curva.roomSearch which searches the
  // room's own applied chat log via QVAC RAG. Feature-flag probe hides the
  // bar entirely when disabled.
  let roomSearchDebounce = null
  function runRoomSearch(rawQuery) {
    const q = typeof rawQuery === 'string' ? rawQuery.trim() : ''
    if (q.length === 0) {
      roomSearchOverlay.hidden = true
      roomSearchOverlay.textContent = ''
      return
    }
    if (!curva.roomSearch || typeof curva.roomSearch.search !== 'function') {
      roomSearchOverlay.hidden = false
      roomSearchOverlay.textContent = ''
      const na = document.createElement('li')
      na.className = 'curva-chat__room-search-empty'
      na.textContent = 'room search unavailable'
      roomSearchOverlay.appendChild(na)
      return
    }
    const capped = q.slice(0, 500)
    curva.roomSearch.search({ query: capped, k: 10 }).then((res) => {
      const hits = Array.isArray(res?.hits) ? res.hits : (Array.isArray(res) ? res : [])
      roomSearchOverlay.textContent = ''
      roomSearchOverlay.hidden = false
      if (hits.length === 0) {
        const empty = document.createElement('li')
        empty.className = 'curva-chat__room-search-empty'
        empty.textContent = 'No matches'
        roomSearchOverlay.appendChild(empty)
        return
      }
      for (const hit of hits) {
        const li = document.createElement('li')
        li.className = 'curva-chat__room-search-hit'
        const authorEl = document.createElement('span')
        authorEl.className = 'curva-chat__room-search-hit-author'
        // textContent-only: every field is untrusted peer input
        const authorRaw = typeof hit.author === 'string' ? hit.author : ''
        authorEl.textContent = authorRaw
          ? (authorRaw.length > 12 ? authorRaw.slice(0, 12) : authorRaw)
          : 'anon'
        const snippetEl = document.createElement('span')
        snippetEl.className = 'curva-chat__room-search-hit-snippet'
        snippetEl.textContent = typeof hit.snippet === 'string' ? hit.snippet.slice(0, 200) : ''
        const timeEl = document.createElement('span')
        timeEl.className = 'curva-chat__room-search-hit-time'
        if (typeof hit.at === 'number' && Number.isFinite(hit.at) && hit.at > 0) {
          const deltaMs = Date.now() - hit.at
          timeEl.textContent = formatRelTime(deltaMs)
        } else {
          timeEl.textContent = ''
        }
        li.appendChild(authorEl)
        li.appendChild(snippetEl)
        li.appendChild(timeEl)
        // Jump-to-message on click.
        const targetMsgId = typeof hit.msgId === 'string' ? hit.msgId : ''
        li.addEventListener('click', () => {
          // targetMsgId is `<wallClockMs>-<peerHex>` from workers/main.js. The
          // chat rows are keyed as `${wall_clock_ms}/${by_peer.slice(0,8)}`.
          // Translate one to the other and scroll the row.
          const dashIdx = targetMsgId.lastIndexOf('-')
          if (dashIdx <= 0) return
          const wallMs = targetMsgId.slice(0, dashIdx)
          const peer = targetMsgId.slice(dashIdx + 1)
          const rowKey = wallMs + '/' + peer
          const row = rowsByKey.get(rowKey)
          if (row) {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' })
            row.classList.add('curva-chat__msg--room-search-highlight')
            setTimeout(() => {
              row.classList.remove('curva-chat__msg--room-search-highlight')
            }, 1500)
          }
        })
        roomSearchOverlay.appendChild(li)
      }
    }).catch(() => {
      roomSearchOverlay.textContent = ''
      roomSearchOverlay.hidden = false
      const err = document.createElement('li')
      err.className = 'curva-chat__room-search-empty'
      err.textContent = 'search error'
      roomSearchOverlay.appendChild(err)
    })
  }

  function formatRelTime(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return ''
    if (deltaMs < 60_000) return 'just now'
    if (deltaMs < 3_600_000) return Math.floor(deltaMs / 60_000) + 'm ago'
    if (deltaMs < 86_400_000) return Math.floor(deltaMs / 3_600_000) + 'h ago'
    return Math.floor(deltaMs / 86_400_000) + 'd ago'
  }

  roomSearchInput.addEventListener('input', () => {
    const v = roomSearchInput.value
    if (roomSearchDebounce) clearTimeout(roomSearchDebounce)
    if (!v || v.trim().length === 0) {
      roomSearchOverlay.hidden = true
      roomSearchOverlay.textContent = ''
      return
    }
    roomSearchDebounce = setTimeout(() => runRoomSearch(v), 250)
  })
  roomSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      roomSearchInput.value = ''
      roomSearchOverlay.hidden = true
      roomSearchOverlay.textContent = ''
      return
    }
    if (e.key === 'Enter') {
      if (roomSearchDebounce) clearTimeout(roomSearchDebounce)
      runRoomSearch(roomSearchInput.value)
    }
  })

  // Feature-flag probe: only reveal the bar if the worker reports enabled.
  if (curva.roomSearch && typeof curva.roomSearch.status === 'function') {
    curva.roomSearch.status().then((st) => {
      if (st && st.enabled) roomSearchBar.hidden = false
    }).catch(() => { /* stay hidden */ })
  }

  input.addEventListener('input', () => {
    const len = Math.min(input.value.length, MAX_CHARS)
    charCount.textContent = `${len} / ${MAX_CHARS}`
    if (input.value.length > MAX_CHARS) {
      charCount.classList.add('curva-chat__charcount--over')
    } else {
      charCount.classList.remove('curva-chat__charcount--over')
    }
  })

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const text = input.value.slice(0, MAX_CHARS).trim()
    if (text.length === 0) return
    input.value = ''
    charCount.textContent = '0 / ' + MAX_CHARS
    charCount.classList.remove('curva-chat__charcount--over')
    // matchTimeMs is 0 here; VideoPlayer emits its own; the chat send just
    // records what the sender's local video was at. Renderer app.js can wire
    // in a real match_time_ms if it wants to (Phase 2 polish).
    // Phase 3.5: DO NOT tag the message with userLang. userLang is what the
    // reader wants translations rendered IN, not what the sender is typing.
    // Passing it as source_lang made every message the user typed after
    // clicking "READ AS: IT" get labelled `source_lang: 'it'` — Bergamot
    // then tried IT->x on plain English text and produced garbage
    // ("what's your name" -> "hello" and similar). Omitting the field
    // means peers fall back to the 'en' default, which matches the
    // reality that most demo chat is typed in English. A future write-in
    // language picker can populate source_lang explicitly.
    curva.sendChat(text, 0).catch((err) => {
      console.warn('[curva] sendChat failed:', err?.message)
    })
  })

  function keyForMessage(msg) {
    return `${msg.wall_clock_ms}/${(msg.by_peer || '').slice(0, 8)}`
  }

  function selectLang(code, { persist = true } = {}) {
    if (!LANG_LABELS[code]) return
    userLang = code
    if (persist) {
      try { localStorage.setItem('curva.userLang', code) } catch { /* noop */ }
    }
    for (const [k, btn] of Object.entries(langButtons)) {
      const active = k === code
      btn.classList.toggle('curva-chat__lang--active', active)
      btn.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
    originalToggle.hidden = false
    setTranslationStatus('Loading translation model...', 'info')
    // Both calls are best-effort; UI just waits for events.
    if (typeof curva.setUserLanguage === 'function') {
      curva.setUserLanguage(code).catch(() => {})
    }
    if (typeof curva.initTranslation === 'function') {
      curva.initTranslation({ targetLang: code }).catch((err) => {
        setTranslationStatus('Translation unavailable: ' + err.message, 'error')
      })
    }
    // T8: bulk-translate any already-loaded history into the new target.
    // The scheduler cancels prior passes via bulkTranslateSeq, so a rapid
    // language switch does not backlog.
    scheduleBulkTranslate(code)
  }

  function setTranslationStatus(text, kind) {
    translationStatus.hidden = false
    translationStatus.textContent = text
    translationStatus.classList.remove('curva-chat__translation-status--error', 'curva-chat__translation-status--ok', 'curva-chat__translation-status--info')
    if (kind) translationStatus.classList.add('curva-chat__translation-status--' + kind)
  }

  originalToggle.addEventListener('click', () => {
    showOriginals = !showOriginals
    originalToggle.textContent = showOriginals ? 'Hide originals' : 'Show originals'
    for (const li of rowsByKey.values()) {
      const orig = li.querySelector('.curva-chat__body')
      if (orig) orig.hidden = !showOriginals && li.querySelector('.curva-chat__translation-body')
    }
  })

  function applyTranslationToRow(key) {
    const li = rowsByKey.get(key)
    const entry = translationsByKey.get(key)
    if (!li || !entry) return
    let translationEl = li.querySelector('.curva-chat__translation-body')
    if (!translationEl) {
      translationEl = document.createElement('div')
      translationEl.className = 'curva-chat__translation-body'
      const label = document.createElement('span')
      label.className = 'curva-chat__translation-label-inline'
      const from = LANG_LABELS[entry.sourceLang]?.name || entry.sourceLang
      const engineLabel = entry.engine === 'qwen3'
        ? 'Qwen3 0.6B'
        : (entry.engine === 'bergamot' ? 'Bergamot NMT' : 'QVAC')
      label.textContent = 'translated from ' + from + ' (on-device, ' + engineLabel + ')'
      const body = document.createElement('div')
      body.className = 'curva-chat__translation-text'
      body.textContent = entry.translatedText // textContent: XSS-safe
      translationEl.appendChild(label)
      translationEl.appendChild(body)
      li.appendChild(translationEl)
    } else {
      const body = translationEl.querySelector('.curva-chat__translation-text')
      if (body) body.textContent = entry.translatedText
    }
    if (!showOriginals) {
      const orig = li.querySelector('.curva-chat__body')
      if (orig) orig.hidden = true
    }
  }

  function addMessage(msg) {
    const key = keyForMessage(msg)
    if (rowsByKey.has(key)) return
    // Track in history cache for future bulk-translate. Cap so a long-running
    // session does not grow unbounded (300 matches the DOM cap below).
    if (msg && typeof msg === 'object' && msg.text) {
      historyCache.push(msg)
      if (historyCache.length > 300) historyCache.shift()
    }

    // F4: index new messages for semantic search. Best-effort; no throw.
    // Only index regular chat text and commentary-style messages with text.
    // id is the Hyperbee key (chatKey) when present, else keyForMessage().
    if (msg && typeof msg.text === 'string' && msg.text.length > 0
        && typeof curva.semSearch?.index === 'function') {
      const indexId = (typeof msg.chatKey === 'string' && msg.chatKey.length > 0)
        ? msg.chatKey
        : key
      const indexText = msg.text.slice(0, MAX_INDEX_TEXT)
      curva.semSearch.index({ id: indexId, text: indexText }).catch(() => {})
    }

    // QVAC Ship 3 F3: `system:match-recap`. Post-match summary pill with
    // per-locale Play buttons. Every peer-authored/LLM-produced string goes
    // through textContent — recap text is model output and untrusted.
    if (msg?.type === 'system:match-recap') {
      const li = renderSystemMatchRecap(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // F2: system:goal-card — AI-parsed goal event. Gold border-left pill.
    // All fields via textContent — model output is untrusted (defense in depth).
    if (msg?.type === 'system:goal-card') {
      const li = renderSystemGoalCard(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // Task 6: system:tip messages render with a distinct style, currency
    // marker, and a clickable Sepolia link (opened via curva.openExternal
    // so the URL is allowlisted on both sides). textContent everywhere.
    if (msg?.type === 'system:tip') {
      const li = renderSystemTip(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // Wave 6 T14: system:tip-ack renders next to the corresponding tip row
    // as a "verified by host" badge. The signature is embedded via a
    // data-verify attribute so any devtools user can ecrecover locally.
    if (msg?.type === 'system:tip-ack') {
      const li = renderSystemTipAck(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // Tier 4: system:tip-batch — one UserOp, N Transfer events.
    // Success pill: "<handle> tipped N hosts (X USDT total) · tx <link>".
    // textContent everywhere — all peer/backend data is untrusted.
    if (msg?.type === 'system:tip-batch') {
      const li = renderSystemTipBatch(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // Wave 11: prediction-pool lifecycle rows. Three system messages, each
    // rendered as a distinct pill: neutral (open), emphasized (result), green
    // (payout). All fields are textContent — pool addresses and tx hashes are
    // untrusted despite the host-only Autobase gate (defense in depth).
    if (msg?.type === 'system:pool-opened') {
      const li = renderSystemPoolOpened(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }
    if (msg?.type === 'system:match-result') {
      const li = renderSystemMatchResult(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }
    if (msg?.type === 'system:pool-payout') {
      const li = renderSystemPoolPayout(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // Tier 4 R2: system:bot-query renders as a gold-border pill showing the
    // peer's prompt. textContent only — prompt is peer-supplied and untrusted.
    if (msg?.type === 'system:bot-query') {
      const li = renderSystemBotQuery(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // Tier 4 R2: system:bot-reply renders as a mint-border pill with the LLM
    // response and tool-call badges. textContent only. Tool names validated
    // against /^[a-z_]+$/ before rendering. (CWE-79 guard.)
    if (msg?.type === 'system:bot-reply') {
      const li = renderSystemBotReply(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // Security audit fix (H4): Cup Final QVAC pills. system:coach is the
    // voice-controlled coach reply, system:vlm-caption is the SmolVLM2 frame
    // description, system:ocr-read is the extracted scoreboard/jersey text.
    // All three are host-only + peer-writer-allowed per bare/chat.js. All
    // text via textContent (LLM/VLM/OCR outputs are untrusted).
    if (msg?.type === 'system:coach'
        || msg?.type === 'system:vlm-caption'
        || msg?.type === 'system:ocr-read') {
      const li = renderSystemQvacPill(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // Wave 13A: QVAC LLM commentator pill. Distinct small-caps deep-red
    // border with an Italian-flag micro-emoji left of the text so users can
    // tell the line is AI-generated (not a peer message). textContent only —
    // the model output is arbitrary and untrusted. Attribution line clarifies
    // "AI commentator - on-device" so peers understand the provenance.
    if (msg?.type === 'system:commentary') {
      const li = renderSystemCommentary(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // Wave 14: system:attendance-issued renders as a subtle small-caps pill
    // "@<handle> is attending the curva". Not translated (event metadata, not
    // chat content). All fields via textContent — the pass carries public
    // ecrecover-verifiable bytes but the peer handle is still untrusted.
    if (msg?.type === 'system:attendance-issued') {
      const li = renderSystemAttendanceIssued(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // D2 prediction stake: gold pill "@handle staked N USDT on SIDE".
    // txHash validated against strict hex pattern before the link is built.
    if (msg?.type === 'system:prediction-stake') {
      const li = renderSystemPredictionStake(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // D2 prediction settle: green pill for winners, italic muted for losers.
    if (msg?.type === 'system:prediction-settle') {
      const li = renderSystemPredictionSettle(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // F3 goal pill: gold left-border row with minute, scorer, and score.
    if (msg?.type === 'system:goal') {
      const li = renderSystemGoal(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // Tier 4: system:reader-joined renders as a subtle grey info pill.
    // textContent only — handle is peer-supplied and untrusted.
    if (msg?.type === 'system:reader-joined') {
      const li = renderSystemReaderJoined(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    // Wave 6 T4: system:tip-congrats rendered as a small-caps gold-tinted
    // banner. No explorer link (the paired system:tip already carries one).
    // The translated variant lands via applyTranslationToRow if the viewer
    // has picked a target language.
    if (msg?.type === 'system:tip-congrats') {
      const li = renderSystemTipCongrats(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      if (translationsByKey.has(key)) applyTranslationToRow(key)
      return
    }

    // Ship 3 F7: system:highlight — auto-detected match event pill (red card,
    // yellow card, corner, substitution). Colored variant class per kind.
    // ALL fields via textContent — model output is untrusted.
    if (msg?.type === 'system:highlight') {
      const li = renderSystemHighlight(msg, key)
      list.appendChild(li)
      rowsByKey.set(key, li)
      msgCount++
      count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')
      while (list.children.length > 300) {
        const first = list.firstChild
        if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
        list.removeChild(first)
      }
      if (autoScroll) list.scrollTop = list.scrollHeight
      return
    }

    const li = document.createElement('li')
    li.className = 'curva-chat__msg'
    li.dataset.key = key

    const meta = document.createElement('div')
    meta.className = 'curva-chat__meta'
    const handleEl = document.createElement('span')
    handleEl.className = 'curva-chat__handle'
    handleEl.textContent = msg.handle || short(msg.by_peer) // may be undefined; safe
    const timeEl = document.createElement('span')
    timeEl.className = 'curva-chat__time'
    timeEl.textContent = formatMatchTime(msg.match_time_ms)
    meta.appendChild(handleEl)
    meta.appendChild(renderIdentityBadge(msg))
    meta.appendChild(timeEl)

    const bodyEl = document.createElement('div')
    bodyEl.className = 'curva-chat__body'
    // textContent, NEVER innerHTML. Peer-supplied text is untrusted.
    bodyEl.textContent = msg.text || ''

    // Dim body if identity proof is present but verification failed.
    if (msg.identity_verified === false) {
      li.classList.add('curva-chat__msg--identity-mismatch')
    }

    li.appendChild(meta)
    li.appendChild(bodyEl)
    list.appendChild(li)
    rowsByKey.set(key, li)

    msgCount++
    count.textContent = msgCount + ' msg' + (msgCount === 1 ? '' : 's')

    // Cap to last 300 rendered messages to keep the DOM small.
    while (list.children.length > 300) {
      const first = list.firstChild
      if (first?.dataset?.key) rowsByKey.delete(first.dataset.key)
      list.removeChild(first)
    }

    if (autoScroll) list.scrollTop = list.scrollHeight

    // If a translation for this key already arrived before the message
    // event (rare but possible), attach it now.
    if (translationsByKey.has(key)) applyTranslationToRow(key)
  }

  function renderSystemTip(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--tip'
    li.dataset.key = key

    const marker = document.createElement('span')
    marker.className = 'curva-chat__tip-marker'
    marker.textContent = '$'

    const body = document.createElement('div')
    body.className = 'curva-chat__tip-body'

    const from = document.createElement('span')
    from.className = 'curva-chat__handle'
    from.textContent = (typeof msg.from_handle === 'string' && msg.from_handle.length > 0)
      ? msg.from_handle
      : short(msg.by_peer)

    const label = document.createElement('span')
    label.className = 'curva-chat__tip-label'
    const amt = formatAmountBaseUnits(msg.amount)
    label.textContent = ' tipped ' + amt + ' USDT to host'

    body.appendChild(from)
    body.appendChild(renderIdentityBadge(msg))
    body.appendChild(label)

    // Explorer link. Only render if URL is present, https, and openExternal
    // is available; otherwise render as plain text.
    if (typeof msg.explorer_url === 'string' && /^https:\/\//.test(msg.explorer_url)) {
      const link = document.createElement('a')
      link.className = 'curva-chat__tip-link'
      link.href = '#'
      link.textContent = 'view tx'
      link.addEventListener('click', (e) => {
        e.preventDefault()
        if (typeof curva.openExternal === 'function') {
          curva.openExternal(msg.explorer_url).catch(() => { /* noop */ })
        }
      })
      body.appendChild(link)
    }

    li.appendChild(marker)
    li.appendChild(body)
    return li
  }

  function renderSystemTipAck(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--ack'
    li.dataset.key = key
    // T14: signature is not sensitive; expose it so any tester can ecrecover
    // offline. Signer address included as a separate attribute for clarity.
    li.dataset.verify = msg.signature || ''
    li.dataset.signer = msg.signer || ''
    li.dataset.tx = msg.tx_hash || ''

    const badge = document.createElement('span')
    badge.className = 'curva-chat__ack-badge'
    badge.textContent = '✓ verified by host'
    badge.title = 'signer ' + (msg.signer || '?') + ' • tx ' + (msg.tx_hash || '')

    const body = document.createElement('div')
    body.className = 'curva-chat__ack-body'
    body.textContent = 'tip ' + (msg.tx_hash ? msg.tx_hash.slice(0, 12) + '…' : '') + ' receipt signed'

    li.appendChild(badge)
    li.appendChild(body)
    return li
  }

  // Wave 11 render helpers. Each row is a single <li> so DOM cleanup
  // (rowsByKey delete + list child cap) works uniformly.
  function renderSystemPoolOpened(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--pool-open'
    li.dataset.key = key
    const marker = document.createElement('span')
    marker.className = 'curva-chat__pool-marker'
    marker.textContent = '◆'
    const body = document.createElement('div')
    body.className = 'curva-chat__pool-body'
    const stake = formatAmountBaseUnits(msg.entryStakeAtomic)
    const deadline = new Date(Number(msg.deadlineMs) || 0)
    const hh = String(deadline.getHours()).padStart(2, '0')
    const mm = String(deadline.getMinutes()).padStart(2, '0')
    body.textContent = `Pool open · ${stake} USDT entry · closes ${hh}:${mm}`
    li.appendChild(marker)
    li.appendChild(body)
    return li
  }

  function renderSystemMatchResult(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--match-result'
    li.dataset.key = key
    const marker = document.createElement('span')
    marker.className = 'curva-chat__result-marker'
    marker.textContent = '⚑'
    const body = document.createElement('div')
    body.className = 'curva-chat__result-body'
    const winner = ['HOME', 'AWAY', 'DRAW'].includes(msg.winner) ? msg.winner : '?'
    body.textContent = `Match ended ${msg.homeGoals ?? '?'}-${msg.awayGoals ?? '?'} (${winner})`
    li.appendChild(marker)
    li.appendChild(body)
    return li
  }

  function renderSystemPoolPayout(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--pool-payout'
    li.dataset.key = key
    const marker = document.createElement('span')
    marker.className = 'curva-chat__payout-marker'
    marker.textContent = '✦'
    const body = document.createElement('div')
    body.className = 'curva-chat__payout-body'
    const amt = formatAmountBaseUnits(msg.amountAtomic)
    const shortAddr = typeof msg.toAddress === 'string'
      ? msg.toAddress.slice(0, 6) + '…' + msg.toAddress.slice(-4)
      : '?'
    body.textContent = `Payout ${amt} USDT → ${shortAddr}`
    if (typeof msg.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(msg.txHash)) {
      const link = document.createElement('a')
      link.className = 'curva-chat__payout-link'
      link.href = '#'
      link.textContent = ' tx'
      link.addEventListener('click', (e) => {
        e.preventDefault()
        if (typeof curva.openExternal === 'function') {
          curva.openExternal('https://sepolia.etherscan.io/tx/' + msg.txHash).catch(() => { /* noop */ })
        }
      })
      body.appendChild(link)
    }
    li.appendChild(marker)
    li.appendChild(body)
    return li
  }

  // Wave 13A: `system:commentary` renderer. Small-caps AI pill with an
  // Italian-flag micro-emoji so viewers instantly know it is AI-generated.
  // All text is set via textContent — the LLM output is untrusted.
  // Cup Final: shared renderer for system:coach / system:vlm-caption /
  // system:ocr-read pills. All three follow the commentary discipline:
  // textContent-only, marker + body + attribution, distinct class so styles.css
  // can theme each colour differently. Content is model-generated, treat as
  // fully untrusted.
  function renderSystemQvacPill(msg, key) {
    const type = String(msg?.type || '')
    const cfg = type === 'system:coach' ? {
      cls: 'curva-chat__msg--coach',
      marker: '🎧',
      attribution: 'voice coach · on-device'
    } : type === 'system:vlm-caption' ? {
      cls: 'curva-chat__msg--vlm',
      marker: '📸',
      attribution: 'frame caption · SmolVLM2 on-device'
    } : {
      cls: 'curva-chat__msg--ocr',
      marker: '🔍',
      attribution: 'OCR · on-device'
    }
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system ' + cfg.cls
    li.dataset.key = key

    const marker = document.createElement('span')
    marker.className = 'curva-chat__commentary-marker'
    marker.textContent = cfg.marker

    const body = document.createElement('div')
    body.className = 'curva-chat__commentary-body curva-chat__body'
    // Cap length defensively; the bare validators already cap 500-800 chars.
    body.textContent = String(msg?.text || '').slice(0, 1000)

    const attribution = document.createElement('div')
    attribution.className = 'curva-chat__commentary-attribution'
    attribution.textContent = cfg.attribution

    li.appendChild(marker)
    li.appendChild(body)
    li.appendChild(attribution)
    return li
  }

  // QVAC Ship 3 F3: `system:match-recap` renderer.
  // Pill styling matches the existing system-message pattern. Renders recap
  // text + one small "Play" button per locale. Playback pulls the blob via
  // the existing curva.clips.getClip bridge (falls back to a no-op when the
  // bridge is absent — older previews). All strings via textContent since
  // recap text is Qwen3 output and translated bodies are Bergamot output;
  // both are untrusted per Curva's Cup Final security posture.
  function renderSystemMatchRecap (msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--match-recap'
    li.dataset.key = key

    const inner = document.createElement('div')
    inner.className = 'curva-chat__match-recap-inner'

    const tag = document.createElement('span')
    tag.className = 'curva-chat__match-recap-tag'
    tag.textContent = 'RECAP'
    inner.appendChild(tag)

    const body = document.createElement('div')
    body.className = 'curva-chat__match-recap-body'
    body.textContent = typeof msg.recapText === 'string'
      ? msg.recapText.slice(0, 800)
      : ''
    inner.appendChild(body)

    const audio = (msg.audioByLocale && typeof msg.audioByLocale === 'object')
      ? msg.audioByLocale : {}
    const localeKeys = Object.keys(audio).slice(0, 8)
    if (localeKeys.length > 0) {
      const playRow = document.createElement('div')
      playRow.className = 'curva-chat__match-recap-play-row'
      for (const locale of localeKeys) {
        const entry = audio[locale] || {}
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'curva-chat__match-recap-play'
        btn.textContent = 'Play ' + String(locale).slice(0, 4).toUpperCase()
        // Only expose a working button if we actually have a blobKey.
        if (typeof entry.blobKey !== 'string' || entry.blobKey.length === 0) {
          btn.disabled = true
          btn.title = 'audio unavailable'
        } else {
          btn.addEventListener('click', async () => {
            btn.disabled = true
            const orig = btn.textContent
            btn.textContent = 'Loading...'
            try {
              // blobKey shape: `<driveKey>:<path>`. Fall back to a no-op if
              // the getClip bridge is missing or the parse fails.
              const sep = entry.blobKey.indexOf(':')
              const driveKey = sep > 0 ? entry.blobKey.slice(0, sep) : null
              const path = sep > 0 ? entry.blobKey.slice(sep + 1) : null
              const clipsBridge = (typeof window !== 'undefined' && window.curva && window.curva.clips) || null
              if (driveKey && path && clipsBridge && typeof clipsBridge.getClip === 'function') {
                const bytes = await clipsBridge.getClip({ driveKey, path })
                if (bytes && bytes.byteLength > 0) {
                  const blob = new Blob([bytes], { type: 'application/octet-stream' })
                  const url = URL.createObjectURL(blob)
                  const audioEl = new Audio(url)
                  audioEl.addEventListener('ended', () => { URL.revokeObjectURL(url) })
                  await audioEl.play()
                }
              }
            } catch { /* silent — button is best-effort */ }
            btn.textContent = orig
            btn.disabled = false
          })
        }
        playRow.appendChild(btn)
      }
      inner.appendChild(playRow)
    }

    const attribution = document.createElement('div')
    attribution.className = 'curva-chat__commentary-attribution'
    attribution.textContent = 'match recap · on-device Qwen3 + Bergamot + Chatterbox'
    inner.appendChild(attribution)

    li.appendChild(inner)
    return li
  }

  // F2: `system:goal-card` renderer.
  // Bold gold border-left. Grid: minute (large mono red) · scorer · team.
  // Optional assist line. Attribution "AI parsed · on-device". "GOAL" tag top-right.
  // All fields via textContent — goalCard output is model-generated and untrusted.
  function renderSystemGoalCard(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--goal-card'
    li.dataset.key = key

    const inner = document.createElement('div')
    inner.className = 'curva-chat__goal-card-inner'

    // "GOAL" tag top-right
    const tag = document.createElement('span')
    tag.className = 'curva-chat__goal-card-tag'
    tag.textContent = 'GOAL'

    // Minute: large mono red
    const min = Number.isFinite(msg.minute) ? String(Math.floor(msg.minute)) + "'" : "?'"
    const minuteEl = document.createElement('span')
    minuteEl.className = 'curva-chat__goal-card-minute'
    minuteEl.textContent = min

    // Scorer: uppercase tracking
    const rawScorer = typeof msg.scorer === 'string' && msg.scorer.length > 0
      ? msg.scorer.toUpperCase().slice(0, 30) : 'GOAL'
    const scorerEl = document.createElement('span')
    scorerEl.className = 'curva-chat__goal-card-scorer'
    scorerEl.textContent = rawScorer

    // Team: small-caps muted
    const rawTeam = typeof msg.team === 'string' && msg.team.length > 0
      ? msg.team.slice(0, 30) : ''
    const teamEl = document.createElement('span')
    teamEl.className = 'curva-chat__goal-card-team'
    teamEl.textContent = rawTeam

    inner.appendChild(tag)
    inner.appendChild(minuteEl)
    inner.appendChild(scorerEl)
    inner.appendChild(teamEl)

    // Optional assist line
    if (typeof msg.assist === 'string' && msg.assist.length > 0) {
      const assistEl = document.createElement('div')
      assistEl.className = 'curva-chat__goal-card-assist'
      const assistLabel = document.createElement('span')
      assistLabel.className = 'curva-chat__goal-card-assist-label'
      assistLabel.textContent = 'assist: '
      const assistName = document.createElement('span')
      assistName.textContent = msg.assist.slice(0, 30)
      assistEl.appendChild(assistLabel)
      assistEl.appendChild(assistName)
      inner.appendChild(assistEl)
    }

    const attribution = document.createElement('div')
    attribution.className = 'curva-chat__commentary-attribution'
    attribution.textContent = 'AI parsed · on-device'

    li.appendChild(inner)
    li.appendChild(attribution)
    return li
  }

  // Ship 3 F7: `system:highlight` renderer. Icon-first colored pill.
  // Variant classes:
  //   .curva-chat__msg--highlight-red-card       (red)
  //   .curva-chat__msg--highlight-yellow-card    (yellow)
  //   .curva-chat__msg--highlight-corner         (blue)
  //   .curva-chat__msg--highlight-substitution   (green)
  // All fields via textContent — model output is untrusted.
  function renderSystemHighlight(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--highlight'
    li.dataset.key = key

    // Whitelist the kind before touching classList — prevents an attacker who
    // somehow bypasses isValidSystemHighlight from injecting arbitrary CSS
    // class fragments.
    const KIND_ALLOWLIST = {
      'red-card': { cls: 'curva-chat__msg--highlight-red-card', icon: '🟥', label: 'Red card' },
      'yellow-card': { cls: 'curva-chat__msg--highlight-yellow-card', icon: '🟨', label: 'Yellow card' },
      'corner': { cls: 'curva-chat__msg--highlight-corner', icon: '⚑', label: 'Corner' },
      'substitution': { cls: 'curva-chat__msg--highlight-substitution', icon: '⇄', label: 'Substitution' }
    }
    const cfg = KIND_ALLOWLIST[msg.kind] || { cls: '', icon: '•', label: String(msg.kind || 'event').slice(0, 24) }
    if (cfg.cls) li.classList.add(cfg.cls)

    const inner = document.createElement('div')
    inner.className = 'curva-chat__highlight-inner'

    const iconEl = document.createElement('span')
    iconEl.className = 'curva-chat__highlight-icon'
    iconEl.textContent = cfg.icon

    const labelEl = document.createElement('span')
    labelEl.className = 'curva-chat__highlight-label'
    labelEl.textContent = cfg.label

    const teamEl = document.createElement('span')
    teamEl.className = 'curva-chat__highlight-team'
    const rawTeam = typeof msg.team === 'string' ? msg.team.slice(0, 32) : ''
    teamEl.textContent = rawTeam

    const summaryEl = document.createElement('div')
    summaryEl.className = 'curva-chat__highlight-summary'
    // Model output; textContent + 200-char cap (matches validator).
    const rawSummary = typeof msg.summaryText === 'string' ? msg.summaryText.slice(0, 200) : ''
    summaryEl.textContent = rawSummary

    inner.appendChild(iconEl)
    inner.appendChild(labelEl)
    if (rawTeam.length > 0) inner.appendChild(teamEl)

    const attribution = document.createElement('div')
    attribution.className = 'curva-chat__commentary-attribution'
    attribution.textContent = 'auto-highlight · on-device VLM'

    li.appendChild(inner)
    li.appendChild(summaryEl)
    li.appendChild(attribution)
    return li
  }

  function renderSystemCommentary(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--commentary'
    li.dataset.key = key

    const marker = document.createElement('span')
    marker.className = 'curva-chat__commentary-marker'
    // Italian flag emoji if tone is italian-ultras (default), diamond otherwise.
    marker.textContent = msg?.tone === 'italian-ultras' || !msg?.tone ? '🇮🇹' : '◆'

    const body = document.createElement('div')
    body.className = 'curva-chat__commentary-body curva-chat__body'
    body.textContent = msg.text || ''

    const attribution = document.createElement('div')
    attribution.className = 'curva-chat__commentary-attribution'
    attribution.textContent = 'AI commentator · on-device'

    li.appendChild(marker)
    li.appendChild(body)
    li.appendChild(attribution)
    return li
  }

  // Wave 14: `system:attendance-issued` renderer. Subtle small-caps pill that
  // reads "@<handle> is attending the curva". Includes data attributes for the
  // signature + host address so any devtools user can ecrecover locally.
  function renderSystemAttendanceIssued(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--attendance'
    li.dataset.key = key
    li.dataset.verify = msg.signature || ''
    li.dataset.signer = msg.hostAddress || ''
    li.dataset.peer = msg.peerAddress || ''

    const marker = document.createElement('span')
    marker.className = 'curva-chat__attendance-marker'
    marker.textContent = '🎫'

    const body = document.createElement('div')
    body.className = 'curva-chat__attendance-body curva-chat__body'
    const peer = typeof msg.peerAddress === 'string' && msg.peerAddress.length >= 10
      ? msg.peerAddress.slice(0, 6) + '…' + msg.peerAddress.slice(-4)
      : (msg.peerAddress || 'peer')
    body.textContent = '@' + peer + ' is attending the curva'

    const attribution = document.createElement('div')
    attribution.className = 'curva-chat__attendance-attribution'
    attribution.textContent = 'attendance pass · EIP-191 signed by host'

    li.appendChild(marker)
    li.appendChild(body)
    li.appendChild(renderIdentityBadge(msg))
    li.appendChild(attribution)
    return li
  }

  // D2: `system:prediction-stake` renderer.
  // Gold pill. txHash is validated against /^0x[0-9a-fA-F]{64}$/ before being
  // used to construct a Sepolia URL opened via curva.openExternal (allowlisted
  // on the preload side). textContent everywhere — peerHandle is untrusted.
  function renderSystemPredictionStake(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--stake'
    li.dataset.key = key

    const marker = document.createElement('span')
    marker.className = 'curva-chat__stake-marker'
    marker.textContent = '◈'

    const body = document.createElement('div')
    body.className = 'curva-chat__stake-body'

    const amt = formatAmountBaseUnits(msg.stakeAtomic)
    const handle = (typeof msg.peerHandle === 'string' && msg.peerHandle.length > 0)
      ? msg.peerHandle : 'peer'
    const winner = ['HOME', 'AWAY', 'DRAW'].includes(msg.winner) ? msg.winner : '?'
    body.textContent = handle + ' staked ' + amt + ' USDT on ' + winner

    if (typeof msg.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(msg.txHash)) {
      const link = document.createElement('a')
      link.className = 'curva-chat__stake-link'
      link.href = '#'
      link.textContent = 'tx'
      // Capture txHash in closure; validated above.
      const safeTx = msg.txHash
      link.addEventListener('click', (e) => {
        e.preventDefault()
        if (typeof curva.openExternal === 'function') {
          curva.openExternal('https://sepolia.etherscan.io/tx/' + safeTx).catch(() => { /* noop */ })
        }
      })
      body.appendChild(link)
    }

    li.appendChild(marker)
    li.appendChild(body)
    return li
  }

  // D2: `system:prediction-settle` renderer.
  // Winners get a green pill with payout amount and Sepolia tx link.
  // Losers get an italic muted message: "Unlucky, next match?"
  function renderSystemPredictionSettle(msg, key) {
    const won = msg.outcome === 'won'
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system ' +
      (won ? 'curva-chat__msg--settle-won' : 'curva-chat__msg--settle-lost')
    li.dataset.key = key

    const marker = document.createElement('span')
    marker.className = 'curva-chat__settle-marker'
    marker.textContent = won ? '✦' : '◇'

    const body = document.createElement('div')
    body.className = 'curva-chat__settle-body ' +
      (won ? 'curva-chat__settle-body--won' : 'curva-chat__settle-body--lost')

    if (won) {
      const amt = formatAmountBaseUnits(msg.payoutAmountAtomic || msg.amountAtomic)
      body.textContent = 'won ' + amt + ' USDT'
      if (typeof msg.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(msg.txHash)) {
        const link = document.createElement('a')
        link.className = 'curva-chat__settle-link'
        link.href = '#'
        link.textContent = 'tx'
        const safeTx = msg.txHash
        link.addEventListener('click', (e) => {
          e.preventDefault()
          if (typeof curva.openExternal === 'function') {
            curva.openExternal('https://sepolia.etherscan.io/tx/' + safeTx).catch(() => { /* noop */ })
          }
        })
        body.appendChild(link)
      }
    } else {
      body.textContent = 'Unlucky, next match?'
    }

    li.appendChild(marker)
    li.appendChild(body)
    return li
  }

  // F3: `system:goal` renderer.
  // Gold left-border pill: "34' MESSI · 1-0 ARG"
  // All strings are textContent — scorer, matchId, and team names are
  // host-authored but still treated as untrusted display text (defense
  // in depth; the host-only gate in bare/chat.js is the primary guard).
  function renderSystemGoal(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--goal-pill'
    li.dataset.key = key

    const minuteEl = document.createElement('span')
    minuteEl.className = 'curva-chat__goal-minute'
    const min = Number.isFinite(msg.minute) ? String(Math.floor(msg.minute)) : '?'
    minuteEl.textContent = min + "'"

    const bodyEl = document.createElement('span')
    bodyEl.className = 'curva-chat__goal-body'

    const scorer = (typeof msg.scorer === 'string' && msg.scorer.length > 0)
      ? msg.scorer.toUpperCase().slice(0, 20) : 'GOAL'
    bodyEl.textContent = scorer

    const scoreEl = document.createElement('span')
    scoreEl.className = 'curva-chat__goal-score'
    const home = Number.isInteger(msg.homeScore) ? msg.homeScore : '?'
    const away = Number.isInteger(msg.awayScore) ? msg.awayScore : '?'
    scoreEl.textContent = ' · ' + home + '-' + away

    bodyEl.appendChild(scoreEl)

    li.appendChild(minuteEl)
    li.appendChild(bodyEl)
    return li
  }

  function renderSystemTipCongrats(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--congrats'
    li.dataset.key = key

    const marker = document.createElement('span')
    marker.className = 'curva-chat__congrats-marker'
    marker.textContent = '★'

    const body = document.createElement('div')
    body.className = 'curva-chat__congrats-body curva-chat__body'
    // textContent: text is originally in English but STILL untrusted (a
    // malicious peer could craft this shape). Never innerHTML.
    body.textContent = msg.text || ''

    li.appendChild(marker)
    li.appendChild(body)
    return li
  }

  // Tier 4: `system:reader-joined` renderer.
  // Subtle grey pill: "spectator @<handle> joined as spectator".
  // textContent only — handle is peer-supplied (untrusted).
  function renderSystemReaderJoined(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--reader-joined'
    li.dataset.key = key

    const body = document.createElement('div')
    body.className = 'curva-chat__reader-joined-body'
    const handle = (typeof msg.handle === 'string' && msg.handle.length > 0)
      ? msg.handle : short(msg.by_peer)
    body.textContent = 'spectator @' + handle + ' joined'

    li.appendChild(body)
    return li
  }

  // Tier 4: `system:tip-batch` renderer.
  // Lightning pill: "<handle> tipped N hosts (X USDT total) · tx <link>"
  // textContent only. Explorer URL validated before use. (CWE-79 guard.)
  function renderSystemTipBatch(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--tip curva-chat__msg--tip-batch'
    li.dataset.key = key

    const marker = document.createElement('span')
    marker.className = 'curva-chat__tip-marker'
    marker.textContent = 'B'

    const body = document.createElement('div')
    body.className = 'curva-chat__tip-body'

    const from = document.createElement('span')
    from.className = 'curva-chat__handle'
    from.textContent = (typeof msg.from_handle === 'string' && msg.from_handle.length > 0)
      ? msg.from_handle : short(msg.by_peer)

    const count = Array.isArray(msg.recipients) ? msg.recipients.length : '?'
    const totalUsdt = typeof msg.total_base === 'string' && /^[0-9]+$/.test(msg.total_base)
      ? (Number(BigInt(msg.total_base)) / 1_000_000).toFixed(2)
      : '?'

    const label = document.createElement('span')
    label.className = 'curva-chat__tip-label'
    label.textContent = ' tipped ' + count + ' host' + (count === 1 ? '' : 's') +
      ' (' + totalUsdt + ' USDT total)'

    body.appendChild(from)
    body.appendChild(label)

    if (typeof msg.explorer_url === 'string' && /^https:\/\//.test(msg.explorer_url)) {
      const link = document.createElement('a')
      link.className = 'curva-chat__tip-link'
      link.href = '#'
      link.textContent = 'view tx'
      link.addEventListener('click', (e) => {
        e.preventDefault()
        if (typeof curva.openExternal === 'function') {
          curva.openExternal(msg.explorer_url).catch(() => { /* noop */ })
        }
      })
      body.appendChild(link)
    }

    li.appendChild(marker)
    li.appendChild(body)
    return li
  }

  // Tier 4 R2: identity verification badge.
  //
  // The bare side resolves `identity_verified` to one of:
  //   true   (identity_proof present and cryptographically verified)
  //   false  (identity_proof present but verification failed)
  //   null   (no identity_proof = legacy message)
  //
  // `identityPublicKeyHex` is the 64-char hex identity public key, set by the
  // worker when identity_verified === true. We display a short form: first 6
  // + last 4 chars of the hex string, and include the full key in the tooltip.
  //
  // We trust the boolean from the worker; the renderer does NOT re-verify.
  // Badge is shown for msg, system:tip, system:attendance-issued.
  //
  // Security: all peer data (handle, pubkey) lands in data-* attributes or
  // textContent — NEVER innerHTML. The inline SVGs are hardcoded constants.
  function renderIdentityBadge(msg) {
    const verified = msg?.identity_verified  // true | false | null | undefined
    const handle = typeof msg?.handle === 'string' && msg.handle.length > 0
      ? msg.handle : short(msg?.by_peer)
    // Short-form pubkey: first 6 + last 4 hex chars. Only set when verified.
    const rawKey = typeof msg?.identityPublicKeyHex === 'string' && msg.identityPublicKeyHex.length >= 10
      ? msg.identityPublicKeyHex : null
    const shortKey = rawKey ? rawKey.slice(0, 6) + '…' + rawKey.slice(-4) : null

    const badge = document.createElement('span')
    badge.className = 'curva-chat__identity-badge'

    if (verified === true) {
      badge.classList.add('curva-chat__identity-badge--verified')
      // data-* attributes are safe (equivalent to setAttribute with textContent semantics).
      badge.dataset.tip = rawKey
        ? 'verified by Keet · ' + rawKey   // full pubkey in tooltip
        : 'verified · @' + handle
      // Inline SVG checkmark (hardcoded, not peer data).
      badge.innerHTML = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      if (shortKey) {
        // Short-form pubkey chip as a text node — textContent, never innerHTML.
        const keyChip = document.createElement('span')
        keyChip.className = 'curva-chat__identity-key'
        keyChip.textContent = shortKey
        keyChip.title = rawKey // full key on hover — title attribute is safe
        badge.appendChild(keyChip)
      }
    } else if (verified === false) {
      badge.classList.add('curva-chat__identity-badge--mismatch')
      badge.dataset.tip = 'signature mismatch'
      badge.innerHTML = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    } else {
      // null or undefined = legacy / no identity proof
      badge.classList.add('curva-chat__identity-badge--unverified')
      badge.dataset.tip = 'unverified · legacy'
      badge.innerHTML = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2"/><text x="6" y="9" text-anchor="middle" font-size="7" fill="currentColor" font-family="monospace">?</text></svg>'
    }

    return badge
  }

  // Tier 4 R2: `system:bot-query` renderer.
  // Gold-border pill. "🤖 @<handle> asked: <prompt>" (max 200 chars display).
  // textContent only — prompt is peer-supplied and untrusted.
  function renderSystemBotQuery(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--bot-query'
    li.dataset.key = key

    const marker = document.createElement('span')
    marker.className = 'curva-chat__bot-marker'
    marker.textContent = '\u{1F916}' // robot face emoji

    const body = document.createElement('div')
    body.className = 'curva-chat__bot-body'

    const prefix = document.createElement('div')
    prefix.className = 'curva-chat__bot-prompt-prefix'
    const handle = (typeof msg.byPeer === 'string' && msg.byPeer.length > 0)
      ? msg.byPeer.slice(0, 24) : 'peer'
    prefix.textContent = '@' + handle + ' asked:'

    const text = document.createElement('div')
    text.className = 'curva-chat__bot-text'
    // Cap at 200 chars for display; full text lives in the message.
    const prompt = typeof msg.text === 'string' ? msg.text.slice(0, 200) : ''
    text.textContent = prompt + (typeof msg.text === 'string' && msg.text.length > 200 ? '…' : '')

    body.appendChild(prefix)
    body.appendChild(text)
    li.appendChild(marker)
    li.appendChild(body)
    return li
  }

  // Tier 4 R2: `system:bot-reply` renderer.
  // Mint-border pill. "🤖 curva-bot: <text>" with tool-call badges below.
  // textContent only. Tool names validated against /^[a-z_]+$/ before
  // rendering; any name that does not match is shown as "(unknown)".
  // (CWE-79 defense in depth; the bare side validates too.)
  const TOOL_NAME_SAFE = /^[a-z_]+$/
  function renderSystemBotReply(msg, key) {
    const li = document.createElement('li')
    li.className = 'curva-chat__msg curva-chat__msg--system curva-chat__msg--bot-reply'
    li.dataset.key = key

    const marker = document.createElement('span')
    marker.className = 'curva-chat__bot-marker'
    marker.textContent = '\u{1F916}'

    const body = document.createElement('div')
    body.className = 'curva-chat__bot-body'

    const attribution = document.createElement('div')
    attribution.className = 'curva-chat__bot-attribution'
    attribution.textContent = 'curva-bot · on-device AI'

    const text = document.createElement('div')
    text.className = 'curva-chat__bot-text'
    text.textContent = typeof msg.text === 'string' ? msg.text : ''

    body.appendChild(attribution)
    body.appendChild(text)

    // Tool-call badges.
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const badgeRow = document.createElement('div')
      badgeRow.className = 'curva-chat__bot-tool-badges'

      for (const tc of msg.tool_calls) {
        if (!tc || typeof tc !== 'object') continue
        const rawName = typeof tc.name === 'string' ? tc.name : ''
        // Validate tool name against allowlist pattern before rendering.
        const safeName = TOOL_NAME_SAFE.test(rawName) ? rawName : '(unknown)'
        const failed = tc.ok === false

        const chip = document.createElement('span')
        chip.className = 'curva-chat__bot-tool-badge' +
          (failed ? ' curva-chat__bot-tool-badge--failed' : '')
        chip.textContent = 'via curva-mcp: ' + safeName + (failed ? ' (failed)' : '')
        badgeRow.appendChild(chip)
      }
      body.appendChild(badgeRow)
    }

    li.appendChild(marker)
    li.appendChild(body)
    return li
  }

  function formatAmountBaseUnits(v) {
    if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) return '?'
    try { return (Number(BigInt(v)) / 1_000_000).toFixed(2) } catch { return v.slice(0, 12) }
  }

  function highlightCluster(payload) {
    if (!payload?.messageIds) return
    // Hyperbee-key based highlight. The reducer keys look like
    // 'chat/<padded ts>/<8-char peer>'. Extract the wall_clock_ms and by_peer
    // to match our rowsByKey convention.
    for (const hbKey of payload.messageIds) {
      const parts = hbKey.split('/')
      if (parts.length !== 3) continue
      const wallClock = parseInt(parts[1], 10)
      const peerShort = parts[2]
      const rowKey = `${wallClock}/${peerShort}`
      const row = rowsByKey.get(rowKey)
      if (row) row.classList.add('curva-chat__msg--goal')
    }
  }

  // -- subscriptions --------------------------------------------------------

  // Wave 6 T8: keep the last-loaded history around so we can bulk-translate
  // it into the selected target language. This is a shallow reference to the
  // messages already rendered; the DOM rows are keyed by keyForMessage().
  const historyCache = []
  const HISTORY_TRANSLATE_BATCH = 10
  const HISTORY_TRANSLATE_GAP_MS = 50
  let bulkTranslateSeq = 0 // incremented on each new lang; workers checking their own seq are cancellable

  const offMsg = curva.onChatMessage((msg) => addMessage(msg))
  const offCluster = curva.onGoalCluster((payload) => highlightCluster(payload))
  const offHistory = curva.onChatHistory(({ messages }) => {
    if (!Array.isArray(messages)) return
    for (const m of messages) {
      historyCache.push(m)
      addMessage(m)
    }
    // If the user already picked a language, kick off a bulk-translate pass
    // now that history has landed. Otherwise this fires when they pick.
    if (userLang) scheduleBulkTranslate(userLang)
  })

  async function scheduleBulkTranslate(targetLang) {
    if (!targetLang) return
    if (typeof curva.translateText !== 'function') return
    const seq = ++bulkTranslateSeq
    const items = historyCache.slice()
    for (let i = 0; i < items.length; i += HISTORY_TRANSLATE_BATCH) {
      if (seq !== bulkTranslateSeq) return // cancelled by a newer language pick
      const slice = items.slice(i, i + HISTORY_TRANSLATE_BATCH)
      // Fire the batch in parallel; the worker's translator queues sequentially.
      await Promise.all(slice.map(async (m) => {
        if (!m || typeof m.text !== 'string' || m.text.length === 0) return
        if (m.type && m.type !== 'msg' && m.type !== 'system:tip-congrats') return
        const from = (m.source_lang || m.lang || 'en').slice(0, 2).toLowerCase()
        if (from === targetLang) return
        const key = keyForMessage(m)
        if (translationsByKey.has(key)) return
        try {
          const translated = await curva.translateText({ text: m.text, from, to: targetLang })
          if (seq !== bulkTranslateSeq) return
          // translated may come back as a string OR as an object with .translated on some paths.
          const text = typeof translated === 'string' ? translated : (translated?.translated || '')
          if (!text) return
          translationsByKey.set(key, { translatedText: text, sourceLang: from })
          applyTranslationToRow(key)
        } catch { /* silent per-message failure */ }
      }))
      if (seq !== bulkTranslateSeq) return
      if (i + HISTORY_TRANSLATE_BATCH < items.length) {
        await new Promise((r) => setTimeout(r, HISTORY_TRANSLATE_GAP_MS))
      }
    }
  }

  // Phase 3.5 subscriptions. All optional — if the preload predates 3.5, no-op.
  const offTranslated = typeof curva.onChatTranslated === 'function'
    ? curva.onChatTranslated((payload) => {
        if (!payload) return
        const key = payload.originalKey ||
          `${payload.wall_clock_ms}/${(payload.by_peer || '').slice(0, 8)}`
        translationsByKey.set(key, {
          translatedText: payload.translatedText,
          sourceLang: payload.sourceLang,
          engine: payload.engine || null
        })
        applyTranslationToRow(key)
      })
    : () => {}
  const offProgress = typeof curva.onTranslationProgress === 'function'
    ? curva.onTranslationProgress((ev) => {
        if (!ev) return
        if (ev.phase === 'download' && typeof ev.percent === 'number') {
          setTranslationStatus(
            'Downloading model ' + (ev.modelId || '') + ' ' + ev.percent + '%',
            'info'
          )
        } else if (ev.phase === 'load') {
          setTranslationStatus('Loading ' + (ev.modelId || '') + ' ' + ev.from + '->' + ev.to, 'info')
        }
      })
    : () => {}
  const offReady = typeof curva.onTranslationReady === 'function'
    ? curva.onTranslationReady((ev) => {
        const pairs = Array.isArray(ev?.loaded) ? ev.loaded.length : 0
        setTranslationStatus('Translation ready (' + pairs + ' pairs, MPL-2.0 Bergamot)', 'ok')
      })
    : () => {}
  const offDisabled = typeof curva.onTranslationDisabled === 'function'
    ? curva.onTranslationDisabled((ev) => {
        setTranslationStatus('Translation unavailable: ' + (ev?.reason || 'unknown'), 'error')
      })
    : () => {}

  // Load history now. Best-effort; the room may not be open yet, in which
  // case the worker will respond with an error event that we swallow.
  curva.loadChatHistory({ from: 0, limit: 100 }).catch(() => {})

  function destroy() {
    if (scrubDebounce) clearTimeout(scrubDebounce)
    if (searchDebounce) clearTimeout(searchDebounce)
    offMsg()
    offCluster()
    offHistory()
    offTranslated()
    offProgress()
    offReady()
    offDisabled()
    translationsByKey.clear()
    container.textContent = ''
  }

  return { destroy }
}

function short(hex) {
  if (typeof hex !== 'string') return '(unknown)'
  return hex.length > 8 ? hex.slice(0, 8) : hex
}

function formatMatchTime(ms) {
  if (typeof ms !== 'number' || ms <= 0) return ''
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
