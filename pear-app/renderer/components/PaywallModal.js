// Wave 13B - PaywallModal.
//
// A small overlay component that surfaces the x402 paywall prompt. Rendered
// on top of the current room UI when the Bare worker emits `x402:paywall`
// (via the preload bridge). The user picks Pay or Cancel; the modal calls
// curva.x402.confirm(id, true|false) which the worker awaits inside
// createX402Client's promptUser callback.
//
// Security discipline (mirrors PredictionPanel.js / Chat.js):
//   - Every backend-supplied string is set via textContent, never innerHTML.
//   - No script execution surface. The modal is a passive DOM tree.
//   - Escape closes with cancel; Enter confirms. Both are wired via keydown
//     so the modal is keyboard-accessible.

'use strict'

function fmtAmount(atomic, decimals = 6, symbol = 'USDT') {
  if (typeof atomic !== 'string' || !/^\d+$/.test(atomic)) return `${atomic} ${symbol}`
  // Simple decimal formatter without BigInt gymnastics: pad, insert point.
  const padded = atomic.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals)
  const frac = padded.slice(-decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac} ${symbol}` : `${whole} ${symbol}`
}

function shortAddr(a) {
  if (typeof a !== 'string' || a.length < 10) return String(a || '')
  return `${a.slice(0, 6)}...${a.slice(-4)}`
}

/**
 * Mount a paywall modal on the given container.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container - where the modal is appended
 * @param {object} opts.challenge      - { chainId, asset, amount, resource, description, payTo? }
 * @param {function} opts.onDecide     - (approved: boolean) => void
 * @returns {{ close: () => void }}
 */
function mountPaywallModal({ container, challenge, onDecide } = {}) {
  if (!container) throw new TypeError('container required')
  if (!challenge || typeof challenge !== 'object') throw new TypeError('challenge required')
  if (typeof onDecide !== 'function') throw new TypeError('onDecide required')

  const backdrop = document.createElement('div')
  backdrop.className = 'curva-paywall__backdrop'
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')
  backdrop.setAttribute('aria-labelledby', 'curva-paywall-title')

  const card = document.createElement('div')
  card.className = 'curva-paywall__card'

  const title = document.createElement('h2')
  title.id = 'curva-paywall-title'
  title.className = 'curva-paywall__title'
  title.textContent = 'Unlock paid resource'
  card.appendChild(title)

  const desc = document.createElement('p')
  desc.className = 'curva-paywall__desc'
  desc.textContent =
    typeof challenge.description === 'string' && challenge.description.length > 0
      ? challenge.description
      : `Unlock the "${challenge.resource || 'premium'}" resource with a single USDT payment.`
  card.appendChild(desc)

  const details = document.createElement('dl')
  details.className = 'curva-paywall__details'
  const rows = [
    ['Resource', challenge.resource || '—'],
    ['Amount', fmtAmount(String(challenge.amount || challenge.maxAmountRequired || '0'))],
    ['Network', `chain ${challenge.chainId ?? '—'}`],
    ['Recipient', shortAddr(challenge.payTo || challenge.recipient || '')]
  ]
  for (const [k, v] of rows) {
    const dt = document.createElement('dt')
    dt.textContent = k
    const dd = document.createElement('dd')
    dd.textContent = String(v)
    details.appendChild(dt)
    details.appendChild(dd)
  }
  card.appendChild(details)

  const buttons = document.createElement('div')
  buttons.className = 'curva-paywall__buttons'

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'curva-paywall__cancel'
  cancelBtn.textContent = 'Cancel'
  buttons.appendChild(cancelBtn)

  const payBtn = document.createElement('button')
  payBtn.type = 'button'
  payBtn.className = 'curva-paywall__pay'
  payBtn.textContent = 'Pay'
  buttons.appendChild(payBtn)

  card.appendChild(buttons)
  backdrop.appendChild(card)
  container.appendChild(backdrop)

  let closed = false
  function close(approved) {
    if (closed) return
    closed = true
    try { document.removeEventListener('keydown', onKey) } catch (_) { /* noop */ }
    try { backdrop.remove() } catch (_) { /* noop */ }
    try { onDecide(!!approved) } catch (_) { /* onDecide swallows */ }
  }

  cancelBtn.addEventListener('click', () => close(false))
  payBtn.addEventListener('click', () => close(true))
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(false) })

  function onKey(ev) {
    if (ev.key === 'Escape') close(false)
    if (ev.key === 'Enter') close(true)
  }
  document.addEventListener('keydown', onKey)

  // Focus payBtn for keyboard-first UX.
  try { payBtn.focus() } catch (_) { /* noop */ }

  return { close: () => close(false) }
}

// Node/brittle test-friendly export shape. In the pear renderer this file is
// loaded as ESM via importmap; we keep the CommonJS export so brittle can
// require it directly if we later add DOM-shim tests.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mountPaywallModal }
}
if (typeof window !== 'undefined') {
  window.CurvaPaywallModal = { mountPaywallModal }
}
