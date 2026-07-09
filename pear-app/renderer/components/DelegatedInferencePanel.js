// Curva DelegatedInferencePanel: Semifinal QVAC depth renderer.
//
// Consumes the `curva.delegated` bridge (electron/preload.js) which fans out
// to bare/delegatedProvider.js -> @qvac/sdk startQVACProvider + loadModel(
// {delegate}) + Hyperbee provider index.
//
// UI:
//   - Header: title + a status chip ("off" / "started (pubkey)")
//   - Firewall toggle: allow / deny + comma-separated pubkey allowlist
//   - Provider grid: one row per Hyperbee entry:
//       [short-pubkey] [models] [last-ping ms] [Test] [Allow] [Block]
//
// Security discipline (matches Chat.js / CommentaryPanel.js):
//   - Every user/model-supplied string is set via textContent, never innerHTML
//   - Pubkeys are validated as 64-char hex on both preload + worker sides
//   - No external URLs. No inline event handlers on non-controlled DOM.

const SHORT_PUBKEY_LEN = 12   // display "aabbccddeeff...11223344ff"

function shortenPubkey(pk) {
  if (typeof pk !== 'string' || pk.length < 20) return String(pk || '')
  return pk.slice(0, SHORT_PUBKEY_LEN) + '…' + pk.slice(-6)
}

function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1000) return ms + ' ms'
  return (ms / 1000).toFixed(2) + ' s'
}

export async function isDelegatedPanelEnabled(curva) {
  if (!curva?.delegated?.snapshot) return false
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    await Promise.race([curva.delegated.snapshot(), timeout])
    return true
  } catch { return false }
}

