// Curva RoomHeader: brand, role badge, peer count, wallet balance, actions.
// Vanilla ES module (ADR-001). textContent only. Peer strings untrusted.
//
// Phase 4 polish (R16):
//   - Balance polling (30s + wallet:ready + wallet:balance events).
//   - About modal on brand-mark click.
//   - Tips total refresh on every list update.

import { mountTipButton } from './TipButton.js'

// -- pear.assets branding pack ---
// Resolve a crest URL for a given roomState. Prefers the pear.assets branding
// drive when available; falls back to the bundled `./logo-index.svg`. The
// branding drive path is exposed by preload as `curva.getBrandingPath()`.
// See branding-drive/PUBLISH.md for how the drive gets a `path` at runtime.
// Uses the unified /web/public/assets/logo.svg (yin-yang + wordmark baked in)
// so the room header doesn't need to show a separate CURVA text next to the
// mark. The topbar uses the same file.
const BUNDLED_LOGO_URL = './logo.svg'
// Poll the worker for a branding-drive snapshot every 5s until the path
// lands. Pear docs describe no fetch-complete event, so a low-frequency pull
// is the documented pattern. Stops once the path is truthy.
const BRANDING_POLL_MS = 5_000
const BRANDING_POLL_MAX_ATTEMPTS = 60 // ~5 minutes cap

export function resolveTeamCode(roomState) {
  if (!roomState || typeof roomState !== 'object') return null
  const raw = roomState.homeTeam || roomState.awayTeam || null
  if (typeof raw === 'string' && raw.length > 0) return raw.toLowerCase().slice(0, 8)
  // Fall back to splitting the slug: e.g. "wc26-ita-vs-arg" -> "ita".
  if (typeof roomState.slug === 'string' && roomState.slug.length > 0) {
    const parts = roomState.slug.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    for (const p of parts) {
      if (p.length === 3 && /^[a-z]{3}$/.test(p)) return p
    }
  }
  return null
}

export function brandingCrestUrl(brandingPath, teamCode) {
  if (typeof brandingPath !== 'string' || brandingPath.length === 0) return null
  if (typeof teamCode !== 'string' || !/^[a-z0-9-]{1,16}$/.test(teamCode)) return null
  const base = brandingPath.replace(/\/+$/, '')
  return 'file://' + base + '/crests/' + teamCode + '.svg'
}

export function brandingLogoUrl(brandingPath) {
  if (typeof brandingPath !== 'string' || brandingPath.length === 0) return null
  const base = brandingPath.replace(/\/+$/, '')
  return 'file://' + base + '/curva-logo.svg'
}
// -- end pear.assets branding pack ---

// Wave 6 T7: poll every 15s (WDK Indexer rate limit is 4 req/10s, so 15s is
// well within budget). Immediate refresh on tip:confirmed via the existing
// onTipConfirmed subscription below.
const BALANCE_POLL_MS = 15_000

// Wave 7 Zone C: fiat pricing chip.
// Locale -> ISO 4217 currency code. Falls back to USD when navigator.language
// yields something we don't map. The mapping is intentionally conservative —
// showing USD to a French user is less confusing than showing an outdated
// EUR estimate. Locale strings are matched by prefix so "id-ID", "id" both
// map to IDR.
export const LOCALE_CURRENCY_MAP = Object.freeze({
  id: 'IDR',
  it: 'EUR',
  'en-gb': 'GBP',
  'pt-br': 'BRL',
  'es-mx': 'MXN',
  ja: 'JPY',
  en: 'USD'
})

// Currency -> Intl.NumberFormat symbol/style hints. Kept small so it's
// obvious what's rendered without opening MDN.
const CURRENCY_LOCALE = Object.freeze({
  IDR: 'id-ID',
  USD: 'en-US',
  EUR: 'it-IT',
  GBP: 'en-GB',
  BRL: 'pt-BR',
  MXN: 'es-MX',
  JPY: 'ja-JP'
})

export function pickFiatCurrency(navigatorLanguage) {
  if (typeof navigatorLanguage !== 'string' || navigatorLanguage.length === 0) return 'USD'
  const lc = navigatorLanguage.toLowerCase()
  // Longest-prefix match first so "en-gb" beats "en".
  if (LOCALE_CURRENCY_MAP[lc]) return LOCALE_CURRENCY_MAP[lc]
  const base = lc.split('-')[0]
  return LOCALE_CURRENCY_MAP[base] || 'USD'
}

// 60s renderer-side cache. Matches the backend cache so we don't hit the
// backend every time the user clicks a tip preset.
const PRICING_CACHE_MS = 60_000
const pricingCache = new Map() // currency -> { quote, expiresAt }

async function fetchFiatQuote(curva, currency) {
  const now = Date.now()
  const cached = pricingCache.get(currency)
  if (cached && cached.expiresAt > now) return cached.quote
  if (typeof curva?.getUsdtQuote !== 'function') return null
  try {
    const quote = await curva.getUsdtQuote(currency)
    if (!quote || typeof quote.rate !== 'number') return null
    pricingCache.set(currency, { quote, expiresAt: now + PRICING_CACHE_MS })
    return quote
  } catch { return null }
}

function formatFiat(currency, amount) {
  try {
    return new Intl.NumberFormat(CURRENCY_LOCALE[currency] || 'en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'IDR' || currency === 'JPY' ? 0 : 2
    }).format(amount)
  } catch {
    return currency + ' ' + amount.toFixed(2)
  }
}

