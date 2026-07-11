// Curva QVAC SDK plugin bootstrap (semifinal live-boot fix).
//
// Root cause of the bug we fix here (verified against installed source
// 2026-07-11):
//
//   Peer boots with @qvac/sdk in Bare runtime. First SDK-adjacent code path
//   is the modules that DO register their plugin (translate.js registers
//   nmtcpp-translation and llamacpp-completion). All OTHER modules then try
//   to call sdk.ocr, sdk.classify, sdk.completion({attachments:[...]}), or
//   sdk.embed against an SDK that has NEVER been told about their plugin
//   registry. The SDK returns:
//
//     Describe failed: No plugins registered in the worker. On Bare, register
//     the plugins you need with `plugins([...])` (or `registerPlugin(...)`)
//     before the first SDK call — import each from its subpath, e.g.
//     `@qvac/sdk/llamacpp-completion/plugin`. For direct Bare usage we
//     recommend the dedicated `@qvac/bare-sdk` package.
//     See https://docs.qvac.tether.io/configuration/plugins#runtime-registration-on-bare
//
// This module registers EVERY plugin Curva uses in one shot, up-front. Every
// downstream module can then call sdk.loadModel + sdk.<verb> without ever
// hitting WORKER_PLUGINS_NOT_REGISTERED. Idempotent: subsequent calls no-op
// after the first successful registration. Best-effort per plugin: a plugin
// that fails to import (e.g. missing native addon on the current arch) is
// logged and skipped rather than breaking the whole boot path.
//
// Docs verified (2026-07-11):
//   - https://docs.qvac.tether.io/configuration/plugins#runtime-registration-on-bare
//   - Installed plugin subpaths at
//     pear-app/node_modules/@qvac/sdk/dist/server/bare/plugins/*
//   - pear-app/bare/translate.js:770-800 for the working registration
//     pattern we replicate here (import subpath -> pick .default or the
//     named export -> mod.plugins([plugin]) -> capture returned hostApi).
//
// The returned `hostApi` from mod.plugins([plugins...]) is what actually
// exposes the primed loadModel + verbs; module callers that need the primed
// surface should await ensureAllPlugins() and use the returned hostApi.

const PLUGIN_SUBPATHS = Object.freeze([
  { name: 'llamacpp-completion',    subpath: '@qvac/sdk/llamacpp-completion/plugin',    exportKey: 'llmPlugin' },
  { name: 'llamacpp-embedding',     subpath: '@qvac/sdk/llamacpp-embedding/plugin',     exportKey: 'embedPlugin' },
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
    if (!sdkMod || typeof sdkMod.plugins !== 'function') {
      const reason = 'sdk-plugins-fn-missing'
      safeLog('warn', '[sdkPlugins] SDK has no plugins() registrar; downstream calls will 4xx', { reason })
      state.ready = true
      state.hostApi = sdkMod || null
      return { hostApi: state.hostApi, registered: [], failed: [{ name: '*', reason }] }
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

    let hostApi = sdkMod
    try {
      // One-shot registration keeps every plugin on the same registry instance
      // (the sibling-registry drift bug documented in translate.js:756-770
      // was caused by calling plugins() repeatedly with single entries).
      hostApi = sdkMod.plugins(collected.map(function (c) { return c.plugin })) || sdkMod
      state.registered = collected.map(function (c) { return c.name })
      safeLog('info', '[sdkPlugins] registered ' + state.registered.length + ' plugins', {
        names: state.registered
      })
    } catch (err) {
      safeLog('warn', '[sdkPlugins] plugins() bulk call threw; falling back to per-plugin', {
        message: err && err.message
      })
      // Fallback: register one by one. Some SDK betas expose registerPlugin.
      for (const c of collected) {
        try {
          if (typeof sdkMod.registerPlugin === 'function') {
            sdkMod.registerPlugin(c.plugin)
          } else {
            sdkMod.plugins([c.plugin])
          }
          state.registered.push(c.name)
        } catch (subErr) {
          state.failed.push({ name: c.name, reason: (subErr && subErr.message) || 'THREW' })
        }
      }
      hostApi = sdkMod
    }

    state.hostApi = hostApi || sdkMod
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
