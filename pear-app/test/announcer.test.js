// Tier 4 brittle tests: Supertonic multilingual TTS goal announcer.
//
// Exercised end-to-end without booting @qvac/sdk: the tests inject an
// `sdkImpl` seam that returns synthesised Int16-range samples so the WAV
// wrap + IPC payload can be asserted without the 121 MB model download.
// Cover the four contract points called out in the task spec:
//   1. Feature-flag gate (CURVA_QVAC_TTS_ENABLED)
//   2. Placeholder interpolation with missing-field collapse
//   3. Canonical 44-byte PCM WAV header byte layout
//   4. Per-locale model caching (second speak() reuses loadModel)

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const {
  createAnnouncer,
  announcerFlagEnabled,
  createWavHeader,
  int16ArrayToBuffer,
  pcmToWav,
  interpolate,
  pickTemplate,
  SUPERTONIC_SAMPLE_RATE,
  SUPERTONIC_MODEL_DIGEST,
  SUPPORTED_LOCALES
} = require('../bare/announcer.js')

const TMP_STORAGE = path.join(
  require('os').tmpdir(),
  'curva-announcer-test-' + process.pid
)
try { fs.mkdirSync(TMP_STORAGE, { recursive: true }) } catch { /* noop */ }

const PHRASEBOOK = Object.freeze({
  goal_templates: {
    en: 'Goal! {scorer} scores for {team}. {score} at minute {minute}.',
    it: 'Gol! {scorer} segna per {team}. {score} al minuto {minute}.',
    id: 'Gol! {scorer} cetak gol untuk {team}. {score} di menit {minute}.'
  }
})

function makeFakeSdk (opts = {}) {
  const loadCalls = []
  const speakCalls = []
  const samples = opts.samples || [0, 100, -100, 200, -200, 0]
  return {
    loadCalls,
    speakCalls,
    async loadModel (params) {
      loadCalls.push(params)
      const lang = params.modelConfig && params.modelConfig.language
      return 'model-' + lang
    },
    textToSpeech (params) {
      speakCalls.push(params)
      return {
        buffer: Promise.resolve(samples.slice()),
        done: Promise.resolve(true)
      }
    },
    async unloadModel () { return true },
    // registry constant surface
    TTS_MULTILINGUAL_SUPERTONIC3_Q8_0: 'registry://tts-multilingual-q8'
  }
}

function withFlag (value, fn) {
  const prev = process.env.CURVA_QVAC_TTS_ENABLED
  process.env.CURVA_QVAC_TTS_ENABLED = value
  try { return fn() } finally {
    if (prev === undefined) delete process.env.CURVA_QVAC_TTS_ENABLED
    else process.env.CURVA_QVAC_TTS_ENABLED = prev
  }
}

async function withFlagAsync (value, fn) {
  const prev = process.env.CURVA_QVAC_TTS_ENABLED
  process.env.CURVA_QVAC_TTS_ENABLED = value
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.CURVA_QVAC_TTS_ENABLED
    else process.env.CURVA_QVAC_TTS_ENABLED = prev
  }
}

// -- Docs-verification memo -------------------------------------------------

test('announcer.js head carries the SDK docs memo', async (t) => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'bare', 'announcer.js'), 'utf8')
  const head = src.slice(0, 3000)
  t.ok(head.includes('Docs-verification memo'), 'memo present at top')
  t.ok(head.includes('TTS_MULTILINGUAL_SUPERTONIC3_Q8_0'), 'model constant named')
  t.ok(head.includes(SUPERTONIC_MODEL_DIGEST), 'sha256 digest cited from SDK registry')
  t.ok(head.includes('44100'), 'sample rate documented')
  t.ok(head.includes('44-byte'), 'WAV header byte count documented')
  t.ok(head.includes('language') && head.includes('modelConfig'),
    'documents that language lives on modelConfig, not per-call')
})

// -- Supported locales sanity ----------------------------------------------