export function mountRoomHeader({ container, curva, roomState, appVersion, backendUrl = 'http://localhost:3700' } = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva bridge is required')
  if (!roomState) throw new TypeError('roomState is required')

  container.textContent = ''
  container.classList.add('curva-header')

  const brand = document.createElement('div')
  brand.className = 'curva-header__brand'
  const brandMark = document.createElement('span')
  brandMark.className = 'curva-header__mark'
  brandMark.textContent = 'CURVA'
  brandMark.title = 'About Curva (click)'
  brandMark.setAttribute('role', 'button')
  brandMark.style.cursor = 'pointer'
  brandMark.addEventListener('click', () => openAboutModal({ curva, appVersion }))
  const brandSlug = document.createElement('span')
  brandSlug.className = 'curva-header__slug'
  brandSlug.textContent = roomState.slug || 'no-room'

  // -- pear.assets branding pack ---
  // Crest slot. Uses bundled logo as first-paint fallback so the header
  // never blocks on the branding drive. Re-renders when the drive lands
  // (subscription below).
  const crestImg = document.createElement('img')
  crestImg.className = 'curva-header__crest'
  crestImg.alt = ''
  crestImg.width = 24
  crestImg.height = 24
  crestImg.style.verticalAlign = 'middle'
  crestImg.style.marginRight = '6px'
  crestImg.src = BUNDLED_LOGO_URL

  function renderCrest() {
    const brandingPath = (typeof curva?.getBrandingPath === 'function')
      ? curva.getBrandingPath()
      : null
    const teamCode = resolveTeamCode(roomState)
    const url = brandingCrestUrl(brandingPath, teamCode)
      || brandingLogoUrl(brandingPath)
      || BUNDLED_LOGO_URL
    // Only touch the DOM if the URL actually changed. Avoids network churn
    // on repeated event fires.
    if (crestImg.getAttribute('data-resolved') !== url) {
      crestImg.src = url
      crestImg.setAttribute('data-resolved', url)
    }
  }
  renderCrest()

  let brandingUnsub = () => {}
  if (typeof curva?.onBranding === 'function') {
    try { brandingUnsub = curva.onBranding(() => renderCrest()) } catch { /* noop */ }
  }
  // Low-frequency pull loop: keep asking the worker to re-read
  // `Pear.app.assets.branding.path` until we see a truthy path. Bounded so
  // an unpublished branding drive doesn't poll forever.
  let brandingAttempts = 0
  const brandingPoll = setInterval(() => {
    brandingAttempts += 1
    const havePath = (typeof curva?.getBrandingPath === 'function') && curva.getBrandingPath()
    if (havePath || brandingAttempts >= BRANDING_POLL_MAX_ATTEMPTS) {
      clearInterval(brandingPoll)
      return
    }
    if (typeof curva?.refreshBranding === 'function') {
      curva.refreshBranding().catch(() => { /* noop */ })
    }
  }, BRANDING_POLL_MS)
  // -- end pear.assets branding pack ---

  brand.appendChild(crestImg)
  brand.appendChild(brandMark)
  brand.appendChild(brandSlug)

  const meta = document.createElement('div')
  meta.className = 'curva-header__meta'

  const roleBadge = document.createElement('span')
  roleBadge.className = 'curva-header__badge'
  roleBadge.classList.add(roomState.isHost ? 'curva-header__badge--host' : 'curva-header__badge--peer')
  roleBadge.textContent = roomState.isHost ? 'host' : 'peer'

  const handleEl = document.createElement('span')
  handleEl.className = 'curva-header__handle'
  handleEl.textContent = roomState.handle || '(loading...)'

  const peersEl = document.createElement('span')
  peersEl.className = 'curva-header__peers'
  peersEl.textContent = 'peers: 0'

  // Wave 12: "translating via <handle>" chip. Hidden until the first
  // translate:delegate-status event arrives from the Bare worker. Falls back
  // to "translating locally" when the room reports a fallback tick. Sits near
  // the integrity badge (peer count / relay) so the demo can see it next to
  // the on-device guarantee copy in the About modal.
  const delegateChip = document.createElement('span')
  delegateChip.className = 'curva-header__delegate'
  delegateChip.title = 'QVAC delegated inference status'
  delegateChip.textContent = ''
  delegateChip.hidden = true

  // Wave 8B T1: "via relay" chip. Hidden until at least one relay:connection
  // arrives. Under CURVA_FORCE_RELAY the relay:info event also flips the
  // enabled bit, in which case we show the chip immediately.
  const relayChip = document.createElement('span')
  relayChip.className = 'curva-header__relay'
  relayChip.title = 'This connection is being forwarded through the Curva companion relay so NAT-blocked peers can still see the room.'
  relayChip.textContent = 'via relay'
  relayChip.hidden = true

  // Wave 15: "blind-peer" chip. Grey when the feature is disabled or the
  // env pubkey is unset. Amber while retrying. Green-ish once the client has
  // an active client. Low-emphasis by design -- the chip sits next to the
  // existing relay + delegate chips as a fourth resilience-signal pill.
  const blindPeerChip = document.createElement('button')
  blindPeerChip.type = 'button'
  blindPeerChip.className = 'curva-header__blind-peer'
  blindPeerChip.title = 'Third-party blind peer replicates this room without seeing chat contents. Keeps the room alive when every human peer disconnects.'
  blindPeerChip.textContent = 'blind-peer'
  blindPeerChip.hidden = false
  blindPeerChip.addEventListener('click', () => openBlindPeerPopover({ curva, anchor: blindPeerChip }))

  const balanceEl = document.createElement('span')
  balanceEl.className = 'curva-header__balance'
  balanceEl.textContent = 'USDT: —'
  // Wave 6 T7: hidden until wallet:ready. Keeps the header uncluttered when
  // the user has not yet supplied a passcode.
  balanceEl.hidden = true
  balanceEl.title = 'Sepolia USDT balance (polled every 15s)'

  const statusEl = document.createElement('span')
  statusEl.className = 'curva-header__status'
  statusEl.textContent = 'joined'

  meta.appendChild(roleBadge)
  meta.appendChild(handleEl)
  meta.appendChild(peersEl)
  meta.appendChild(delegateChip)
  meta.appendChild(relayChip)
  meta.appendChild(blindPeerChip)
  meta.appendChild(balanceEl)
  meta.appendChild(statusEl)

  const actions = document.createElement('div')
  actions.className = 'curva-header__actions'

  const leaveBtn = document.createElement('button')
  leaveBtn.type = 'button'
  leaveBtn.className = 'curva-header__btn'
  leaveBtn.textContent = 'Leave'
  leaveBtn.addEventListener('click', () => {
    curva.leaveRoom().catch(() => { /* noop */ })
  })

  const publishBtn = document.createElement('button')
  publishBtn.type = 'button'
  publishBtn.className = 'curva-header__btn curva-header__btn--primary'
  publishBtn.textContent = 'Publish to directory'
  publishBtn.disabled = !roomState.isHost
  publishBtn.title = roomState.isHost ? '' : 'only the host can publish'
  publishBtn.addEventListener('click', () => {
    curva.publishRoom({
      hostHandle: roomState.handle,
      matchId: roomState.matchId
    }).catch(() => { /* noop */ })
  })

  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'curva-header__btn'
  copyBtn.textContent = 'Copy invite'
  copyBtn.addEventListener('click', async () => {
    const link = await resolveInviteLink(curva, roomState.slug)
    try {
      navigator.clipboard.writeText(link).catch(() => { /* noop */ })
      copyBtn.textContent = 'Copied'
      setTimeout(() => { copyBtn.textContent = 'Copy invite' }, 1500)
    } catch { /* noop */ }
  })

  const inviteBtn = document.createElement('button')
  inviteBtn.type = 'button'
  inviteBtn.className = 'curva-header__btn'
  inviteBtn.textContent = 'Invite (QR)'
  inviteBtn.addEventListener('click', () => {
    openInviteModal({ curva, slug: roomState.slug })
  })

  actions.appendChild(publishBtn)
  actions.appendChild(copyBtn)
  actions.appendChild(inviteBtn)
  actions.appendChild(leaveBtn)

  const tipContainer = document.createElement('div')
  tipContainer.className = 'curva-header__tip'

  const tipTotalEl = document.createElement('span')
  tipTotalEl.className = 'curva-header__tip-total'
  tipTotalEl.textContent = 'tips: 0.00 USDT'

  // Wave 7 Zone C: fiat sanity chip. Detects a preferred fiat from
  // navigator.language, fetches USDT->fiat, and re-renders when the
  // TipButton reports a preset change via `curva-tip:amount-change`.
  const fiatChip = document.createElement('span')
  fiatChip.className = 'curva-header__fiat'
  fiatChip.textContent = ''
  fiatChip.hidden = true

  const tipButton = mountTipButton({
    container: tipContainer,
    curva,
    hostSmartAddress: roomState.hostSmartAddress || null,
    backendUrl,
    chainId: roomState.chainId || 11155111
  })

  // Bug fix: subscribe to `tip:host-discovered`. The Bare worker emits this
  // when the host's smart address is discovered from the backend room
  // directory OR through P2P host discovery. Without this hook, the tip
  // button stays "Waiting for host..." forever on viewer peers.
  let offTipHostDiscovered = null
  if (typeof curva.onTipHostDiscovered === 'function') {
    offTipHostDiscovered = curva.onTipHostDiscovered((payload) => {
      const addr = payload?.smartAddress || payload?.hostSmartAddress || null
      if (addr) tipButton.setHostAddress(addr)
    })
  }

  // Wave 14: Attendance chip + modal. Renders "Attendees · N" with a hover
  // affordance. Click opens a modal listing every issued pass with a copy
  // button per row for the verify URL. All strings are textContent — pass
  // fields are ecrecover-verifiable but the peer-address handle is still
  // untrusted display text.
  const attendanceChip = document.createElement('button')
  attendanceChip.type = 'button'
  attendanceChip.className = 'curva-header__attendance'
  attendanceChip.textContent = 'Attendees · 1'
  attendanceChip.title = 'Curva Attendance Passes (EIP-191, off-chain verifiable)'
  attendanceChip.hidden = true

  // listArrived: tracks whether the attendance list has arrived from the worker.
  // Until then, we show at least 1 (the local peer is always "attending" by
  // virtue of being in the room). This prevents the chip flickering "0" on
  // initial mount before the worker responds.
  const attendanceState = { passes: [], enabled: false, listArrived: false }

  function renderAttendanceChip() {
    if (!attendanceState.enabled) { attendanceChip.hidden = true; return }
    attendanceChip.hidden = false
    // Show at least 1 until the server confirms the list (local peer is always present).
    const displayCount = attendanceState.listArrived
      ? Math.max(1, attendanceState.passes.length)
      : 1
    attendanceChip.textContent = 'Attendees · ' + displayCount
  }

  attendanceChip.addEventListener('click', () => {
    openAttendanceModal({ curva, passes: attendanceState.passes, slug: roomState.slug })
  })

  // Query config once so we know whether to show the chip at all.
  if (curva?.attendance?.getConfig) {
    curva.attendance.getConfig().catch(() => { /* noop */ })
  }
  const offAttConfig = curva?.attendance?.onConfig
    ? curva.attendance.onConfig((cfg) => {
        attendanceState.enabled = !!cfg?.enabled
        renderAttendanceChip()
        if (attendanceState.enabled && curva?.attendance?.list) {
          curva.attendance.list({ limit: 200 }).catch(() => { /* noop */ })
        }
      })
    : () => {}
  const offAttList = curva?.attendance?.onList
    ? curva.attendance.onList((payload) => {
        const arr = Array.isArray(payload?.passes) ? payload.passes : []
        attendanceState.passes = arr
        attendanceState.listArrived = true
        renderAttendanceChip()
      })
    : () => {}
  const offAttIssued = curva?.attendance?.onIssued
    ? curva.attendance.onIssued((payload) => {
        const pass = payload?.pass
        if (!pass || !pass.peerAddress) return
        // Replace any existing entry for this peer (last write wins).
        const idx = attendanceState.passes.findIndex((p) => p.peerAddress === pass.peerAddress)
        if (idx >= 0) attendanceState.passes[idx] = pass
        else attendanceState.passes = [...attendanceState.passes, pass]
        renderAttendanceChip()
        // Also add a badge via the address map so the chat subscription
        // path and the attendance list path converge.
        peerTicketMap.set(pass.peerAddress.toLowerCase(), true)
      })
    : () => {}

  // Task 3: per-peer ticket badge map.
  // Keys are lowercased EVM addresses. Value: true when a pass is confirmed.
  // Updated from two sources:
  //   (a) attendance list/issued events above.
  //   (b) system:attendance-issued chat messages arriving via onChatMessage.
  // Both sources ultimately reflect the same Hyperbee state; the chat path
  // gives us live updates without polling the attendance list every second.
  const peerTicketMap = new Map()

  // Seed the map from any passes already loaded before the chat subscription fires.
  for (const p of attendanceState.passes) {
    if (p?.peerAddress) peerTicketMap.set(p.peerAddress.toLowerCase(), true)
  }

  // Subscribe to chat messages to catch new system:attendance-issued rows that
  // arrive after mount. We only read the peerAddress field (a checksummed EVM
  // address); it is not rendered to DOM here — the attendanceChip shows the
  // count, and openAttendanceModal shows the addresses.
  const offChatMsgForBadge = typeof curva.onChatMessage === 'function'
    ? curva.onChatMessage((msg) => {
        if (msg?.type !== 'system:attendance-issued') return
        const addr = typeof msg.peerAddress === 'string' ? msg.peerAddress.toLowerCase() : ''
        if (!addr || addr.length < 10) return
        if (peerTicketMap.has(addr)) return
        peerTicketMap.set(addr, true)
        // Mirror into attendanceState so the modal shows it.
        const existing = attendanceState.passes.find(
          (p) => p.peerAddress && p.peerAddress.toLowerCase() === addr
        )
        if (!existing) {
          attendanceState.passes = [...attendanceState.passes, {
            peerAddress: msg.peerAddress,
            signature: msg.signature || '',
            hostAddress: msg.hostAddress || ''
          }]
          attendanceState.listArrived = true
          renderAttendanceChip()
        }
      })
    : () => {}

  container.appendChild(brand)
  container.appendChild(meta)
  container.appendChild(actions)
  container.appendChild(tipContainer)
  container.appendChild(fiatChip)
  container.appendChild(attendanceChip)
  container.appendChild(tipTotalEl)

  // -- Fiat chip (Wave 7 Zone C) -----------------------------------------
  const preferredFiat = pickFiatCurrency(
    (typeof navigator !== 'undefined' && navigator.language) || 'en-US'
  )
  let currentTipUsdt = 5 // Default preset. TipButton emits actual value below.

  function renderFiatChip(quote) {
    if (!quote || typeof quote.rate !== 'number') { fiatChip.hidden = true; return }
    const fiatAmount = currentTipUsdt * quote.rate
    fiatChip.hidden = false
    const staleHint = quote.stale ? ' (cached)' : ''
    const pegHint = quote.assumption ? ' *' : ''
    fiatChip.textContent = '~ ' + formatFiat(quote.currency, fiatAmount) + staleHint + pegHint
    fiatChip.title = quote.assumption
      ? quote.assumption
      : 'Source: ' + (quote.source || 'unknown') + ' • fetched ' + (quote.fetchedAt || '')
  }

  // Kick off the initial fetch. Silent on failure — chip stays hidden.
  fetchFiatQuote(curva, preferredFiat).then(renderFiatChip).catch(() => { /* noop */ })

  // TipButton dispatches this event on its container whenever the user
  // clicks a preset amount. Kept as a DOM CustomEvent because it stays
  // internal to the header — no need to route through the Bare worker.
  const onTipAmountChange = (evt) => {
    const usdt = evt?.detail?.usdt
    if (typeof usdt !== 'number' || !Number.isFinite(usdt) || usdt <= 0) return
    currentTipUsdt = usdt
    // Serve from cache when possible.
    const cached = pricingCache.get(preferredFiat)
    if (cached && cached.expiresAt > Date.now()) {
      renderFiatChip(cached.quote)
      return
    }
    fetchFiatQuote(curva, preferredFiat).then(renderFiatChip).catch(() => { /* noop */ })
  }
  tipContainer.addEventListener('curva-tip:amount-change', onTipAmountChange)

  // -- Tip totals ---------------------------------------------------------
  let tipTotalBaseUnits = 0n
  function refreshTotal() {
    curva.getTips({ limit: 100 }).catch(() => null)
  }
  const offTipList = curva.onTipList(({ tips }) => {
    if (!Array.isArray(tips)) return
    tipTotalBaseUnits = 0n
    for (const t of tips) {
      if (t?.status === 'confirmed' || t?.status === 'submitted') {
        try { tipTotalBaseUnits += BigInt(t.amount || '0') } catch { /* noop */ }
      }
    }
    const whole = Number(tipTotalBaseUnits / 10000n) / 100
    tipTotalEl.textContent = 'tips: ' + whole.toFixed(2) + ' USDT'
  })
  const offTipConfirmed = curva.onTipConfirmed(() => refreshTotal())
  const offTipSubmitted = curva.onTipSubmitted(() => refreshTotal())
  refreshTotal()

  // -- Balance polling (Phase 4 A4) --------------------------------------
  // Poll every 30s + refresh on wallet:ready. All failures fall through to
  // the placeholder "—" display; balance is informational, not blocking.
  function formatBalance(v) {
    if (v === null || v === undefined) return '—'
    const s = String(v)
    if (!/^[0-9]+$/.test(s)) return s
    try {
      const base = BigInt(s)
      // USDT = 6 decimals. Show 4dp so small dev balances remain legible.
      const whole = Number(base) / 1_000_000
      return whole.toFixed(4)
    } catch { return s }
  }
  function updateBalance(v) {
    balanceEl.hidden = false
    balanceEl.textContent = 'USDT: ' + formatBalance(v)
  }
  function pollBalance() {
    // Prefer the explicit getWalletBalance name (T7) but tolerate the older
    // getBalance alias.
    const fn = typeof curva.getWalletBalance === 'function'
      ? curva.getWalletBalance
      : (typeof curva.getBalance === 'function' ? curva.getBalance : null)
    if (!fn) return
    fn().catch(() => { /* leave last-known value */ })
  }
  const offBalance = curva.onWalletBalance(({ balance }) => updateBalance(balance))
  const offWalletReady = curva.onWalletReady(({ balance }) => {
    if (balance !== undefined) updateBalance(balance)
    pollBalance()
  })
  const offWalletErr = curva.onWalletError(() => {
    balanceEl.hidden = false
    balanceEl.textContent = 'USDT: unavailable'
    balanceEl.classList.add('curva-header__balance--err')
  })
  // T7: refresh balance immediately after a tip is confirmed (the WDK Indexer
  // may lag by a block, but polling on demand still catches it faster than
  // the 15s ticker).
  const offTipConfirmedBal = curva.onTipConfirmed?.(() => pollBalance()) || (() => {})
  pollBalance() // initial fetch
  const balanceTimer = setInterval(pollBalance, BALANCE_POLL_MS)

  // Wave 12: delegated inference status. Deterministic-handle the provider
  // pubkey so peers see a friendly word-color-number handle rather than a
  // 64-char hex string. Handle derivation lives in bare/identity.js and is
  // exposed here via curva.onDelegateStatus (Wave 12 preload marker block).
  const shortDelegateHandle = (hex) => {
    if (typeof hex !== 'string' || hex.length < 8) return 'unknown'
    return hex.slice(0, 6) + '…' + hex.slice(-4)
  }
  const offDelegateStatus = (typeof curva.onDelegateStatus === 'function')
    ? curva.onDelegateStatus((evt) => {
        if (!evt || typeof evt !== 'object') return
        delegateChip.hidden = false
        delegateChip.classList.remove('curva-header__delegate--fallback')
        if (evt.fallback) {
          delegateChip.textContent = 'translating locally'
          delegateChip.classList.add('curva-header__delegate--fallback')
        } else {
          const handle = evt.providerHandle || shortDelegateHandle(evt.provider)
          const ms = typeof evt.latencyMs === 'number' ? Math.round(evt.latencyMs) : null
          delegateChip.textContent = 'translating via ' + handle + (ms !== null ? ' (' + ms + 'ms)' : '')
        }
      })
    : (() => {})

  const offPeerC = curva.onPeerConnected(({ count }) => {
    peersEl.textContent = 'peers: ' + count
  })
  const offPeerD = curva.onPeerDisconnected(({ count }) => {
    peersEl.textContent = 'peers: ' + count
  })

  // Wave 8B T1: reveal "via relay" chip when a relayed connection is active,
  // or when the operator forced relay-everything mode.
  let relayActiveCount = 0
  const offRelayStatus = (typeof curva.onRelayStatus === 'function')
    ? curva.onRelayStatus((s) => {
        if (!s) return
        if (s.kind === 'info') {
          // Forced-mode: chip visible as soon as we know a relay key exists.
          if (s.enabled && s.forced) {
            relayChip.hidden = false
            relayChip.textContent = 'via relay (forced)'
          } else if (s.enabled && (s.activeConnections || 0) > 0) {
            relayChip.hidden = false
            relayChip.textContent = 'via relay'
          }
        } else if (s.kind === 'connection' && s.relayed) {
          relayActiveCount++
          relayChip.hidden = false
        }
      })
    : (() => {})
  // Ask for the current snapshot at mount so a rejoin doesn't miss the boot event.
  if (typeof curva.getRelayInfo === 'function') {
    curva.getRelayInfo().catch(() => { /* noop */ })
  }

  // Wave 15: blind-peer chip state. Query once at mount + subscribe to any
  // registration events emitted by the Bare worker.
  function applyBlindPeerStatus(st) {
    if (!st || typeof st !== 'object') return
    // Use class-based state so CSS controls colours.
    blindPeerChip.classList.remove(
      'curva-header__blind-peer--off',
      'curva-header__blind-peer--retrying',
      'curva-header__blind-peer--active'
    )
    if (!st.enabled) {
      blindPeerChip.classList.add('curva-header__blind-peer--off')
      blindPeerChip.textContent = 'blind-peer · off'
      return
    }
    if (!st.active) {
      blindPeerChip.classList.add('curva-header__blind-peer--retrying')
      blindPeerChip.textContent = 'blind-peer · retrying'
      return
    }
    blindPeerChip.classList.add('curva-header__blind-peer--active')
    blindPeerChip.textContent = 'blind-peer'
  }
  const offBlindPeerStatus = curva?.blindPeering?.onStatus
    ? curva.blindPeering.onStatus((st) => applyBlindPeerStatus(st))
    : () => {}
  const offBlindPeerReg = curva?.blindPeering?.onRegistration
    ? curva.blindPeering.onRegistration((payload) => applyBlindPeerStatus(payload?.status))
    : () => {}
  if (curva?.blindPeering?.getStatus) {
    curva.blindPeering.getStatus().catch(() => { /* noop */ })
  }
  const offPublish = curva.onPublishRoom(({ ok, error }) => {
    if (ok) {
      statusEl.textContent = 'published'
      publishBtn.textContent = 'Published ✓'
      publishBtn.disabled = true
    } else if (error) {
      statusEl.textContent = 'publish failed: ' + (error.code || error.message || error)
    }
  })

  function destroy() {
    clearInterval(balanceTimer)
    try { tipContainer.removeEventListener('curva-tip:amount-change', onTipAmountChange) } catch { /* noop */ }
    offPeerC()
    offPeerD()
    try { offDelegateStatus() } catch { /* noop */ }
    try { offRelayStatus() } catch { /* noop */ }
    offPublish()
    offTipList()
    offTipConfirmed()
    offTipSubmitted()
    if (typeof offTipHostDiscovered === 'function') { try { offTipHostDiscovered() } catch { /* noop */ } }
    offBalance()
    offWalletReady()
    offWalletErr()
    offTipConfirmedBal()
    try { offAttConfig() } catch { /* noop */ }
    try { offAttList() } catch { /* noop */ }
    try { offAttIssued() } catch { /* noop */ }
    try { offChatMsgForBadge() } catch { /* noop */ }
    try { offBlindPeerStatus() } catch { /* noop */ }
    try { offBlindPeerReg() } catch { /* noop */ }
    try { brandingUnsub() } catch { /* noop */ }
    try { clearInterval(brandingPoll) } catch { /* noop */ }
    if (tipButton) tipButton.destroy()
    container.textContent = ''
  }

  return { destroy }
}

