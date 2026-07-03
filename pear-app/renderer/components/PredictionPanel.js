// Curva PredictionPanel: Wave 11 renderer for the Match Prediction Pool.
//
// Two variants toggled by `isHost`:
//   Host: "Open pool" form -> live pool status -> "Publish result" form ->
//         winners grid with Sepolia tx links.
//   Peer: prediction form -> "Stake N USDT" -> waiting state -> personal
//         outcome row post-settlement.
//
// The feature flag is checked twice: once via curva.predictions.getConfig
// (which returns { enabled, clientReady, isHost }) before mounting anything
// interactive, and again on every action via the Bare worker (defense in
// depth). If the flag is off, the panel renders nothing — see the
// early-return in mountPredictionPanel.
//
// Security discipline (mirrors Chat.js):
//   - EVERY peer/backend-supplied string is set via textContent, never
//     innerHTML. This includes handles, matchId, tx hashes, error messages.
//   - Sepolia links go through curva.openExternal which is host-allowlisted
//     to sepolia.etherscan.io.

const DEFAULT_STAKE_PRESETS = [
  { label: '1 USDT',  value: '1000000' },
  { label: '5 USDT',  value: '5000000' },
  { label: '10 USDT', value: '10000000' }
]
const WINNERS = ['HOME', 'AWAY', 'DRAW']

