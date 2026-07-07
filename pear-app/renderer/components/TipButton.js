// Curva TipButton: real EIP-3009 gasless USDT tip with preset amounts.
// Vanilla ES module (ADR-001). textContent only. No secret material passes
// through the renderer — all we do is call curva.tipHost() and render state
// transitions coming back over IPC.
//
// Wave 6 T6: three presets (1 / 5 / 10 USDT) plus a custom input capped at
// min(balance, 100 USDT). Presets disable when balance is insufficient.
// Balance is polled via curva.getWalletBalance() (T7).
//
// States: idle | signing | submitting | submitted | confirmed | failed
//   idle       -> "Tip 1 USDT"
//   signing    -> "Signing..."
//   submitting -> "Broadcasting..."
//   submitted  -> "On-chain (view tx)"
//   confirmed  -> "Tipped!"
//   failed     -> "Failed"
//
// After a terminal state (confirmed/failed) we auto-reset to idle after 4s.
//
// C3.b: Attribution chip. After a successful ERC-4337 UserOp tip, a small
// pill chip appears:
//   loading  (grey)  -> "Verifying attribution..."
//   verified (green) -> "UserOp attributed to curva 0.1.0 * curva-wallet * Widget"
//   pending  (amber) -> "Attribution check pending"
//   mismatch (amber) -> "Marker mismatch"
// Only shown when the backend returns a userOpHash (ERC-4337 path).
// EIP-3009 direct tips never produce a UserOp, so the chip never shows.

const SEPOLIA_EXPLORER = 'https://sepolia.etherscan.io/tx/'
// Batch tip caps (renderer-side enforcement; Bare enforces again server-side).
const BATCH_MIN_RECIPIENTS = 2
const BATCH_MAX_RECIPIENTS = 5
const BATCH_MAX_TOTAL_USDT = 15
// Attribution verify endpoint. The chip POSTs to the backend after a
// successful ERC-4337 tip. The backend proxies Candide and checks the marker.
const ATTRIBUTION_PATH = '/wdk/verify-attribution/'
// Hex pattern for userOpHash validation.
const USER_OP_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const PRESETS = [1, 5, 10] // whole USDT
const MAX_CUSTOM_USDT = 100 // matches bare/tip.js MAX_DEMO_AMOUNT_BASE