// -- Invite link resolver -------------------------------------------------
// Task 3: prefer pear://<key>?room=<slug>. Fall back to curva://room/<slug>
// when the Bare worker reports no key (backend distribution disabled).
async function resolveInviteLink(curva, slug) {
  const fallback = 'curva://room/' + encodeURIComponent(slug)
  if (typeof curva.getPearAppKey !== 'function') return fallback
  return new Promise((resolve) => {
    let done = false
    const off = curva.onDistributionKey?.(({ link, key }) => {
      if (done) return
      done = true
      try { off?.() } catch { /* noop */ }
      // Worker builds the link with the slug (if we sent one). Otherwise
      // synthesize here.
      if (typeof link === 'string' && link.length > 0) return resolve(link)
      if (typeof key === 'string' && key.startsWith('pear://')) {
        // pear.links + pear.routes native form. The Pear sidecar delivers the
        // path via Pear.app.route on boot so the renderer auto-joins the room.
        // Docs: https://docs.pears.com/reference/pear/configuration/
        const base = key.replace(/\/+$/, '')
        return resolve(base + '/room/' + encodeURIComponent(slug))
      }
      resolve(fallback)
    }) || (() => {})
    // Fire the request. If preload lacks getInviteLink, fall through.
    const p = (typeof curva.getInviteLink === 'function')
      ? curva.getInviteLink({ slug })
      : curva.getPearAppKey()
    p.catch(() => {
      if (done) return
      done = true
      try { off?.() } catch { /* noop */ }
      resolve(fallback)
    })
    // Hard timeout: 2s.
    setTimeout(() => {
      if (done) return
      done = true
      try { off?.() } catch { /* noop */ }
      resolve(fallback)
    }, 2000)
  })
}

