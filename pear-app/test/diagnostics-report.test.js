// Brittle tests for bare/diagnosticsReport.js — the @qvac/diagnostics wrapper.
//
// Ground truth cited by createDiagnosticsReport:
//   node_modules/@qvac/diagnostics/index.d.ts (v0.1.2), lines 101, 109, 119,
//   126, 132, 138, 145, 154, 159. We hand-roll a fake matching the same
//   public surface so we can assert what the wrapper does with each API.

'use strict'

const test = require('brittle')
const {
  createDiagnosticsReport,
  CURVA_EXTENSION_NAME
} = require('../bare/diagnosticsReport.js')

// --- Fake @qvac/diagnostics matching index.d.ts ---------------------------

function fakeDiagnostics ({ throwOnGenerate = false, throwOnSerialize = false, sync = true } = {}) {
  const addons = new Map()
  const extensions = new Map()
  const calls = { generate: 0, serialize: 0, addon: 0, extension: 0, unregisterAddon: 0 }
  const impl = {
    REPORT_VERSION: '1.0.0',
    registerAddon (addon) {
      calls.addon += 1
      addons.set(addon.name, addon)
    },
    unregisterAddon (name) {
      calls.unregisterAddon += 1
      addons.delete(name)
    },
    registerExtension (name, data) {
      calls.extension += 1
      extensions.set(name, data)
    },
    collectEnvironment () {
      return { os: 'darwin', arch: 'arm64', osVersion: '25.2.0', runtime: 'bare0.0.0' }
    },
    collectHardware () {
      return { cpuModel: 'Apple M-Test', cpuCores: 8, totalMemoryMB: 16384 }
    },
    generateReport (opts) {
      calls.generate += 1
      if (throwOnGenerate) throw new Error('gen boom')
      const report = {
        reportVersion: '1.0.0',
        generatedAt: '2026-07-10T00:00:00.000Z',
        app: opts && opts.app ? opts.app : { name: 'unknown', version: 'unknown' },
        environment: impl.collectEnvironment(),
        hardware: impl.collectHardware(),
        addons: Array.from(addons.entries()).map(([name, entry]) => ({
          name,
          version: entry.version,
          diagnostics: entry.getDiagnostics()
        })),
        extensions: Array.from(extensions.entries()).map(([name, data]) => ({ name, data }))
      }
      return sync ? report : Promise.resolve(report)
    },
    serializeReport (report) {
      calls.serialize += 1
      if (throwOnSerialize) throw new Error('ser boom')
      return JSON.stringify(report, null, 2)
    },
    reset () {
      addons.clear()
      extensions.clear()
    }
  }
  return { impl, calls, addons, extensions }
}

// --- Tests ---------------------------------------------------------------

test('generate returns a JSON string that parses to a DiagnosticReport shape', async (t) => {
  const { impl } = fakeDiagnostics()
  const rep = createDiagnosticsReport({
    diagnosticsImpl: impl,
    appName: 'curva',
    appVersion: '0.1.0'
  })
  const res = await rep.generate({})
  t.ok(res.ok, 'ok:true')
  t.is(typeof res.json, 'string')
  const parsed = JSON.parse(res.json)
  t.is(parsed.reportVersion, '1.0.0')
  t.is(parsed.app.name, 'curva')
  t.is(parsed.app.version, '0.1.0')
  t.is(parsed.environment.os, 'darwin')
  t.is(parsed.hardware.cpuCores, 8)
  t.ok(Array.isArray(parsed.addons))
  t.ok(Array.isArray(parsed.extensions))
})

test('Curva extension section carries roomSlug + isHost + activeCapabilities', async (t) => {
  const { impl } = fakeDiagnostics()
  const rep = createDiagnosticsReport({ diagnosticsImpl: impl })
  const res = await rep.generate({
    roomSlug: 'euro-final',
    isHost: true,
    activeCapabilities: ['commentator', 'voice-coach', 'ask-the-frame']
  })
  t.ok(res.ok)
  const parsed = JSON.parse(res.json)
  const curva = parsed.extensions.find((e) => e.name === CURVA_EXTENSION_NAME)
  t.ok(curva, 'curva-room extension present')
  t.is(curva.data.roomSlug, 'euro-final')
  t.is(curva.data.isHost, true)
  t.alike(curva.data.activeCapabilities, ['commentator', 'voice-coach', 'ask-the-frame'])
  t.ok(typeof curva.data.generatedAt === 'string')
})

test('generate defaults gracefully when context is empty', async (t) => {
  const { impl } = fakeDiagnostics()
  const rep = createDiagnosticsReport({ diagnosticsImpl: impl })
  const res = await rep.generate()
  t.ok(res.ok)
  const parsed = JSON.parse(res.json)
  const curva = parsed.extensions.find((e) => e.name === CURVA_EXTENSION_NAME)
  t.is(curva.data.roomSlug, null)
  t.is(curva.data.isHost, false)
  t.alike(curva.data.activeCapabilities, [])
})

test('generate returns DIAGNOSTICS_UNAVAILABLE when the package is missing', async (t) => {
  // Pass null diagnosticsImpl and simulate a missing package — the wrapper's
  // fallback loader will find nothing. To make the test deterministic across
  // machines that DO have @qvac/diagnostics installed, we instead pass a
  // hand-rolled null-object.
  const rep = createDiagnosticsReport({ diagnosticsImpl: {} })
  const res = await rep.generate({})
  t.absent(res.ok, 'ok:false when impl surface is invalid')
  t.is(res.reason, 'DIAGNOSTICS_UNAVAILABLE')
})

