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
  header.appendChild(title)
  header.appendChild(count)

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
  container.appendChild(translationBar)
  container.appendChild(translationStatus)
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
