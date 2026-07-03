// Curva PasscodePrompt: first-run modal that collects the wallet passcode.
// Vanilla ES module (ADR-001). textContent only.
//
// Contract:
//   - Called when the Bare worker emits `wallet:error` with code
//     WALLET_PASSCODE_REQUIRED (or when the renderer decides to init the
//     wallet lazily and the passcode has not been supplied yet).
//   - On submit, calls `curva.setWalletPasscode(passcode)`. The bridge
//     validates length before crossing IPC. The passcode never round-trips
//     back to the renderer.
//   - Cleared from memory on unmount (setting the input value to '').
//
// Security notes:
//   - `type="password"` prevents shoulder-surfing.
//   - We DO NOT persist to localStorage. The Bare worker owns the seed key
//     material and re-derives on next launch.
//   - We DO NOT log the passcode; error surfaces are generic.

const MIN_LEN = 6
const MAX_LEN = 128

export function mountPasscodePrompt({ container, curva, onComplete } = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva bridge is required')
  if (typeof curva.setWalletPasscode !== 'function') {
    throw new TypeError('curva.setWalletPasscode is not exposed by preload')
  }

  container.textContent = ''

  const modal = document.createElement('div')
  modal.className = 'curva-passcode'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  modal.setAttribute('aria-labelledby', 'curva-passcode-title')

  const backdrop = document.createElement('div')
  backdrop.className = 'curva-passcode__backdrop'

  const card = document.createElement('div')
  card.className = 'curva-passcode__card'

  const title = document.createElement('h2')
  title.id = 'curva-passcode-title'
  title.className = 'curva-passcode__title'
  title.textContent = 'Unlock your Curva wallet'

  const explain = document.createElement('p')
  explain.className = 'curva-passcode__explain'
  explain.textContent = 'Curva stores your gasless USDT tipping key on this device, encrypted with a passcode you choose. It is never sent to any server.'

  const form = document.createElement('form')
  form.className = 'curva-passcode__form'
  form.autocomplete = 'off'

  const label = document.createElement('label')
  label.className = 'curva-passcode__label'
  label.textContent = 'Passcode (' + MIN_LEN + '-' + MAX_LEN + ' characters)'
  const input = document.createElement('input')
  input.type = 'password'
  input.autocomplete = 'new-password'
  input.className = 'curva-passcode__input'
  input.name = 'curva-passcode'
  input.minLength = MIN_LEN
  input.maxLength = MAX_LEN
  input.required = true
  input.spellcheck = false
  label.appendChild(input)

  const err = document.createElement('div')
  err.className = 'curva-passcode__error'
  err.setAttribute('role', 'alert')
  err.hidden = true

  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'curva-passcode__submit'
  submit.textContent = 'Unlock wallet'

  const footnote = document.createElement('p')
  footnote.className = 'curva-passcode__foot'
  footnote.textContent = 'You can also start Curva with DEV_WALLET_PASSCODE=... to skip this prompt in development.'

  form.appendChild(label)
  form.appendChild(err)
  form.appendChild(submit)

  card.appendChild(title)
  card.appendChild(explain)
  card.appendChild(form)
  card.appendChild(footnote)

  modal.appendChild(backdrop)
  modal.appendChild(card)
  container.appendChild(modal)

  // Auto-focus for keyboard-first UX.
  setTimeout(() => { try { input.focus() } catch { /* noop */ } }, 0)

  let submitting = false

  function setError(msg) {
    if (!msg) { err.hidden = true; err.textContent = ''; return }
    err.hidden = false
    err.textContent = msg
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (submitting) return
    const value = input.value
    if (typeof value !== 'string' || value.length < MIN_LEN || value.length > MAX_LEN) {
      setError('Passcode must be ' + MIN_LEN + '-' + MAX_LEN + ' characters.')
      return
    }
    setError('')
    submitting = true
    submit.disabled = true
    submit.textContent = 'Unlocking...'
    try {
      await curva.setWalletPasscode(value)
      // Immediately wipe from the DOM to reduce residency time.
      input.value = ''
      submit.textContent = 'Unlocked'
      // The parent unmounts us once wallet:ready arrives; call onComplete
      // to signal that the passcode was accepted at the boundary.
      if (typeof onComplete === 'function') onComplete()
    } catch (e2) {
      submitting = false
      submit.disabled = false
      submit.textContent = 'Unlock wallet'
      setError('Failed to unlock: ' + (e2?.message || 'unknown error'))
    }
  })

  function destroy() {
    // Wipe input value on unmount so it does not linger in DOM memory.
    try { input.value = '' } catch { /* noop */ }
    try { container.removeChild(modal) } catch { /* noop */ }
  }

  return { destroy }
}