test('Supertonic locale set is Curva-superset (en it id es pt de fr all present)', async (t) => {
  for (const l of ['en', 'it', 'id', 'es', 'pt', 'de', 'fr']) {
    t.ok(SUPPORTED_LOCALES.has(l), 'locale supported: ' + l)
  }
  t.is(SUPPORTED_LOCALES.size, 31, '31 Supertonic locales per schemas/text-to-speech.d.ts')
})

// -- Interpolation ---------------------------------------------------------

test('interpolate substitutes {placeholders} and collapses missing fields', async (t) => {
  const tpl = 'Goal! {scorer} for {team}. {score} at {minute}.'
  t.is(
    interpolate(tpl, { scorer: 'Messi', team: 'ARG', score: '2-1', minute: '87' }),
    'Goal! Messi for ARG. 2-1 at 87.',
    'all placeholders filled'
  )
  t.is(
    interpolate(tpl, { scorer: 'Messi', team: 'ARG' }),
    'Goal! Messi for ARG. ' + ' at ' + '.',
    'missing fields collapse to empty string'
  )
  t.is(
    interpolate(tpl, { scorer: '', team: '', score: '', minute: '' }),
    'Goal!  for . ' + ' at ' + '.',
    'empty-string values stay empty (no default fallback)'
  )
  t.is(interpolate('no placeholders', { x: 1 }), 'no placeholders', 'passthrough for static text')
  t.is(interpolate(null, {}), '', 'null template collapses to empty string')
})

test('pickTemplate supports both flat and keyed phrasebook shapes', async (t) => {
  t.is(
    pickTemplate({ goal_templates: { it: 'Gol!' } }, 'it', 'en'),
    'Gol!',
    'flat shape resolves target locale'
  )
  t.is(
    pickTemplate({ goal_templates: { en: 'Goal!' } }, 'it', 'en'),
    'Goal!',
    'flat shape falls back to default locale'
  )
  t.is(
    pickTemplate({ goal_templates: { 'goal:{team}': { it: 'Gol!', en: 'Goal!' } } }, 'it', 'en'),
    'Gol!',
    'keyed shape resolves target locale'
  )
  t.is(pickTemplate(null, 'en', 'en'), null, 'null phrasebook returns null')
  t.is(pickTemplate({}, 'en', 'en'), null, 'empty phrasebook returns null')
})

// -- WAV header byte layout ------------------------------------------------

test('createWavHeader emits canonical 44-byte RIFF/WAVE/fmt/data chunks', async (t) => {
  const dataLen = 8      // e.g. 4 samples * 2 bytes each
  const sr = 44100
  const header = createWavHeader(dataLen, sr)
  t.is(header.length, 44, 'header is exactly 44 bytes')
  t.is(header.toString('ascii', 0, 4), 'RIFF', 'bytes 0-3 = RIFF')
  t.is(header.readUInt32LE(4), 36 + dataLen, 'bytes 4-7 = 36 + dataLen')
  t.is(header.toString('ascii', 8, 12), 'WAVE', 'bytes 8-11 = WAVE')
  t.is(header.toString('ascii', 12, 16), 'fmt ', 'bytes 12-15 = fmt (with trailing space)')
  t.is(header.readUInt32LE(16), 16, 'bytes 16-19 = fmt chunk size 16')
  t.is(header.readUInt16LE(20), 1, 'bytes 20-21 = PCM format tag 1')
  t.is(header.readUInt16LE(22), 1, 'bytes 22-23 = 1 channel (mono)')
  t.is(header.readUInt32LE(24), sr, 'bytes 24-27 = sample rate LE')
  t.is(header.readUInt32LE(28), sr * 2, 'bytes 28-31 = byte rate (sr * 2 for mono s16)')
  t.is(header.readUInt16LE(32), 2, 'bytes 32-33 = block align (2 bytes per frame)')
  t.is(header.readUInt16LE(34), 16, 'bytes 34-35 = 16 bits per sample')
  t.is(header.toString('ascii', 36, 40), 'data', 'bytes 36-39 = data')
  t.is(header.readUInt32LE(40), dataLen, 'bytes 40-43 = dataLen LE')
})

