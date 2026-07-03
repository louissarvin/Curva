// Wave 7 Zone C: unit tests for the split-screen demo-mode argv parser.
//
// Deliberately does not boot Electron. The parser and grid math live in
// scripts/demo-argv.cjs so they can be exercised without the electron
// module (which would require Xvfb in CI).

const test = require('brittle')

const {
  parseDemoFlag,
  demoGridRects,
  DEMO_PEER_LABELS,
  DEMO_PEER_TITLES
} = require('../scripts/demo-argv.cjs')

// -- parseDemoFlag --------------------------------------------------------

test('parseDemoFlag: --demo=4 returns 4', (t) => {
  t.is(parseDemoFlag('4', undefined), 4)
})

test('parseDemoFlag: numeric 4 returns 4', (t) => {
  t.is(parseDemoFlag(4, undefined), 4)
})

test('parseDemoFlag: env CURVA_DEMO=4 returns 4 when cli value absent', (t) => {
  t.is(parseDemoFlag(undefined, '4'), 4)
  t.is(parseDemoFlag(null, '4'), 4)
  t.is(parseDemoFlag('', '4'), 4)
})

test('parseDemoFlag: cli value wins over env', (t) => {
  // env is 4 but cli is invalid -> null (cli was explicitly set)
  t.is(parseDemoFlag('nope', '4'), null)
})

test('parseDemoFlag: absent returns null', (t) => {
  t.is(parseDemoFlag(undefined, undefined), null)
  t.is(parseDemoFlag(null, null), null)
  t.is(parseDemoFlag('', ''), null)
})

test('parseDemoFlag: unsupported peer counts return null', (t) => {
  t.is(parseDemoFlag('2', undefined), null)
  t.is(parseDemoFlag('3', undefined), null)
  t.is(parseDemoFlag('5', undefined), null)
  t.is(parseDemoFlag('9', undefined), null)
})

test('parseDemoFlag: non-integer returns null', (t) => {
  t.is(parseDemoFlag('4.5', undefined), null)
  t.is(parseDemoFlag('four', undefined), null)
})

test('parseDemoFlag: negative and zero return null', (t) => {
  t.is(parseDemoFlag('0', undefined), null)
  t.is(parseDemoFlag('-4', undefined), null)
  t.is(parseDemoFlag('1', undefined), null)
})

// -- demoGridRects --------------------------------------------------------

test('demoGridRects: 2x2 grid tiles the work area', (t) => {
  const rects = demoGridRects({ width: 1920, height: 1080 })
  t.is(rects.length, 4)
  t.is(rects[0].x, 0);   t.is(rects[0].y, 0)
  t.is(rects[1].x, 960); t.is(rects[1].y, 0)
  t.is(rects[2].x, 0);   t.is(rects[2].y, 540)
  t.is(rects[3].x, 960); t.is(rects[3].y, 540)
  for (const r of rects) {
    t.is(r.width, 960)
    t.is(r.height, 540)
  }
})

test('demoGridRects: odd work-area sizes floor cleanly', (t) => {
  const rects = demoGridRects({ width: 1281, height: 721 })
  // 1281/2 = 640.5 -> floor 640; 721/2 = 360.5 -> floor 360.
  t.is(rects[0].width, 640)
  t.is(rects[0].height, 360)
  // Second column starts at 640 (not 641).
  t.is(rects[1].x, 640)
})

// -- Peer labels ----------------------------------------------------------

test('DEMO_PEER_LABELS: exactly 4 entries a..d', (t) => {
  t.alike(Array.from(DEMO_PEER_LABELS), ['a', 'b', 'c', 'd'])
})

test('DEMO_PEER_TITLES: 4 world-cities aligned with labels', (t) => {
  t.is(DEMO_PEER_TITLES.length, 4)
  t.is(DEMO_PEER_TITLES[0], 'Torino')
  t.is(DEMO_PEER_TITLES[1], 'Jakarta')
  t.is(DEMO_PEER_TITLES[2], 'Sao Paulo')
  t.is(DEMO_PEER_TITLES[3], 'Ciudad de Mexico')
})

test('DEMO_PEER_LABELS is frozen (guard against accidental mutation)', (t) => {
  t.ok(Object.isFrozen(DEMO_PEER_LABELS))
  t.ok(Object.isFrozen(DEMO_PEER_TITLES))
})
