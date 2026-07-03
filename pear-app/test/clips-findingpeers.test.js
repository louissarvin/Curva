// Fix Wave A T3: verify clips code calls drive.findingPeers() after opening a
// peer drive, per Hyperdrive docs:
//   https://github.com/holepunchto/hyperdrive - "requests will be on hold
//   until this is done"
//
// The test uses a source-code assertion because clips.js opens a real
// Hyperdrive through the shared corestore and driving findingPeers() behavior
// in a unit test is brittle (it depends on internal peer-discovery counters).
// A source-level check is enough to guarantee the pattern is applied at both
// sites; runtime behavior is covered by the two-window integration run.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const CLIPS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'bare', 'clips.js'),
  'utf8'
)

test('T3: clips.js calls drive.findingPeers() at least twice (trackPeerDrive + getClip)', (t) => {
  const matches = CLIPS_SRC.match(/drive\.findingPeers\(\)/g) || []
  t.ok(matches.length >= 2, `expected >= 2 findingPeers() call sites, saw ${matches.length}`)
})

test('T3: trackPeerDrive block includes findingPeers', (t) => {
  // Slice the function body of trackPeerDrive and assert findingPeers is
  // called inside it.
  const start = CLIPS_SRC.indexOf('function trackPeerDrive')
  t.ok(start > 0, 'trackPeerDrive function present')
  const end = CLIPS_SRC.indexOf('\n  }', start)
  const body = CLIPS_SRC.slice(start, end)
  t.ok(body.includes('drive.findingPeers()'), 'trackPeerDrive body calls findingPeers')
})

test('T3: getClip fallback path includes findingPeers', (t) => {
  const start = CLIPS_SRC.indexOf('async function getClip')
  t.ok(start > 0, 'getClip function present')
  const end = CLIPS_SRC.indexOf('\n  }', start)
  const body = CLIPS_SRC.slice(start, end)
  t.ok(body.includes('drive.findingPeers()'), 'getClip body calls findingPeers')
})

test('T3: findingPeers token is released via setTimeout so it does not leak', (t) => {
  const matches = CLIPS_SRC.match(/setTimeout\(\(\) => \{ try \{ done\(\) \}/g) || []
  t.ok(matches.length >= 2, 'both findingPeers sites clear their token')
})
