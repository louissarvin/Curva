// Wave 21: pear.links deep-link boot.
//
// Covers:
//   1. base32url encode/decode round-trip for signed invitations
//   2. Invitation URL packing preserves pubkey/sig/timestamp fields
//   3. Decoder rejects garbage without throwing
//
// The pear.link parser itself lives in renderer/app.js and requires a
// window + Pear.app runtime, so it is tested via manual pear run steps in
// memory/impl_pear_links.md rather than here.

const test = require('brittle')
const b4a = require('b4a')
const {
  signInvitation,
  encodeInvitationForUrl,
  decodeInvitationFromUrl,
  _internal: { base32urlEncode, base32urlDecode }
} = require('../bare/writerInvitation.js')

test('base32url: encode/decode round-trip on random bytes', (t) => {
  const cases = [
    b4a.from([0]),
    b4a.from([255]),
    b4a.from([0, 1, 2, 3, 4, 5, 6, 7]),
    b4a.from('hello world', 'utf8'),
    b4a.from(new Array(64).fill(0).map((_, i) => i))
  ]
  for (const buf of cases) {
    const encoded = base32urlEncode(buf)
    t.is(typeof encoded, 'string')
    t.ok(/^[a-z2-7]+$/.test(encoded), 'lowercase base32 alphabet only')
    const decoded = base32urlDecode(encoded)
    t.ok(decoded)
    t.alike(Array.from(decoded), Array.from(buf), 'round-trip preserves bytes')
  }
})

test('base32url: decode returns null on invalid alphabet', (t) => {
  t.is(base32urlDecode('!!!!'), null)
  t.is(base32urlDecode('0189'), null) // 0, 1, 8, 9 not in RFC 4648 base32
})

test('encodeInvitationForUrl: null input rejected', (t) => {
  t.is(encodeInvitationForUrl(null), null)
  t.is(encodeInvitationForUrl(undefined), null)
})

test('encodeInvitationForUrl + decodeInvitationFromUrl: round-trip', (t) => {
  // Deterministic keypair from a fixed 32-byte seed so the test is stable.
  const seed = b4a.alloc(32, 7)
  const signed = signInvitation(seed)
  t.ok(signed)
  t.is(typeof signed.pubkey, 'string')
  t.is(typeof signed.sig, 'string')
  t.is(typeof signed.timestamp, 'number')

  const token = encodeInvitationForUrl(signed)
  t.is(typeof token, 'string')
  t.ok(token.length > 0)
  // Token is URL-safe.
  t.ok(/^[a-z2-7]+$/.test(token))

  const restored = decodeInvitationFromUrl(token)
  t.ok(restored)
  t.is(restored.pubkey, signed.pubkey)
  t.is(restored.sig, signed.sig)
  t.is(restored.timestamp, signed.timestamp)
})

test('decodeInvitationFromUrl: garbage input returns null', (t) => {
  t.is(decodeInvitationFromUrl(''), null)
  t.is(decodeInvitationFromUrl('!!!'), null)
  // Valid base32 but not JSON.
  const notJson = base32urlEncode(b4a.from('not json {'))
  t.is(decodeInvitationFromUrl(notJson), null)
})