export function mountPredictionPanel({ container, curva, roomState, appVersion } = {}) {
  if (!container) throw new TypeError('container required')
  if (!curva) throw new TypeError('curva bridge required')

  const isHost = !!(roomState && roomState.isHost)
  const matchId = roomState?.matchId || null
  const roomSlug = roomState?.slug || null

  container.textContent = ''
  container.classList.add('curva-predictions')

  // Header row with title + status chip. Rendered unconditionally so the panel
  // has visual weight even when the pool has not yet been opened. Voice:
  // deliberately short — the demo audience should be able to read this at a
  // glance from the back of a keynote hall.
  const header = document.createElement('div')
  header.className = 'curva-predictions__header'
  const title = document.createElement('span')
  title.className = 'curva-predictions__title'
  title.textContent = 'Prediction Pool'
  const statusChip = document.createElement('span')
  statusChip.className = 'curva-predictions__chip'
  statusChip.textContent = 'checking…'
  header.appendChild(title)
  header.appendChild(statusChip)
  container.appendChild(header)

  const body = document.createElement('div')
  body.className = 'curva-predictions__body'
  container.appendChild(body)

  const errorBanner = document.createElement('div')
  errorBanner.className = 'curva-predictions__error'
  errorBanner.hidden = true
  container.appendChild(errorBanner)

  // State cache. Updated on every getStatus response + on predictions:opened /
  // predictions:submitted / predictions:result-published / activity SSE.
  const state = {
    enabled: null,          // null | true | false
    clientReady: false,
    pool: null,             // pool snapshot from getPoolStatus
    myPrediction: null,     // matched by peer address once known
    mySmartAddress: null,   // filled by wallet:ready event
    myOwnerAddress: null,
    pollTimer: null,
    destroyed: false
  }

  // ------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------
  function setError(msg) {
    if (!msg) { errorBanner.hidden = true; errorBanner.textContent = ''; return }
    errorBanner.hidden = false
    errorBanner.textContent = String(msg)
  }

  function setChip(text, kind) {
    statusChip.textContent = text
    statusChip.classList.remove(
      'curva-predictions__chip--open',
      'curva-predictions__chip--locked',
      'curva-predictions__chip--settled',
      'curva-predictions__chip--disabled'
    )
    if (kind) statusChip.classList.add('curva-predictions__chip--' + kind)
  }

  function fmtUsdt(atomicStr) {
    if (typeof atomicStr !== 'string' || !/^[0-9]+$/.test(atomicStr)) return '?'
    try {
      const whole = Number(BigInt(atomicStr)) / 1_000_000
      return whole.toFixed(whole >= 1 && Number.isInteger(whole) ? 0 : 2)
    } catch { return '?' }
  }

  function fmtCountdown(deadlineMsRaw) {
    const deadline = Number(deadlineMsRaw)
    if (!Number.isFinite(deadline)) return ''
    const now = Date.now()
    if (deadline <= now) return 'closed'
    const s = Math.floor((deadline - now) / 1000)
    const m = Math.floor(s / 60)
    const rest = s % 60
    if (m >= 60) {
      const h = Math.floor(m / 60)
      return `${h}h ${m % 60}m`
    }
    return `${m}m ${rest}s`
  }

  function clearBody() {
    body.textContent = ''
  }

  // ------------------------------------------------------------
  // Host: open-pool form
  // ------------------------------------------------------------
  function renderHostOpenForm() {
    clearBody()
    if (!matchId) {
      const hint = document.createElement('div')
      hint.className = 'curva-predictions__hint'
      hint.textContent = 'Join a room for a match to open a prediction pool.'
      body.appendChild(hint)
      return
    }

    const form = document.createElement('form')
    form.className = 'curva-predictions__form'

    const modeLabel = document.createElement('label')
    modeLabel.className = 'curva-predictions__field'
    const modeText = document.createElement('span')
    modeText.textContent = 'Mode'
    const modeSel = document.createElement('select')
    modeSel.className = 'curva-predictions__select'
    for (const [val, label] of [['winner-only', 'Winner only'], ['exact-score', 'Exact score']]) {
      const opt = document.createElement('option')
      opt.value = val
      opt.textContent = label
      modeSel.appendChild(opt)
    }
    modeLabel.appendChild(modeText)
    modeLabel.appendChild(modeSel)

    const stakeLabel = document.createElement('label')
    stakeLabel.className = 'curva-predictions__field'
    const stakeText = document.createElement('span')
    stakeText.textContent = 'Entry stake'
    const stakeSel = document.createElement('select')
    stakeSel.className = 'curva-predictions__select'
    for (const preset of DEFAULT_STAKE_PRESETS) {
      const opt = document.createElement('option')
      opt.value = preset.value
      opt.textContent = preset.label
      stakeSel.appendChild(opt)
    }
    stakeLabel.appendChild(stakeText)
    stakeLabel.appendChild(stakeSel)

    const deadlineLabel = document.createElement('label')
    deadlineLabel.className = 'curva-predictions__field'
    const deadlineText = document.createElement('span')
    deadlineText.textContent = 'Deadline (minutes from now)'
    const deadlineInput = document.createElement('input')
    deadlineInput.type = 'number'
    deadlineInput.className = 'curva-predictions__input'
    deadlineInput.min = '2'
    deadlineInput.max = '360'
    deadlineInput.value = '20'
    deadlineLabel.appendChild(deadlineText)
    deadlineLabel.appendChild(deadlineInput)

    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.className = 'curva-predictions__btn curva-predictions__btn--primary'
    submit.textContent = 'Open pool'

    form.appendChild(modeLabel)
    form.appendChild(stakeLabel)
    form.appendChild(deadlineLabel)
    form.appendChild(submit)
    body.appendChild(form)

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      setError('')
      submit.disabled = true
      submit.textContent = 'Opening…'
      try {
        const minutes = Math.max(2, Math.min(360, Number(deadlineInput.value) || 20))
        const deadlineMs = Date.now() + minutes * 60_000
        await curva.predictions.openPool({
          matchId,
          mode: modeSel.value,
          entryStakeAtomic: stakeSel.value,
          deadlineMs
        })
        // The predictions:opened event handler triggers a fresh getStatus.
      } catch (err) {
        setError('Open pool failed: ' + (err?.message || 'unknown'))
      } finally {
        submit.disabled = false
        submit.textContent = 'Open pool'
      }
    })
  }

  // ------------------------------------------------------------
  // Host: publish-result form
  // ------------------------------------------------------------
  function renderHostResultForm(pool) {
    const form = document.createElement('form')
    form.className = 'curva-predictions__form curva-predictions__form--result'

    const title = document.createElement('div')
    title.className = 'curva-predictions__section-title'
    title.textContent = 'Publish result'
    form.appendChild(title)

    const winnerLabel = document.createElement('label')
    winnerLabel.className = 'curva-predictions__field'
    winnerLabel.appendChild(document.createTextNode('Winner'))
    const winnerSel = document.createElement('select')
    winnerSel.className = 'curva-predictions__select'
    for (const w of WINNERS) {
      const opt = document.createElement('option')
      opt.value = w
      opt.textContent = w
      winnerSel.appendChild(opt)
    }
    winnerLabel.appendChild(winnerSel)
    form.appendChild(winnerLabel)

    let hgInput = null
    let agInput = null
    if (pool.mode === 'exact-score') {
      const scoreWrap = document.createElement('div')
      scoreWrap.className = 'curva-predictions__row'
      const hgLabel = document.createElement('label')
      hgLabel.className = 'curva-predictions__field'
      hgLabel.appendChild(document.createTextNode('Home goals'))
      hgInput = document.createElement('input')
      hgInput.type = 'number'
      hgInput.min = '0'
      hgInput.max = '30'
      hgInput.value = '0'
      hgInput.className = 'curva-predictions__input'
      hgLabel.appendChild(hgInput)
      const agLabel = document.createElement('label')
      agLabel.className = 'curva-predictions__field'
      agLabel.appendChild(document.createTextNode('Away goals'))
      agInput = document.createElement('input')
      agInput.type = 'number'
      agInput.min = '0'
      agInput.max = '30'
      agInput.value = '0'
      agInput.className = 'curva-predictions__input'
      agLabel.appendChild(agInput)
      scoreWrap.appendChild(hgLabel)
      scoreWrap.appendChild(agLabel)
      form.appendChild(scoreWrap)
    }

    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.className = 'curva-predictions__btn curva-predictions__btn--primary'
    submit.textContent = 'Publish result'
    form.appendChild(submit)

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      setError('')
      submit.disabled = true
      submit.textContent = 'Publishing…'
      try {
        // For winner-only mode we still need HOME/AWAY/DRAW consistent goals.
        // Use 1-0 / 0-1 / 0-0 as canonical fillers so backend's deriveWinner
        // matches.
        let hg = hgInput ? Number(hgInput.value) : 0
        let ag = agInput ? Number(agInput.value) : 0
        if (pool.mode !== 'exact-score') {
          if (winnerSel.value === 'HOME') { hg = 1; ag = 0 }
          else if (winnerSel.value === 'AWAY') { hg = 0; ag = 1 }
          else { hg = 0; ag = 0 }
        }
        await curva.predictions.publishResult({
          poolId: pool.id,
          winner: winnerSel.value,
          homeGoals: hg,
          awayGoals: ag,
          matchId: pool.matchId
        })
      } catch (err) {
        setError('Publish result failed: ' + (err?.message || 'unknown'))
      } finally {
        submit.disabled = false
        submit.textContent = 'Publish result'
      }
    })

    body.appendChild(form)
  }

  // ------------------------------------------------------------
  // Peer: prediction form
  // ------------------------------------------------------------
  function renderPeerPredictionForm(pool) {
    const form = document.createElement('form')
    form.className = 'curva-predictions__form curva-predictions__form--predict'

    const winnerLabel = document.createElement('label')
    winnerLabel.className = 'curva-predictions__field'
    winnerLabel.appendChild(document.createTextNode('Your pick'))
    const winnerSel = document.createElement('select')
    winnerSel.className = 'curva-predictions__select'
    for (const w of WINNERS) {
      const opt = document.createElement('option')
      opt.value = w
      opt.textContent = w
      winnerSel.appendChild(opt)
    }
    winnerLabel.appendChild(winnerSel)
    form.appendChild(winnerLabel)

    let hgInput = null
    let agInput = null
    if (pool.mode === 'exact-score') {
      const scoreWrap = document.createElement('div')
      scoreWrap.className = 'curva-predictions__row'
      const hgLabel = document.createElement('label')
      hgLabel.className = 'curva-predictions__field'
      hgLabel.appendChild(document.createTextNode('Home'))
      hgInput = document.createElement('input')
      hgInput.type = 'number'
      hgInput.min = '0'
      hgInput.max = '30'
      hgInput.value = '1'
      hgInput.className = 'curva-predictions__input'
      hgLabel.appendChild(hgInput)
      const agLabel = document.createElement('label')
      agLabel.className = 'curva-predictions__field'
      agLabel.appendChild(document.createTextNode('Away'))
      agInput = document.createElement('input')
      agInput.type = 'number'
      agInput.min = '0'
      agInput.max = '30'
      agInput.value = '0'
      agInput.className = 'curva-predictions__input'
      agLabel.appendChild(agInput)
      scoreWrap.appendChild(hgLabel)
      scoreWrap.appendChild(agLabel)
      form.appendChild(scoreWrap)
    }

    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.className = 'curva-predictions__btn curva-predictions__btn--primary'
    submit.textContent = `Stake ${fmtUsdt(pool.entryStakeAtomic)} USDT`
    form.appendChild(submit)

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      setError('')
      submit.disabled = true
      submit.textContent = 'Signing…'
      try {
        await curva.predictions.submitPrediction({
          poolId: pool.id,
          winner: winnerSel.value,
          homeGoals: hgInput ? Number(hgInput.value) : undefined,
          awayGoals: agInput ? Number(agInput.value) : undefined,
          stakeAtomic: pool.entryStakeAtomic,
          poolAddress: pool.poolAddress,
          chainId: pool.chainId,
          stakeToken: pool.stakeToken,
          mode: pool.mode
        })
      } catch (err) {
        setError('Submit prediction failed: ' + (err?.message || 'unknown'))
      } finally {
        submit.disabled = false
        submit.textContent = `Stake ${fmtUsdt(pool.entryStakeAtomic)} USDT`
      }
    })
    body.appendChild(form)
  }

  // ------------------------------------------------------------
  // Common: pool metadata + entries list
  // ------------------------------------------------------------
  function renderPoolMeta(pool) {
    const meta = document.createElement('div')
    meta.className = 'curva-predictions__meta'
    const modeLine = document.createElement('div')
    modeLine.textContent = `${pool.mode === 'exact-score' ? 'Exact score' : 'Winner only'} · ${fmtUsdt(pool.entryStakeAtomic)} USDT entry`
    const countdownLine = document.createElement('div')
    countdownLine.className = 'curva-predictions__countdown'
    countdownLine.textContent = `Deadline: ${fmtCountdown(pool.deadlineMs)}`
    const stakedLine = document.createElement('div')
    stakedLine.className = 'curva-predictions__staked'
    stakedLine.textContent = `Total staked: ${fmtUsdt(pool.totalStakedAtomic || '0')} USDT`
    meta.appendChild(modeLine)
    meta.appendChild(countdownLine)
    meta.appendChild(stakedLine)
    body.appendChild(meta)
  }

  function renderEntriesList(pool) {
    const preds = Array.isArray(pool.predictions) ? pool.predictions : []
    if (preds.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'curva-predictions__empty'
      empty.textContent = 'No predictions yet.'
      body.appendChild(empty)
      return
    }
    const listTitle = document.createElement('div')
    listTitle.className = 'curva-predictions__section-title'
    listTitle.textContent = `Predictions (${preds.length})`
    body.appendChild(listTitle)

    const list = document.createElement('ul')
    list.className = 'curva-predictions__list'
    for (const p of preds) {
      const li = document.createElement('li')
      li.className = 'curva-predictions__row'
      const handleEl = document.createElement('span')
      handleEl.className = 'curva-predictions__handle'
      handleEl.textContent = p.peerHandle || p.peerAddress || 'peer'
      const pickEl = document.createElement('span')
      pickEl.className = 'curva-predictions__pick'
      const scorePart = (p.homeGoals !== null && p.awayGoals !== null && p.homeGoals !== undefined)
        ? ` ${p.homeGoals}-${p.awayGoals}` : ''
      pickEl.textContent = ` ${p.winner}${scorePart}`
      const stakeEl = document.createElement('span')
      stakeEl.className = 'curva-predictions__stake'
      stakeEl.textContent = ` · ${fmtUsdt(p.stakeAtomic)} USDT`
      li.appendChild(handleEl)
      li.appendChild(pickEl)
      li.appendChild(stakeEl)
      // Payout badge if this row won something
      if (p.status === 'won' && p.payoutAmountAtomic) {
        const won = document.createElement('span')
        won.className = 'curva-predictions__won'
        won.textContent = ` · won ${fmtUsdt(p.payoutAmountAtomic)} USDT`
        li.appendChild(won)
        if (typeof p.payoutTxHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(p.payoutTxHash)) {
          const link = document.createElement('a')
          link.href = '#'
          link.className = 'curva-predictions__txlink'
          link.textContent = ' tx'
          const explorer = 'https://sepolia.etherscan.io/tx/' + p.payoutTxHash
          link.addEventListener('click', (e) => {
            e.preventDefault()
            if (typeof curva.openExternal === 'function') {
              curva.openExternal(explorer).catch(() => { /* noop */ })
            }
          })
          li.appendChild(link)
        }
      }
      list.appendChild(li)
    }
    body.appendChild(list)
  }

  function renderResult(pool) {
    if (!pool.resultWinner) return
    const res = document.createElement('div')
    res.className = 'curva-predictions__result'
    res.textContent = `Result: ${pool.resultWinner} ${pool.resultHomeGoals ?? '?'}-${pool.resultAwayGoals ?? '?'}`
    body.appendChild(res)
  }

  // ------------------------------------------------------------
  // Top-level render orchestrator
  // ------------------------------------------------------------
  function render() {
    clearBody()
    if (state.enabled === false) {
      // Never reach here because we early-return in mount; kept defensive.
      setChip('disabled', 'disabled')
      const p = document.createElement('div')
      p.className = 'curva-predictions__hint'
      p.textContent = 'Prediction pool feature is disabled on this build.'
      body.appendChild(p)
      return
    }
    if (!state.pool || state.pool.exists === false) {
      // No pool yet.
      setChip('no pool', 'disabled')
      if (isHost) {
        renderHostOpenForm()
      } else {
        const hint = document.createElement('div')
        hint.className = 'curva-predictions__hint'
        hint.textContent = 'Waiting for the host to open a prediction pool for this match.'
        body.appendChild(hint)
      }
      return
    }
    const pool = state.pool
    const status = pool.status || 'unknown'
    if (status === 'open') setChip('open · ' + fmtCountdown(pool.deadlineMs), 'open')
    else if (status === 'locked') setChip('awaiting settlement', 'locked')
    else if (status === 'settled') setChip('settled', 'settled')
    else if (status === 'refunded') setChip('refunded', 'settled')
    else setChip(status, null)

    renderPoolMeta(pool)
    renderResult(pool)
    renderEntriesList(pool)

    if (isHost) {
      if (status === 'open') {
        // Show a small "close early" note (deadline countdown suffices for now).
      }
      if (status === 'locked' || (status === 'open' && Number(pool.deadlineMs) <= Date.now())) {
        renderHostResultForm(pool)
      }
    } else {
      // Peer flow: only allow submission while status is 'open' AND deadline
      // has not passed AND we have not already submitted.
      const now = Date.now()
      const canPredict = status === 'open' && Number(pool.deadlineMs) > now
      const alreadyPredicted = detectMyPrediction(pool)
      if (canPredict && !alreadyPredicted) {
        renderPeerPredictionForm(pool)
      } else if (alreadyPredicted) {
        const you = document.createElement('div')
        you.className = 'curva-predictions__you'
        const scorePart = (alreadyPredicted.homeGoals !== null && alreadyPredicted.homeGoals !== undefined)
          ? ` ${alreadyPredicted.homeGoals}-${alreadyPredicted.awayGoals}` : ''
        you.textContent = `Your pick: ${alreadyPredicted.winner}${scorePart} · ${fmtUsdt(alreadyPredicted.stakeAtomic)} USDT`
        body.appendChild(you)
        if (status === 'settled' && alreadyPredicted.status === 'won') {
          const wonMsg = document.createElement('div')
          wonMsg.className = 'curva-predictions__you-won'
          wonMsg.textContent = `You won ${fmtUsdt(alreadyPredicted.payoutAmountAtomic)} USDT!`
          body.appendChild(wonMsg)
        }
      }
    }
  }

  function detectMyPrediction(pool) {
    if (!pool || !Array.isArray(pool.predictions)) return null
    // Backend returns shortened peer addresses (via shortenAddress) so exact
    // matching is not always possible. We fall back to peerHandle if the
    // wallet address is not in the row.
    const preds = pool.predictions
    if (state.mySmartAddress) {
      const target = state.mySmartAddress.toLowerCase()
      for (const p of preds) {
        if (typeof p.peerAddress === 'string' && p.peerAddress.toLowerCase() === target) return p
      }
    }
    // handle match: rendered handles are unique per session.
    if (roomState?.handle) {
      const h = String(roomState.handle).toLowerCase()
      for (const p of preds) {
        if (typeof p.peerHandle === 'string' && p.peerHandle.toLowerCase() === h) return p
      }
    }
    return null
  }

  // ------------------------------------------------------------
  // Polling + event subscriptions
  // ------------------------------------------------------------
  async function refreshStatus({ force = false } = {}) {
    if (state.destroyed || !matchId) return
    if (!state.enabled) return
    try {
      await curva.predictions.getStatus({ matchId, forceRefresh: force })
    } catch (err) {
      // getStatus resolves via the predictions:status event; a throw here
      // means the boundary validation rejected. Surface but do not crash.
      setError('Status query failed: ' + (err?.message || 'unknown'))
    }
  }

  function startPolling() {
    stopPolling()
    // 10s cadence — matches ARCHITECTURE.md polling budget for pool state.
    // Bare worker caches for 60s so this is amortized to one HTTP hit per
    // minute. Force-refresh on the first tick after mount so we do not sit
    // on a stale cache.
    state.pollTimer = setInterval(() => refreshStatus({ force: false }), 10_000)
  }
  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer)
      state.pollTimer = null
    }
  }

  const subs = []
  subs.push(curva.predictions.onConfig((cfg) => {
    state.enabled = !!cfg.enabled
    state.clientReady = !!cfg.clientReady
    if (!state.enabled) {
      // Should never happen because we gate mount on getConfig — kept defensive.
      destroy()
      return
    }
    refreshStatus({ force: true })
    startPolling()
  }))

  subs.push(curva.predictions.onStatus((snap) => {
    if (state.destroyed) return
    if (snap?.error) {
      // Non-fatal: pool may not be open. Only surface if it's not a POOL_NOT_FOUND.
      if (snap.error.code === 'POOL_NOT_FOUND') {
        state.pool = { exists: false }
      } else {
        setError('Status: ' + snap.error.message)
        state.pool = { exists: false }
      }
    } else {
      state.pool = snap
      setError('')
    }
    render()
  }))

  subs.push(curva.predictions.onOpened(() => {
    refreshStatus({ force: true })
  }))
  subs.push(curva.predictions.onSubmitted(() => {
    refreshStatus({ force: true })
  }))
  subs.push(curva.predictions.onResultPublished(() => {
    refreshStatus({ force: true })
  }))
  subs.push(curva.predictions.onError((err) => {
    if (err?.code && err?.message) setError(`${err.code}: ${err.message}`)
  }))

  // SSE-driven refresh: prediction.payout + prediction.settled land as
  // `backend:activity` events which the predictions bridge filters for us.
  subs.push(curva.predictions.onPayout((payload) => {
    refreshStatus({ force: true })
    // If we're the host, mirror the payout as a system:pool-payout chat row.
    if (isHost && payload && matchId) {
      const txHash = payload.txHash || payload.tx_hash
      const toAddress = payload.toAddress || payload.to_address
      const amountAtomic = payload.amountAtomic || payload.amount_atomic || payload.amount
      if (txHash && toAddress && amountAtomic) {
        curva.predictions.announcePayout({ matchId, txHash, toAddress, amountAtomic: String(amountAtomic) })
          .catch(() => { /* best-effort */ })
      }
    }
  }))
  subs.push(curva.predictions.onSettled(() => {
    refreshStatus({ force: true })
  }))
  // Wallet address discovery so we can highlight our own row on the peer path.
  if (typeof curva.onWalletReady === 'function') {
    subs.push(curva.onWalletReady((info) => {
      state.mySmartAddress = info?.smartAddress || null
      state.myOwnerAddress = info?.ownerAddress || null
      render()
    }))
  }
  if (typeof curva.getWalletInfo === 'function') {
    curva.getWalletInfo().catch(() => { /* noop */ })
  }

  // Kick things off: fetch config immediately. Config event handler starts
  // polling + first refresh.
  curva.predictions.getConfig().catch((err) => {
    setError('Config query failed: ' + err.message)
  })

  // Initial render with placeholder state.
  render()

  function destroy() {
    state.destroyed = true
    stopPolling()
    for (const off of subs) {
      try { off() } catch { /* noop */ }
    }
    container.textContent = ''
  }

  return { destroy, refresh: () => refreshStatus({ force: true }) }
}

// Static gate helper: renderer/app.js calls this first. Returns a Promise<boolean>.
// When flag is off, the entire panel mount is skipped and the layout collapses
// so no visual weight is spent on a dark feature.
export async function isPredictionPanelEnabled(curva) {
  if (!curva?.predictions?.getConfig) return false
  return new Promise((resolve) => {
    let done = false
    const off = curva.predictions.onConfig((cfg) => {
      if (done) return
      done = true
      try { off() } catch { /* noop */ }
      resolve(!!cfg?.enabled)
    })
    // Fallback timeout: no config event within 4s => assume disabled.
    setTimeout(() => { if (!done) { done = true; try { off() } catch { /* noop */ } resolve(false) } }, 4_000)
    curva.predictions.getConfig().catch(() => {
      if (!done) { done = true; resolve(false) }
    })
  })
}
