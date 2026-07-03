// Phase 2 brittle test: backend HTTP client.
// We mock `fetch` globally so no network is required.

const test = require('brittle')
const { createBackendClient } = require('../bare/backend.js')

const ORIG_FETCH = globalThis.fetch

function installMockFetch(responder) {
  globalThis.fetch = async (url, init) => {
    const record = { url, init: init || {} }
    const out = await responder(record)
    if (out === undefined) throw new Error('mock returned nothing for ' + url)
    return out
  }
}

function restoreFetch() {
  globalThis.fetch = ORIG_FETCH
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body }
  }
}

test('createBackendClient requires a baseUrl', (t) => {
  t.exception.all(() => createBackendClient(''), 'empty rejected')
  t.exception.all(() => createBackendClient(null), 'null rejected')
})

test('trailing slashes are trimmed', (t) => {
  const c = createBackendClient('http://localhost:3700///')
  t.is(c.baseUrl, 'http://localhost:3700')
})

test('ping hits /health', async (t) => {
  const calls = []
  installMockFetch(async ({ url }) => {
    calls.push(url)
    return jsonResponse(200, { status: 'ok' })
  })
  try {
    const c = createBackendClient('http://localhost:3700')
    const res = await c.ping()
    t.ok(res.ok, 'ok=true')
    t.is(calls[0], 'http://localhost:3700/health')
  } finally { restoreFetch() }
})

test('Accept-Language header propagates', async (t) => {
  const seen = []
  installMockFetch(async ({ init }) => {
    seen.push(init.headers['Accept-Language'])
    return jsonResponse(200, { success: true, data: { matches: [] } })
  })
  try {
    const c = createBackendClient('http://localhost:3700', { lang: 'it' })
    await c.listMatches({ limit: 5 })
    t.is(seen[0], 'it')
  } finally { restoreFetch() }
})

test('listMatches builds the right query string', async (t) => {
  const seen = []
  installMockFetch(async ({ url }) => {
    seen.push(url)
    return jsonResponse(200, { success: true, data: { matches: [] } })
  })
  try {
    const c = createBackendClient('http://api.test')
    await c.listMatches({ status: 'in_progress', limit: 10, offset: 5 })
    t.ok(seen[0].includes('status=in_progress'))
    t.ok(seen[0].includes('limit=10'))
    t.ok(seen[0].includes('offset=5'))
  } finally { restoreFetch() }
})

test('getMatchesToday hits /matches/today', async (t) => {
  const seen = []
  installMockFetch(async ({ url }) => {
    seen.push(url)
    return jsonResponse(200, { success: true, data: [] })
  })
  try {
    const c = createBackendClient('http://api.test')
    await c.getMatchesToday()
    t.is(seen[0], 'http://api.test/matches/today')
  } finally { restoreFetch() }
})

test('envelope: peels { success, data } and returns data on ok=true', async (t) => {
  installMockFetch(async () => jsonResponse(200, { success: true, data: { rooms: [{ slug: 'a' }] } }))
  try {
    const c = createBackendClient('http://api.test')
    const res = await c.listRooms({})
    t.is(res.ok, true)
    t.alike(res.data, { rooms: [{ slug: 'a' }] })
  } finally { restoreFetch() }
})

test('envelope: success=false payload maps to error', async (t) => {
  installMockFetch(async () => jsonResponse(200, {
    success: false,
    error: { code: 'ROOM_TAKEN', message: 'slug already exists' },
    data: null
  }))
  try {
    const c = createBackendClient('http://api.test')
    const res = await c.publishRoom({ slug: 'x', matchId: 'm1', hostHandle: 'h' })
    t.is(res.ok, false)
    t.is(res.error.code, 'ROOM_TAKEN')
    t.is(res.error.message, 'slug already exists')
  } finally { restoreFetch() }
})

test('non-2xx HTTP status maps to error', async (t) => {
  installMockFetch(async () => jsonResponse(500, { success: false, error: { code: 'SERVER_ERROR', message: 'boom' } }))
  try {
    const c = createBackendClient('http://api.test')
    const res = await c.getRoom('x')
    t.is(res.ok, false)
    t.is(res.error.code, 'SERVER_ERROR')
  } finally { restoreFetch() }
})

test('network error is captured, not thrown', async (t) => {
  installMockFetch(async () => { throw new Error('ECONNREFUSED') })
  try {
    const c = createBackendClient('http://api.test')
    const res = await c.ping()
    t.is(res.ok, false)
    t.is(res.error.code, 'BACKEND_UNREACHABLE')
  } finally { restoreFetch() }
})

