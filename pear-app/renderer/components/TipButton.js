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
//   signing    -> "Signing…"
//   submitting -> "Broadcasting…"
//   submitted  -> "On-chain (view tx)"
//   confirmed  -> "Tipped! ✓"
//   failed     -> "Failed"
//
// After a terminal state (confirmed/failed) we auto-reset to idle after 4s.

const SEPOLIA_EXPLORER = 'https://sepolia.etherscan.io/tx/'
const PRESETS = [1, 5, 10] // whole USDT
const MAX_CUSTOM_USDT = 100 // matches bare/tip.js MAX_DEMO_AMOUNT_BASE

export function mountTipButton({
  container,
  curva,
  hostSmartAddress
} = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva bridge is required')

  container.textContent = ''
  container.classList.add('curva-tip')

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

  container.appendChild(presetRow)
  container.appendChild(btn)
  container.appendChild(status)
  container.appendChild(hint)

  let currentTxHash = null
  let currentState = 'idle'
  let resetTimer = null
  // Balance in base units (BigInt). null = unknown, treat as gated-off.
  let balanceBase = null

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
          : 'Waiting for host…'
        btn.classList.remove('curva-tip__btn--pending', 'curva-tip__btn--ok', 'curva-tip__btn--fail')
        status.textContent = hostSmartAddress
          ? 'to ' + short(hostSmartAddress)
          : 'host has not published a tip address'
        hint.hidden = !gated
        if (gated) hint.textContent = 'insufficient USDT for this tip amount'
        currentTxHash = null
        break
      }
      case 'signing':
        btn.disabled = true
        btn.textContent = 'Signing…'
        btn.classList.add('curva-tip__btn--pending')
        status.textContent = 'sign in wallet worklet'
        hint.hidden = true
        break
      case 'submitting':
        btn.disabled = true
        btn.textContent = 'Broadcasting…'
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
      case 'confirmed':
        btn.disabled = false
        btn.classList.add('curva-tip__btn--ok')
        btn.textContent = 'Tipped ✓'
        status.textContent = currentTxHash ? 'tx ' + short(currentTxHash) : 'confirmed'
        renderExplorerLink(currentTxHash)
        resetTimer = setTimeout(() => setState('idle'), 4000)
        break
      case 'failed':
        btn.disabled = false
        btn.classList.add('curva-tip__btn--fail')
        btn.textContent = 'Failed — retry'
        status.textContent = extra.reason || 'error'
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
        setState('confirmed')
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

  selectPreset(PRESETS[0])
  setState('idle')

  function destroy() {
    if (resetTimer) clearTimeout(resetTimer)
    offUpdate()
    offHostDiscovered()
    offWalletError()
    offBalance()
    offWalletReady()
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
