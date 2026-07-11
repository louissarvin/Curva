// F21 OCR audit trail — unit tests for the goal-proof Hyperblob attachment
// and the extended isValidSystemGoalCard validator.
//
// Uses a fake clips + fake chat handle and drives the goal pipeline with all
// LLM/OCR/TTS deps stubbed. The proof feature flag is forced ON via
// `proofFlagOverride: true` so tests do not need to set the environment.

const test = require('brittle')
const { createGoalPipeline, _internal } = require('../bare/goalPipeline.js')
const { _internal: chatInternal } = require('../bare/chat.js')

const { isValidSystemGoalCard } = chatInternal

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeFakeOcr() {
  return {
    async read() {
      return {
        ok: true,
        blocks: [{ text: '10 GOAL 12 3', confidence: 0.9 }],
        durationMs: 5
      }
    }
  }
}

function makeFakeGoalCard() {
  return {
    async parse() {
      return {
        ok: true,
        card: { minute: 12, scorer: 'MESSI', team: 'ARG', assist: 'DI MARIA' }
      }
    }
  }
}

function makeFakeChat() {
  const sent = []
  return {
    sendSystem: async (payload) => { sent.push(payload); return { ok: true } },
    _sent: sent
  }
}

function makeSuccessClips() {
  const calls = []
  return {
    calls,
    addClip: async ({ buffer, match_time_ms, caption }) => {
      calls.push({ size: buffer.length, match_time_ms, caption })
      return {
        clipId: 'padded-ts-000000000000',
        driveKey: 'aa'.repeat(32), // 64-char hex
        path: '/clips/1720000000000.mp4',
        ts: 1720000000000,
        match_time_ms: match_time_ms || 0,
        by_peer: 'bb'.repeat(32)
      }
    }
  }
}

// -----------------------------------------------------------------------------
// isValidSystemGoalCard: proofBlobKey behaviour
// -----------------------------------------------------------------------------

test('isValidSystemGoalCard accepts a goal-card WITHOUT proofBlobKey (backward compat)', (t) => {
  const v = {
    type: 'system:goal-card',
    by_peer: 'aa',
    wall_clock_ms: 1,
    match_time_ms: 0,
    text: 'goal',
    minute: 12
  }
  t.is(isValidSystemGoalCard(v), true)
})

test('isValidSystemGoalCard accepts a goal-card WITH a valid proofBlobKey', (t) => {
  const key = 'a'.repeat(64) + ':/clips/1720000000000.mp4' // 89 chars
  const v = {
    type: 'system:goal-card',
    by_peer: 'aa',
    wall_clock_ms: 1,
    match_time_ms: 0,
    text: 'goal',
    minute: 12,
    proofBlobKey: key
  }
  t.is(isValidSystemGoalCard(v), true)
})

test('isValidSystemGoalCard rejects a proofBlobKey that is too short', (t) => {
  const v = {
    type: 'system:goal-card',
    by_peer: 'aa',
    wall_clock_ms: 1,
    match_time_ms: 0,
    text: 'goal',
    minute: 12,
    proofBlobKey: 'abc:/x' // 6 chars, below the 16 min
  }
  t.is(isValidSystemGoalCard(v), false)
})

test('isValidSystemGoalCard rejects a proofBlobKey that is too long', (t) => {
  const v = {
    type: 'system:goal-card',
    by_peer: 'aa',
    wall_clock_ms: 1,
    match_time_ms: 0,
    text: 'goal',
    minute: 12,
    proofBlobKey: 'x'.repeat(257)
  }
  t.is(isValidSystemGoalCard(v), false)
})

test('isValidSystemGoalCard rejects a non-string proofBlobKey', (t) => {
  const v = {
    type: 'system:goal-card',
    by_peer: 'aa',
    wall_clock_ms: 1,
    match_time_ms: 0,
    text: 'goal',
    minute: 12,
    proofBlobKey: 42
  }
  t.is(isValidSystemGoalCard(v), false)
})

// -----------------------------------------------------------------------------
// goal pipeline: proof attach behaviour
// -----------------------------------------------------------------------------

