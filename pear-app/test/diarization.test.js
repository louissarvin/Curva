// Wave 3 F2 brittle tests: Parakeet Sortformer diarized replay.
//
// Exercises bare/diarization.js via a scripted fake @qvac/sdk. The fake
// transcribeStream returns a session whose async iterator emits the events
// we pre-load, so we can drive the speaker-table math deterministically.

const test = require('brittle')
const {
  createDiarization,
  extractSpeakerId,
  coerceAudio,
  SESSION_MAX_BYTES,
  MAX_TRACKED_SPEAKERS,
  UNKNOWN_SPEAKER
} = require('../bare/diarization.js')

// -- Docs-verification memo -------------------------------------------------

test('docs-verification memo lives at the top of diarization.js', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'bare', 'diarization.js'), 'utf8')
  const head = src.slice(0, 4000)
  t.ok(head.includes('Docs-verification memo'), 'memo present')
  t.ok(head.includes('@qvac/sdk'), 'names the SDK it verifies against')
  t.ok(head.includes('transcription-config.d.ts:120-126'), 'cites config .d.ts line range')
  t.ok(head.includes('spkCacheEnable'), 'names spkCacheEnable field')
  t.ok(head.includes('Sortformer'), 'documents Sortformer')
})

// -- Helpers ----------------------------------------------------------------

function scriptedSdk ({ events = [], openThrows = null } = {}) {
  const writes = []
  let ended = false
  let destroyed = false
  const session = {
    write (b) { writes.push(b.byteLength) },
    end () { ended = true },
    destroy () { destroyed = true },
    [Symbol.asyncIterator] () {
      let i = 0
      return {
        async next () {
          if (i >= events.length) return { value: undefined, done: true }
          const v = events[i++]
          return { value: v, done: false }
        }
      }
    }
  }
  const sdk = {
    lastParams: null,
    async transcribeStream (params) {
      if (openThrows) throw openThrows
      sdk.lastParams = params
      return session
    },
    async unloadModel () {}
  }
  return { sdk, session, writes, isEnded: () => ended, isDestroyed: () => destroyed }
}

function collectEmits () {
  const events = []
  const emit = (e, p) => events.push({ e, p })
  return { events, emit }
}

// -- extractSpeakerId (defensive over unknown field name) -------------------

test('extractSpeakerId reads speakerId', (t) => {
  t.is(extractSpeakerId({ speakerId: 'Andi' }), 'Andi')
})

test('extractSpeakerId reads speaker fallback', (t) => {
  t.is(extractSpeakerId({ speaker: 'Budi' }), 'Budi')
})

test('extractSpeakerId reads spkId fallback', (t) => {
  t.is(extractSpeakerId({ spkId: 'Sari' }), 'Sari')
})

test('extractSpeakerId reads speaker_id snake_case', (t) => {
  t.is(extractSpeakerId({ speaker_id: 'X' }), 'X')
})

test('extractSpeakerId coerces numeric ids to "spk-N"', (t) => {
  t.is(extractSpeakerId({ speakerId: 3 }), 'spk-3')
  t.is(extractSpeakerId({ speaker: 0 }), 'spk-0')
})

test('extractSpeakerId returns "unknown" when nothing present', (t) => {
  t.is(extractSpeakerId({}), UNKNOWN_SPEAKER)
  t.is(extractSpeakerId(null), UNKNOWN_SPEAKER)
})

test('extractSpeakerId caps overlong ids at 32 chars', (t) => {
  const long = 'x'.repeat(60)
  t.is(extractSpeakerId({ speakerId: long }).length, 32)
})

// -- coerceAudio ------------------------------------------------------------

test('coerceAudio passes Uint8Array', (t) => {
  const u = new Uint8Array([1, 2, 3])
  t.is(coerceAudio(u), u)
})

test('coerceAudio wraps ArrayBuffer', (t) => {
  const ab = new ArrayBuffer(8)
  const out = coerceAudio(ab)
  t.ok(out instanceof Uint8Array)
  t.is(out.byteLength, 8)
})

test('coerceAudio views Float32Array', (t) => {
  const f = new Float32Array([1, 2])
  const out = coerceAudio(f)
  t.ok(out instanceof Uint8Array)
  t.is(out.byteLength, 8)
})

test('coerceAudio returns null on garbage', (t) => {
  t.is(coerceAudio(null), null)
  t.is(coerceAudio('str'), null)
  t.is(coerceAudio(42), null)
})

// -- startSession validation ------------------------------------------------

test('startSession fails cleanly when sdk missing', async (t) => {
  const d = createDiarization({ sdk: null })
  const res = await d.startSession()
  t.absent(res.ok)
  t.is(res.code, 'STT_UNAVAILABLE')
})