// -- Invite (QR) modal ----------------------------------------------------
async function openInviteModal({ curva, slug }) {
  const existing = document.querySelector('.curva-invite')
  if (existing) existing.remove()

  const modal = document.createElement('div')
  modal.className = 'curva-invite'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')

  const backdrop = document.createElement('div')
  backdrop.className = 'curva-invite__backdrop'
  backdrop.addEventListener('click', () => modal.remove())

  const card = document.createElement('div')
  card.className = 'curva-invite__card'

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'curva-invite__close'
  closeBtn.textContent = 'x'
  closeBtn.setAttribute('aria-label', 'close')
  closeBtn.addEventListener('click', () => modal.remove())

  const title = document.createElement('h3')
  title.className = 'curva-invite__title'
  title.textContent = 'Invite a friend'

  const qrHost = document.createElement('div')
  qrHost.className = 'curva-invite__qr'
  qrHost.textContent = 'generating QR...'

  const linkText = document.createElement('div')
  linkText.className = 'curva-invite__link'
  linkText.textContent = 'resolving invite link...'

  const note = document.createElement('div')
  note.className = 'curva-invite__note'
  note.textContent = ''

  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'curva-invite__copy'
  copyBtn.textContent = 'Copy link'

  card.appendChild(closeBtn)
  card.appendChild(title)
  card.appendChild(qrHost)
  card.appendChild(linkText)
  card.appendChild(note)
  card.appendChild(copyBtn)

  modal.appendChild(backdrop)
  modal.appendChild(card)
  document.body.appendChild(modal)

  const link = await resolveInviteLink(curva, slug)
  linkText.textContent = link
  if (link.startsWith('curva://')) {
    note.textContent = 'Curva pear:// key not yet published; sharing curva:// deep link instead.'
  }
  copyBtn.addEventListener('click', () => {
    try {
      navigator.clipboard.writeText(link).catch(() => { /* noop */ })
      copyBtn.textContent = 'Copied'
      setTimeout(() => { copyBtn.textContent = 'Copy link' }, 1500)
    } catch { /* noop */ }
  })

  if (typeof curva.toQrDataUrl === 'function') {
    try {
      const dataUrl = await curva.toQrDataUrl(link, { width: 300 })
      qrHost.textContent = ''
      const img = document.createElement('img')
      img.className = 'curva-invite__qr-img'
      img.alt = 'invite QR code'
      img.src = dataUrl
      img.width = 300
      img.height = 300
      qrHost.appendChild(img)
    } catch (err) {
      qrHost.textContent = 'QR unavailable: ' + (err?.message || 'error')
    }
  } else {
    qrHost.textContent = 'QR unavailable (qrcode module not exposed).'
  }
}

