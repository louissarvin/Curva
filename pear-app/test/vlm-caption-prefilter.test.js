// Wave 4 F1: MobileNetV3-Small pre-filter unit tests for bare/vlmCaption.js.
//
// Verified against installed .d.ts (0.14.0):
//   node_modules/@qvac/sdk/dist/client/api/classify.d.ts:22
//     classify(params) => Promise<ClassificationResult[]>
//   node_modules/@qvac/sdk/dist/client/api/classify.d.ts:4-6 (JSDoc)
//     bundled MobileNetV3-Small emits labels "food"|"report"|"other".
//
// Every test injects a fake SDK; no network, no model files, no bare/`fs`
// path required for pre-filter tests since we pass Buffer inputs.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const {
  createVlmCaption,
  prefilterEnabled,
  PREFILTER_MIN_CONFIDENCE
} = require('../bare/vlmCaption.js')

// --- fake SDK ---------------------------------------------------------------

/**
 * Build a fake SDK with:
 *  - scripted classify results (for pre-filter tests)
 *  - scripted completion events (for the VLM path)
 * Tracks loadModel({modelType}) calls so tests can assert which model was
 * loaded and how many times.
 */
function makeFakeSdk ({
  classifyResults = [],
  classifyThrows = null,
  completionEvents = [],
  loadThrows = null,
  classifierLoadThrows = null
} = {}) {
  const loadCalls = []
  const completionCalls = []
  const classifyCalls = []
  return {
    _loadCalls: loadCalls,
    _completionCalls: completionCalls,
    _classifyCalls: classifyCalls,
    async loadModel (opts) {
      loadCalls.push(opts)
      if (opts.modelType === 'ggml-classification') {
        if (classifierLoadThrows) throw classifierLoadThrows
        return 'fake-classifier-id'
      }
      if (loadThrows) throw loadThrows
      return 'fake-vlm-model-id'
    },
    async classify (opts) {
      classifyCalls.push(opts)
      if (classifyThrows) throw classifyThrows
      return classifyResults
    },
    completion (opts) {
      completionCalls.push(opts)
      return {
        events: (async function * () {
          for (const e of completionEvents) yield e
        })()
      }
    },
    async unloadModel () {}
  }
}

// A minimal PNG buffer so materializeImage's sniffExt returns 'png' when the
// caption path runs. Bytes are never actually decoded by the fake SDK.
function makePngBuffer () {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

// Feature-flag helpers — every test that toggles the flag MUST restore it in a
// finally block. brittle uses process-global lifecycle so leaks cross-tests.
function withPrefilterFlag (value, fn) {
  const prev = process.env.CURVA_VLM_PREFILTER_ENABLED
  if (value === undefined) delete process.env.CURVA_VLM_PREFILTER_ENABLED
  else process.env.CURVA_VLM_PREFILTER_ENABLED = value
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.CURVA_VLM_PREFILTER_ENABLED
      else process.env.CURVA_VLM_PREFILTER_ENABLED = prev
    })
}

// ---------------------------------------------------------------------------

test('prefilterEnabled respects the CURVA_VLM_PREFILTER_ENABLED env flag', async (t) => {
  await withPrefilterFlag(undefined, () => t.is(prefilterEnabled(), false, 'unset -> off'))
  await withPrefilterFlag('false', () => t.is(prefilterEnabled(), false, 'false -> off'))
  await withPrefilterFlag('TRUE', () => t.is(prefilterEnabled(), true, 'TRUE -> on (case-insensitive)'))
  await withPrefilterFlag('true', () => t.is(prefilterEnabled(), true, 'true -> on'))
})

test('flag off: pre-filter does NOT run and VLM caption path is unchanged', async (t) => {
  await withPrefilterFlag('false', async () => {
    const sdk = makeFakeSdk({
      completionEvents: [
        { type: 'contentDelta', seq: 0, text: 'A pass.' },
        { type: 'completionDone', seq: 1, stopReason: 'eos' }
      ],
      classifyResults: [{ label: 'food', confidence: 0.99 }] // would skip if pre-filter ran
    })
    const emitted = []
    const vlm = createVlmCaption({ sdk, emit: (ev, p) => emitted.push({ ev, p }) })
    const r = await vlm.caption(makePngBuffer())
    t.ok(r.ok, 'caption succeeded because pre-filter is gated off')
    t.is(sdk._classifyCalls.length, 0, 'classify NEVER called when flag off')
    // Only the VLM model was loaded; the classifier was NOT.
    const kinds = sdk._loadCalls.map((c) => c.modelType)
    t.absent(kinds.includes('ggml-classification'), 'classifier never loaded when flag off')
    t.absent(emitted.some((e) => e.ev.startsWith('vlm:pre-filter')), 'no pre-filter events emitted')
  })
})