test('startSession fails cleanly when transcribeStream throws', async (t) => {
  const { sdk } = scriptedSdk({ openThrows: new Error('boom') })
  const d = createDiarization({ sdk })
  const res = await d.startSession()
  t.absent(res.ok)
  t.is(res.code, 'STT_OPEN')
})

test('startSession rejects a second start while the first is active', async (t) => {
  const { sdk } = scriptedSdk({ events: [] })
  const d = createDiarization({ sdk })
  const first = await d.startSession()
  t.ok(first.ok)
  const second = await d.startSession()
  t.absent(second.ok)
  t.is(second.code, 'SESSION_ACTIVE')
})

test('startSession passes spkCache config through to transcribeStream', async (t) => {
  const { sdk } = scriptedSdk({ events: [] })
  const d = createDiarization({ sdk, spkCacheLen: 300, spkCacheUpdatePeriodMs: 750 })
  await d.startSession()
  const cfg = sdk.lastParams.parakeetStreamingConfig
  t.ok(cfg.spkCacheEnable === true, 'spkCacheEnable true')
  t.is(cfg.spkCacheLen, 300)
  t.is(cfg.spkCacheUpdatePeriod, 750)
  // Both flavours passed for SDK build compat.
  t.ok(cfg.streamingSpkCacheEnable === true)
  t.is(cfg.streamingSpkCacheLen, 300)
})

// -- Speaker table math (scripted turns) -----------------------------------

test('scripted turns build cumulative speaker table', async (t) => {
  // Andi: 12s over 2 segments, Budi: 8s, Sari: 6s over 2 segments.
  const events = [
    { type: 'segment', segment: { speakerId: 'Andi', text: 'go left', startMs: 0, endMs: 5000, append: false, id: 1 } },
    { type: 'segment', segment: { speakerId: 'Budi', text: 'no cross', startMs: 5000, endMs: 13000, append: false, id: 2 } },
    { type: 'segment', segment: { speakerId: 'Andi', text: 'i said left', startMs: 13000, endMs: 20000, append: false, id: 3 } },
    { type: 'segment', segment: { speakerId: 'Sari', text: 'goal!', startMs: 20000, endMs: 22000, append: false, id: 4 } },
    { type: 'segment', segment: { speakerId: 'Sari', text: 'again', startMs: 22000, endMs: 26000, append: false, id: 5 } }
  ]
  const { sdk } = scriptedSdk({ events })
  const { events: emits, emit } = collectEmits()
  const d = createDiarization({ sdk, emit })
  await d.startSession()
  await d.endSession()

  const table = d.getSpeakerTable()
  // Sorted by totalMs descending.
  t.is(table.length, 3, 'three speakers tracked')
  t.is(table[0].speakerId, 'Andi')
  t.is(table[0].totalMs, 12000)
  t.is(table[0].segmentCount, 2)
  t.is(table[1].speakerId, 'Budi')
  t.is(table[1].totalMs, 8000)
  t.is(table[1].segmentCount, 1)
  t.is(table[2].speakerId, 'Sari')
  t.is(table[2].totalMs, 6000)
  t.is(table[2].segmentCount, 2)

  const turns = d.getTurns()
  t.is(turns.length, 5, '5 turns logged in order')
  t.is(turns[0].speakerId, 'Andi')
  t.is(turns[4].speakerId, 'Sari')

  // diarize:turn events one-per-segment.
  const turnEvents = emits.filter((e) => e.e === 'diarize:turn')
  t.is(turnEvents.length, 5, 'five diarize:turn events')
  t.is(turnEvents[0].p.speakerId, 'Andi')
})

test('store callback is invoked once per turn (and errors are non-fatal)', async (t) => {
  const events = [
    { type: 'segment', segment: { speakerId: 'A', text: 'x', startMs: 0, endMs: 1000, append: false, id: 1 } },
    { type: 'segment', segment: { speakerId: 'B', text: 'y', startMs: 1000, endMs: 2000, append: false, id: 2 } }
  ]
  const { sdk } = scriptedSdk({ events })
  const stored = []
  const store = async (turn) => {
    stored.push(turn)
    if (turn.speakerId === 'B') throw new Error('storage down')
  }
  const d = createDiarization({ sdk })
  await d.startSession({ store })
  await d.endSession()
  // Flush microtasks so Promise.resolve().then(store) chains fire.
  await new Promise((r) => setTimeout(r, 5))
  t.is(stored.length, 2, 'store invoked for each turn')
  t.is(stored[0].speakerId, 'A')
  t.is(stored[1].speakerId, 'B')
})

