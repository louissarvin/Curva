// Curva QVAC SDK plugin bootstrap (semifinal live-boot fix, revision 3).
//
// Root cause (verified via runtime diagnostic 2026-07-11):
//
//   `@qvac/sdk` client/rpc/rpc-client.js caches the `rpcInstance` promise
//   on FIRST call to getRPCInstance():
//     let rpcInstance = null;
//     async function getRPCInstance() {
//       if (rpcInstance) return { rpc: await rpcInstance };
//       rpcInstance = getRPC();   // <-- CACHED
//       ...
//     }
//   And `getRPC()` awaits `ensureWorkerReady()` which awaits
//   `ensurePluginsRegistered()` which throws
//   `WorkerPluginsNotRegisteredError` when the plugin registry is empty.
//
//   If ANY SDK verb fires BEFORE the plugin registry is populated (e.g.
//   workers/main.js used to invoke `subscribeToServerLogs(mod, ...)` at
//   module top level, kicking off a `loggingStream(...)` -> `send(...)`
//   round-trip, which awaits getRPC()), the `rpcInstance` promise is
//   cached as REJECTED. Every subsequent SDK call then awaits the cached
//   rejection and re-throws WORKER_PLUGINS_NOT_REGISTERED forever - even
//   after plugins are eventually registered.
//
//   The error message misleads: "No plugins registered in the worker.
//   On Bare, register the plugins you need with `plugins([...])` (or
//   `registerPlugin(...)`) before the first SDK call - import each from
//   its subpath, e.g. `@qvac/sdk/llamacpp-completion/plugin`."
//   The plugins ARE registered by the time the error fires; the issue is
//   just that the cache holds a rejection from before registration.
//
// FIX (two-part):
//   1. This module registers every plugin via `registerPlugin` imported
//      from `@qvac/sdk/plugins` - the SAME subpath the SDK's own
//      auto-generated Pear worker entry uses
//      (dist/pear/pre.js::generatePearWorkerEntry).
//   2. workers/main.js BLOCKING-awaits sdkPluginsMod.boot(log) BEFORE
//      emit('ready'), and any observability/subscribeToServerLogs bridge
//      is deferred until AFTER ready fires.
//
// Idempotent: subsequent calls no-op after the first successful boot.
// Best-effort per plugin: a plugin that fails to import (e.g. missing
// native addon on the current arch) is logged and skipped rather than
// breaking the whole boot path.
//
// Docs verified (2026-07-11):
//   - https://docs.qvac.tether.io/configuration/plugins#runtime-registration-on-bare
//   - Installed plugin subpaths at
//     pear-app/node_modules/@qvac/sdk/dist/server/bare/plugins/*
//   - pear-app/node_modules/@qvac/sdk/dist/pear/pre.js::generatePearWorkerEntry
//     for the canonical registration pattern this module replicates.

const PLUGIN_SUBPATHS = Object.freeze([
  { name: 'llamacpp-completion',    subpath: '@qvac/sdk/llamacpp-completion/plugin',    exportKey: 'llmPlugin' },
  { name: 'llamacpp-embedding',     subpath: '@qvac/sdk/llamacpp-embedding/plugin',     exportKey: 'embeddingsPlugin' },
  { name: 'nmtcpp-translation',     subpath: '@qvac/sdk/nmtcpp-translation/plugin',     exportKey: 'nmtPlugin' },
  { name: 'whispercpp-transcription', subpath: '@qvac/sdk/whispercpp-transcription/plugin', exportKey: 'whisperPlugin' },
  { name: 'parakeet-transcription', subpath: '@qvac/sdk/parakeet-transcription/plugin', exportKey: 'parakeetPlugin' },
  { name: 'tts-ggml',               subpath: '@qvac/sdk/tts-ggml/plugin',               exportKey: 'ttsPlugin' },
  { name: 'ggml-vla',               subpath: '@qvac/sdk/ggml-vla/plugin',               exportKey: 'vlaPlugin' },
  { name: 'ggml-ocr',               subpath: '@qvac/sdk/ggml-ocr/plugin',               exportKey: 'ocrPlugin' },
  { name: 'ggml-classification',    subpath: '@qvac/sdk/ggml-classification/plugin',    exportKey: 'classificationPlugin' }
])

let state = {
  ready: false,
  inFlight: null,
  hostApi: null,
  registered: [],
  failed: []
}

function pickPluginExport (mod, exportKey) {
  if (!mod) return null
  // Prefer the semantic named export the docs show, then default, then the
  // module itself. Every layout below is seen in the wild across SDK betas.
  if (exportKey && mod[exportKey]) return mod[exportKey]
  if (mod.default) return mod.default
  if (typeof mod === 'function') return mod
  // Some plugin modules expose { plugin } or { register } as the shape.
  if (mod.plugin) return mod.plugin
  if (mod.register && typeof mod.register === 'function') return mod
  return null
}

/**
 * Register every Curva plugin against the imported @qvac/sdk. Returns
 * `{ hostApi, registered, failed }`. Idempotent: safe to call multiple times.
 *
 * @param {object} sdkMod - The imported @qvac/sdk module (top-level object).
 * @param {(level:string,msg:string,extra?:object)=>void} log
 * @returns {Promise<{hostApi:object, registered:string[], failed:Array<{name,reason}>}>}
 */