test('flag on + top label "food": pre-filter SKIPS the VLM caption', async (t) => {
  await withPrefilterFlag('true', async () => {
    const sdk = makeFakeSdk({
      classifyResults: [
        { label: 'food', confidence: 0.87 },
        { label: 'other', confidence: 0.10 },
        { label: 'report', confidence: 0.03 }
      ],
      completionEvents: [
        { type: 'contentDelta', seq: 0, text: 'should not be reached' },
        { type: 'completionDone', seq: 1, stopReason: 'eos' }
      ]
    })
    const emitted = []
    const vlm = createVlmCaption({ sdk, emit: (ev, p) => emitted.push({ ev, p }) })
    const r = await vlm.caption(makePngBuffer())
    t.is(r.ok, false, 'skipped')
    t.is(r.code, 'PRE_FILTER')
    t.is(r.reason, 'off-topic-label')
    t.is(r.topLabel, 'food')
    t.is(sdk._classifyCalls.length, 1, 'classify called once')
    t.is(sdk._completionCalls.length, 0, 'expensive VLM completion NEVER called')
    const skip = emitted.find((e) => e.ev === 'vlm:pre-filter-skip')
    t.ok(skip, 'pre-filter-skip event emitted')
    t.is(skip.p.reason, 'off-topic-label')
    t.is(skip.p.topLabel, 'food')
    // Counter check
    const s = vlm.status()
    t.is(s.prefilter.skippedLabel, 1)
    t.is(s.prefilter.passed, 0)
  })
})

test('flag on + low confidence: pre-filter SKIPS with reason low-confidence', async (t) => {
  await withPrefilterFlag('true', async () => {
    const sdk = makeFakeSdk({
      // Top confidence < PREFILTER_MIN_CONFIDENCE (0.4) -> skip regardless of label
      classifyResults: [
        { label: 'report', confidence: 0.31 },
        { label: 'other', confidence: 0.28 },
        { label: 'food', confidence: 0.10 }
      ],
      completionEvents: [{ type: 'completionDone', seq: 0 }]
    })
    const emitted = []
    const vlm = createVlmCaption({ sdk, emit: (ev, p) => emitted.push({ ev, p }) })
    const r = await vlm.caption(makePngBuffer())
    t.is(r.ok, false)
    t.is(r.code, 'PRE_FILTER')
    t.is(r.reason, 'low-confidence')
    t.ok(r.topConfidence < PREFILTER_MIN_CONFIDENCE)
    t.is(sdk._completionCalls.length, 0, 'VLM NOT called on low-confidence skip')
    t.is(vlm.status().prefilter.skippedLowConf, 1)
  })
})

test('flag on + label "report" high conf: pre-filter PASSES and VLM runs', async (t) => {
  await withPrefilterFlag('true', async () => {
    const sdk = makeFakeSdk({
      classifyResults: [
        { label: 'report', confidence: 0.72 },
        { label: 'other', confidence: 0.20 },
        { label: 'food', confidence: 0.08 }
      ],
      completionEvents: [
        { type: 'contentDelta', seq: 0, text: 'Two players contest ' },
        { type: 'contentDelta', seq: 1, text: 'the ball at midfield.' },
        { type: 'completionDone', seq: 2, stopReason: 'eos' }
      ]
    })
    const emitted = []
    const vlm = createVlmCaption({ sdk, emit: (ev, p) => emitted.push({ ev, p }) })
    const r = await vlm.caption(makePngBuffer())
    t.ok(r.ok, 'caption returned success')
    t.is(r.caption, 'Two players contest the ball at midfield.')
    t.is(sdk._classifyCalls.length, 1, 'classifier ran')
    t.is(sdk._completionCalls.length, 1, 'VLM ran because pre-filter passed')
    const pass = emitted.find((e) => e.ev === 'vlm:pre-filter-passed')
    t.ok(pass, 'pre-filter-passed emitted')
    t.is(pass.p.topLabel, 'report')
    t.is(vlm.status().prefilter.passed, 1)
  })
})

test('flag on + label "other" high conf: pre-filter PASSES', async (t) => {
  await withPrefilterFlag('true', async () => {
    // "other" is treated as pass-through (a weak signal, not a skip).
    const sdk = makeFakeSdk({
      classifyResults: [{ label: 'other', confidence: 0.55 }],
      completionEvents: [
        { type: 'contentDelta', seq: 0, text: 'ok.' },
        { type: 'completionDone', seq: 1 }
      ]
    })
    const vlm = createVlmCaption({ sdk })
    const r = await vlm.caption(makePngBuffer())
    t.ok(r.ok)
    t.is(sdk._completionCalls.length, 1, 'VLM called for "other" label')
  })
})

