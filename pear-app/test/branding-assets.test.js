// pear.assets branding pack tests.
//
// Covers bare/assets.js — the tiny accessor that reads
// `Pear.app.assets.branding` at runtime so workers/main.js can forward the
// current drive path to the renderer via IPC.
//
// Design goal: the accessor must never throw regardless of the shape of
// `globalThis.Pear`. A missing Pear runtime (packaged Electron outside
// `pear run`) must degrade to a null path so the renderer keeps the bundled
// fallback logo.

const test = require('brittle')
const { getBrandingPath, getBrandingBytes } = require('../bare/assets.js')

// Snapshot and restore globalThis.Pear around each test so ordering does not
// matter and other suites do not see leaked state.
function withPear(pearValue, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'Pear')
  const prev = globalThis.Pear
  try {
    if (pearValue === undefined) delete globalThis.Pear
    else globalThis.Pear = pearValue
    return fn()
  } finally {
    if (had) globalThis.Pear = prev
    else delete globalThis.Pear
  }
}

test('getBrandingPath: returns null when Pear global unavailable', (t) => {
  withPear(undefined, () => {
    t.is(getBrandingPath(), null, 'no Pear -> null')
  })
})

test('getBrandingPath: returns null when Pear is not an object', (t) => {
  withPear(42, () => t.is(getBrandingPath(), null, 'number Pear -> null'))
  withPear('string', () => t.is(getBrandingPath(), null, 'string Pear -> null'))
  withPear(null, () => t.is(getBrandingPath(), null, 'null Pear -> null'))
})

test('getBrandingPath: returns null when app.assets.branding is missing', (t) => {
  withPear({}, () => t.is(getBrandingPath(), null, 'empty Pear -> null'))
  withPear({ app: {} }, () => t.is(getBrandingPath(), null, 'no assets -> null'))
  withPear({ app: { assets: {} } }, () => t.is(getBrandingPath(), null, 'no branding ns -> null'))
  withPear({ app: { assets: { branding: {} } } }, () => t.is(getBrandingPath(), null, 'no path -> null'))
})

test('getBrandingPath: returns null when path is empty string', (t) => {
  withPear({ app: { assets: { branding: { path: '' } } } }, () => {
    t.is(getBrandingPath(), null, 'empty string -> null')
  })
})

test('getBrandingPath: returns string when Pear.app.assets.branding.path is set', (t) => {
  const p = '/Users/somebody/Library/Application Support/pear/assets/branding'
  withPear({ app: { assets: { branding: { path: p } } } }, () => {
    t.is(getBrandingPath(), p, 'passes through the path string')
  })
})

test('getBrandingPath: ignores non-string path', (t) => {
  withPear({ app: { assets: { branding: { path: 42 } } } }, () => {
    t.is(getBrandingPath(), null, 'number path -> null')
  })
  withPear({ app: { assets: { branding: { path: null } } } }, () => {
    t.is(getBrandingPath(), null, 'null path -> null')
  })
  withPear({ app: { assets: { branding: { path: {} } } } }, () => {
    t.is(getBrandingPath(), null, 'object path -> null')
  })
})

test('getBrandingBytes: returns null when unset, number when present', (t) => {
  withPear(undefined, () => t.is(getBrandingBytes(), null, 'no Pear -> null'))
  withPear({ app: { assets: { branding: {} } } }, () => {
    t.is(getBrandingBytes(), null, 'no bytes -> null')
  })
  withPear({ app: { assets: { branding: { bytes: 4096 } } } }, () => {
    t.is(getBrandingBytes(), 4096, 'number bytes -> number')
  })
  withPear({ app: { assets: { branding: { bytes: '4096' } } } }, () => {
    t.is(getBrandingBytes(), null, 'string bytes -> null (strict)')
  })
})

test('accessors never throw: adversarial getters', (t) => {
  // A Pear object whose accessor throws should NOT crash the worker.
  const trap = {
    get app() { throw new Error('boom') }
  }
  withPear(trap, () => {
    t.is(getBrandingPath(), null, 'throwing getter -> null')
    t.is(getBrandingBytes(), null, 'throwing getter -> null (bytes)')
  })
})

test('accessors never throw: circular / weird shapes', (t) => {
  const weird = { app: { assets: { branding: Object.create(null) } } }
  weird.app.assets.branding.path = '/tmp/x'
  weird.app.assets.branding.bytes = 1
  withPear(weird, () => {
    t.is(getBrandingPath(), '/tmp/x')
    t.is(getBrandingBytes(), 1)
  })
})