test('unknown speaker id falls back to "unknown" without dropping the turn', async (t) => {
  const events = [
    { type: 'segment', segment: { text: 'no id here', startMs: 0, endMs: 2000, append: false, id: 1 } }
  ]
  const { sdk } = scriptedSdk({ events })
  const d = createDiarization({ sdk })
  await d.startSession()
  await d.endSession()
  const tbl = d.getSpeakerTable()
  t.is(tbl.length, 1)
  t.is(tbl[0].speakerId, UNKNOWN_SPEAKER)
  t.is(tbl[0].totalMs, 2000)
})

test('speaker table cap prevents runaway growth', async (t) => {
  const events = []
  for (let i = 0; i < MAX_TRACKED_SPEAKERS + 10; i++) {
    events.push({
      type: 'segment',
      segment: { speakerId: 'sp-' + i, text: 't', startMs: i * 100, endMs: i * 100 + 50, append: false, id: i }
    })
  }
  const { sdk } = scriptedSdk({ events })
  const { events: emits, emit } = collectEmits()
  const d = createDiarization({ sdk, emit })
  await d.startSession()
  await d.endSession()
  const tbl = d.getSpeakerTable()
  t.is(tbl.length, MAX_TRACKED_SPEAKERS, 'table capped')
  const cap = emits.filter((e) => e.e === 'diarize:speaker-cap')
  t.ok(cap.length >= 10, 'cap events for overflow speakers')
})

test('resetTable clears table + turns on next startSession', async (t) => {
  const events = [
    { type: 'segment', segment: { speakerId: 'A', text: 'x', startMs: 0, endMs: 1000, append: false, id: 1 } }
  ]
  const { sdk } = scriptedSdk({ events })
  const d = createDiarization({ sdk })
  await d.startSession()
  await d.endSession()
  t.is(d.getSpeakerTable().length, 1)

  const empty = scriptedSdk({ events: [] })
  const d2 = createDiarization({ sdk: empty.sdk })
  await d2.startSession({ resetTable: true })
  await d2.endSession()
  t.is(d2.getSpeakerTable().length, 0)
})

test('pushAudio without session returns NO_SESSION', async (t) => {
  const { sdk } = scriptedSdk({ events: [] })
  const d = createDiarization({ sdk })
  const res = await d.pushAudio(new Uint8Array([1, 2, 3]))
  t.absent(res.ok)
  t.is(res.code, 'NO_SESSION')
})

test('pushAudio rejects unsupported chunk types', async (t) => {
  const { sdk } = scriptedSdk({ events: [] })
  const d = createDiarization({ sdk })
  await d.startSession()
  const res = await d.pushAudio('not-a-buffer')
  t.absent(res.ok)
  t.is(res.code, 'BAD_AUDIO')
  await d.endSession()
})

test('pushAudio writes bytes to the SDK session', async (t) => {
  const s = scriptedSdk({ events: [] })
  const d = createDiarization({ sdk: s.sdk })
  await d.startSession()
  const res = await d.pushAudio(new Uint8Array([1, 2, 3, 4]))
  t.ok(res.ok)
  t.is(res.bytes, 4)
  t.is(s.writes[0], 4, 'session.write got 4 bytes')
  await d.endSession()
})

test('SESSION_MAX_BYTES fuse trips endSession + returns AUDIO_CAP', async (t) => {
  const s = scriptedSdk({ events: [] })
  const d = createDiarization({ sdk: s.sdk })
  await d.startSession()
  // Force the internal counter close to the cap so a single chunk trips it.
  const st = d._internal.state
  st.bytesThisSession = SESSION_MAX_BYTES - 8
  const res = await d.pushAudio(new Uint8Array(16))
  t.absent(res.ok)
  t.is(res.code, 'AUDIO_CAP')
  t.absent(d.status().sessionActive, 'session ended by fuse')
})

test('endSession is idempotent', async (t) => {
  const { sdk } = scriptedSdk({ events: [] })
  const d = createDiarization({ sdk })
  await d.startSession()
  const first = await d.endSession()
  t.ok(first.ok)
  const second = await d.endSession()
  t.absent(second.ok)
  t.is(second.code, 'NO_SESSION')
})

test('close() ends the current session and marks closed', async (t) => {
  const s = scriptedSdk({ events: [] })
  const d = createDiarization({ sdk: s.sdk })
  await d.startSession()
  await d.close()
  t.ok(d.status().closed)
  const res = await d.startSession()
  t.absent(res.ok)
  t.is(res.code, 'CLOSED')
})

test('emit fires diarize:session-started + diarize:session-ended', async (t) => {
  const { sdk } = scriptedSdk({ events: [] })
  const { events, emit } = collectEmits()
  const d = createDiarization({ sdk, emit })
  await d.startSession()
  await d.endSession()
  const kinds = events.map((e) => e.e)
  t.ok(kinds.includes('diarize:session-started'))
  t.ok(kinds.includes('diarize:session-ended'))
})
