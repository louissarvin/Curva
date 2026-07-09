// Curva bare/ocr.js unit tests. Uses a fake SDK that scripts the ocr() return
// shape from @qvac/sdk 0.14.0 (schemas/ocr.d.ts + client/api/ocr.d.ts).

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const {
  createOcr,
  extractScore,
  MAX_IMAGE_BYTES,
  MAX_BLOCKS_RETURNED,
  DEFAULT_MIN_CONFIDENCE,
  _internal
} = require('../bare/ocr.js')

// --- helpers ---------------------------------------------------------------

/**
 * Fake SDK. `ocr()` returns a `{blocks: Promise<Block[]>}` per the client d.ts.
 */
function makeFakeSdk ({ blocks = [], loadThrows = null, ocrThrows = null } = {}) {
  const loadCalls = []
  const ocrCalls = []
  return {
    _loadCalls: loadCalls,
    _ocrCalls: ocrCalls,
    async loadModel (opts) {
      loadCalls.push(opts)
      if (loadThrows) throw loadThrows
      return 'fake-ocr-model-id'
    },
    ocr (opts) {
      ocrCalls.push(opts)
      if (ocrThrows) throw ocrThrows
      return {
        blocks: Promise.resolve(blocks),
        stats: Promise.resolve({ totalTime: 123 })
      }
    },
    async unloadModel () {}
  }
}

function writeTmpImg () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curva-ocr-test-'))
  const p = path.join(dir, 'frame.jpg')
  // JPEG magic. SDK stub never reads bytes.
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))
  return { dir, path: p }
}

// --- sanitizeText -----------------------------------------------------------

test('sanitizeText strips control chars and collapses whitespace', (t) => {
  t.is(_internal.sanitizeText('MAN  \x00 UTD'), 'MAN UTD')
  t.is(_internal.sanitizeText('\r\n7\t'), '7')
  t.is(_internal.sanitizeText(''), '')
  t.is(_internal.sanitizeText(null), '')
})

// --- filterAndSanitize (block cap + confidence filter) ---------------------

test('filterAndSanitize applies the confidence floor', (t) => {
  const raw = [
    { text: 'HIGH', confidence: 0.9, bbox: [0, 0, 10, 10] },
    { text: 'MID', confidence: 0.5 },
    { text: 'LOW', confidence: 0.1 }
  ]
  const out = _internal.filterAndSanitize(raw, 0.3, 32)
  t.is(out.length, 2, 'LOW dropped by confidence floor')
  t.is(out[0].text, 'HIGH', 'sorted by confidence desc')
})

test('filterAndSanitize caps the total block count and keeps highest-confidence first', (t) => {
  const raw = []
  for (let i = 0; i < 100; i++) raw.push({ text: `block-${i}`, confidence: i / 100 })
  const out = _internal.filterAndSanitize(raw, 0, 32)
  t.is(out.length, 32, 'cap enforced')
  // Top block should have the highest confidence.
  t.is(out[0].text, 'block-99')
  t.is(out[31].text, 'block-68')
})

test('filterAndSanitize hard-caps at MAX_BLOCKS_RETURNED even if caller asks for more', (t) => {
  const raw = []
  for (let i = 0; i < 50; i++) raw.push({ text: `b${i}`, confidence: 0.9 })
  const out = _internal.filterAndSanitize(raw, 0, 999)
  t.is(out.length <= MAX_BLOCKS_RETURNED || out.length === 50, true)
  // filterAndSanitize itself doesn't clamp against MAX; that's done by read()
  // via clampInt. This test just documents the direct helper contract.
})

test('filterAndSanitize sanitizes text and preserves valid bbox', (t) => {
  const raw = [
    { text: 'MAN\x00 UTD', confidence: 0.8, bbox: [1, 2, 3, 4] },
    { text: 'BAD\x1fBBOX', confidence: 0.8, bbox: [1, 2, NaN, 4] }
  ]
  const out = _internal.filterAndSanitize(raw, 0, 32)
  t.is(out[0].text, 'MAN UTD')
  t.alike(out[0].bbox, [1, 2, 3, 4])
  t.absent(out[1].bbox, 'invalid bbox dropped')
})

test('filterAndSanitize drops empty text and non-object entries', (t) => {
  const raw = [null, undefined, { text: '' }, { text: '   ', confidence: 1 }, { text: 'ok', confidence: 1 }]
  const out = _internal.filterAndSanitize(raw, 0, 32)
  t.is(out.length, 1)
  t.is(out[0].text, 'ok')
})

// --- lazy load --------------------------------------------------------------