export function mountDelegatedInferencePanel({ container, curva, roomState } = {}) {
  if (!container) throw new TypeError('container required')
  if (!curva?.delegated) throw new TypeError('curva.delegated bridge required')

  const isHost = !!(roomState && roomState.isHost)

  container.textContent = ''
  container.classList.add('curva-delegated')

  // -- Header ---------------------------------------------------------------
  const header = document.createElement('div')
  header.className = 'curva-delegated__header'
  const title = document.createElement('span')
  title.className = 'curva-delegated__title'
  title.textContent = 'Delegated Inference (P2P)'
  const chip = document.createElement('span')
  chip.className = 'curva-delegated__chip'
  chip.textContent = 'off'
  header.appendChild(title)
  header.appendChild(chip)
  container.appendChild(header)

  // -- Firewall row (host-only controls) -------------------------------------
  const firewall = document.createElement('div')
  firewall.className = 'curva-delegated__firewall'
  const modeLabel = document.createElement('label')
  modeLabel.className = 'curva-delegated__mode-label'
  modeLabel.textContent = 'Firewall mode'
  const modeSel = document.createElement('select')
  modeSel.className = 'curva-delegated__mode'
  modeSel.disabled = !isHost
  const optAllow = document.createElement('option')
  optAllow.value = 'allow'; optAllow.textContent = 'allow (allowlist)'
  const optDeny = document.createElement('option')
  optDeny.value = 'deny'; optDeny.textContent = 'deny (blocklist)'
  modeSel.appendChild(optAllow)
  modeSel.appendChild(optDeny)
  modeLabel.appendChild(modeSel)
  firewall.appendChild(modeLabel)

  const keysInput = document.createElement('input')
  keysInput.className = 'curva-delegated__keys'
  keysInput.type = 'text'
  keysInput.placeholder = 'Comma-separated 64-hex pubkeys'
  keysInput.disabled = !isHost
  keysInput.maxLength = 4096
  firewall.appendChild(keysInput)

  const applyBtn = document.createElement('button')
  applyBtn.type = 'button'
  applyBtn.className = 'curva-delegated__apply'
  applyBtn.textContent = 'Apply firewall'
  applyBtn.disabled = !isHost
  firewall.appendChild(applyBtn)
  container.appendChild(firewall)

  // -- Provider grid --------------------------------------------------------
  const grid = document.createElement('div')
  grid.className = 'curva-delegated__grid'
  container.appendChild(grid)

  const empty = document.createElement('div')
  empty.className = 'curva-delegated__empty'
  empty.textContent = 'No providers advertised in this room yet.'
  container.appendChild(empty)

  const errorBanner = document.createElement('div')
  errorBanner.className = 'curva-delegated__error'
  errorBanner.hidden = true
  container.appendChild(errorBanner)

  function setError(msg) {
    if (!msg) { errorBanner.hidden = true; errorBanner.textContent = ''; return }
    errorBanner.hidden = false
    errorBanner.textContent = String(msg).slice(0, 240)
  }

  // Per-pubkey latest ping cache so re-renders after list() do not wipe it.
  const pingByPubkey = new Map()   // hex -> { ok, roundTripMs, error, at }

  function renderRows(providers) {
    grid.textContent = ''
    if (!Array.isArray(providers) || providers.length === 0) {
      empty.hidden = false
      return
    }
    empty.hidden = true
    for (const p of providers) {
      const row = document.createElement('div')
      row.className = 'curva-delegated__row'

      const pkEl = document.createElement('span')
      pkEl.className = 'curva-delegated__pubkey'
      pkEl.textContent = shortenPubkey(p.pubkey)
      pkEl.title = p.pubkey
      row.appendChild(pkEl)

      const modelsEl = document.createElement('span')
      modelsEl.className = 'curva-delegated__models'
      const models = Array.isArray(p.models) ? p.models.slice(0, 4) : []
      modelsEl.textContent = models.length > 0 ? models.join(', ') : '(no models advertised)'
      row.appendChild(modelsEl)

      const pingEl = document.createElement('span')
      pingEl.className = 'curva-delegated__ping'
      const last = pingByPubkey.get(p.pubkey)
      if (!last) {
        pingEl.textContent = '-'
      } else if (last.ok) {
        pingEl.textContent = '✓ ' + fmtMs(last.roundTripMs)
        pingEl.classList.add('curva-delegated__ping--ok')
      } else {
        pingEl.textContent = '✗ ' + fmtMs(last.roundTripMs)
        pingEl.classList.add('curva-delegated__ping--err')
      }
      row.appendChild(pingEl)

      const testBtn = document.createElement('button')
      testBtn.type = 'button'
      testBtn.className = 'curva-delegated__test'
      testBtn.textContent = 'Test'
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true
        testBtn.textContent = 'Testing…'
        try {
          const res = await curva.delegated.ping(p.pubkey)
          const entry = {
            ok: !!(res && res.ok),
            roundTripMs: Number(res && res.roundTripMs) || 0,
            error: (res && res.error) || null,
            at: Date.now()
          }
          pingByPubkey.set(p.pubkey, entry)
          renderRows(providers)
        } catch (err) {
          setError('ping failed: ' + (err?.message || 'unknown'))
        } finally {
          testBtn.disabled = false
        }
      })
      row.appendChild(testBtn)

      if (isHost) {
        const allowBtn = document.createElement('button')
        allowBtn.type = 'button'
        allowBtn.className = 'curva-delegated__allow'
        allowBtn.textContent = 'Allow'
        allowBtn.addEventListener('click', () => togglePubkeyInList(p.pubkey, 'allow'))
        row.appendChild(allowBtn)

        const blockBtn = document.createElement('button')
        blockBtn.type = 'button'
        blockBtn.className = 'curva-delegated__block'
        blockBtn.textContent = 'Block'
        blockBtn.addEventListener('click', () => togglePubkeyInList(p.pubkey, 'deny'))
        row.appendChild(blockBtn)
      }

      grid.appendChild(row)
    }
  }

  function togglePubkeyInList(pubkey, mode) {
    const existing = keysInput.value.split(',').map((s) => s.trim()).filter(Boolean)
    if (!existing.includes(pubkey)) existing.push(pubkey)
    keysInput.value = existing.join(', ')
    modeSel.value = mode
  }

  applyBtn.addEventListener('click', async () => {
    if (!isHost) return
    const raw = keysInput.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const publicKeys = raw.filter((k) => /^[0-9a-f]{64}$/.test(k))
    if (publicKeys.length !== raw.length) {
      setError('Some pubkeys were invalid (must be 64-char hex).')
    } else {
      setError(null)
    }
    applyBtn.disabled = true
    applyBtn.textContent = 'Applying…'
    try {
      await curva.delegated.setFirewall({ mode: modeSel.value, publicKeys })
    } catch (err) {
      setError('firewall apply failed: ' + (err?.message || 'unknown'))
    } finally {
      applyBtn.disabled = false
      applyBtn.textContent = 'Apply firewall'
    }
  })

  // -- Data flow -----------------------------------------------------------
  async function refreshList() {
    try {
      await curva.delegated.list()
    } catch (err) {
      setError('list failed: ' + (err?.message || 'unknown'))
    }
  }

  const offs = []
  offs.push(curva.delegated.onList((payload) => {
    renderRows((payload && payload.providers) || [])
  }))
  offs.push(curva.delegated.onPinged((payload) => {
    if (payload && typeof payload.pubkey === 'string') {
      pingByPubkey.set(payload.pubkey, {
        ok: !!payload.ok,
        roundTripMs: Number(payload.roundTripMs) || 0,
        error: payload.error || null,
        at: Date.now()
      })
    }
  }))
  offs.push(curva.delegated.onStarted((payload) => {
    chip.textContent = payload && payload.publicKey
      ? 'started · ' + shortenPubkey(payload.publicKey)
      : 'started'
  }))
  offs.push(curva.delegated.onError((payload) => {
    setError((payload && (payload.message || payload.code)) || 'delegated error')
  }))

  // Kick a first list + snapshot fetch.
  refreshList()
  try {
    curva.delegated.snapshot().then((snap) => {
      if (snap && snap.publicKey) {
        chip.textContent = 'started · ' + shortenPubkey(snap.publicKey)
      }
    }).catch(() => { /* noop */ })
  } catch { /* noop */ }

  // Poll list every 15s for freshness (Hyperbee updates are eventual).
  const timer = setInterval(refreshList, 15_000)
  try { timer.unref && timer.unref() } catch { /* noop */ }

  return {
    destroy() {
      try { clearInterval(timer) } catch { /* noop */ }
      for (const off of offs) { try { off && off() } catch { /* noop */ } }
      container.textContent = ''
      container.classList.remove('curva-delegated')
    },
    refresh: refreshList
  }
}
