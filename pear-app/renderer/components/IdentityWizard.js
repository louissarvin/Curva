// Curva IdentityWizard: first-launch keet-identity flow.
// Vanilla ES module (ADR-001). textContent only. No innerHTML.
//
// State machine:
//   idle -> create -> showing-mnemonic -> done
//   idle -> restore -> done | error
//
// Security discipline:
//   - Mnemonic words are set via .textContent. Never innerHTML.
//   - After the "I've written it down" checkbox is clicked and Continue fires,
//     EVERY word element has its .textContent wiped to '' BEFORE onComplete is
//     called. This removes mnemonic material from the DOM as fast as possible.
//   - The mnemonic is never stored in a closure after that wipe.
//   - Restore input is cleared on success but NOT on failure (user must correct).
//   - Feature flag: if curva.identity.generateNew is not a function, we treat
//     the feature as disabled and call onComplete({skipped: true}) immediately.
//
// CWE-312 (cleartext sensitive in memory): we minimise residency by wiping
// the word cells immediately after the user confirms they've written them down.
//
// IPC contract (electron/preload.js must expose):
//   curva.identity.hasKeetIdentity()  -> Promise<boolean>
//   curva.identity.generateNew()      -> Promise<{mnemonic: string, identityPublicKey: string}>
//   curva.identity.restore(mnemonic)  -> Promise<{identityPublicKey: string}>
//
// onComplete is called with one of:
//   {skipped: true}                           feature off or identity already exists
//   {identityPublicKey: string}               create branch
//   {identityPublicKey: string, restored: true} restore branch

const WORD_REGEX = /^[a-z]{3,10}$/

