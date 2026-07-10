// Curva Diagnostics Report (wave-final QVAC depth F2).
//
// Docs-verification memo ---------------------------------------------------
//
// Thin wrapper around the Tether-native `@qvac/diagnostics` package that
// generates a full snapshot report for a peer: app info, environment, hardware
// (CPU + RAM), addon diagnostics, and Curva-specific extension sections. The
// serialized JSON is shown in DiagnosticsPanel's Report tab and can be copied
// out for support tickets / bug reports.
//
// Ground truth (installed 2026-07-10):
//   pear-app/node_modules/@qvac/diagnostics/index.d.ts (v0.1.2)
//     line 132  collectEnvironment() -> EnvironmentInfo {os, arch, osVersion, runtime}
//     line 138  collectHardware()    -> HardwareInfo    {cpuModel, cpuCores, totalMemoryMB}
//     line 109  registerAddon({name, version, getDiagnostics: () => string})
//     line 119  unregisterAddon(name)
//     line 126  registerExtension(name, data)
//     line 145  generateReport({app: AppInfo})   -> DiagnosticReport
//     line 154  serializeReport(report)          -> string  (JSON.stringify with indent 2)
//     line 159  reset()  singleton wipe (test-only)
//     line 101  REPORT_VERSION constant (currently '1.0.0')
//
// Note: The installed index.js (line 166-196) exposes generateReport() as a
// SYNCHRONOUS function returning DiagnosticReport, even though the .d.ts on
// line 145 declares it non-Promise but the docs blurb calls it "async". We
// invoke without await; the surrounding code paths remain async so callers
// can substitute a Promise-returning fake in tests without needing changes.
//
// Docs consulted:
//   https://docs.qvac.tether.io/utilities/diagnostics/ (fetched 2026-07-10) —
//   confirms extension sections are the correct escape hatch for app-specific
//   diagnostic data (room slug, host flag, active AI capabilities).
//
// Failure posture: this is a READ-ONLY diagnostic surface. Any construction
// failure (missing package, throw at import) returns
//   { ok: false, reason: 'DIAGNOSTICS_UNAVAILABLE' }
// so DiagnosticsPanel can display a graceful "no report available" state.
//
// Style: CommonJS + no em-dashes.

'use strict'

const APP_NAME_FALLBACK = 'curva'
const APP_VERSION_FALLBACK = '0.0.0'
const CURVA_EXTENSION_NAME = 'curva-room'

/**
 * Load the `@qvac/diagnostics` package dynamically. Returns null when the
 * package is missing or the module surface does not match the .d.ts contract.
 * A short-circuit path in the factory converts null into a graceful
 * DIAGNOSTICS_UNAVAILABLE reply so callers never need to try/catch require().
 */
function tryLoadDiagnostics () {
  try {
    // eslint-disable-next-line global-require
    const mod = require('@qvac/diagnostics')
    if (!mod || typeof mod.generateReport !== 'function'
      || typeof mod.serializeReport !== 'function'
      || typeof mod.registerExtension !== 'function'
      || typeof mod.registerAddon !== 'function') {
      return null
    }
    return mod
  } catch {
    return null
  }
}

/**
 * Build a report factory. `diagnosticsImpl` accepts a hand-rolled shim in
 * tests; production callers omit it and get the real `@qvac/diagnostics`.
 *
 * @param {{
 *   emit?: (event: string, payload: any) => void,
 *   log?:  (level: string, msg: string, extra?: any) => void,
 *   appName?: string,
 *   appVersion?: string,
 *   diagnosticsImpl?: object | null
 * }} opts
 * @returns {{
 *   generate: (ctx?: {roomSlug?: string, isHost?: boolean, activeCapabilities?: string[]}) => Promise<{ok: boolean, json?: string, reason?: string}>,
 *   registerAddon: (addon: {name: string, version: string, getDiagnostics: () => string}) => boolean,
 *   registerExtension: (name: string, data: any) => boolean,
 *   status: () => {available: boolean, appName: string, appVersion: string, reportVersion: string | null, registeredExtensions: string[]},
 *   close: () => void
 * }}
 */