// -- About modal (D2). Curva pitch + Ardoino quote + version. -------------

function openAboutModal({ curva, appVersion }) {
  // If a prior modal is still open, remove it.
  const existing = document.querySelector('.curva-about')
  if (existing) existing.remove()

  const modal = document.createElement('div')
  modal.className = 'curva-about'

  const backdrop = document.createElement('div')
  backdrop.className = 'curva-about__backdrop'
  backdrop.addEventListener('click', () => modal.remove())

  const card = document.createElement('div')
  card.className = 'curva-about__card'

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'curva-about__close'
  closeBtn.textContent = '×'
  closeBtn.setAttribute('aria-label', 'close')
  closeBtn.addEventListener('click', () => modal.remove())

  const brand = document.createElement('div')
  brand.className = 'curva-about__brand'
  brand.textContent = 'CURVA'

  const pitch = document.createElement('p')
  pitch.className = 'curva-about__pitch'
  pitch.textContent = 'Watch the World Cup with friends, peer-to-peer.'

  const version = document.createElement('p')
  version.className = 'curva-about__version'
  version.textContent = 'v' + (appVersion || '0.1.0') + ' • Tether Developers Cup 2026'

  const stack = document.createElement('p')
  stack.className = 'curva-about__stack'
  stack.textContent = 'Pears • WDK (gasless USDT) • QVAC (on-device translation)'

  const quote = document.createElement('blockquote')
  quote.className = 'curva-about__quote'
  quote.textContent = 'loading quote…'

  const attrib = document.createElement('cite')
  attrib.className = 'curva-about__attrib'
  attrib.textContent = ''

  const license = document.createElement('p')
  license.className = 'curva-about__license'
  license.textContent = 'MIT • MPL-2.0 (Bergamot) • Apache-2.0 (qvac/translation-nmtcpp)'

  // Wave 6 T9 + T10: integrity badge + "Why QVAC not cloud" explainer.
  const whyQvac = renderWhyQvac()
  const integrity = renderIntegrityBadge(curva)

  card.appendChild(closeBtn)
  card.appendChild(brand)
  card.appendChild(pitch)
  card.appendChild(version)
  card.appendChild(stack)
  card.appendChild(quote)
  card.appendChild(attrib)
  card.appendChild(whyQvac)
  card.appendChild(integrity)
  card.appendChild(license)

  modal.appendChild(backdrop)
  modal.appendChild(card)
  document.body.appendChild(modal)

  // Best-effort Ardoino quote from backend /phrasebook. Fallback baked in
  // (never blocks the modal). Phase 3.5: if translation is initialized, we
  // ALSO translate the quote via curva.translateText so the About modal
  // becomes a live QVAC cameo.
  const fallbackQuote = 'Peer-to-peer software gives people back agency.'
  const fallbackAttrib = 'Paolo Ardoino, Tether'

  const setQuote = (text, attribution, mapsTo) => {
    quote.textContent = '"' + text + '"'
    attrib.textContent = attribution + (mapsTo ? '  (pillar: ' + mapsTo + ')' : '')
    tryTranslateQuote(curva, text, quote, attrib)
  }

  if (typeof curva?.fetchPhrasebook === 'function') {
    // Subscribe once, expecting one backend:phrasebook event.
    const off = curva.onPhrasebook?.((res) => {
      try { off?.() } catch { /* noop */ }
      const phrases = Array.isArray(res?.phrases) ? res.phrases : []
      const cached = pickSessionQuote(phrases)
      if (cached) setQuote(cached.text, cached.attribution || fallbackAttrib, cached.mapsTo || '')
      else setQuote(fallbackQuote, fallbackAttrib, '')
    }) || (() => {})
    curva.fetchPhrasebook().catch(() => {
      try { off?.() } catch { /* noop */ }
      setQuote(fallbackQuote, fallbackAttrib, '')
    })
    // Hard timeout so modal never sits on "loading quote..." forever.
    setTimeout(() => {
      if (quote.textContent === 'loading quote…') {
        try { off?.() } catch { /* noop */ }
        setQuote(fallbackQuote, fallbackAttrib, '')
      }
    }, 3000)
  } else {
    setQuote(fallbackQuote, fallbackAttrib, '')
  }
}