export function mountTipButton({
  container,
  curva,
  hostSmartAddress,
  backendUrl = 'http://localhost:3700',
  chainId = 11155111,
  tier = 'writer'
} = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva bridge is required')

  // Tier 4: reader-tier peers never see the tip UI.
  if (tier === 'reader') {
    container.textContent = ''
    return { destroy: () => {}, setHostAddress: () => {} }
  }

  container.textContent = ''
  container.classList.add('curva-tip')

  // Feature flag: batch tip is only wired when the IPC surface exists.
  const batchEnabled = typeof curva.tipBatch === 'function'

  // Mode toggle: only shown when batch is available.
  const modeBar = document.createElement('div')
  modeBar.className = 'curva-tip__modebar'
  modeBar.hidden = !batchEnabled

  const modeHost = document.createElement('button')
  modeHost.type = 'button'
  modeHost.className = 'curva-tip__mode curva-tip__mode--active'
  modeHost.textContent = 'Tip host'
  const modeEveryone = document.createElement('button')
  modeEveryone.type = 'button'
  modeEveryone.className = 'curva-tip__mode'
  modeEveryone.textContent = 'Tip everyone'
  modeBar.appendChild(modeHost)
  modeBar.appendChild(modeEveryone)
  container.appendChild(modeBar)

  // Single-tip section (existing UI, wrapped in a div for toggling).
  const singlePanel = document.createElement('div')
  singlePanel.className = 'curva-tip__single-panel'

  const presetRow = document.createElement('div')
  presetRow.className = 'curva-tip__presets'

  const presetButtons = []
  let selectedAmountUsdt = PRESETS[0]
  for (const amt of PRESETS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'curva-tip__preset'
    b.dataset.amount = String(amt)
    b.textContent = amt + ' USDT'
    b.addEventListener('click', () => selectPreset(amt))
    presetRow.appendChild(b)
    presetButtons.push(b)
  }

  const customWrap = document.createElement('span')
  customWrap.className = 'curva-tip__custom'
  const customInput = document.createElement('input')
  customInput.type = 'number'
  customInput.min = '0'
  customInput.max = String(MAX_CUSTOM_USDT)
  customInput.step = '0.01'
  customInput.placeholder = 'custom'
  customInput.className = 'curva-tip__custom-input'
  customInput.addEventListener('input', onCustomInput)
  customWrap.appendChild(customInput)
  presetRow.appendChild(customWrap)

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'curva-tip__btn'

  const status = document.createElement('span')
  status.className = 'curva-tip__status'

  const hint = document.createElement('span')
  hint.className = 'curva-tip__hint'
  hint.style.color = '#ef4444'
  hint.style.fontSize = '11px'
  hint.hidden = true

  // Attribution chip: only shown after a successful ERC-4337 tip.
  const attribChip = document.createElement('span')
  attribChip.className = 'curva-tip__attrib'
  attribChip.hidden = true

  singlePanel.appendChild(presetRow)
  singlePanel.appendChild(btn)
  singlePanel.appendChild(status)
  singlePanel.appendChild(hint)
  singlePanel.appendChild(attribChip)
  container.appendChild(singlePanel)

  // Batch tip panel. Hidden until the user selects "Tip everyone" mode.
  // Populated lazily when we have a roster; peer data comes from curva.getRoomRoster.
  const batchPanel = document.createElement('div')
  batchPanel.className = 'curva-tip__batch-panel'
  batchPanel.hidden = true
  container.appendChild(batchPanel)

  const batchPeerList = document.createElement('ul')
  batchPeerList.className = 'curva-tip__batch-peers'

  const batchAmountWrap = document.createElement('div')
  batchAmountWrap.className = 'curva-tip__batch-amount-row'
  const batchAmountLabel = document.createElement('label')
  batchAmountLabel.textContent = 'Per peer (USDT)'
  batchAmountLabel.className = 'curva-tip__batch-label'
  const batchAmountInput = document.createElement('input')
  batchAmountInput.type = 'number'
  batchAmountInput.min = '0.01'
  batchAmountInput.max = String(BATCH_MAX_TOTAL_USDT)
  batchAmountInput.step = '0.01'
  batchAmountInput.value = '1'
  batchAmountInput.className = 'curva-tip__custom-input curva-tip__batch-amount-input'
  batchAmountWrap.appendChild(batchAmountLabel)
  batchAmountWrap.appendChild(batchAmountInput)

  const batchTotal = document.createElement('div')
  batchTotal.className = 'curva-tip__batch-total'

  const batchError = document.createElement('div')
  batchError.className = 'curva-tip__batch-error'
  batchError.hidden = true

  const batchConfirmBtn = document.createElement('button')
  batchConfirmBtn.type = 'button'
  batchConfirmBtn.className = 'curva-tip__btn curva-tip__batch-confirm'
  batchConfirmBtn.textContent = 'Confirm one signature'
  batchConfirmBtn.disabled = true

  const batchStatus = document.createElement('span')
  batchStatus.className = 'curva-tip__batch-status'

  batchPanel.appendChild(batchPeerList)
  batchPanel.appendChild(batchAmountWrap)
  batchPanel.appendChild(batchTotal)
  batchPanel.appendChild(batchError)
  batchPanel.appendChild(batchConfirmBtn)
  batchPanel.appendChild(batchStatus)

  // Batch state machine: idle | signing | submitted | confirmed | failed
  let batchState = 'idle'
  let batchResetTimer = null
  // Set of selected peer smart_address strings (lower-cased).
  const batchSelected = new Set()
  // Roster populated from curva.getRoomRoster when batch panel opens.
  let batchRoster = []

  function batchPerBase() {
    const val = Number(batchAmountInput.value)
    if (!Number.isFinite(val) || val <= 0) return 0n
    return BigInt(Math.round(val * 1_000_000))
  }

  function batchTotalUsdt() {
    const perBase = batchPerBase()
    const n = batchSelected.size
    if (n === 0 || perBase <= 0n) return 0
    return Number(BigInt(n) * perBase) / 1_000_000
  }

  function batchValid() {
    const n = batchSelected.size
    if (n < BATCH_MIN_RECIPIENTS || n > BATCH_MAX_RECIPIENTS) return false
    const total = batchTotalUsdt()
    if (total > BATCH_MAX_TOTAL_USDT) return false
    if (batchPerBase() <= 0n) return false
    return true
  }

  function updateBatchTotal() {
    const total = batchTotalUsdt()
    const n = batchSelected.size
    batchTotal.textContent = 'Total: ' + total.toFixed(2) + ' USDT across ' + n + ' peer' + (n === 1 ? '' : 's')
    const over = total > BATCH_MAX_TOTAL_USDT
    batchTotal.classList.toggle('curva-tip__batch-total--over', over)
    batchConfirmBtn.disabled = batchState !== 'idle' || !batchValid()
  }

  function setBatchError(msg) {
    if (!msg) { batchError.hidden = true; batchError.textContent = ''; return }
    batchError.hidden = false
    batchError.textContent = String(msg).slice(0, 200)
  }

  function setBatchState(next, extra = {}) {
    batchState = next
    if (batchResetTimer) { clearTimeout(batchResetTimer); batchResetTimer = null }
    switch (next) {
      case 'idle':
        batchConfirmBtn.disabled = !batchValid()
        batchConfirmBtn.textContent = 'Confirm one signature'
        batchConfirmBtn.classList.remove('curva-tip__btn--pending', 'curva-tip__btn--ok', 'curva-tip__btn--fail')
        batchStatus.textContent = ''
        setBatchError(null)
        break
      case 'signing':
        batchConfirmBtn.disabled = true
        batchConfirmBtn.textContent = 'Signing...'
        batchConfirmBtn.classList.add('curva-tip__btn--pending')
        batchStatus.textContent = 'one UserOp for ' + batchSelected.size + ' recipients'
        setBatchError(null)
        break
      case 'submitted':
        batchConfirmBtn.disabled = true
        batchConfirmBtn.classList.remove('curva-tip__btn--pending')
        batchConfirmBtn.textContent = 'On-chain (pending)'
        if (extra.txHash) {
          batchStatus.textContent = ''
          const node = document.createTextNode('UserOp ' + extra.txHash.slice(0, 10) + '... ')
          const link = document.createElement('a')
          link.href = '#'
          link.rel = 'noopener noreferrer'
          link.className = 'curva-tip__link'
          link.textContent = 'view'
          link.addEventListener('click', (e) => {
            e.preventDefault()
            if (typeof curva.openExternal === 'function') {
              curva.openExternal(SEPOLIA_EXPLORER + extra.txHash).catch(() => { /* noop */ })
            }
          })
          batchStatus.appendChild(node)
          batchStatus.appendChild(link)
        }
        break
      case 'confirmed':
        batchConfirmBtn.disabled = false
        batchConfirmBtn.classList.add('curva-tip__btn--ok')
        batchConfirmBtn.textContent = 'Sent!'
        batchResetTimer = setTimeout(() => setBatchState('idle'), 8000)
        break
      case 'failed':
        batchConfirmBtn.disabled = false
        batchConfirmBtn.classList.add('curva-tip__btn--fail')
        batchConfirmBtn.textContent = 'Failed, retry'
        setBatchError(extra.reason || 'batch tip failed')
        batchResetTimer = setTimeout(() => setBatchState('idle'), 6000)
        break
    }
  }

  function renderBatchRoster(peers) {
    batchPeerList.textContent = ''
    batchSelected.clear()
    for (const p of peers) {
      const addr = typeof p.smart_address === 'string' ? p.smart_address.toLowerCase() : ''
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) continue

      const li = document.createElement('li')
      li.className = 'curva-tip__batch-peer'

      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.className = 'curva-tip__batch-check'
      // Use a stable id derived from the address so the label association works.
      const safeId = 'batch-peer-' + addr.slice(2, 10)
      checkbox.id = safeId
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) batchSelected.add(addr)
        else batchSelected.delete(addr)
        updateBatchTotal()
      })

      const labelEl = document.createElement('label')
      labelEl.htmlFor = safeId
      labelEl.className = 'curva-tip__batch-peer-label'
      // textContent only: handle + short address are peer-supplied (untrusted).
      const handle = (typeof p.handle === 'string' && p.handle.length > 0)
        ? p.handle : (addr.slice(0, 6) + '...' + addr.slice(-4))
      labelEl.textContent = handle

      li.appendChild(checkbox)
      li.appendChild(labelEl)
      batchPeerList.appendChild(li)
    }
    updateBatchTotal()
  }

  async function openBatchPanel() {
    batchPanel.hidden = false
    singlePanel.hidden = true
    modeHost.classList.remove('curva-tip__mode--active')
    modeEveryone.classList.add('curva-tip__mode--active')
    setBatchState('idle')

    // Load roster. Use getRoomRoster if available; fall back to empty.
    batchRoster = []
    if (typeof curva.getRoomRoster === 'function') {
      try {
        const roster = await curva.getRoomRoster()
        // Only writer-tier peers with a valid smart_address are tippable.
        batchRoster = (Array.isArray(roster) ? roster : [])
          .filter((p) => {
            const addr = typeof p?.smart_address === 'string' ? p.smart_address : ''
            return /^0x[0-9a-fA-F]{40}$/.test(addr) && p?.tier !== 'reader'
          })
          .slice(0, BATCH_MAX_RECIPIENTS)
      } catch { /* noop; render empty roster */ }
    }
    renderBatchRoster(batchRoster)
  }

  function closeBatchPanel() {
    batchPanel.hidden = true
    singlePanel.hidden = false
    modeHost.classList.add('curva-tip__mode--active')
    modeEveryone.classList.remove('curva-tip__mode--active')
  }

  batchAmountInput.addEventListener('input', () => updateBatchTotal())

  batchConfirmBtn.addEventListener('click', () => {
    if (batchState !== 'idle') return
    if (!batchValid()) return
    const perBase = batchPerBase()
    const recipients = Array.from(batchSelected).map((addr) => ({
      address: addr,
      amount: perBase.toString()
    }))
    setBatchState('signing')
    curva.tipBatch({ recipients }).then((row) => {
      setBatchState('submitted', { txHash: row?.tx_hash || row?.user_op_hash || null })
    }).catch((err) => {
      setBatchState('failed', { reason: err?.message || 'batch error' })
    })
  })

  if (batchEnabled) {
    modeHost.addEventListener('click', () => { if (!singlePanel.hidden) return; closeBatchPanel() })
    modeEveryone.addEventListener('click', () => { if (!batchPanel.hidden) return; openBatchPanel() })
  }

  // Batch tip event subscriptions (mirror single-tip state machine).
  const offBatchSigning = typeof curva.onTipBatchSigning === 'function'
    ? curva.onTipBatchSigning(() => setBatchState('signing'))
    : () => {}
  const offBatchSubmitted = typeof curva.onTipBatchSubmitted === 'function'
    ? curva.onTipBatchSubmitted((row) => setBatchState('submitted', { txHash: row?.tx_hash || row?.user_op_hash }))
    : () => {}
  const offBatchConfirmed = typeof curva.onTipBatchConfirmed === 'function'
    ? curva.onTipBatchConfirmed(() => setBatchState('confirmed'))
    : () => {}
  const offBatchFailed = typeof curva.onTipBatchFailed === 'function'
    ? curva.onTipBatchFailed((row) => setBatchState('failed', { reason: row?.error?.message || row?.error?.code || 'error' }))
    : () => {}

  let currentTxHash = null
  let currentState = 'idle'
  let resetTimer = null
  // Balance in base units (BigInt). null = unknown, treat as gated-off.
  let balanceBase = null

  // Track in-flight attribution fetch so we can cancel on destroy.
  let attribAbortController = null

  function setAttribChip(variant, text) {
    attribChip.hidden = false
    attribChip.textContent = text
    attribChip.className = 'curva-tip__attrib curva-tip__attrib--' + variant
  }

  function hideAttribChip() {
    attribChip.hidden = true
    attribChip.textContent = ''
    attribChip.className = 'curva-tip__attrib'
    if (attribAbortController) {
      attribAbortController.abort()
      attribAbortController = null
    }
  }

  /**
   * Fetch attribution for a confirmed ERC-4337 UserOp.
   * Only called when `userOpHash` is a valid 0x-prefixed 32-byte hex string.
   * Uses textContent for all backend data; never innerHTML.
   */
  function fetchAttribution(userOpHash) {
    if (!USER_OP_HASH_RE.test(userOpHash)) return
    // Guard backendUrl: only http(s) and only localhost or 127.0.0.1 for the
    // local backend. External URLs are rejected. CWE-918 (SSRF) mitigation.
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(backendUrl)) return

    setAttribChip('loading', 'Verifying attribution...')

    attribAbortController = new AbortController()
    const signal = attribAbortController.signal

    // Build the URL with URLSearchParams, never by string concatenation.
    const url = new URL(ATTRIBUTION_PATH + encodeURIComponent(userOpHash), backendUrl)
    url.searchParams.set('chainId', String(chainId))

    fetch(url.toString(), { signal })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then((body) => {
        if (signal.aborted) return
        attribAbortController = null
        const d = body && body.data
        if (body && body.success && d && d.verified) {
          // Build the one-liner from backend-supplied fields via textContent.
          const project = typeof d.project === 'string' ? d.project : 'curva'
          const toolVersion = typeof d.toolVersion === 'string' ? d.toolVersion : ''
          const tool = typeof d.tool === 'string' ? d.tool : ''
          const platform = typeof d.platform === 'string' ? d.platform : ''
          setAttribChip(
            'verified',
            'UserOp attributed to ' + project + ' ' + toolVersion +
            ' · ' + tool + ' · ' + platform
          )
          return
        }
        if (d && d.note === 'bundler_unreachable') {
          setAttribChip('pending', 'Attribution check pending')
          return
        }
        // verified:false but no specific note: marker mismatch.
        setAttribChip('mismatch', 'Marker mismatch')
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return
        attribAbortController = null
        setAttribChip('pending', 'Attribution check pending')
      })
  }

  function selectPreset(amt) {
    selectedAmountUsdt = amt
    customInput.value = ''
    for (const b of presetButtons) {
      const active = Number(b.dataset.amount) === amt
      b.classList.toggle('curva-tip__preset--active', active)
    }
    if (currentState === 'idle') setState('idle')
  }

  function onCustomInput() {
    const val = Number(customInput.value)
    if (!Number.isFinite(val) || val <= 0) return
    const clamped = Math.min(val, MAX_CUSTOM_USDT)
    selectedAmountUsdt = clamped
    for (const b of presetButtons) b.classList.remove('curva-tip__preset--active')
    if (currentState === 'idle') setState('idle')
  }

  function currentAmountBase() {
    // USDT has 6 decimals. Handle fractional custom inputs safely by rounding
    // to the nearest micro-USDT to avoid float drift.
    const micro = Math.round(selectedAmountUsdt * 1_000_000)
    if (!Number.isFinite(micro) || micro <= 0) return 0n
    return BigInt(micro)
  }

  function insufficient() {
    if (balanceBase === null) return false // unknown -> allow attempt
    return currentAmountBase() > balanceBase
  }

  function setState(next, extra = {}) {
    currentState = next
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null }
    switch (next) {
      case 'idle': {
        const gated = insufficient()
        btn.disabled = !hostSmartAddress || gated
        btn.textContent = hostSmartAddress
          ? 'Tip ' + selectedAmountUsdt + ' USDT'
          : 'Waiting for host...'
        btn.classList.remove('curva-tip__btn--pending', 'curva-tip__btn--ok', 'curva-tip__btn--fail')
        status.textContent = hostSmartAddress
          ? 'to ' + short(hostSmartAddress)
          : 'host has not published a tip address'
        hint.hidden = !gated
        if (gated) hint.textContent = 'insufficient USDT for this tip amount'
        currentTxHash = null
        hideAttribChip()
        break
      }
      case 'signing':
        btn.disabled = true
        btn.textContent = 'Signing...'
        btn.classList.add('curva-tip__btn--pending')
        status.textContent = 'sign in wallet worklet'
        hint.hidden = true
        break
      case 'submitting':
        btn.disabled = true
        btn.textContent = 'Broadcasting...'
        status.textContent = 'relaying via facilitator'
        break
      case 'submitted':
        btn.disabled = true
        btn.classList.remove('curva-tip__btn--pending')
        btn.textContent = 'On-chain (pending confirmation)'
        currentTxHash = extra.tx_hash || null
        status.textContent = currentTxHash
          ? 'tx ' + short(currentTxHash)
          : 'submitted'
        renderExplorerLink(currentTxHash)
        break
      case 'confirmed': {
        btn.disabled = false
        btn.classList.add('curva-tip__btn--ok')
        btn.textContent = 'Tipped!'
        status.textContent = currentTxHash ? 'tx ' + short(currentTxHash) : 'confirmed'
        renderExplorerLink(currentTxHash)
        // C3.b: if the backend returned a userOpHash (ERC-4337 path), start
        // the attribution check. EIP-3009 direct tips set userOpHash to null.
        const uoh = extra.userOpHash || null
        if (uoh && USER_OP_HASH_RE.test(uoh)) {
          fetchAttribution(uoh)
        } else {
          hideAttribChip()
        }
        resetTimer = setTimeout(() => setState('idle'), 8000)
        break
      }
      case 'failed':
        btn.disabled = false
        btn.classList.add('curva-tip__btn--fail')
        btn.textContent = 'Failed, retry'
        status.textContent = extra.reason || 'error'
        hideAttribChip()
        resetTimer = setTimeout(() => setState('idle'), 4000)
        break
    }
  }

  function renderExplorerLink(txHash) {
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return
    status.textContent = ''
    const label = document.createTextNode('tx ' + short(txHash) + ' ')
    const a = document.createElement('a')
    a.href = SEPOLIA_EXPLORER + txHash
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.textContent = 'view'
    a.className = 'curva-tip__link'
    status.appendChild(label)
    status.appendChild(a)
  }

  function short(s) {
    if (typeof s !== 'string') return String(s)
    return s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : s
  }

  btn.addEventListener('click', () => {
    if (currentState !== 'idle') return
    if (!hostSmartAddress) return
    if (insufficient()) return
    const base = currentAmountBase()
    if (base <= 0n) return
    curva.tipHost({ amount: base.toString() }).catch((err) => {
      setState('failed', { reason: err?.message || 'invocation error' })
    })
  })

  const offUpdate = curva.onTipUpdate((kind, row) => {
    switch (kind) {
      case 'pending':
      case 'signing':
        setState('signing')
        break
      case 'submitting':
        setState('submitting')
        break
      case 'submitted':
        setState('submitted', { tx_hash: row?.tx_hash })
        break
      case 'confirmed':
        // row.userOpHash is only set on the ERC-4337 path. The EIP-3009 path
        // has no UserOp and leaves this field absent. The chip only appears when
        // userOpHash is a valid 0x-prefixed 32-byte hex string.
        setState('confirmed', { userOpHash: row?.userOpHash || null })
        break
      case 'failed':
        setState('failed', { reason: row?.error?.message || row?.error?.code || 'error' })
        break
    }
  })

  const offHostDiscovered = curva.onTipHostDiscovered((info) => {
    hostSmartAddress = info?.smartAddress || hostSmartAddress
    if (currentState === 'idle') setState('idle')
  })

  const offWalletError = curva.onWalletError((err) => {
    setState('failed', { reason: err?.message || 'wallet error' })
  })

  const offBalance = curva.onWalletBalance?.(({ balance }) => {
    try {
      balanceBase = BigInt(balance || '0')
    } catch { balanceBase = 0n }
    if (currentState === 'idle') setState('idle')
  }) || (() => {})

  const offWalletReady = curva.onWalletReady?.(({ balance }) => {
    if (balance !== undefined) {
      try { balanceBase = BigInt(balance) } catch { balanceBase = 0n }
    }
    if (currentState === 'idle') setState('idle')
  }) || (() => {})

  // 2026-07-07: local balance auto-refresh. RoomHeader already polls every
  // 15s but TipButton mounts independently and can outlive the header (e.g.
  // embedded in other views). We poll on mount and every 15s so the
  // "insufficient USDT" pre-check reflects on-chain reality without waiting
  // for the header's poll. wallet:balance is a fresh RPC read per handler in
  // workers/main.js — no cache staleness risk.
  const BALANCE_REFRESH_MS = 15_000
  const refreshBalance = () => {
    const fn = typeof curva.getWalletBalance === 'function'
      ? curva.getWalletBalance
      : (typeof curva.getBalance === 'function' ? curva.getBalance : null)
    if (!fn) return
    fn().catch(() => { /* leave last-known */ })
  }
  refreshBalance()
  const balanceRefreshTimer = setInterval(refreshBalance, BALANCE_REFRESH_MS)

  selectPreset(PRESETS[0])
  setState('idle')

  function destroy() {
    if (resetTimer) clearTimeout(resetTimer)
    if (batchResetTimer) clearTimeout(batchResetTimer)
    if (balanceRefreshTimer) clearInterval(balanceRefreshTimer)
    if (attribAbortController) { attribAbortController.abort(); attribAbortController = null }
    offUpdate()
    offHostDiscovered()
    offWalletError()
    offBalance()
    offWalletReady()
    offBatchSigning()
    offBatchSubmitted()
    offBatchConfirmed()
    offBatchFailed()
    container.textContent = ''
  }

  return {
    destroy,
    setHostAddress(addr) {
      hostSmartAddress = addr || null
      if (currentState === 'idle') setState('idle')
    }
  }
}