test('malformed JSON maps to BACKEND_BAD_RESPONSE', async (t) => {
  installMockFetch(async () => ({
    ok: true,
    status: 200,
    async json() { throw new Error('bad json') }
  }))
  try {
    const c = createBackendClient('http://api.test')
    const res = await c.ping()
    t.is(res.ok, false)
    t.is(res.error.code, 'BACKEND_BAD_RESPONSE')
  } finally { restoreFetch() }
})

test('publishRoom validates inputs client-side', async (t) => {
  const c = createBackendClient('http://api.test')
  const missing = await c.publishRoom({})
  t.is(missing.ok, false)
  t.is(missing.error.code, 'VALIDATION_ERROR')
})

test('publishRoom sends JSON body when inputs are valid', async (t) => {
  const seen = []
  installMockFetch(async ({ init }) => {
    seen.push(init)
    return jsonResponse(200, { success: true, data: { slug: 'x' } })
  })
  try {
    const c = createBackendClient('http://api.test')
    const res = await c.publishRoom({
      slug: 'my-room',
      matchId: 'match-1',
      hostHandle: 'curva-forza'
    })
    t.is(res.ok, true)
    t.is(seen[0].method, 'POST')
    t.is(seen[0].headers['Content-Type'], 'application/json')
    const body = JSON.parse(seen[0].body)
    t.is(body.slug, 'my-room')
    t.is(body.matchId, 'match-1')
    t.is(body.hostHandle, 'curva-forza')
  } finally { restoreFetch() }
})

test('deleteRoom validates inputs client-side', async (t) => {
  const c = createBackendClient('http://api.test')
  const res = await c.deleteRoom({ slug: 'x' })
  t.is(res.ok, false)
  t.is(res.error.code, 'VALIDATION_ERROR')
})

test('getMatchLive validates matchId', async (t) => {
  const c = createBackendClient('http://api.test')
  const res = await c.getMatchLive('')
  t.is(res.ok, false)
  t.is(res.error.code, 'VALIDATION_ERROR')
})

test('getQvacModels + getDistribution + getPhrasebook hit correct paths', async (t) => {
  const seen = []
  installMockFetch(async ({ url }) => {
    seen.push(url)
    return jsonResponse(200, { success: true, data: {} })
  })
  try {
    const c = createBackendClient('http://api.test', { lang: 'it' })
    await c.getQvacModels()
    await c.getDistribution()
    await c.getPhrasebook('id')
    t.is(seen[0], 'http://api.test/qvac/models')
    t.is(seen[1], 'http://api.test/distribution')
    t.ok(seen[2].startsWith('http://api.test/i18n/phrasebook'))
    t.ok(seen[2].includes('lang=id'), 'lang override used')
  } finally { restoreFetch() }
})

// -- Phase 4 extensions -------------------------------------------------

test('ping returns { ok: true } when /health responds 200', async (t) => {
  installMockFetch(async () => jsonResponse(200, { status: 'ok', uptime: 42 }))
  try {
    const c = createBackendClient('http://api.test')
    const res = await c.ping()
    t.ok(res.ok, 'ping succeeds')
  } finally { restoreFetch() }
})

test('ping returns { ok: false } on 5xx', async (t) => {
  installMockFetch(async () => jsonResponse(503, { error: 'db down' }))
  try {
    const c = createBackendClient('http://api.test')
    const res = await c.ping()
    t.is(res.ok, false, 'ping fails cleanly')
    t.ok(res.error, 'error payload present')
  } finally { restoreFetch() }
})

test('ping does NOT throw on network error (returns { ok: false })', async (t) => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    const c = createBackendClient('http://unreachable.test', { timeoutMs: 100 })
    const res = await c.ping()
    t.is(res.ok, false, 'network error becomes ok:false')
    t.ok(res.error?.code, 'error code present')
  } finally { restoreFetch() }
})

test('listRooms returns empty array + error on backend 500 (RoomBrowser fallback)', async (t) => {
  installMockFetch(async () => jsonResponse(500, { error: 'internal' }))
  try {
    const c = createBackendClient('http://api.test')
    const res = await c.listRooms({ activeOnly: true })
    t.is(res.ok, false, 'error surfaced')
    t.ok(res.error, 'error present so caller can render banner')
  } finally { restoreFetch() }
})

test('getMatchesToday tolerates missing envelope (raw match array)', async (t) => {
  installMockFetch(async () => jsonResponse(200, { matches: [{ id: 'wc-1' }] }))
  try {
    const c = createBackendClient('http://api.test')
    const res = await c.getMatchesToday()
    t.ok(res.ok, 'ok despite non-standard envelope')
  } finally { restoreFetch() }
})