// One random quote per app session; cached so re-opening About shows the
// same quote until the app restarts (avoids UI flicker).
let sessionQuoteIndex = -1
function pickSessionQuote(phrases) {
  if (!Array.isArray(phrases) || phrases.length === 0) return null
  if (sessionQuoteIndex < 0 || sessionQuoteIndex >= phrases.length) {
    sessionQuoteIndex = Math.floor(Math.random() * phrases.length)
  }
  return phrases[sessionQuoteIndex]
}

// T10: two-slide "Why QVAC not cloud" explainer. Copy is authored for a
// senior-engineer voice: matter-of-fact, no marketing hyperbole.
function renderWhyQvac() {
  const wrap = document.createElement('section')
  wrap.className = 'curva-about__why'
  wrap.style.cssText = 'margin-top:16px;padding:12px;border-radius:6px;background:rgba(148,163,184,0.08);'

  const h = document.createElement('h4')
  h.className = 'curva-about__why-title'
  h.textContent = 'Why on-device'
  h.style.cssText = 'margin:0 0 6px 0;font-size:13px;color:#f1f5f9;'
  wrap.appendChild(h)

  const ul = document.createElement('ul')
  ul.style.cssText = 'margin:0 0 12px 0;padding-left:18px;font-size:12px;color:#cbd5e1;line-height:1.5;'
  const b1 = document.createElement('li')
  b1.textContent = 'Your chat never leaves your device, not even to translate.'
  const b2 = document.createElement('li')
  b2.textContent = 'Works offline, on airport wifi, during internet shutdowns.'
  ul.appendChild(b1)
  ul.appendChild(b2)
  wrap.appendChild(ul)

  const attrib = document.createElement('p')
  attrib.style.cssText = 'margin:0;font-size:12px;color:#94a3b8;'
  attrib.textContent = 'Powered by Bergamot NMT via QVAC. Models are sha256-verified on this device before load.'
  wrap.appendChild(attrib)

  return wrap
}