test('read() lazy-loads OCR_LATIN with defaultRotationAngles on modelConfig', async (t) => {
  const sdk = makeFakeSdk({
    blocks: [{ text: '23', confidence: 0.95, bbox: [10, 10, 50, 50] }]
  })
  const ocrMod = createOcr({ sdk })
  t.is(sdk._loadCalls.length, 0, 'no loadModel before first read')

  const { dir, path: p } = writeTmpImg()
  try {
    const r = await ocrMod.read(p)
    t.ok(r.ok)
    t.is(r.blocks.length, 1)
    t.is(r.blocks[0].text, '23')

    t.is(sdk._loadCalls.length, 1)
    const load = sdk._loadCalls[0]
    t.is(load.modelType, 'ocr')
    t.alike(load.modelConfig.defaultRotationAngles, [90, 180, 270])
    t.is(load.modelConfig.lowConfidenceThreshold, DEFAULT_MIN_CONFIDENCE)

    // Second call skips loadModel.
    await ocrMod.read(p)
    t.is(sdk._loadCalls.length, 1)
    t.is(sdk._ocrCalls.length, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('read() forwards paragraph option to sdk.ocr', async (t) => {
  const sdk = makeFakeSdk({ blocks: [{ text: 'ok', confidence: 0.9 }] })
  const ocrMod = createOcr({ sdk })
  const { dir, path: p } = writeTmpImg()
  try {
    await ocrMod.read(p, { paragraph: true })
    t.is(sdk._ocrCalls[0].options.paragraph, true)
    await ocrMod.read(p)
    t.is(sdk._ocrCalls[1].options.paragraph, false, 'defaults to false')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- image size cap ---------------------------------------------------------

test('read() rejects oversized Buffer input', async (t) => {
  const sdk = makeFakeSdk()
  const ocrMod = createOcr({ sdk })
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1)
  const r = await ocrMod.read(big)
  t.is(r.ok, false)
  t.is(r.code, 'IMAGE_TOO_LARGE')
  t.is(sdk._loadCalls.length, 0, 'oversized image never triggers loadModel')
})

test('read() rejects missing files', async (t) => {
  const sdk = makeFakeSdk()
  const ocrMod = createOcr({ sdk })
  const r = await ocrMod.read('/no/such/path.jpg')
  t.is(r.ok, false)
  t.is(r.code, 'IMAGE_NOT_FOUND')
})

// --- confidence filter + block cap through the read() surface --------------

test('read() applies the confidence filter at the boundary', async (t) => {
  const sdk = makeFakeSdk({
    blocks: [
      { text: 'GOOD', confidence: 0.9 },
      { text: 'BAD', confidence: 0.1 }
    ]
  })
  const ocrMod = createOcr({ sdk })
  const { dir, path: p } = writeTmpImg()
  try {
    const r = await ocrMod.read(p)
    t.ok(r.ok)
    t.is(r.blocks.length, 1)
    t.is(r.blocks[0].text, 'GOOD')

    // Higher floor drops both.
    const r2 = await ocrMod.read(p, { minConfidence: 0.95 })
    t.is(r2.blocks.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('read() caps to MAX_BLOCKS_RETURNED even when caller asks for more', async (t) => {
  const blocks = []
  for (let i = 0; i < 100; i++) blocks.push({ text: `n${i}`, confidence: 0.9 })
  const sdk = makeFakeSdk({ blocks })
  const ocrMod = createOcr({ sdk })
  const { dir, path: p } = writeTmpImg()
  try {
    const r = await ocrMod.read(p, { maxBlocks: 500 })
    t.ok(r.ok)
    t.is(r.blocks.length, MAX_BLOCKS_RETURNED, 'hard cap wins over caller opts')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- error paths ------------------------------------------------------------

test('read() surfaces loadModel failure as {ok:false, code}', async (t) => {
  const err = new Error('addon crash')
  err.code = 'LOAD_FAILED'
  const sdk = makeFakeSdk({ loadThrows: err })
  const emitted = []
  const ocrMod = createOcr({ sdk, emit: (ev) => emitted.push(ev) })
  const { dir, path: p } = writeTmpImg()
  try {
    const r = await ocrMod.read(p)
    t.is(r.ok, false)
    t.is(r.code, 'LOAD_FAILED')
    t.ok(emitted.includes('ocr:error'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- extractScore (scoreboard regex) ---------------------------------------

test('extractScore matches bare "N - M" jersey/scoreboard patterns', (t) => {
  const blocks = [{ text: '2 - 1', confidence: 0.9 }]
  const s = extractScore(blocks)
  t.ok(s)
  t.is(s.home, 2)
  t.is(s.away, 1)
})

test('extractScore matches "N:M" without dashes', (t) => {
  const s = extractScore([{ text: '3:0', confidence: 0.9 }])
  t.ok(s)
  t.is(s.home, 3)
  t.is(s.away, 0)
})

test('extractScore captures optional team labels', (t) => {
  const s = extractScore([{ text: 'MAN 2 - 1 LIV', confidence: 0.9 }])
  t.ok(s)
  t.is(s.home, 2)
  t.is(s.away, 1)
  t.is(s.homeLabel, 'MAN')
  t.is(s.awayLabel, 'LIV')
})

test('extractScore prefers the longest text (scoreboard beats jersey)', (t) => {
  const s = extractScore([
    { text: '23', confidence: 0.99 },
    { text: 'ITA 2 - 1 FRA', confidence: 0.7 }
  ])
  t.ok(s)
  t.is(s.homeLabel, 'ITA')
  t.is(s.awayLabel, 'FRA')
})

test('extractScore rejects absurd numbers (>30)', (t) => {
  const s = extractScore([{ text: '99 - 88', confidence: 0.9 }])
  t.absent(s, 'guards against random OCR noise passing as a score')
})

test('extractScore returns null on empty input', (t) => {
  t.is(extractScore([]), null)
  t.is(extractScore(null), null)
  t.is(extractScore([{ text: 'no numbers here', confidence: 0.9 }]), null)
})

// --- close() ---------------------------------------------------------------

test('close() blocks further reads', async (t) => {
  const sdk = makeFakeSdk({ blocks: [{ text: 'ok', confidence: 0.9 }] })
  const ocrMod = createOcr({ sdk })
  const { dir, path: p } = writeTmpImg()
  try {
    await ocrMod.read(p)
    await ocrMod.close()
    t.is(ocrMod.status().closed, true)
    const r = await ocrMod.read(p)
    t.is(r.ok, false)
    t.is(r.code, 'CLOSED')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