function createDiagnosticsReport (opts = {}) {
  const {
    emit = () => {},
    log = () => {},
    appName = APP_NAME_FALLBACK,
    appVersion = APP_VERSION_FALLBACK,
    diagnosticsImpl = null
  } = opts

  // Prefer the injected impl (tests). Fall back to a dynamic require() so a
  // production caller doesn't need to hand the module in.
  const rawMod = diagnosticsImpl || tryLoadDiagnostics()
  // Validate the module surface matches the .d.ts contract before we declare
  // it available. A partial impl (like an empty test stub) counts as
  // unavailable so generate() cleanly returns DIAGNOSTICS_UNAVAILABLE.
  const available = !!(rawMod
    && typeof rawMod.generateReport === 'function'
    && typeof rawMod.serializeReport === 'function'
    && typeof rawMod.registerAddon === 'function'
    && typeof rawMod.unregisterAddon === 'function'
    && typeof rawMod.registerExtension === 'function')
  const mod = available ? rawMod : null
  const cleanAppName = String(appName || APP_NAME_FALLBACK).slice(0, 64)
  const cleanAppVersion = String(appVersion || APP_VERSION_FALLBACK).slice(0, 32)

  // Track everything we registered so status() can report it and close() can
  // unregister addon entries (extensions are overwritten by name, not append).
  const registeredExtensions = new Set()
  const registeredAddons = new Set()
  let closed = false

  if (!available) {
    log('warn', 'diagnosticsReport: @qvac/diagnostics unavailable', {})
  }

  function status () {
    return {
      available,
      appName: cleanAppName,
      appVersion: cleanAppVersion,
      reportVersion: available && typeof mod.REPORT_VERSION === 'string' ? mod.REPORT_VERSION : null,
      registeredExtensions: Array.from(registeredExtensions),
      registeredAddons: Array.from(registeredAddons),
      closed
    }
  }

  function registerAddon (addon) {
    if (closed || !available) return false
    if (!addon || typeof addon.name !== 'string' || addon.name.length === 0) return false
    if (typeof addon.getDiagnostics !== 'function') return false
    try {
      mod.registerAddon({
        name: String(addon.name).slice(0, 64),
        version: String(addon.version || '0.0.0').slice(0, 32),
        getDiagnostics: addon.getDiagnostics
      })
      registeredAddons.add(addon.name)
      return true
    } catch (err) {
      log('warn', 'diagnosticsReport: registerAddon threw', { message: err && err.message })
      return false
    }
  }

  function registerExtension (name, data) {
    if (closed || !available) return false
    if (typeof name !== 'string' || name.length === 0) return false
    try {
      mod.registerExtension(String(name).slice(0, 64), data)
      registeredExtensions.add(name)
      return true
    } catch (err) {
      log('warn', 'diagnosticsReport: registerExtension threw', { message: err && err.message })
      return false
    }
  }

  /**
   * Generate one report. Applies the caller-supplied context as the
   * `curva-room` extension section (overwriting any prior value on the same
   * name), then produces the report and returns the serialized JSON string.
   *
   * @param {{roomSlug?: string, isHost?: boolean, activeCapabilities?: string[]}} ctx
   * @returns {Promise<{ok: boolean, json?: string, reason?: string}>}
   */
  async function generate (ctx = {}) {
    if (closed) return { ok: false, reason: 'DIAGNOSTICS_CLOSED' }
    if (!available) return { ok: false, reason: 'DIAGNOSTICS_UNAVAILABLE' }

    // Sanitize the context payload before it lands in the report JSON. Cap
    // strings and arrays so a compromised caller cannot balloon the report.
    const roomSlug = typeof ctx.roomSlug === 'string' ? ctx.roomSlug.slice(0, 128) : null
    const isHost = !!ctx.isHost
    const capsIn = Array.isArray(ctx.activeCapabilities) ? ctx.activeCapabilities : []
    const activeCapabilities = capsIn
      .filter((c) => typeof c === 'string' && c.length > 0)
      .slice(0, 64)
      .map((c) => c.slice(0, 64))

    registerExtension(CURVA_EXTENSION_NAME, {
      roomSlug,
      isHost,
      activeCapabilities,
      generatedAt: new Date().toISOString()
    })

    let report
    try {
      // Per index.js:166-196, generateReport is synchronous — but tests may
      // supply a Promise-returning fake, so we await defensively.
      report = await Promise.resolve(mod.generateReport({
        app: { name: cleanAppName, version: cleanAppVersion }
      }))
    } catch (err) {
      log('warn', 'diagnosticsReport: generateReport threw', { message: err && err.message })
      return { ok: false, reason: 'GENERATE_FAILED', message: err && err.message }
    }
    if (!report || typeof report !== 'object') {
      return { ok: false, reason: 'GENERATE_EMPTY' }
    }
    let json
    try {
      json = mod.serializeReport(report)
    } catch (err) {
      log('warn', 'diagnosticsReport: serializeReport threw', { message: err && err.message })
      return { ok: false, reason: 'SERIALIZE_FAILED', message: err && err.message }
    }
    if (typeof json !== 'string' || json.length === 0) {
      return { ok: false, reason: 'SERIALIZE_EMPTY' }
    }
    emit('diagnostics:report-generated', {
      bytes: json.length,
      roomSlug,
      isHost,
      capabilities: activeCapabilities.length
    })
    return { ok: true, json }
  }

  function close () {
    if (closed) return
    closed = true
    if (!available) return
    // Best-effort per-report cleanup. The diagnostics singleton is shared
    // across the process, so we ONLY unregister addons we registered — leaving
    // any that were owned by other factories intact.
    for (const name of registeredAddons) {
      try { mod.unregisterAddon(name) } catch { /* noop */ }
    }
    registeredAddons.clear()
    registeredExtensions.clear()
  }

  return {
    generate,
    registerAddon,
    registerExtension,
    status,
    close
  }
}

module.exports = {
  createDiagnosticsReport,
  tryLoadDiagnostics,
  CURVA_EXTENSION_NAME,
  APP_NAME_FALLBACK,
  APP_VERSION_FALLBACK
}