test('activeCapabilities is capped in count and per-string length', async (t) => {
  const { impl } = fakeDiagnostics()
  const rep = createDiagnosticsReport({ diagnosticsImpl: impl })
  const many = new Array(200).fill(0).map((_, i) => 'cap-' + i)
  const long = 'x'.repeat(200)
  const res = await rep.generate({ activeCapabilities: [...many, long] })
  const parsed = JSON.parse(res.json)
  const curva = parsed.extensions.find((e) => e.name === CURVA_EXTENSION_NAME)
  t.ok(curva.data.activeCapabilities.length <= 64, 'capped at 64 entries')
  for (const c of curva.data.activeCapabilities) {
    t.ok(c.length <= 64, 'each capability capped at 64 chars')
  }
})

test('registerAddon + registerExtension forward to the underlying module', async (t) => {
  const { impl, calls, addons, extensions } = fakeDiagnostics()
  const rep = createDiagnosticsReport({ diagnosticsImpl: impl })
  const ok1 = rep.registerAddon({
    name: 'curva-commentator',
    version: '1.0.0',
    getDiagnostics: () => JSON.stringify({ turns: 4 })
  })
  t.ok(ok1)
  t.is(calls.addon, 1)
  t.ok(addons.has('curva-commentator'))

  const ok2 = rep.registerExtension('custom-section', { hello: 'world' })
  t.ok(ok2)
  t.is(calls.extension, 1)
  t.is(extensions.get('custom-section').hello, 'world')

  const stat = rep.status()
  t.ok(stat.available)
  t.is(stat.reportVersion, '1.0.0')
  t.ok(stat.registeredAddons.includes('curva-commentator'))
})

test('registerAddon rejects invalid input without crashing', async (t) => {
  const { impl } = fakeDiagnostics()
  const rep = createDiagnosticsReport({ diagnosticsImpl: impl })
  t.absent(rep.registerAddon(null))
  t.absent(rep.registerAddon({}))
  t.absent(rep.registerAddon({ name: '', version: '1', getDiagnostics: () => '' }))
  t.absent(rep.registerAddon({ name: 'x', version: '1', getDiagnostics: 'not-a-fn' }))
})

test('close() is idempotent and unregisters our addons only', async (t) => {
  const { impl, addons, calls } = fakeDiagnostics()
  const rep = createDiagnosticsReport({ diagnosticsImpl: impl })
  rep.registerAddon({ name: 'curva-a', version: '1', getDiagnostics: () => '{}' })
  rep.registerAddon({ name: 'curva-b', version: '1', getDiagnostics: () => '{}' })
  // Simulate another factory owning this addon — we should NOT touch it.
  impl.registerAddon({ name: 'other-owner', version: '2', getDiagnostics: () => '{}' })
  rep.close()
  rep.close() // idempotent
  t.absent(addons.has('curva-a'), 'removed our addon a')
  t.absent(addons.has('curva-b'), 'removed our addon b')
  t.ok(addons.has('other-owner'), 'left other-owner intact')
  // After close, generate should refuse.
  const res = await rep.generate({})
  t.absent(res.ok)
  t.is(res.reason, 'DIAGNOSTICS_CLOSED')
  t.is(calls.unregisterAddon, 2, 'unregisterAddon called for each of our addons')
})

test('generate surfaces GENERATE_FAILED when the impl throws', async (t) => {
  const { impl } = fakeDiagnostics({ throwOnGenerate: true })
  const rep = createDiagnosticsReport({ diagnosticsImpl: impl })
  const res = await rep.generate({})
  t.absent(res.ok)
  t.is(res.reason, 'GENERATE_FAILED')
  t.ok(typeof res.message === 'string' && res.message.length > 0)
})

test('generate surfaces SERIALIZE_FAILED when serialize throws', async (t) => {
  const { impl } = fakeDiagnostics({ throwOnSerialize: true })
  const rep = createDiagnosticsReport({ diagnosticsImpl: impl })
  const res = await rep.generate({})
  t.absent(res.ok)
  t.is(res.reason, 'SERIALIZE_FAILED')
})

test('generate awaits Promise-returning fake generateReport implementations', async (t) => {
  const { impl } = fakeDiagnostics({ sync: false })
  const rep = createDiagnosticsReport({ diagnosticsImpl: impl })
  const res = await rep.generate({ roomSlug: 'r1' })
  t.ok(res.ok)
  const parsed = JSON.parse(res.json)
  t.is(parsed.app.name, 'curva')
})

test('appName + appVersion get sanitized (clamped length)', async (t) => {
  const { impl } = fakeDiagnostics()
  const long = 'x'.repeat(200)
  const rep = createDiagnosticsReport({
    diagnosticsImpl: impl,
    appName: long,
    appVersion: long
  })
  const res = await rep.generate({})
  const parsed = JSON.parse(res.json)
  t.ok(parsed.app.name.length <= 64)
  t.ok(parsed.app.version.length <= 32)
})

test('emit callback fires diagnostics:report-generated with metadata', async (t) => {
  const { impl } = fakeDiagnostics()
  const events = []
  const rep = createDiagnosticsReport({
    diagnosticsImpl: impl,
    emit: (e, p) => events.push({ e, p })
  })
  await rep.generate({
    roomSlug: 'e1',
    isHost: true,
    activeCapabilities: ['a', 'b']
  })
  const ev = events.find((e) => e.e === 'diagnostics:report-generated')
  t.ok(ev, 'event emitted')
  t.is(ev.p.roomSlug, 'e1')
  t.is(ev.p.isHost, true)
  t.is(ev.p.capabilities, 2)
  t.ok(ev.p.bytes > 0)
})