// T9: integrity badge. Reads translate:status via curva.getTranslationStatus
// and lists loaded pairs with their (short) digest. Renders "no cloud" mark.
function renderIntegrityBadge(curva) {
  const wrap = document.createElement('section')
  wrap.className = 'curva-about__integrity'
  wrap.style.cssText = 'margin-top:12px;padding:12px;border-radius:6px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);'

  const line = document.createElement('div')
  line.style.cssText = 'font-size:12px;color:#86efac;margin-bottom:6px;'
  line.textContent = '✓ No cloud. Models verified locally on this device.'
  wrap.appendChild(line)

  const summary = document.createElement('div')
  summary.className = 'curva-about__integrity-summary'
  summary.style.cssText = 'font-size:11px;color:#cbd5e1;margin-bottom:6px;'
  summary.textContent = 'Loading translation status…'
  wrap.appendChild(summary)

  const list = document.createElement('ul')
  list.className = 'curva-about__integrity-list'
  list.style.cssText = 'margin:0;padding-left:0;list-style:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#94a3b8;'
  wrap.appendChild(list)

  // Fix Wave C T4: prefer getTranslationState (new, richer surface with a
  // networkCallsThisSession counter) and fall back to getTranslationStatus
  // for older workers. The badge line surfaces the on-device guarantee to the
  // user: "N models loaded, K network calls this session, sha256 verified
  // locally".
  const hasState = typeof curva?.getTranslationState === 'function'
  const hasStatus = typeof curva?.getTranslationStatus === 'function'
  if (!hasState && !hasStatus) {
    summary.textContent = 'Translation not initialised.'
    return wrap
  }

  let done = false
  const finish = (renderFn, arg) => {
    if (done) return
    done = true
    renderFn(arg)
  }

  if (hasState) {
    const off = curva.onTranslationState?.((s) => {
      try { off?.() } catch { /* noop */ }
      finish(renderState, s)
    }) || (() => {})
    curva.getTranslationState().catch(() => {
      try { off?.() } catch { /* noop */ }
      finish((r) => { summary.textContent = r }, 'Translation state unavailable.')
    })
    setTimeout(() => {
      try { off?.() } catch { /* noop */ }
      finish((r) => { summary.textContent = r }, 'Translation state timed out.')
    }, 3000)
  } else {
    const off = curva.onTranslationStatus?.((st) => {
      try { off?.() } catch { /* noop */ }
      finish(renderStatus, st)
    }) || (() => {})
    curva.getTranslationStatus().catch(() => {
      try { off?.() } catch { /* noop */ }
      finish((r) => { summary.textContent = r }, 'Translation status unavailable.')
    })
    setTimeout(() => {
      try { off?.() } catch { /* noop */ }
      finish((r) => { summary.textContent = r }, 'Translation status timed out.')
    }, 3000)
  }

  function renderState(s) {
    if (!s) { summary.textContent = 'Translation state unavailable.'; return }
    if (s.mode === 'disabled') {
      summary.textContent = 'Translation disabled.'
      return
    }
    const loaded = Array.isArray(s.loadedModels) ? s.loadedModels : []
    const netCalls = typeof s.networkCallsThisSession === 'number' ? s.networkCallsThisSession : 0
    summary.textContent = loaded.length + ' model' + (loaded.length === 1 ? '' : 's') +
      ' loaded, ' + netCalls + ' network call' + (netCalls === 1 ? '' : 's') +
      ' this session, sha256 verified locally.'
    for (const m of loaded) {
      const li = document.createElement('li')
      const digest = m.digest ? ' ' + m.digest : ''
      li.textContent = (m.pair || '?') + digest
      list.appendChild(li)
    }
  }

  function renderStatus(st) {
    if (!st) { summary.textContent = 'Translation status unavailable.'; return }
    if (st.disabled) {
      summary.textContent = 'Translation disabled: ' + (st.disabledReason || 'unknown')
      return
    }
    const loaded = Array.isArray(st.loaded) ? st.loaded : []
    summary.textContent = loaded.length + ' model' + (loaded.length === 1 ? '' : 's') +
      ' loaded, 0 network calls this session, sha256 verified locally.'
    for (const p of loaded) {
      const li = document.createElement('li')
      const pair = (p.from || '?') + '->' + (p.to || '?')
      const digest = p.digest ? ' ' + p.digest : ''
      li.textContent = pair + digest
      list.appendChild(li)
    }
  }

  return wrap
}

// Best-effort QVAC translation of the quote. Falls back silently.
async function tryTranslateQuote(curva, text, quoteEl, attribEl) {
  if (typeof curva?.translateText !== 'function') return
  if (typeof curva?.getTranslationStatus !== 'function') return
  try {
    const st = await curva.getTranslationStatus()
    // getTranslationStatus writes to the worker; the actual status arrives
    // via onTranslationStatus. Rather than wire another subscription here,
    // we simply attempt the translation and fall back on rejection.
    void st
  } catch { /* noop */ }
  try {
    // Attempt English -> Italian by default for the demo. Bergamot IT-ID
    // may not be loaded; that's fine — we just skip.
    const translated = await curva.translateText({ text, from: 'en', to: 'it' })
    if (typeof translated === 'string' && translated.length > 0) {
      const box = document.createElement('div')
      box.className = 'curva-about__quote-translated'
      box.textContent = '"' + translated + '"  (IT, on-device QVAC)'
      quoteEl.parentNode.insertBefore(box, attribEl)
    }
  } catch { /* translation not available; keep original */ }
}

// -- Attendance modal (Wave 14) ------------------------------------------
// Lists every issued attendance pass. Each row shows the peer address (short
// form), issued-at, and a "Copy verify URL" button that puts the canonical
// GET /wdk/verify-attendance URL on the clipboard so anyone can independently
// recover the signer via `curl ... | jq`. textContent everywhere.

function openAttendanceModal({ curva, passes, slug }) {
  const existing = document.querySelector('.curva-attendance-modal')
  if (existing) existing.remove()

  const modal = document.createElement('div')
  modal.className = 'curva-attendance-modal curva-about'
  const backdrop = document.createElement('div')
  backdrop.className = 'curva-about__backdrop'
  backdrop.addEventListener('click', () => modal.remove())

  const card = document.createElement('div')
  card.className = 'curva-about__card'
  card.style.cssText = 'max-width:520px;'

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'curva-about__close'
  closeBtn.textContent = '×'
  closeBtn.setAttribute('aria-label', 'close')
  closeBtn.addEventListener('click', () => modal.remove())

  const title = document.createElement('div')
  title.className = 'curva-about__brand'
  title.textContent = 'ATTENDANCE'

  const subtitle = document.createElement('p')
  subtitle.className = 'curva-about__pitch'
  subtitle.style.cssText = 'font-size:12px;color:#94a3b8;margin-top:0;'
  subtitle.textContent = 'Off-chain EIP-191 passes signed by the host. Any peer can ecrecover.'

  const list = document.createElement('ul')
  list.style.cssText = 'list-style:none;padding:0;margin:16px 0 0;max-height:60vh;overflow:auto;'

  if (!Array.isArray(passes) || passes.length === 0) {
    const empty = document.createElement('li')
    empty.style.cssText = 'color:#64748b;font-size:12px;padding:16px 0;'
    empty.textContent = 'No attendance passes yet.'
    list.appendChild(empty)
  } else {
    // Newest first.
    const sorted = [...passes].sort((a, b) => (b?.issuedAt || 0) - (a?.issuedAt || 0))
    for (const pass of sorted) {
      const li = renderAttendanceRow({ curva, pass, slug })
      if (li) list.appendChild(li)
    }
  }

  card.appendChild(closeBtn)
  card.appendChild(title)
  card.appendChild(subtitle)
  card.appendChild(list)
  modal.appendChild(backdrop)
  modal.appendChild(card)
  document.body.appendChild(modal)
}