test('proofBlobKey attached on clips.addClip success', async (t) => {
  const chat = makeFakeChat()
  const clips = makeSuccessClips()
  const pipeline = createGoalPipeline({
    ocr: makeFakeOcr(),
    goalCard: makeFakeGoalCard(),
    clips,
    chat,
    locales: [], // skip TTS locales for speed
    flagOverride: true,
    proofFlagOverride: true
  })
  const res = await pipeline.trigger({ image: Buffer.from([0x1, 0x2, 0x3]) })
  t.is(res.ok, true, 'pipeline succeeded')
  t.is(clips.calls.length, 1, 'clips.addClip called once')
  const goalCard = chat._sent[0]
  t.ok(goalCard, 'goal-card was sent')
  t.is(goalCard.type, 'system:goal-card')
  t.is(typeof goalCard.proofBlobKey, 'string')
  t.ok(goalCard.proofBlobKey.length >= 16 && goalCard.proofBlobKey.length <= 256,
    'proofBlobKey length within validator bounds')
})

test('pipeline still succeeds when clips.addClip throws (no proofBlobKey)', async (t) => {
  const chat = makeFakeChat()
  const clips = {
    addClip: async () => { throw new Error('clips exploded') }
  }
  const pipeline = createGoalPipeline({
    ocr: makeFakeOcr(),
    goalCard: makeFakeGoalCard(),
    clips,
    chat,
    locales: [],
    flagOverride: true,
    proofFlagOverride: true
  })
  const res = await pipeline.trigger({ image: Buffer.from([0x1]) })
  t.is(res.ok, true, 'pipeline still succeeded')
  const goalCard = chat._sent[0]
  t.ok(goalCard, 'goal-card was sent')
  t.is(goalCard.proofBlobKey, undefined, 'no proofBlobKey attached on throw')
})

test('pipeline still succeeds when clips.addClip hangs (timeout)', async (t) => {
  const chat = makeFakeChat()
  const clips = {
    // Hang forever; the pipeline should time out at PROOF_SAVE_TIMEOUT_MS.
    addClip: () => new Promise(() => { /* never resolve */ })
  }
  const pipeline = createGoalPipeline({
    ocr: makeFakeOcr(),
    goalCard: makeFakeGoalCard(),
    clips,
    chat,
    locales: [],
    flagOverride: true,
    proofFlagOverride: true
  })
  const started = Date.now()
  const res = await pipeline.trigger({ image: Buffer.from([0x1]) })
  const elapsed = Date.now() - started
  t.is(res.ok, true, 'pipeline still succeeded on timeout')
  // 2s proof timeout + slack; well below the 30s pipeline timeout.
  t.ok(elapsed < 10_000, 'proof timeout kept pipeline under 10s')
  const goalCard = chat._sent[0]
  t.ok(goalCard, 'goal-card was sent')
  t.is(goalCard.proofBlobKey, undefined, 'no proofBlobKey attached on timeout')
})

test('pipeline succeeds without proofBlobKey when clips handle is absent', async (t) => {
  const chat = makeFakeChat()
  const pipeline = createGoalPipeline({
    ocr: makeFakeOcr(),
    goalCard: makeFakeGoalCard(),
    clips: null,
    chat,
    locales: [],
    flagOverride: true,
    proofFlagOverride: true
  })
  const res = await pipeline.trigger({ image: Buffer.from([0x1]) })
  t.is(res.ok, true)
  const goalCard = chat._sent[0]
  t.ok(goalCard)
  t.is(goalCard.proofBlobKey, undefined, 'no proofBlobKey when clips missing')
})

test('proof feature flag OFF means no clips.addClip call', async (t) => {
  const chat = makeFakeChat()
  const clips = makeSuccessClips()
  const pipeline = createGoalPipeline({
    ocr: makeFakeOcr(),
    goalCard: makeFakeGoalCard(),
    clips,
    chat,
    locales: [],
    flagOverride: true,
    proofFlagOverride: false
  })
  const res = await pipeline.trigger({ image: Buffer.from([0x1]) })
  t.is(res.ok, true)
  t.is(clips.calls.length, 0, 'clips.addClip NOT called when proof flag is off')
})
