// Curva Leaderboard: top-N tip totals for the current match.
// Vanilla ES module (ADR-001). textContent only.
//
// Fetches /leaderboard?matchId=<id> via the Bare worker (IPC command
// `backend:leaderboard`). Refreshes every 30 seconds. All fields are
// treated as untrusted strings.

const REFRESH_MS = 30_000
const TOP_N = 5

export function mountLeaderboard({ container, curva, matchId } = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva is required')

  container.textContent = ''
  container.classList.add('curva-lb')

  const header = document.createElement('div')
  header.className = 'curva-lb__header'
  const title = document.createElement('span')
  title.className = 'curva-lb__title'
  title.textContent = 'top tippers'
  const status = document.createElement('span')
  status.className = 'curva-lb__status'
  status.textContent = ''
  header.appendChild(title)
  header.appendChild(status)

  // Wave 6 T13: client-derived in-room leaderboard. Sums system:tip amounts
  // from the local chat stream, keyed by tipper handle. This is intentionally
  // separate from the backend leaderboard: backend persists cross-room / cross-
  // session totals; this widget shows what has happened live in THIS room.
  const liveChip = document.createElement('div')
  liveChip.className = 'curva-lb__live'
  liveChip.style.cssText = 'margin-bottom:8px;padding:6px 10px;border-radius:6px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.2);'
  const liveLabel = document.createElement('div')
  liveLabel.style.cssText = 'font-size:11px;color:#93c5fd;margin-bottom:4px;'
  liveLabel.textContent = 'Live in this room'
  const liveList = document.createElement('ol')
  liveList.style.cssText = 'margin:0;padding-left:20px;font-size:12px;color:#e0f2fe;'
  const liveEmpty = document.createElement('div')
  liveEmpty.style.cssText = 'font-size:12px;color:#94a3b8;'
  liveEmpty.textContent = 'No tips yet in this room.'
  liveChip.appendChild(liveLabel)
  liveChip.appendChild(liveEmpty)
  liveChip.appendChild(liveList)

  const list = document.createElement('ol')
  list.className = 'curva-lb__list'

  const empty = document.createElement('div')
  empty.className = 'curva-lb__empty'
  empty.textContent = 'First tip wins this match.'
  empty.hidden = true

  container.appendChild(header)
  container.appendChild(liveChip)
  container.appendChild(list)
  container.appendChild(empty)

  // -- Live client-side reducer -------------------------------------------
  // Sum confirmed + submitted system:tip amounts per tipper handle.
  const liveTotals = new Map() // handle -> { totalBaseUnits: BigInt, count: number }
  function ingestTipRow(msg) {
    if (!msg || msg.type !== 'system:tip') return
    const handle = typeof msg.from_handle === 'string' && msg.from_handle.length > 0
      ? msg.from_handle
      : (typeof msg.by_peer === 'string' ? msg.by_peer.slice(0, 8) : 'anon')
    let amt = 0n
    try { amt = BigInt(msg.amount || '0') } catch { amt = 0n }
    const cur = liveTotals.get(handle) || { totalBaseUnits: 0n, count: 0 }
    cur.totalBaseUnits += amt
    cur.count += 1
    liveTotals.set(handle, cur)
    renderLive()
  }

  function renderLive() {
    liveList.textContent = ''
    if (liveTotals.size === 0) {
      liveEmpty.hidden = false
      return
    }
    liveEmpty.hidden = true
    const rows = Array.from(liveTotals.entries()).map(([h, v]) => ({
      handle: h,
      totalBaseUnits: v.totalBaseUnits,
      count: v.count
    }))
    rows.sort((a, b) => (a.totalBaseUnits > b.totalBaseUnits ? -1 : a.totalBaseUnits < b.totalBaseUnits ? 1 : 0))
    for (const r of rows.slice(0, 3)) {
      const li = document.createElement('li')
      const whole = Number(r.totalBaseUnits) / 1_000_000
      li.textContent = r.handle + ' — ' + whole.toFixed(2) + ' USDT (' + r.count + ')'
      liveList.appendChild(li)
    }
  }

  const offLiveMsg = curva.onChatMessage?.((msg) => ingestTipRow(msg)) || (() => {})
  // Also fold in history so the widget populates on cold room join.
  const offLiveHistory = curva.onChatHistory?.(({ messages }) => {
    if (!Array.isArray(messages)) return
    for (const m of messages) ingestTipRow(m)
  }) || (() => {})

  function render(rows) {
    list.textContent = ''
    if (!Array.isArray(rows) || rows.length === 0) {
      empty.hidden = false
      return
    }
    empty.hidden = true
    const top = rows.slice(0, TOP_N)
    for (const r of top) {
      const li = document.createElement('li')
      li.className = 'curva-lb__row'

      const handle = document.createElement('span')
      handle.className = 'curva-lb__handle'
      handle.textContent = typeof r.hostHandle === 'string'
        ? r.hostHandle.slice(0, 32)
        : (typeof r.host === 'string' ? r.host.slice(0, 32) : '?')

      const total = document.createElement('span')
      total.className = 'curva-lb__total'
      total.textContent = formatAmount(r.totalBaseUnits ?? r.total ?? r.amount) + ' USDT'

      const count = document.createElement('span')
      count.className = 'curva-lb__count'
      const c = Number(r.tipCount ?? r.count ?? 0)
      count.textContent = Number.isFinite(c) ? c + ' tip' + (c === 1 ? '' : 's') : ''

      li.appendChild(handle)
      li.appendChild(total)
      li.appendChild(count)
      list.appendChild(li)
    }
  }

  function formatAmount(v) {
    if (v === null || v === undefined) return '0.00'
    const s = String(v)
    if (/^[0-9]+$/.test(s)) {
      try {
        const whole = Number(BigInt(s)) / 1_000_000
        return whole.toFixed(2)
      } catch { return s.slice(0, 16) }
    }
    const n = Number(s)
    if (Number.isFinite(n)) return n.toFixed(2)
    return '0.00'
  }

  function fetchNow() {
    status.textContent = 'refreshing...'
    if (typeof curva.fetchLeaderboard === 'function') {
      curva.fetchLeaderboard(matchId).catch(() => {
        status.textContent = 'unavailable'
      })
    }
  }

  const off = typeof curva.onLeaderboard === 'function'
    ? curva.onLeaderboard(({ ok, rows, error }) => {
        if (!ok) {
          status.textContent = 'unavailable'
          empty.hidden = false
          return
        }
        status.textContent = ''
        render(rows)
      })
    : () => {}

  fetchNow()
  const timer = setInterval(fetchNow, REFRESH_MS)

  function destroy() {
    clearInterval(timer)
    try { off() } catch { /* noop */ }
    try { offLiveMsg() } catch { /* noop */ }
    try { offLiveHistory() } catch { /* noop */ }
    container.textContent = ''
  }

  return { destroy }
}