test('int16ArrayToBuffer clamps out-of-range samples and encodes LE s16', async (t) => {
  const buf = int16ArrayToBuffer([0, 32767, -32768, 40000, -40000, 12345])
  t.is(buf.length, 12, '6 samples * 2 bytes = 12 bytes')
  t.is(buf.readInt16LE(0), 0, 'zero preserved')
  t.is(buf.readInt16LE(2), 32767, 'max int16 preserved')
  t.is(buf.readInt16LE(4), -32768, 'min int16 preserved')
  t.is(buf.readInt16LE(6), 32767, 'positive overflow clamped to 32767')
  t.is(buf.readInt16LE(8), -32768, 'negative overflow clamped to -32768')
  t.is(buf.readInt16LE(10), 12345, 'mid-range preserved')
})

test('pcmToWav returns {wavBuffer, sizeBytes} with correct total size', async (t) => {
  const samples = [1, 2, 3, 4]
  const { wavBuffer, sizeBytes } = pcmToWav(samples, SUPERTONIC_SAMPLE_RATE)
  t.is(sizeBytes, 44 + samples.length * 2, 'header + samples*2 bytes')
  t.is(wavBuffer.length, sizeBytes, 'wavBuffer length matches sizeBytes')
  t.is(wavBuffer.toString('ascii', 0, 4), 'RIFF', 'wraps with RIFF prefix')
  // Data chunk contents at [44..]
  t.is(wavBuffer.readInt16LE(44), 1, 'first sample LE at byte 44')
  t.is(wavBuffer.readInt16LE(46), 2, 'second sample LE at byte 46')
})

// -- Feature-flag gate -----------------------------------------------------

test('announcerFlagEnabled reads env correctly', async (t) => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
    withFlag(v, () => t.ok(announcerFlagEnabled(), 'enabled for ' + v))
  }
  for (const v of ['', '0', 'false', 'no', 'off', 'anything']) {
    withFlag(v, () => t.absent(announcerFlagEnabled(), 'disabled for ' + JSON.stringify(v)))
  }
})

test('speak() returns null when CURVA_QVAC_TTS_ENABLED is not set', async (t) => {
  await withFlagAsync('', async () => {
    const sdk = makeFakeSdk()
    const a = createAnnouncer({
      storageDir: TMP_STORAGE,
      isHost: true,
      sdkImpl: sdk
    })
    a.setPhrasebook(PHRASEBOOK)
    const out = await a.speak({
      matchId: 'm1', minute: 42, scorer: 'Messi',
      team: 'ARG', score: { home: 1, away: 0 }, targetLocale: 'en'
    })
    t.is(out, null, 'speak short-circuits to null when flag off')
    t.is(sdk.loadCalls.length, 0, 'no loadModel calls when flag off')
    t.is(sdk.speakCalls.length, 0, 'no textToSpeech calls when flag off')
  })
})

test('speak() returns null when phrasebook has no template', async (t) => {
  await withFlagAsync('true', async () => {
    const sdk = makeFakeSdk()
    const a = createAnnouncer({ storageDir: TMP_STORAGE, isHost: true, sdkImpl: sdk })
    a.setPhrasebook({ goal_templates: {} })
    const out = await a.speak({
      matchId: 'm1', minute: 1, scorer: 'x', team: 'y',
      score: { home: 0, away: 0 }, targetLocale: 'en'
    })
    t.is(out, null, 'null when no template resolves for locale')
    t.is(sdk.speakCalls.length, 0, 'no synth when template missing')
  })
})

// -- Full synth path -------------------------------------------------------

