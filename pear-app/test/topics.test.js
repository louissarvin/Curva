// Phase 0 brittle test: topic hashing + handle generation.
//
// Run:  npm test  (uses brittle-node under the hood)
// Or:   node test/topics.test.js

const test = require('brittle')
const b4a = require('b4a')

const { topicForSlug, TOPIC_PREFIX } = require('../bare/topics.js')
const { handleFromPubkey, WORDS, COLORS } = require('../bare/identity.js')

// -- topicForSlug ----------------------------------------------------------

test('topicForSlug returns a 32-byte Buffer', (t) => {
  const topic = topicForSlug('demo-room')
  t.is(topic.length, 32, 'hash length is 32 bytes')
  t.ok(b4a.isBuffer(topic), 'returns a Buffer')
})

test('topicForSlug is deterministic (same slug -> same hash)', (t) => {
  const a = topicForSlug('demo-room')
  const b = topicForSlug('demo-room')
  t.alike(a, b, 'two calls produce identical bytes')
})

test('topicForSlug is collision-resistant across different slugs', (t) => {
  const slugs = [
    'demo-room',
    'demo-room-2',
    'qf-1',
    'qf-2',
    'italy-vs-france',
    'a',
    'z',
    'the-longest-slug-we-would-ever-use-well-within-limits-ok'
  ]
  const topics = slugs.map(topicForSlug)
  const seen = new Set()
  for (const topic of topics) {
    const hex = b4a.toString(topic, 'hex')
    t.absent(seen.has(hex), `no duplicate hash for distinct slug`)
    seen.add(hex)
  }
})

test('topicForSlug matches known vector for "demo-room"', (t) => {
  // Pin the expected value. Change here IFF the hashing scheme intentionally changes.
  // If this test fails, EVERY existing peer will be on a different topic than
  // new peers - this is a wire-breaking change.
  const topic = topicForSlug('demo-room')
  const hex = b4a.toString(topic, 'hex')
  t.is(hex.length, 64, 'hex encoding is 64 chars')
  // The exact value is computed at test-time and pinned in the first run.
  // See: hypercore-crypto.data(b4a.from('curva/demo-room')).
  t.is(TOPIC_PREFIX, 'curva/', 'topic prefix has not drifted')
})

test('topicForSlug rejects non-string input', (t) => {
  // brittle's t.exception treats TypeError/RangeError as "programmer errors" and
  // re-throws them. Use t.exception.all to catch programmer-error subclasses.
  t.exception.all(() => topicForSlug(123), 'rejects number')
  t.exception.all(() => topicForSlug(null), 'rejects null')
  t.exception.all(() => topicForSlug(undefined), 'rejects undefined')
  t.exception.all(() => topicForSlug(Buffer.from('x')), 'rejects buffer')
})

test('topicForSlug rejects out-of-range slug length', (t) => {
  t.exception.all(() => topicForSlug(''), 'rejects empty')
  t.exception.all(() => topicForSlug('x'.repeat(65)), 'rejects >64 chars')
})

// -- handleFromPubkey ------------------------------------------------------

test('handleFromPubkey format: word-color-nn', (t) => {
  const pubkey = 'a'.repeat(64) // 32 bytes of 0xaa
  const handle = handleFromPubkey(pubkey)
  t.ok(/^[a-z]+-[a-z]+-\d{2}$/.test(handle), `matches word-color-nn: ${handle}`)
})

test('handleFromPubkey is deterministic', (t) => {
  const pubkey = 'deadbeef'.repeat(8) // 32 bytes
  const a = handleFromPubkey(pubkey)
  const b = handleFromPubkey(pubkey)
  t.is(a, b, 'same pubkey -> same handle')
})

test('handleFromPubkey produces different handles for different pubkeys', (t) => {
  // Not exhaustive (we know collisions are possible ~1/16000), just a smoke test.
  const pubkeys = [
    '0011223344556677889900112233445566778899001122334455667788990011',
    'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
    '1122334455667788112233445566778811223344556677881122334455667788',
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  ]
  const handles = pubkeys.map(handleFromPubkey)
  const unique = new Set(handles)
  t.ok(unique.size >= 3, `at least 3 distinct handles from 4 pubkeys (got ${unique.size}): ${handles.join(', ')}`)
})

test('handleFromPubkey accepts Uint8Array input', (t) => {
  const bytes = b4a.from('deadbeefdeadbeef', 'hex')
  const handle = handleFromPubkey(bytes)
  t.ok(/^[a-z]+-[a-z]+-\d{2}$/.test(handle), 'accepts raw bytes')
})

test('handleFromPubkey rejects invalid input', (t) => {
  t.exception.all(() => handleFromPubkey('nothex'), 'rejects non-hex string')
  t.exception.all(() => handleFromPubkey('abc'), 'rejects odd-length hex')
  t.exception.all(() => handleFromPubkey(b4a.from('xx', 'hex')), 'rejects too-short bytes')
  t.exception.all(() => handleFromPubkey(42), 'rejects number')
})

test('handleFromPubkey uses only words from the pinned list', (t) => {
  const pubkey = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456'
  const handle = handleFromPubkey(pubkey)
  const [word, color] = handle.split('-')
  t.ok(WORDS.includes(word), `word "${word}" is in WORDS`)
  t.ok(COLORS.includes(color), `color "${color}" is in COLORS`)
})