test('classifier is loaded exactly once and reused across calls', async (t) => {
  await withPrefilterFlag('true', async () => {
    const sdk = makeFakeSdk({
      classifyResults: [{ label: 'report', confidence: 0.9 }],
      completionEvents: [
        { type: 'contentDelta', seq: 0, text: 'ok.' },
        { type: 'completionDone', seq: 1 }
      ]
    })
    const vlm = createVlmCaption({ sdk })
    await vlm.caption(makePngBuffer())
    await vlm.caption(makePngBuffer())
    await vlm.caption(makePngBuffer())
    const classifierLoads = sdk._loadCalls.filter((c) => c.modelType === 'ggml-classification')
    t.is(classifierLoads.length, 1, 'ggml-classification loaded exactly once')
    t.is(sdk._classifyCalls.length, 3, 'classifier invoked once per frame')
  })
})

test('classifier load failure: pre-filter fails OPEN (VLM still runs)', async (t) => {
  await withPrefilterFlag('true', async () => {
    const sdk = makeFakeSdk({
      classifierLoadThrows: Object.assign(new Error('boom'), { code: 'CLASSIFIER_DOWN' }),
      completionEvents: [
        { type: 'contentDelta', seq: 0, text: 'ok.' },
        { type: 'completionDone', seq: 1 }
      ]
    })
    const emitted = []
    const vlm = createVlmCaption({ sdk, emit: (ev, p) => emitted.push({ ev, p }) })
    const r = await vlm.caption(makePngBuffer())
    t.ok(r.ok, 'VLM still runs when classifier fails to load')
    t.ok(emitted.some((e) => e.ev === 'vlm:pre-filter-error'), 'error event emitted')
    // Second call should not attempt to reload the broken classifier.
    await vlm.caption(makePngBuffer())
    const classifierLoads = sdk._loadCalls.filter((c) => c.modelType === 'ggml-classification')
    t.is(classifierLoads.length, 1, 'broken classifier is NOT reloaded on subsequent frames')
  })
})

test('classify() throw: pre-filter fails OPEN (VLM still runs) and counter increments', async (t) => {
  await withPrefilterFlag('true', async () => {
    const sdk = makeFakeSdk({
      classifyThrows: new Error('classify crashed'),
      completionEvents: [
        { type: 'contentDelta', seq: 0, text: 'ok.' },
        { type: 'completionDone', seq: 1 }
      ]
    })
    const vlm = createVlmCaption({ sdk })
    const r = await vlm.caption(makePngBuffer())
    t.ok(r.ok, 'VLM still runs when classify throws')
    t.is(vlm.status().prefilter.error, 1, 'error counter incremented')
  })
})

test('caller opt-out via usePreFilter:false bypasses the pre-filter even with flag on', async (t) => {
  await withPrefilterFlag('true', async () => {
    const sdk = makeFakeSdk({
      classifyResults: [{ label: 'food', confidence: 0.99 }], // would skip if invoked
      completionEvents: [
        { type: 'contentDelta', seq: 0, text: 'A goal.' },
        { type: 'completionDone', seq: 1 }
      ]
    })
    const vlm = createVlmCaption({ sdk })
    const r = await vlm.caption(makePngBuffer(), { usePreFilter: false })
    t.ok(r.ok)
    t.is(sdk._classifyCalls.length, 0, 'classifier NOT called when caller opts out')
  })
})

test('path-input skips pre-filter (fail-open) even when flag is on', async (t) => {
  await withPrefilterFlag('true', async () => {
    // Path inputs go straight to VLM — we do not read the file just to run
    // classify. Preserves back-compat for callers wired to file paths.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curva-vlm-pf-'))
    const p = path.join(dir, 'frame.png')
    fs.writeFileSync(p, makePngBuffer())
    try {
      const sdk = makeFakeSdk({
        classifyResults: [{ label: 'food', confidence: 0.99 }],
        completionEvents: [
          { type: 'contentDelta', seq: 0, text: 'A goal.' },
          { type: 'completionDone', seq: 1 }
        ]
      })
      const vlm = createVlmCaption({ sdk })
      const r = await vlm.caption(p)
      t.ok(r.ok, 'path input passes straight through to VLM')
      t.is(sdk._classifyCalls.length, 0, 'no classify call for path input')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('preFilter() is directly callable (for observability wiring)', async (t) => {
  await withPrefilterFlag('true', async () => {
    const sdk = makeFakeSdk({
      classifyResults: [{ label: 'food', confidence: 0.9 }]
    })
    const vlm = createVlmCaption({ sdk })
    const result = await vlm.preFilter(makePngBuffer())
    t.is(result.shouldCaption, false)
    t.is(result.reason, 'off-topic-label')
    t.is(result.topLabel, 'food')
    t.ok(result.topConfidence > 0.4)
  })
})