export function mountIdentityWizard({ container, curva, onComplete } = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva bridge is required')
  if (typeof onComplete !== 'function') throw new TypeError('onComplete is required')

  // Feature flag probe: if the IPC surface is absent, skip entirely.
  if (typeof curva?.identity?.generateNew !== 'function') {
    onComplete({ skipped: true })
    return { destroy: () => {} }
  }

  container.textContent = ''

  // Check if identity already exists; if so, skip.
  const checkPromise = typeof curva.identity.hasKeetIdentity === 'function'
    ? curva.identity.hasKeetIdentity()
    : Promise.resolve(false)

  checkPromise.then((has) => {
    if (has) {
      onComplete({ skipped: true })
      return
    }
    renderIdle()
  }).catch(() => {
    // If the check fails (e.g. IPC not wired yet), proceed to show the wizard.
    renderIdle()
  })

  // Component state (flat, not closures-within-closures).
  let currentMode = 'idle'   // 'idle' | 'create' | 'restore'
  let wordCells = []         // array of {num, text} DOM element refs for wipe
  let confirmed = false
  let submitting = false

  // -- Wizard shell ----------------------------------------------------------

  const wizard = document.createElement('div')
  wizard.className = 'curva-identity-wizard'
  wizard.setAttribute('role', 'dialog')
  wizard.setAttribute('aria-modal', 'true')
  wizard.setAttribute('aria-labelledby', 'curva-identity-title')

  const backdrop = document.createElement('div')
  backdrop.className = 'curva-identity-wizard__backdrop'

  const card = document.createElement('div')
  card.className = 'curva-identity-wizard__card'

  wizard.appendChild(backdrop)
  wizard.appendChild(card)
  container.appendChild(wizard)

  // -- render helpers --------------------------------------------------------

  function clearCard() {
    card.textContent = ''
    wordCells = []
    confirmed = false
    submitting = false
  }

  function mkTitle(text) {
    const h = document.createElement('h2')
    h.id = 'curva-identity-title'
    h.className = 'curva-identity-wizard__title'
    h.textContent = text
    return h
  }

  function mkSub(text) {
    const p = document.createElement('p')
    p.className = 'curva-identity-wizard__sub'
    p.textContent = text
    return p
  }

  function mkBtn(text, primary = false) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'curva-identity-wizard__btn' + (primary ? ' curva-identity-wizard__btn--primary' : '')
    btn.textContent = text
    return btn
  }

  function mkError() {
    const div = document.createElement('div')
    div.className = 'curva-identity-wizard__error'
    div.setAttribute('role', 'alert')
    div.hidden = true
    return div
  }

  function setError(errEl, msg) {
    if (!msg) { errEl.hidden = true; errEl.textContent = ''; return }
    errEl.hidden = false
    errEl.textContent = msg
  }

  // -- idle: choose create or restore ----------------------------------------

  function renderIdle() {
    currentMode = 'idle'
    clearCard()

    card.appendChild(mkTitle('Set up your Curva identity'))
    card.appendChild(mkSub(
      'Your identity lets peers verify your messages are really from you. ' +
      'Create a new one or restore from a 24-word phrase you already have.'
    ))

    const actions = document.createElement('div')
    actions.className = 'curva-identity-wizard__actions'

    const restoreBtn = mkBtn('Restore from phrase')
    const createBtn = mkBtn('Create new identity', true)

    restoreBtn.addEventListener('click', () => renderRestore())
    createBtn.addEventListener('click', () => renderCreateLoading())

    actions.appendChild(restoreBtn)
    actions.appendChild(createBtn)
    card.appendChild(actions)
  }

  // -- create: call generateNew, show mnemonic once --------------------------

  function renderCreateLoading() {
    currentMode = 'create'
    clearCard()
    card.appendChild(mkTitle('Creating your identity...'))
    const spinner = document.createElement('p')
    spinner.className = 'curva-identity-wizard__sub'
    spinner.textContent = 'Generating 24-word phrase. This takes a moment.'
    card.appendChild(spinner)

    curva.identity.generateNew().then((result) => {
      if (!result || typeof result.mnemonic !== 'string') {
        renderCreateError('Identity generation failed. Please retry.')
        return
      }
      renderMnemonic(result.mnemonic, result.identityPublicKey || '')
    }).catch((err) => {
      renderCreateError('Failed to generate identity: ' + (err?.message || 'unknown error'))
    })
  }

  function renderCreateError(msg) {
    clearCard()
    card.appendChild(mkTitle('Something went wrong'))
    const errEl = document.createElement('div')
    errEl.className = 'curva-identity-wizard__error'
    errEl.textContent = msg
    card.appendChild(errEl)

    const retryBtn = mkBtn('Go back', false)
    retryBtn.addEventListener('click', () => renderIdle())
    const actions = document.createElement('div')
    actions.className = 'curva-identity-wizard__actions'
    actions.appendChild(retryBtn)
    card.appendChild(actions)
  }

  function renderMnemonic(mnemonic, identityPublicKey) {
    // Split and validate mnemonic immediately; hold words only in local scope.
    const words = mnemonic.trim().split(/\s+/)
    if (words.length !== 24) {
      renderCreateError('Unexpected mnemonic length: ' + words.length + ' words. Expected 24.')
      return
    }

    clearCard()
    card.appendChild(mkTitle('Your 24-word identity phrase'))

    const warning = document.createElement('div')
    warning.className = 'curva-identity-wizard__warning'
    warning.textContent =
      'This phrase is your identity. Write it down. It appears ONCE and is never shown again.'
    card.appendChild(warning)

    // 6x4 grid of word pills.
    const grid = document.createElement('div')
    grid.className = 'curva-identity-wizard__mnemonic-grid'

    for (let i = 0; i < 24; i++) {
      const pill = document.createElement('div')
      pill.className = 'curva-identity-wizard__word'

      const numEl = document.createElement('span')
      numEl.className = 'curva-identity-wizard__word-num'
      numEl.textContent = String(i + 1)

      const textEl = document.createElement('span')
      textEl.className = 'curva-identity-wizard__word-text'
      textEl.textContent = words[i]   // textContent: safe

      pill.appendChild(numEl)
      pill.appendChild(textEl)
      grid.appendChild(pill)

      // Track text elements so we can wipe them later.
      wordCells.push(textEl)
    }
    card.appendChild(grid)

    // Checkbox: required before Continue.
    const checkboxRow = document.createElement('label')
    checkboxRow.className = 'curva-identity-wizard__checkbox-row'

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.id = 'curva-identity-confirm'
    checkbox.addEventListener('change', () => {
      confirmed = checkbox.checked
      continueBtn.disabled = !confirmed
    })

    const checkLabel = document.createElement('span')
    checkLabel.textContent = "I've written down all 24 words safely."

    checkboxRow.appendChild(checkbox)
    checkboxRow.appendChild(checkLabel)
    card.appendChild(checkboxRow)

    const continueBtn = mkBtn('Continue', true)
    continueBtn.disabled = true
    continueBtn.addEventListener('click', () => {
      if (!confirmed || submitting) return
      submitting = true
      continueBtn.disabled = true
      continueBtn.textContent = 'Setting up...'

      // CRITICAL: wipe every word from the DOM before proceeding.
      // After this loop the mnemonic string is no longer visible in the DOM.
      for (const cell of wordCells) {
        cell.textContent = ''
      }
      wordCells = []

      // identityPublicKey is safe to pass; it is a hex string from the worker.
      onComplete({ identityPublicKey })
    })

    const actions = document.createElement('div')
    actions.className = 'curva-identity-wizard__actions'
    actions.appendChild(continueBtn)
    card.appendChild(actions)
  }

  // -- restore: 24-word textarea input ---------------------------------------

  function renderRestore() {
    currentMode = 'restore'
    clearCard()
    card.appendChild(mkTitle('Restore from phrase'))
    card.appendChild(mkSub(
      'Enter your 24 words separated by spaces. ' +
      'Each word must be 3-10 lowercase letters.'
    ))

    const area = document.createElement('div')
    area.className = 'curva-identity-wizard__restore-area'

    const textarea = document.createElement('textarea')
    textarea.className = 'curva-identity-wizard__restore-input'
    textarea.placeholder = 'word1 word2 word3 ... word24'
    textarea.autocomplete = 'off'
    textarea.spellcheck = false
    textarea.autocorrect = 'off'
    textarea.autocapitalize = 'none'

    const hint = document.createElement('div')
    hint.className = 'curva-identity-wizard__restore-hint'
    hint.textContent = '24 words required.'

    const errEl = mkError()

    area.appendChild(textarea)
    area.appendChild(hint)
    area.appendChild(errEl)
    card.appendChild(area)

    const actions = document.createElement('div')
    actions.className = 'curva-identity-wizard__actions'

    const backBtn = mkBtn('Back')
    backBtn.addEventListener('click', () => renderIdle())

    const restoreBtn = mkBtn('Restore identity', true)
    restoreBtn.addEventListener('click', () => {
      if (submitting) return
      setError(errEl, '')

      const raw = textarea.value
      const words = raw.trim().split(/\s+/)

      // Client-side validation (server is the source of truth on checksum).
      if (words.length !== 24) {
        setError(errEl, 'Need exactly 24 words. Got ' + words.length + '.')
        return
      }
      const invalid = words.filter((w) => !WORD_REGEX.test(w))
      if (invalid.length > 0) {
        setError(
          errEl,
          'Invalid word(s): ' + invalid.slice(0, 3).join(', ') +
          (invalid.length > 3 ? ' and ' + (invalid.length - 3) + ' more' : '') +
          '. Each word must be 3-10 lowercase letters.'
        )
        return
      }

      submitting = true
      restoreBtn.disabled = true
      restoreBtn.textContent = 'Restoring...'

      const mnemonicStr = words.join(' ')

      curva.identity.restore(mnemonicStr).then((result) => {
        // Wipe the textarea immediately on success.
        textarea.value = ''
        onComplete({ identityPublicKey: result?.identityPublicKey || '', restored: true })
      }).catch((err) => {
        submitting = false
        restoreBtn.disabled = false
        restoreBtn.textContent = 'Restore identity'
        // Do NOT wipe textarea on failure so the user can correct.
        const msg = err?.message || 'unknown error'
        if (/checksum|invalid/i.test(msg)) {
          setError(errEl, 'Invalid phrase or checksum mismatch. Check your words and try again.')
        } else {
          setError(errEl, 'Restore failed: ' + msg)
        }
      })
    })

    actions.appendChild(backBtn)
    actions.appendChild(restoreBtn)
    card.appendChild(actions)

    setTimeout(() => { try { textarea.focus() } catch { /* noop */ } }, 0)
  }

  // -- blur listener: hide mnemonic when window loses focus ------------------
  // Reduces over-the-shoulder exposure while the phrase is visible.
  function onWindowBlur() {
    if (currentMode !== 'create') return
    for (const cell of wordCells) {
      cell.style.filter = 'blur(6px)'
    }
  }
  function onWindowFocus() {
    for (const cell of wordCells) {
      cell.style.filter = ''
    }
  }
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('focus', onWindowFocus)

  function destroy() {
    window.removeEventListener('blur', onWindowBlur)
    window.removeEventListener('focus', onWindowFocus)
    // Wipe any remaining mnemonic material from the DOM.
    for (const cell of wordCells) {
      try { cell.textContent = '' } catch { /* noop */ }
    }
    wordCells = []
    try { container.removeChild(wizard) } catch { /* noop */ }
  }

  return { destroy }
}