async function ensureAllPlugins (sdkMod, log) {
  if (state.ready) {
    return {
      hostApi: state.hostApi,
      registered: state.registered.slice(),
      failed: state.failed.slice()
    }
  }
  if (state.inFlight) return state.inFlight
  const safeLog = typeof log === 'function' ? log : function () {}

  state.inFlight = (async () => {
    // Load registerPlugin via @qvac/sdk/plugins - the canonical registry
    // subpath used by the SDK's auto-generated Pear worker entry
    // (dist/pear/pre.js::generatePearWorkerEntry). Falls back to
    // sdk.plugins([p]) from the top-level module if the subpath is
    // unavailable.
    let registerPlugin = null
    try {
      const pluginsRegistry = await import('@qvac/sdk/plugins')
      if (typeof pluginsRegistry.registerPlugin === 'function') {
        registerPlugin = pluginsRegistry.registerPlugin
      }
    } catch (err) {
      safeLog('warn', '[sdkPlugins] @qvac/sdk/plugins import failed', {
        message: err && err.message
      })
    }
    if (typeof registerPlugin !== 'function') {
      if (sdkMod && typeof sdkMod.plugins === 'function') {
        safeLog('warn', '[sdkPlugins] @qvac/sdk/plugins subpath missing registerPlugin; falling back to sdk.plugins()')
        registerPlugin = function (p) { sdkMod.plugins([p]) }
      } else {
        const reason = 'no-registerPlugin'
        safeLog('warn', '[sdkPlugins] SDK exposes no registration function; downstream SDK calls will 4xx', { reason })
        state.ready = true
        state.hostApi = sdkMod || null
        return { hostApi: state.hostApi, registered: [], failed: [{ name: '*', reason }] }
      }
    }

    const collected = []
    for (const entry of PLUGIN_SUBPATHS) {
      try {
        const mod = await import(entry.subpath).catch((err) => {
          safeLog('warn', '[sdkPlugins] import ' + entry.subpath + ' failed', {
            name: entry.name,
            message: err && err.message
          })
          return null
        })
        if (!mod) {
          state.failed.push({ name: entry.name, reason: 'IMPORT_FAILED' })
          continue
        }
        const plugin = pickPluginExport(mod, entry.exportKey)
        if (!plugin) {
          state.failed.push({ name: entry.name, reason: 'NO_EXPORT' })
          safeLog('warn', '[sdkPlugins] no usable export from ' + entry.subpath, {
            keys: Object.keys(mod || {}).slice(0, 10)
          })
          continue
        }
        collected.push({ name: entry.name, plugin })
      } catch (err) {
        state.failed.push({ name: entry.name, reason: (err && err.message) || 'THREW' })
      }
    }

    if (collected.length === 0) {
      safeLog('warn', '[sdkPlugins] no plugins collected to register')
      state.ready = true
      state.hostApi = sdkMod
      return { hostApi: sdkMod, registered: [], failed: state.failed.slice() }
    }

    // Register plugins one by one via the CANONICAL registerPlugin from
    // @qvac/sdk/plugins. This is the exact pattern the SDK's auto-generated
    // Pear worker entry uses (dist/pear/pre.js::generatePearWorkerEntry).
    for (const c of collected) {
      try {
        registerPlugin(c.plugin)
        state.registered.push(c.name)
      } catch (err) {
        // "Plugin already registered" is FINE - means another module beat us
        // to it and the registry already has the plugin. Any other error is a
        // failure worth logging.
        const msg = (err && err.message) || 'THREW'
        if (msg.indexOf('already registered') >= 0) {
          state.registered.push(c.name)
          safeLog('info', '[sdkPlugins] ' + c.name + ' already registered (fine)', {})
        } else {
          state.failed.push({ name: c.name, reason: msg })
        }
      }
    }

    safeLog('info', '[sdkPlugins] registered ' + state.registered.length + ' plugins', {
      names: state.registered
    })

    // Prime the SDK's rpc-client so the first hostApi is captured. This
    // ALSO guarantees that any subsequent `import('@qvac/sdk')` in
    // downstream modules gets the primed surface. Skipping this leaves the
    // top-level SDK unprimed - `sdk.loadModel(...)` still resolves through
    // the same registry we just wrote to, so it works either way, but the
    // hostApi is nice to have for callers that want the returned surface.
    try {
      const freshSdk = await import('@qvac/sdk').catch(() => null)
      if (freshSdk && typeof freshSdk.plugins === 'function') {
        const host = freshSdk.plugins([])
        state.hostApi = host || freshSdk
      } else {
        state.hostApi = sdkMod
      }
    } catch {
      state.hostApi = sdkMod
    }
    state.ready = true
    return { hostApi: state.hostApi, registered: state.registered.slice(), failed: state.failed.slice() }
  })()

  const out = await state.inFlight
  state.inFlight = null
  return out
}

/**
 * Convenience helper: import the SDK, register everything, return hostApi.
 * Callers that don't have the sdk module in scope can use this to boot in
 * one line.
 * @param {(level:string,msg:string,extra?:object)=>void} log
 */
async function boot (log) {
  let sdkMod
  try {
    sdkMod = await import('@qvac/sdk')
  } catch (err) {
    if (typeof log === 'function') log('warn', '[sdkPlugins] @qvac/sdk import failed', { message: err && err.message })
    return { hostApi: null, registered: [], failed: [{ name: '*', reason: 'SDK_IMPORT_FAILED' }] }
  }
  return ensureAllPlugins(sdkMod, log)
}

function status () {
  return {
    ready: state.ready,
    registered: state.registered.slice(),
    failed: state.failed.slice()
  }
}

module.exports = { ensureAllPlugins, boot, status }