test('speak() interpolates, synths, and returns WAV base64 payload', async (t) => {
  await withFlagAsync('true', async () => {
    const sdk = makeFakeSdk({ samples: [0, 1000, -1000, 0] })
    const a = createAnnouncer({ storageDir: TMP_STORAGE, isHost: true, sdkImpl: sdk })
    a.setPhrasebook(PHRASEBOOK)
    const out = await a.speak({
      matchId: 'wc-final',
      minute: 87,
      scorer: 'Messi',
      team: 'Argentina',
      score: { home: 2, away: 1 },
      targetLocale: 'it'
    })
    t.ok(out && typeof out === 'object', 'returns payload object')
    t.is(out.lang, 'it', 'lang echoed')
    t.is(out.matchId, 'wc-final', 'matchId echoed')
    t.is(out.minute, '87', 'minute normalised to string')
    t.is(out.sampleRate, SUPERTONIC_SAMPLE_RATE, 'sample rate stamped')
    t.is(out.sizeBytes, 44 + 4 * 2, 'sizeBytes = header + samples*2')
    t.is(out.text, 'Gol! Messi segna per Argentina. 2-1 al minuto 87.',
      'italian template interpolated correctly')

    // Verify the base64 decodes to a well-formed WAV with our data.
    const wav = Buffer.from(out.wavBase64, 'base64')
    t.is(wav.length, out.sizeBytes, 'base64 decodes to sizeBytes')
    t.is(wav.toString('ascii', 0, 4), 'RIFF', 'base64 payload starts with RIFF')
    t.is(wav.readUInt32LE(24), 44100, 'sample rate at byte 24 = 44100')
    t.is(wav.readInt16LE(44), 0, 'first sample')
    t.is(wav.readInt16LE(46), 1000, 'second sample')
    t.is(wav.readInt16LE(48), -1000, 'third sample')

    // exactly ONE loadModel and ONE textToSpeech call
    t.is(sdk.loadCalls.length, 1, 'loadModel called once for it')
    t.is(sdk.speakCalls.length, 1, 'textToSpeech called once')
    const call = sdk.speakCalls[0]
    t.is(call.inputType, 'text', 'inputType is text')
    t.is(call.stream, false, 'stream is false (non-streaming)')
    t.is(call.sentenceStream, false, 'sentenceStream is false')
    t.is(call.modelId, 'model-it', 'per-locale modelId routed')
  })
})

test('speak() with missing minute/team collapses placeholders to empty', async (t) => {
  await withFlagAsync('true', async () => {
    const sdk = makeFakeSdk({ samples: [0, 1, 2] })
    const a = createAnnouncer({ storageDir: TMP_STORAGE, isHost: true, sdkImpl: sdk })
    a.setPhrasebook(PHRASEBOOK)
    const out = await a.speak({
      matchId: 'wc',
      scorer: 'X',
      targetLocale: 'en'
    })
    t.ok(out, 'payload returned')
    // Empty team/minute/score placeholders collapse to '' — grammar may
    // look funny but the string is non-empty and safe.
    t.ok(!out.text.includes('{'), 'no {placeholders} leaked')
    t.ok(out.text.includes('X'), 'scorer preserved')
  })
})

// -- Per-locale model caching ---------------------------------------------

test('second speak() for same locale reuses cached modelId (loadModel called once)', async (t) => {
  await withFlagAsync('true', async () => {
    const sdk = makeFakeSdk()
    const a = createAnnouncer({ storageDir: TMP_STORAGE, isHost: true, sdkImpl: sdk })
    a.setPhrasebook(PHRASEBOOK)
    await a.speak({ scorer: 'A', team: 'T', score: { home: 1, away: 0 }, targetLocale: 'en' })
    await a.speak({ scorer: 'B', team: 'T', score: { home: 2, away: 0 }, targetLocale: 'en' })
    await a.speak({ scorer: 'C', team: 'T', score: { home: 3, away: 0 }, targetLocale: 'en' })
    t.is(sdk.loadCalls.length, 1, 'loadModel called exactly once for en')
    t.is(sdk.speakCalls.length, 3, 'textToSpeech called three times')
    t.is(a._internal.loadCallsFor('en'), 1, 'loadCallsFor reports 1 for en')
  })
})

