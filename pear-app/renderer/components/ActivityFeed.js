// Curva ActivityFeed: side panel showing SSE events from backend.
// Vanilla ES module (ADR-001). textContent only. All peer strings are
// untrusted; we do NOT set innerHTML anywhere.

const MAX_EVENTS = 30

const KIND_ICON = {
  'tip.confirmed': '$',
  'tip.pending': '~',
  'match.goal': 'GOL',
  'match.start': 'K/O',
  'match.end': 'FT',
  'room.created': '+',
  'room.expired': '-',
  'facilitator.confirmed': 'fac'
}

export function mountActivityFeed({ container, curva } = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva bridge is required')

  container.textContent = ''
  container.classList.add('curva-feed')

  const header = document.createElement('div')
  header.className = 'curva-feed__header'
  const title = document.createElement('span')
  title.className = 'curva-feed__title'
  title.textContent = 'activity'
  const statusEl = document.createElement('span')
  statusEl.className = 'curva-feed__status'
  statusEl.textContent = 'disconnected'
  header.appendChild(title)
  header.appendChild(statusEl)

  const list = document.createElement('ul')
  list.className = 'curva-feed__list'

  const empty = document.createElement('div')
  empty.className = 'curva-feed__empty'
  empty.textContent = 'no events yet.'

  container.appendChild(header)
  container.appendChild(list)
  container.appendChild(empty)

  function addEvent(evt) {
    const li = document.createElement('li')
    li.className = 'curva-feed__row'
    const kind = String(evt?.type || evt?.event || 'event')
    const icon = document.createElement('span')
    icon.className = 'curva-feed__icon'
    icon.textContent = KIND_ICON[kind] || '*'
    const text = document.createElement('span')
    text.className = 'curva-feed__text'
    text.textContent = formatEvent(kind, evt)
    li.appendChild(icon)
    li.appendChild(text)
    list.insertBefore(li, list.firstChild)
    while (list.children.length > MAX_EVENTS) {
      list.removeChild(list.lastChild)
    }
    empty.hidden = true
  }

  const offEvent = curva.onActivityEvent((evt) => addEvent(evt))
  const offStatus = curva.onActivityStatus(({ connected, reason }) => {
    statusEl.textContent = connected ? 'live' : ('disconnected' + (reason ? ' (' + reason + ')' : ''))
    statusEl.classList.toggle('curva-feed__status--live', !!connected)
  })

  curva.connectActivityFeed().catch(() => { /* noop */ })

  function destroy() {
    offEvent()
    offStatus()
    curva.disconnectActivityFeed().catch(() => { /* noop */ })
    container.textContent = ''
  }

  return { destroy }
}

function formatEvent(kind, evt) {
  const parts = []
  parts.push(kind)
  if (evt?.matchId) parts.push('match=' + short(evt.matchId))
  if (evt?.slug) parts.push('room=' + short(evt.slug))
  if (evt?.amount) parts.push('amt=' + formatAmount(evt.amount))
  if (evt?.senderHandle || evt?.handle) parts.push('by=' + (evt.senderHandle || evt.handle))
  if (evt?.txHash) parts.push('tx=' + short(evt.txHash))
  return parts.join(' ')
}

// USDT has 6 decimals. If the amount looks like base units, render as
// "1.23 USDT"; otherwise pass through.
function formatAmount(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return String(v)
  const s = String(v)
  if (!/^[0-9]+$/.test(s)) return s
  try {
    const base = BigInt(s)
    if (base < 10n ** 12n) {
      // treat as 6 decimals
      const whole = Number(base / 10000n) / 100
      return whole.toFixed(2) + ' USDT'
    }
  } catch { /* noop */ }
  return s
}

function short(s) {
  if (typeof s !== 'string') return String(s)
  return s.length > 10 ? s.slice(0, 8) + '...' : s
}