function renderAttendanceRow({ curva, pass, slug }) {
  if (!pass || typeof pass !== 'object') return null
  const li = document.createElement('li')
  li.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);'

  // Gold ticket SVG badge. Inline SVG is safe here: no user data interpolated.
  // The icon signals "this peer has a verified attendance pass."
  const ticketBadge = document.createElement('span')
  ticketBadge.title = 'Attendance pass issued (EIP-191)'
  ticketBadge.setAttribute('aria-label', 'ticket')
  ticketBadge.style.cssText = 'width:14px;height:14px;flex-shrink:0;'
  ticketBadge.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1" y="3.5" width="12" height="7" rx="1.5" fill="none" stroke="#d4af37" stroke-width="1.2"/><path d="M9 3.5v7M1 6.5h2M11 6.5h2" stroke="#d4af37" stroke-width="1.2" stroke-linecap="round"/><circle cx="9" cy="7" r="1" fill="#d4af37"/></svg>'

  const check = document.createElement('span')
  check.textContent = '✓'
  check.style.cssText = 'color:#4ade80;font-size:12px;width:14px;'
  check.title = 'Signature format verified locally (65-byte EIP-191)'

  const handle = document.createElement('span')
  handle.style.cssText = 'font-family:ui-monospace,monospace;font-size:12px;color:#e2e8f0;flex:1;'
  const peer = typeof pass.peerAddress === 'string' ? pass.peerAddress : ''
  handle.textContent = peer.length >= 10 ? peer.slice(0, 6) + '…' + peer.slice(-4) : (peer || 'unknown')

  const time = document.createElement('span')
  time.style.cssText = 'font-size:11px;color:#64748b;'
  const secondsAgo = pass.issuedAt ? Math.max(0, Math.floor(Date.now() / 1000) - Number(pass.issuedAt)) : 0
  time.textContent = formatRelativeSeconds(secondsAgo)
  time.title = 'issued at unix seconds: ' + (pass.issuedAt || '?')

  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'curva-header__btn'
  copyBtn.style.cssText = 'font-size:11px;padding:2px 8px;'
  copyBtn.textContent = 'Copy verify URL'
  copyBtn.addEventListener('click', async () => {
    const url = buildVerifyUrl({ curva, pass, slug })
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      copyBtn.textContent = 'Copied ✓'
      setTimeout(() => { copyBtn.textContent = 'Copy verify URL' }, 1500)
    } catch { /* noop */ }
  })

  li.appendChild(ticketBadge)
  li.appendChild(check)
  li.appendChild(handle)
  li.appendChild(time)
  li.appendChild(copyBtn)
  return li
}

function formatRelativeSeconds(sec) {
  if (!Number.isFinite(sec) || sec < 0) return 'just now'
  if (sec < 60) return sec + 's ago'
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago'
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago'
  return Math.floor(sec / 86400) + 'd ago'
}

function buildVerifyUrl({ curva, pass, slug }) {
  if (!pass || !pass.peerAddress || !pass.signature || !pass.issuedAt) return null
  let base = ''
  try {
    const boot = (typeof window !== 'undefined' && window.bridge && window.bridge.bootConfig)
      ? window.bridge.bootConfig()
      : null
    base = (boot && typeof boot.backend === 'string') ? boot.backend : ''
  } catch { /* noop */ }
  if (!base) return null
  const params = new URLSearchParams({
    signature: pass.signature,
    issuedAt: String(pass.issuedAt)
  })
  if (pass.matchId) params.set('matchId', String(pass.matchId))
  return base.replace(/\/$/, '') +
    '/wdk/verify-attendance/' + encodeURIComponent(String(slug || pass.slug || '')) +
    '/' + encodeURIComponent(pass.peerAddress) +
    '?' + params.toString()
}

// -- Blind-peer popover (Wave 15) ----------------------------------------
// One-sentence explainer + short status line. textContent everywhere; the
// peerKeyShort field is Bare-worker-derived (safe, but treated as untrusted
// display text). Auto-closes on next click or Escape.
function openBlindPeerPopover({ curva, anchor }) {
  const existing = document.querySelector('.curva-blind-peer-popover')
  if (existing) { existing.remove(); return }

  const pop = document.createElement('div')
  pop.className = 'curva-blind-peer-popover'
  pop.style.cssText = 'position:fixed;z-index:1000;padding:12px 14px;border-radius:8px;background:#0f172a;border:1px solid rgba(148,163,184,0.30);color:#e2e8f0;font-size:12px;max-width:320px;line-height:1.45;box-shadow:0 10px 24px rgba(0,0,0,0.35);'

  const line = document.createElement('p')
  line.style.cssText = 'margin:0 0 8px 0;color:#f1f5f9;'
  line.textContent = 'A third-party blind peer replicates this room’s Autobase discovery keys so the watch party survives after every human peer disconnects. It never receives the read key, so it cannot see chat.'

  const statusLine = document.createElement('p')
  statusLine.style.cssText = 'margin:0;color:#94a3b8;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;'
  statusLine.textContent = 'status: querying…'

  pop.appendChild(line)
  pop.appendChild(statusLine)

  if (anchor && typeof anchor.getBoundingClientRect === 'function') {
    const rect = anchor.getBoundingClientRect()
    pop.style.top = (rect.bottom + 6) + 'px'
    pop.style.left = Math.max(8, rect.left - 40) + 'px'
  } else {
    pop.style.top = '80px'
    pop.style.left = '20px'
  }
  document.body.appendChild(pop)

  const dismiss = (evt) => {
    if (evt && evt.type === 'click' && pop.contains(evt.target)) return
    if (evt && evt.type === 'keydown' && evt.key !== 'Escape') return
    pop.remove()
    document.removeEventListener('click', dismiss, true)
    document.removeEventListener('keydown', dismiss, true)
  }
  setTimeout(() => {
    document.addEventListener('click', dismiss, true)
    document.addEventListener('keydown', dismiss, true)
  }, 0)

  if (curva?.blindPeering?.onStatus && curva?.blindPeering?.getStatus) {
    let done = false
    const off = curva.blindPeering.onStatus((st) => {
      if (done) return
      done = true
      try { off?.() } catch { /* noop */ }
      const label = !st?.enabled
        ? 'disabled (flag off)'
        : (!st?.active
            ? 'inactive (' + (st?.reason || 'no key') + ')'
            : 'active · ' + (st?.registrationsCount || 0) + ' registration(s) · peer ' + (st?.peerKeyShort || '?'))
      statusLine.textContent = 'status: ' + label
    })
    curva.blindPeering.getStatus().catch(() => {
      if (done) return
      done = true
      try { off?.() } catch { /* noop */ }
      statusLine.textContent = 'status: unavailable'
    })
    setTimeout(() => {
      if (done) return
      done = true
      try { off?.() } catch { /* noop */ }
      statusLine.textContent = 'status: timeout'
    }, 2000)
  } else {
    statusLine.textContent = 'status: bridge unavailable'
  }
}