test('different locales trigger separate loadModel calls (one per language)', async (t) => {
  await withFlagAsync('true', async () => {
    const sdk = makeFakeSdk()
    const a = createAnnouncer({ storageDir: TMP_STORAGE, isHost: true, sdkImpl: sdk })
    a.setPhrasebook(PHRASEBOOK)
    await a.speak({ scorer: 'A', team: 'T', score: { home: 1, away: 0 }, targetLocale: 'en' })
    await a.speak({ scorer: 'B', team: 'T', score: { home: 2, away: 0 }, targetLocale: 'it' })
    await a.speak({ scorer: 'C', team: 'T', score: { home: 3, away: 0 }, targetLocale: 'id' })
    t.is(sdk.loadCalls.length, 3, 'one loadModel per unique locale')
    const langs = sdk.loadCalls.map((c) => c.modelConfig.language).sort()
    t.alike(langs, ['en', 'id', 'it'], 'each language configured separately')

    // Second call for 'en' still reuses cache.
    await a.speak({ scorer: 'D', team: 'T', score: { home: 4, away: 0 }, targetLocale: 'en' })
    t.is(sdk.loadCalls.length, 3, 'repeat en does not re-load')
  })
})

test('enable({locales}) warms models for the requested set', async (t) => {
  await withFlagAsync('true', async () => {
    const sdk = makeFakeSdk()
    const a = createAnnouncer({ storageDir: TMP_STORAGE, isHost: true, sdkImpl: sdk })
    a.setPhrasebook(PHRASEBOOK)
    const res = await a.enable({ locales: ['en', 'it'], defaultLocale: 'en' })
    t.ok(res.enabled, 'enable returns enabled')
    t.alike(res.locales.sort(), ['en', 'it'], 'both locales warm')
    t.is(sdk.loadCalls.length, 2, 'two loadModel calls at enable time')
    // Speak reuses cache.
    await a.speak({ scorer: 'X', team: 'Y', score: { home: 0, away: 0 }, targetLocale: 'en' })
    t.is(sdk.loadCalls.length, 2, 'speak after enable does not re-load')
  })
})

test('enable() short-circuits when feature flag is off', async (t) => {
  await withFlagAsync('', async () => {
    const sdk = makeFakeSdk()
    const a = createAnnouncer({ storageDir: TMP_STORAGE, isHost: true, sdkImpl: sdk })
    const res = await a.enable({ locales: ['en'] })
    t.is(res.enabled, false, 'not enabled')
    t.is(res.reason, 'FLAG_OFF', 'reason is FLAG_OFF')
    t.is(sdk.loadCalls.length, 0, 'no loadModel calls when flag off')
  })
})

// -- close() unloads models -------------------------------------------------

test('close() unloads all cached models', async (t) => {
  await withFlagAsync('true', async () => {
    const unloadCalls = []
    const sdk = makeFakeSdk()
    sdk.unloadModel = async (p) => { unloadCalls.push(p); return true }
    const a = createAnnouncer({ storageDir: TMP_STORAGE, isHost: true, sdkImpl: sdk })
    a.setPhrasebook(PHRASEBOOK)
    await a.speak({ scorer: 'A', team: 'T', score: { home: 1, away: 0 }, targetLocale: 'en' })
    await a.speak({ scorer: 'B', team: 'T', score: { home: 2, away: 0 }, targetLocale: 'it' })
    await a.close()
    t.is(unloadCalls.length, 2, 'unload called for each cached locale')
    const status = a.status()
    t.is(status.enabled, false, 'status reflects disabled state')
    t.is(status.loadedLocales.length, 0, 'no locales remain loaded')
  })
})

// -- Constructor validation -------------------------------------------------

test('createAnnouncer requires storageDir', async (t) => {
  t.exception.all(() => createAnnouncer({}), /storageDir/, 'throws without storageDir')
  t.exception.all(() => createAnnouncer({ storageDir: '' }), /storageDir/, 'throws on empty storageDir')
})
