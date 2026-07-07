// Curva backend HTTP client.
//
// Trust model (ARCHITECTURE.md Section 0, 12.1): the backend is UNTRUSTED
// infrastructure. Every call is best-effort and every error has a P2P
// fallback. This client therefore NEVER throws for network failures — it
// returns `{ ok: false, error }` and the caller decides.
//
// Envelope: backend returns `{ success, error, data }`. This client peels
// that envelope and returns:
//   { ok: true,  data }
//   { ok: false, error: { code, message } }
//
// Uses the global `fetch` provided by Bare 1.x. If `fetch` is missing (older
// runtime), calls return a synthetic BACKEND_UNAVAILABLE error.
//
// Accept-Language: value is set at construction so backend F9 can return
// Italian labels for the demo.

const DEFAULT_TIMEOUT_MS = 8_000

function createBackendClient(baseUrl, { lang = 'en', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new RangeError('baseUrl is required')
  }
  const trimmed = baseUrl.replace(/\/+$/, '')
  const doFetch = typeof fetch === 'function' ? fetch : null

  async function request(pathWithQuery, init = {}) {
    if (!doFetch) {
      return { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'fetch not available in this runtime' } }
    }
    const url = trimmed + pathWithQuery
    const headers = {
      'Accept': 'application/json',
      'Accept-Language': lang,
      ...(init.headers || {})
    }
    if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'

    let controller = null
    let timeoutHandle = null
    if (typeof AbortController === 'function') {
      controller = new AbortController()
      timeoutHandle = setTimeout(() => {
        try { controller.abort() } catch { /* noop */ }
      }, timeoutMs)
    }

    let resp
    try {
      resp = await doFetch(url, {
        method: init.method || 'GET',
        headers,
        body: init.body,
        signal: controller?.signal
      })
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      return {
        ok: false,
        error: {
          code: err?.name === 'AbortError' ? 'BACKEND_TIMEOUT' : 'BACKEND_UNREACHABLE',
          message: err?.message || 'network error'
        }
      }
    }
    if (timeoutHandle) clearTimeout(timeoutHandle)

    let json = null
    try {
      json = await resp.json()
    } catch {
      return {
        ok: false,
        error: {
          code: 'BACKEND_BAD_RESPONSE',
          message: `non-JSON response (${resp.status})`
        }
      }
    }

    if (!resp.ok || (json && json.success === false)) {
      const err = json?.error || {}
      return {
        ok: false,
        error: {
          code: err.code || 'BACKEND_ERROR',
          message: err.message || `HTTP ${resp.status}`
        }
      }
    }

    // Envelope handling: if `{ success, data }` present, return data; otherwise
    // return the whole body (some endpoints like /health may not wrap).
    return {
      ok: true,
      data: json?.data !== undefined ? json.data : json
    }
  }

  function encodeQuery(params) {
    const pairs = []
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue
      pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    }
    return pairs.length > 0 ? '?' + pairs.join('&') : ''
  }

  return {
    baseUrl: trimmed,
    lang,

    ping() { return request('/health') },

    listMatches({ status, stage, from, to, limit = 20, offset = 0 } = {}) {
      // `from` / `to` are ISO 8601 strings. Backend validates and filters by
      // kickoffUtc range. Used by the RoomBrowser to surface only upcoming
      // matches so the lobby stays useful on rest-days between rounds.
      return request('/matches' + encodeQuery({ status, stage, from, to, limit, offset }))
    },
    getMatchesToday() { return request('/matches/today') },
    getMatchLive(matchId) {
      if (!matchId) return Promise.resolve({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'matchId required' } })
      return request('/matches/' + encodeURIComponent(matchId) + '/live')
    },

    listRooms({ matchId, activeOnly = true, limit = 50 } = {}) {
      return request('/rooms' + encodeQuery({ matchId, activeOnly, limit }))
    },
    getRoom(slug) {
      if (!slug) return Promise.resolve({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'slug required' } })
      return request('/rooms/' + encodeURIComponent(slug))
    },
    publishRoom({ slug, matchId, hostHandle, hostSmartAddress, hostOwnerAddress, expiresAt } = {}) {
      // 2026-07-07: matchId is now optional. Slug-only joins (e.g. `--room
      // wc26-final`) do not know the underlying match cuid; the backend
      // auto-resolves final > first scheduled when matchId is absent. Do NOT
      // wire an empty string through — the backend treats '' as missing but
      // the client-side isValidCuid would still reject non-null falsy values.
      if (!slug || !hostHandle) {
        return Promise.resolve({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'slug, hostHandle required' } })
      }
      const body = { slug, hostHandle, hostSmartAddress, hostOwnerAddress, expiresAt }
      if (matchId) body.matchId = matchId
      return request('/rooms', {
        method: 'POST',
        body: JSON.stringify(body)
      })
    },
    deleteRoom({ slug, signature } = {}) {
      if (!slug || !signature) {
        return Promise.resolve({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'slug, signature required' } })
      }
      return request('/rooms/' + encodeURIComponent(slug), {
        method: 'DELETE',
        body: JSON.stringify({ signature })
      })
    },

    getPhrasebook(lang2) {
      const l = lang2 || lang
      return request('/i18n/phrasebook' + encodeQuery({ lang: l }))
    },

    getQvacModels() { return request('/qvac/models') },

    // Phase 3.5: model download URL. Returns the full URL (not a fetch result)
    // because the caller (bare/translate.js) streams the response to disk with
    // its own fetch call so it can chunk + hash without buffering.
    getQvacModelDownloadUrl(modelId) {
      if (!modelId || typeof modelId !== 'string') return null
      return trimmed + '/qvac/models/' + encodeURIComponent(modelId) + '/download'
    },

    getDistribution() { return request('/distribution') },

    // F11 facilitator: submit an EIP-3009 signed authorization.
    // Body shape is authoritative per backend/src/routes/facilitatorRoutes.ts.
    submitFacilitator(body) {
      if (!body || typeof body !== 'object') {
        return Promise.resolve({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'body required' } })
      }
      const required = ['chainId', 'tokenAddress', 'from', 'to', 'value', 'validAfter', 'validBefore', 'nonce', 'v', 'r', 's']
      for (const k of required) {
        if (body[k] === undefined || body[k] === null) {
          return Promise.resolve({ ok: false, error: { code: 'VALIDATION_ERROR', message: `missing ${k}` } })
        }
      }
      return request('/wdk/relay/eip3009', {
        method: 'POST',
        body: JSON.stringify(body)
      })
    },

    getFacilitatorStatus(txHash) {
      if (!txHash) return Promise.resolve({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'txHash required' } })
      return request('/wdk/relay/status/' + encodeURIComponent(txHash))
    }
  }
}

module.exports = { createBackendClient }
