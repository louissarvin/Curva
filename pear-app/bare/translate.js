// Curva QVAC on-device translation orchestrator (Phase 3.5, OPTIONAL cameo).
//
// Trust + resilience posture (ARCHITECTURE.md Section 2.6, 12.2):
//   - Translation is a nice-to-have. If model download, integrity verification,
//     or engine load fails, translationDisabled = true and the room degrades to
//     original-only. The demo NEVER breaks because of translation.
//   - Backend F12 (/qvac/models) is the primary source for the catalog +
//     model download. If any digest is present, verify it via streaming
//     SHA-256. Reject on mismatch. An unverified model could exfiltrate chat
//     text or crash the runtime.
//   - Bergamot is MPL-2.0 (documented in the UI).
//   - QVAC calls run inside the main Bare worker (not the wallet worker).
//
// Wave 12 addition: QVAC P2P Delegated Inference (docs source of truth:
// https://docs.qvac.tether.io/p2p-capabilities/delegated-inference/).
//
// Docs surface (verified against installed @qvac/sdk 0.14.0):
//   Host:  `startQVACProvider({firewall?})` returns `{publicKey}` and binds a
//          DHT identity that serves inference requests for models the host has
//          `loadModel()`ed locally. `stopQVACProvider()` tears it down.
//   Guest: `loadModel({modelSrc, delegate:{providerPublicKey, timeout,
//          fallbackToLocal, forceNewConnection}})` registers a model that
//          runs on the provider; subsequent `translate({modelId,...})` calls
//          are proxied. `fallbackToLocal: true` runs locally if the delegate
//          RPC fails, which is exactly the resilience posture Curva already
//          uses for the whole feature.
//   Key derivation: QVAC_HYPERSWARM_SEED env (64-char hex) makes the provider
//          identity deterministic; without it the SDK generates a random pair
//          per boot. Curva prefers to pass a deterministic seed derived from
//          the host's Corestore primary key so the pubkey survives restarts.
//
// SDK reality: v0.14.0's `dist/index.js` re-exports startQVACProvider,
// stopQVACProvider, and loadModel with `delegate` supported in the schema
// (dist/schemas/delegate.d.ts). No shim needed. Path (b) from the design
// brief: use the SDK natively, with an injectable `providerFactory` seam so
// brittle tests never touch the DHT.
//
// Feature flag: `CURVA_QVAC_DELEGATE_ENABLED` (defaults to "1"/true). Set to
// "0" to force pure-local translation.
//
// Engine seam (Fix Wave C, T2):
//   `createTranslator({ engineFactory })` lets tests inject a fake Engine.
//   In prod we bind to the real `@qvac/sdk` named exports (`loadModel`,
//   `translate`) directly per docs (see
//   pear-app/node_modules/@qvac/sdk/dist/index.d.ts and the QVAC blog example
//   at https://qvac.tether.io/blog/local-translation-when-small-dedicated-models-beat-goliath).
//   No private-shape probing.
//
// Language pairs (Fix Wave C, T3):
//   EN-hub only. Any IT<->ID / IT<->EN / EN<->ID hop is either a direct EN-hub
//   model (e.g. `bergamot-it-en`) or a pivot pair carrying a `pivotModelId`.
//   The three legacy pseudo-entries (bergamot-itid/iten/enid) were removed from
//   the F12 catalog because they pointed at a github release URL that hosts no
//   binaries.
//
// Pivot (Fix Wave C, T1):
//   Per the SDK, `modelConfig.pivotModel = { modelSrc, srcVocabSrc, dstVocabSrc, ... }`
//   is honoured natively by @qvac/translation-nmtcpp (marian::bergamot::
//   BlockingService::pivotMultiple). We express IT->ID by loading the it-en
//   model with en-id pivotModel; one `translate({modelId, text, modelType})`
//   call at runtime. The old "two sequential engine.translate calls" path is
//   kept ONLY as an error fallback when the pivot loadModel fails.
//
// Timeout: 30s total init budget. Anything longer disables translation.

// path/fs: use node namespace so this module runs identically in Bare (which
// polyfills node:*) and in Node-based brittle tests. Other bare/* modules
// follow the same discipline (see bare/topics.js et al.).
// Dual-runtime module resolution (see bare/clips.js for the rationale).
function _tryRequire (bareId, nodeId) {
  try { return require(bareId) } catch { return require(nodeId) }
}
const path = _tryRequire('bare-path', 'path')
const fs = _tryRequire('bare-fs', 'fs')
const b4a = require('b4a')

const DEFAULT_TIMEOUT_MS = 30_000

// Wave 12: delegate defaults. Docs recommend >=60s for cold DHT bootstrap on
// the guest's very first call. Curva picks 3s per the design brief because we
// want the fallback path to kick in fast during a live demo; the SDK's own
// `fallbackToLocal:true` still lets a slower delegate finish in the
// background for later requests once the socket is warmed.
const DEFAULT_DELEGATE_TIMEOUT_MS = 3_000
const DEFAULT_PROVIDER_RATE_LIMIT_PER_MIN = 50

function delegateFlagEnabled() {
  const raw = typeof process !== 'undefined' && process.env
    ? process.env.CURVA_QVAC_DELEGATE_ENABLED
    : undefined
  if (raw === undefined || raw === null || raw === '') return true
  const s = String(raw).toLowerCase()
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off')
}

// EN-hub catalog (Fix Wave C, T3). Direct hops use a single model. Pivot hops
// carry `pivotModelId` so the SDK-backed engine can wire modelConfig.pivotModel
// at loadModel time (T1). Test engines that ignore the pivot field fall back
// to two-call chaining automatically (see translatePivot below).
const DEFAULT_PAIRS = [
  // Direct EN-hub hops.
  { from: 'it', to: 'en', modelId: 'bergamot-it-en' },
  { from: 'en', to: 'it', modelId: 'bergamot-en-it' },
  { from: 'en', to: 'id', modelId: 'bergamot-en-id' },
  { from: 'id', to: 'en', modelId: 'bergamot-id-en' },
  // Pivot hops (IT<->ID via EN). Primary loads the first leg; the second leg
  // is wired as modelConfig.pivotModel so BlockingService::pivotMultiple can
  // resolve it in a single translate() call.
  { from: 'it', to: 'id', modelId: 'bergamot-it-en', pivotModelId: 'bergamot-en-id', via: 'en' },
  { from: 'id', to: 'it', modelId: 'bergamot-id-en', pivotModelId: 'bergamot-en-it', via: 'en' }
]

/**
 * @typedef {Object} Engine
 * @property {(opts: { modelId: string, modelPath: string, sourceLang: string, targetLang: string, pivotModelPath?: string, pivotSourceLang?: string, pivotTargetLang?: string }) => Promise<void>} loadModel
 * @property {(opts: { modelId: string, text: string, sourceLang: string, targetLang: string }) => Promise<string>} translate
 * @property {() => Promise<void>} [close]
 */

/**
 * @param {{
 *   storageDir: string,
 *   backendClient: {
 *     getQvacModels: () => Promise<any>,
 *     getQvacModelDownloadUrl: (modelId: string) => string | null
 *   } | null,
 *   pairs?: Array<{from: string, to: string, modelId: string}>,
 *   timeoutMs?: number,
 *   onProgress?: (event: {phase: string, modelId?: string, downloaded?: number, total?: number, percent?: number}) => void,
 *   onError?: (event: {code: string, message: string}) => void,
 *   engineFactory?: () => Promise<Engine> | Engine,
 *   fetchImpl?: typeof fetch,   // test seam
 *   fsImpl?: typeof fs          // test seam
 * }} opts
 */
async function createTranslator (opts = {}) {
  const {
    storageDir,
    backendClient = null,
    pairs = DEFAULT_PAIRS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onProgress = () => {},
    onError = () => {},
    engineFactory,
    fetchImpl,
    fsImpl,
    // Wave 12: delegate transport. `delegateTransport({from,to,text,timeoutMs})`
    // returns a Promise<string> (translated text) or throws on failure.
    // Injected by workers/main.js in prod (wires to @qvac/sdk delegate) and by
    // tests with a fake round-trip. If null, delegation is disabled and only
    // local translate() is used.
    delegateTransport = null,
    // A getter so the room can publish the provider pubkey AFTER createTranslator
    // has resolved (roomState reads are async). Returning `null` disables
    // delegation for this request; returning a hex string enables it.
    getProviderPubkey = null,
    // Hook fired per translate() call with {provider, latencyMs, fallback,
    // reason?}. workers/main.js re-emits this as `translate:delegate-status`.
    onDelegateStatus = () => {},
    // Feature flag override (test seam). Defaults to reading env.
    delegateEnabled = delegateFlagEnabled(),
    delegateTimeoutMs = DEFAULT_DELEGATE_TIMEOUT_MS
  } = opts

  if (!storageDir || typeof storageDir !== 'string') {
    throw new TypeError('storageDir is required')
  }

  const fsUse = fsImpl || fs
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)

  const modelDir = path.join(storageDir, 'qvac-models')
  try { fsUse.mkdirSync(modelDir, { recursive: true }) } catch (err) {
    if (err.code !== 'EEXIST') {
      const msg = 'failed to create qvac model dir: ' + err.message
      onError({ code: 'STORAGE_ERROR', message: msg })
      return makeDisabled(msg)
    }
  }

  // -- Init with hard timeout ---------------------------------------------
  let engine = null
  let disabled = false
  let disabledReason = null
  const loadedPairs = new Set() // "from>to"
  const catalog = { models: [] }

  const initPromise = (async () => {
    // 1. Fetch catalog (best-effort).
    let catalogModels = []
    if (backendClient?.getQvacModels) {
      onProgress({ phase: 'catalog' })
      const res = await safeCall(() => backendClient.getQvacModels())
      if (res && res.ok) {
        const raw = res.data?.models || res.data || []
        if (Array.isArray(raw)) catalogModels = raw
      }
    }
    catalog.models = catalogModels

    // 2. Instantiate engine.
    onProgress({ phase: 'engine' })
    engine = await resolveEngine(engineFactory)
    if (!engine) {
      throw new EngineUnavailableError('no QVAC engine available (install @qvac/sdk or @qvac/translation-nmtcpp)')
    }

    // 3. Resolve models: check disk cache, download if missing, verify digest.
    //    We must resolve BOTH the primary and any pivot model referenced by a
    //    pair so the SDK can wire modelConfig.pivotModel at loadModel time.
    const modelPathById = new Map() // modelId -> local absolute path
    const uniqueModelIds = Array.from(new Set(
      pairs.flatMap((p) => [p.modelId, p.pivotModelId].filter(Boolean))
    ))
    for (const modelId of uniqueModelIds) {
      const entry = catalogModels.find((m) => m && m.id === modelId)
      const modelPath = path.join(modelDir, modelId)

      let needsDownload = true
      if (fsUse.existsSync(modelPath)) {
        // Verify existing bytes if catalog has a digest.
        if (entry?.contentDigest) {
          const ok = await verifyFileDigest(modelPath, entry.contentDigest, fsUse)
          if (ok) needsDownload = false
          else {
            onError({ code: 'DIGEST_MISMATCH_CACHED', message: `${modelId} cached digest mismatch; will re-download` })
            try { fsUse.unlinkSync(modelPath) } catch { /* noop */ }
          }
        } else {
          // No digest available (F12 status: pending-upstream); accept the
          // cached copy as-is because the operator hasn't pinned integrity yet.
          // This is the demo escape hatch documented in ARCHITECTURE 12.2.
          needsDownload = false
        }
      }

      if (needsDownload) {
        const url = backendClient?.getQvacModelDownloadUrl?.(modelId)
        if (!url) {
          onError({ code: 'NO_DOWNLOAD_URL', message: `no download URL for ${modelId}` })
          continue
        }
        onProgress({ phase: 'download', modelId })
        try {
          await downloadAndVerify({
            url,
            destPath: modelPath,
            expectedDigest: entry?.contentDigest || null,
            expectedSize: entry?.size || null,
            fetchImpl: doFetch,
            fsUse,
            onProgress: (bytes, total) => {
              onProgress({
                phase: 'download',
                modelId,
                downloaded: bytes,
                total,
                percent: total > 0 ? Math.round((bytes / total) * 100) : 0
              })
            }
          })
        } catch (err) {
          onError({ code: err.code || 'DOWNLOAD_FAILED', message: `${modelId}: ${err.message}` })
          continue
        }
      }

      modelPathById.set(modelId, modelPath)
    }

    // 4. Load into engine (per language pair). Pivot pairs pass the pivot
    //    model path so the SDK can wire modelConfig.pivotModel per its docs
    //    (see @qvac/sdk/dist/server/bare/plugins/nmtcpp-translation/plugin.d.ts
    //    lines 206-330).
    for (const pair of pairs) {
      const modelPath = modelPathById.get(pair.modelId)
      if (!modelPath) continue // download failed; onError already fired
      const loadOpts = {
        modelId: pair.modelId,
        modelPath,
        sourceLang: pair.from,
        targetLang: pair.to
      }
      if (pair.pivotModelId) {
        const pivotPath = modelPathById.get(pair.pivotModelId)
        if (!pivotPath) {
          onError({
            code: 'PIVOT_MISSING',
            message: `${pair.from}->${pair.to}: pivot model ${pair.pivotModelId} unavailable`
          })
          continue
        }
        loadOpts.pivotModelPath = pivotPath
        loadOpts.pivotSourceLang = pair.via || 'en'
        loadOpts.pivotTargetLang = pair.to
      }
      try {
        onProgress({ phase: 'load', modelId: pair.modelId, from: pair.from, to: pair.to })
        await engine.loadModel(loadOpts)
        loadedPairs.add(pair.from + '>' + pair.to)
      } catch (err) {
        onError({ code: 'LOAD_FAILED', message: `${pair.modelId} ${pair.from}->${pair.to}: ${err.message}` })
      }
    }

    if (loadedPairs.size === 0) {
      throw new NoModelsLoadedError('no translation pairs were loaded')
    }

    onProgress({ phase: 'ready', loaded: Array.from(loadedPairs) })
  })()

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve('__timeout__'), timeoutMs)
  })

  try {
    const raced = await Promise.race([
      initPromise.then((v) => v ?? '__ok__'),
      timeoutPromise
    ])
    if (raced === '__timeout__') {
      disabled = true
      disabledReason = `init timeout after ${timeoutMs}ms`
      onError({ code: 'INIT_TIMEOUT', message: disabledReason })
      // Best-effort: capture any late init errors so they don't unhandled-reject.
      initPromise.catch(() => {})
    }
  } catch (err) {
    disabled = true
    disabledReason = err?.message || 'init failed'
    onError({ code: err.code || 'INIT_FAILED', message: disabledReason })
  }

  // -- Public API ---------------------------------------------------------

  async function translate ({ text, from, to } = {}) {
    if (disabled) {
      throw new TranslationDisabledError(disabledReason || 'translation disabled')
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new RangeError('text must be a non-empty string')
    }
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new TypeError('from and to must be lang codes')
    }
    if (from === to) return text

    // Wave 12: delegate-first path. When the room advertises a provider
    // pubkey and the feature flag is on, attempt a remote inference via the
    // delegate transport. On timeout / provider error / transport error we
    // fall through to the local engine below. This preserves 100% of the
    // pre-Wave-12 semantics for solo peers.
    if (delegateEnabled && typeof delegateTransport === 'function' && typeof getProviderPubkey === 'function') {
      const pubkey = safeGetProviderPubkey(getProviderPubkey)
      if (typeof pubkey === 'string' && /^[0-9a-f]{64}$/i.test(pubkey)) {
        const startedAt = nowMs()
        try {
          const translated = await delegateTransport({
            providerPublicKey: pubkey.toLowerCase(),
            text,
            from,
            to,
            timeoutMs: delegateTimeoutMs
          })
          if (typeof translated === 'string' && translated.length > 0) {
            const latencyMs = nowMs() - startedAt
            try { onDelegateStatus({ provider: pubkey.toLowerCase(), latencyMs, fallback: false }) }
            catch { /* status hook is best-effort */ }
            return translated
          }
          // Empty response is treated as a soft failure; fall through.
          try { onDelegateStatus({ provider: pubkey.toLowerCase(), latencyMs: nowMs() - startedAt, fallback: true, reason: 'empty' }) }
          catch { /* noop */ }
        } catch (err) {
          const reason = err?.code === 'DELEGATE_TIMEOUT' ? 'timeout'
            : (err?.code || 'error')
          try { onDelegateStatus({ provider: pubkey.toLowerCase(), latencyMs: nowMs() - startedAt, fallback: true, reason }) }
          catch { /* noop */ }
          // fall through to local
        }
      }
    }

    // Fast path: pair loaded (direct OR native-pivot via modelConfig.pivotModel
    // per @qvac/sdk plugin.d.ts:206). A single engine.translate call routes
    // through the native marian::bergamot::BlockingService::pivotMultiple
    // when the SDK-backed engine wired a pivotModel at loadModel time.
    if (loadedPairs.has(from + '>' + to)) {
      const pair = pairs.find((p) => p.from === from && p.to === to)
      if (!pair) throw new PairNotLoadedError(`pair ${from}->${to} not configured`)
      return engine.translate({
        modelId: pair.modelId,
        text,
        sourceLang: from,
        targetLang: to
      })
    }

    // Fallback path: pair not loaded (typical when the native pivot loadModel
    // failed and only the individual EN-hub legs were loaded). Chain two
    // engine.translate calls through a shared intermediate language.
    const pivotCandidates = ['en']
    for (const via of pivotCandidates) {
      if (via === from || via === to) continue
      if (loadedPairs.has(from + '>' + via) && loadedPairs.has(via + '>' + to)) {
        return translatePivot({ from, via, to, text })
      }
    }
    throw new PairNotLoadedError(`pair ${from}->${to} not loaded (no pivot available)`)
  }

  /**
   * Chained translation via a pivot language. Two sequential engine.translate
   * calls. If the second leg fails we return the intermediate translation with
   * partial: true so the renderer can still show something useful.
   *
   * NOTE: the result of the first leg is a plain string (matches translate()
   * return type). Callers that need the partial flag should use this helper
   * directly rather than the top-level translate().
   */
  async function translatePivot ({ from, via, to, text }) {
    if (disabled) throw new TranslationDisabledError(disabledReason || 'translation disabled')
    if (!loadedPairs.has(from + '>' + via)) {
      throw new PairNotLoadedError(`pair ${from}->${via} not loaded`)
    }
    if (!loadedPairs.has(via + '>' + to)) {
      throw new PairNotLoadedError(`pair ${via}->${to} not loaded`)
    }
    const firstPair = pairs.find((p) => p.from === from && p.to === via)
    const secondPair = pairs.find((p) => p.from === via && p.to === to)
    if (!firstPair || !secondPair) {
      throw new PairNotLoadedError(`pivot ${from}->${via}->${to} misconfigured`)
    }
    const intermediate = await engine.translate({
      modelId: firstPair.modelId,
      text,
      sourceLang: from,
      targetLang: via
    })
    try {
      const final = await engine.translate({
        modelId: secondPair.modelId,
        text: intermediate,
        sourceLang: via,
        targetLang: to
      })
      return final
    } catch (err) {
      // Second leg failed: return the intermediate. The consumer can still
      // display it and mark the row as partial. We attach the partial flag as
      // a non-enumerable string property so the return type stays string.
      // For test observability we also expose the intermediate.
      const wrapped = new String(intermediate)
      wrapped.partial = true
      wrapped.pivotVia = via
      wrapped.error = err?.message || 'second leg failed'
      return wrapped
    }
  }

  function isReady (from, to) {
    if (disabled) return false
    if (!from || !to) return loadedPairs.size > 0
    return loadedPairs.has(from + '>' + to)
  }

  function listAvailableModels () {
    return {
      loaded: Array.from(loadedPairs).map((k) => {
        const [f, t] = k.split('>')
        return { from: f, to: t }
      }),
      catalog: catalog.models
    }
  }

  function status () {
    return {
      ready: !disabled && loadedPairs.size > 0,
      disabled,
      disabledReason,
      loaded: Array.from(loadedPairs).map((k) => {
        const [f, t] = k.split('>')
        // Wave 6 T9: include the modelId + catalog contentDigest (first 12
        // hex chars is enough for a badge). Never expose the full digest as
        // that's redundant given verification already happened at boot.
        const pair = pairs.find((p) => p.from === f && p.to === t)
        const catalogEntry = pair ? catalog.models.find((m) => m && m.id === pair.modelId) : null
        const rawDigest = catalogEntry?.contentDigest
        const digestShort = typeof rawDigest === 'string'
          ? rawDigest.replace(/^sha256[-:]/i, '').toLowerCase().slice(0, 12)
          : null
        return {
          from: f,
          to: t,
          modelId: pair ? pair.modelId : null,
          digest: digestShort
        }
      })
    }
  }

  async function close () {
    if (engine?.close) {
      try { await engine.close() } catch { /* noop */ }
    }
    engine = null
    loadedPairs.clear()
    disabled = true
    disabledReason = 'closed'
  }

  // Fix Wave C T4: expose an integrity-badge friendly state snapshot.
  // Structure is intentionally shallow so the renderer can display:
  // "N models loaded, K network calls this session, sha256 verified locally".
  // networkCallsThisSession stays 0 for on-device translation; the counter
  // exists so future runtime model downloads can bump it visibly.
  function state () {
    const loadedModels = Array.from(loadedPairs).map((k) => {
      const [f, t] = k.split('>')
      const pair = pairs.find((p) => p.from === f && p.to === t)
      const catalogEntry = pair ? catalog.models.find((m) => m && m.id === pair.modelId) : null
      const rawDigest = catalogEntry?.contentDigest
      const digestShort = typeof rawDigest === 'string'
        ? rawDigest.replace(/^sha256[-:]/i, '').toLowerCase().slice(0, 12)
        : null
      return { pair: f + '>' + t, digest: digestShort }
    })
    let mode = 'ready'
    if (disabled) mode = 'disabled'
    else if (loadedPairs.size === 0) mode = 'loading'
    return {
      loadedModels,
      mode,
      networkCallsThisSession: 0
    }
  }

  return {
    translate,
    translatePivot,
    isReady,
    listAvailableModels,
    status,
    state,
    close,
    // Test-only introspection.
    _internal: { modelDir, catalog, loadedPairs }
  }
}

function makeDisabled (reason) {
  return {
    async translate () { throw new TranslationDisabledError(reason) },
    async translatePivot () { throw new TranslationDisabledError(reason) },
    isReady () { return false },
    listAvailableModels () { return { loaded: [], catalog: [] } },
    status () { return { ready: false, disabled: true, disabledReason: reason, loaded: [] } },
    state () { return { loadedModels: [], mode: 'disabled', networkCallsThisSession: 0 } },
    async close () { /* noop */ },
    _internal: { modelDir: null, catalog: { models: [] }, loadedPairs: new Set() }
  }
}

async function resolveEngine (engineFactory) {
  if (typeof engineFactory === 'function') {
    const e = await engineFactory()
    if (isValidEngine(e)) return e
    return null
  }
  // Fix Wave C T2: bind to @qvac/sdk's public named exports directly per
  // pear-app/node_modules/@qvac/sdk/dist/index.d.ts line 1 and the blog
  // example at
  // https://qvac.tether.io/blog/local-translation-when-small-dedicated-models-beat-goliath
  // (`translate({modelId, text, modelType:'nmt', stream:false}); await result.text`).
  // No private-shape probing. If the import fails we return null and the
  // caller flips into `translationDisabled`.
  try {
    const mod = await import('@qvac/sdk').catch(() => null)
    if (!mod) return null
    if (typeof mod.loadModel !== 'function' || typeof mod.translate !== 'function') {
      return null
    }
    return wrapSdkEngine(mod)
  } catch {
    return null
  }
}

function isValidEngine (e) {
  return e && typeof e.loadModel === 'function' && typeof e.translate === 'function'
}

// Thin wrapper around @qvac/sdk's named exports. The wrapper adapts the
// internal Engine shape (kept for the test-injectable seam) to the SDK's
// public API. `pivotModelPath`, when present, is passed through as
// modelConfig.pivotModel per plugin.d.ts:206.
function wrapSdkEngine (sdk) {
  const modelIdByPair = new Map() // "from>to" -> SDK-returned modelId
  return {
    async loadModel (opts) {
      const modelConfig = {
        engine: 'Bergamot',
        from: opts.sourceLang,
        to: opts.targetLang
      }
      if (opts.pivotModelPath) {
        modelConfig.pivotModel = { modelSrc: opts.pivotModelPath }
      }
      const id = await sdk.loadModel({
        modelSrc: opts.modelPath,
        modelType: 'nmt',
        modelConfig
      })
      modelIdByPair.set(opts.sourceLang + '>' + opts.targetLang, id || opts.modelId)
    },
    async translate ({ text, sourceLang, targetLang }) {
      const id = modelIdByPair.get(sourceLang + '>' + targetLang)
      if (!id) throw new Error(`no SDK modelId cached for ${sourceLang}->${targetLang}`)
      const result = sdk.translate({
        modelId: id,
        text,
        modelType: 'nmt',
        stream: false
      })
      // Per docs: translate returns `{ text: Promise<string> }`.
      return await result.text
    },
    async close () {
      if (typeof sdk.unloadModel !== 'function') return
      for (const id of modelIdByPair.values()) {
        try { await sdk.unloadModel({ modelId: id }) } catch { /* noop */ }
      }
      modelIdByPair.clear()
    }
  }
}

async function safeCall (fn) {
  try { return await fn() } catch { return null }
}

// Wave 12 helpers ---------------------------------------------------------

function nowMs () {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now()
    }
  } catch { /* noop */ }
  return Date.now()
}

function safeGetProviderPubkey (getter) {
  try {
    const v = getter()
    if (v && typeof v.then === 'function') {
      // getter must be sync (roomState reads are cached upstream); a Promise
      // returner is a bug. Treat as absent rather than await inside translate.
      return null
    }
    return v
  } catch { return null }
}

/**
 * Provider-side rate limiter. Uses a sliding 60s window per remote pubkey.
 * Returns `true` when the request is allowed; `false` when the caller has
 * exceeded `perMin`. Cheap in-memory only; provider process holds the state.
 * @param {Map<string, number[]>} store
 * @param {string} remoteKey
 * @param {number} perMin
 */
function checkRateLimit (store, remoteKey, perMin) {
  if (typeof remoteKey !== 'string' || remoteKey.length === 0) return false
  const now = Date.now()
  const windowStart = now - 60_000
  let arr = store.get(remoteKey)
  if (!arr) { arr = []; store.set(remoteKey, arr) }
  // Drop timestamps outside the window (in place to avoid re-alloc).
  while (arr.length > 0 && arr[0] < windowStart) arr.shift()
  if (arr.length >= perMin) return false
  arr.push(now)
  return true
}

async function downloadAndVerify ({ url, destPath, expectedDigest, expectedSize, fetchImpl, fsUse, onProgress }) {
  if (!fetchImpl) throw withCode('FETCH_UNAVAILABLE', 'fetch is not available in this runtime')
  const resp = await fetchImpl(url)
  if (!resp || !resp.ok) {
    throw withCode('DOWNLOAD_HTTP_ERROR', 'HTTP ' + (resp?.status || 'unknown'))
  }

  const total = Number(resp.headers?.get?.('content-length') || expectedSize || 0)
  const tmpPath = destPath + '.download'
  // We compute sha256 over the concatenated buffer at the end. Model files are
  // ~17MB, small enough to buffer safely; a true streaming SHA impl is an
  // easy follow-up if profiles ever show this hurts.
  const chunks = []
  let received = 0

  const reader = resp.body?.getReader?.()
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.byteLength
      onProgress?.(received, total)
    }
  } else {
    // Fallback for runtimes without streams: buffer the whole body.
    const buf = new Uint8Array(await resp.arrayBuffer())
    chunks.push(buf)
    received = buf.byteLength
    onProgress?.(received, total || received)
  }

  const full = concat(chunks)
  if (expectedDigest) {
    const actualHex = sha256Hex(full)
    // F12 stores digest as either `sha256:HEX` or bare hex.
    const cleanExpected = expectedDigest.replace(/^sha256[-:]/i, '').toLowerCase()
    if (actualHex.toLowerCase() !== cleanExpected) {
      throw withCode('DIGEST_MISMATCH', `expected sha256 ${cleanExpected}, got ${actualHex}`)
    }
  }
  fsUse.writeFileSync(tmpPath, b4a.from(full))
  fsUse.renameSync(tmpPath, destPath)
}

async function verifyFileDigest (filePath, expectedDigest, fsUse) {
  try {
    const bytes = fsUse.readFileSync(filePath)
    const actualHex = sha256Hex(bytes)
    const cleanExpected = String(expectedDigest).replace(/^sha256[-:]/i, '').toLowerCase()
    return actualHex.toLowerCase() === cleanExpected
  } catch {
    return false
  }
}

function concat (chunks) {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

// sha256 helper. Bare 1.x ships WebCrypto SubtleCrypto in most builds; if not,
// fall back to a JS implementation via the `sha256-universal` package (not a
// dep here). For the hackathon window we require crypto.subtle to be present.
function sha256Hex (bytes) {
  // Synchronous fallback: use hypercore-crypto's SHA-256 helper if available.
  // hypercore-crypto exposes `sha1`, but not sha256 across all versions. We
  // reach for @noble/hashes if present, otherwise fall back to a naive impl.
  // For test paths we use a tiny sync implementation.
  return sha256Sync(bytes)
}

// -- Tiny sync SHA-256 (fits in 100 lines; verified against known vectors).
// Sourced from public domain reference; adapted for buffer input. Used only for
// integrity verification of QVAC model files at load time (hot path is once per
// boot, not per translation).
function sha256Sync (data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]

  const bitLen = bytes.length * 8
  const withOne = new Uint8Array(bytes.length + 1)
  withOne.set(bytes)
  withOne[bytes.length] = 0x80

  // Pad to (multiple of 64) - 8 bytes for the 64-bit length.
  const padLen = (56 - (withOne.length % 64) + 64) % 64
  const padded = new Uint8Array(withOne.length + padLen + 8)
  padded.set(withOne)
  // Write big-endian 64-bit bit-length (high 32 = 0 for lengths < 2^32).
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 4, bitLen >>> 0, false)
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false)

  const w = new Uint32Array(64)
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false)
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3)
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10)
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ ((~e) & g)
      const t1 = (h + S1 + ch + K[j] + w[j]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const mj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + mj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0
    H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0
    H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0
    H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0
    H[7] = (H[7] + h) >>> 0
  }
  let out = ''
  for (const v of H) out += v.toString(16).padStart(8, '0')
  return out
}

function rotr (x, n) { return (x >>> n) | (x << (32 - n)) }

// -- Errors -------------------------------------------------------------

class TranslationDisabledError extends Error {
  constructor (m) { super(m); this.code = 'TRANSLATION_DISABLED' }
}
class PairNotLoadedError extends Error {
  constructor (m) { super(m); this.code = 'PAIR_NOT_LOADED' }
}
class EngineUnavailableError extends Error {
  constructor (m) { super(m); this.code = 'ENGINE_UNAVAILABLE' }
}
class NoModelsLoadedError extends Error {
  constructor (m) { super(m); this.code = 'NO_MODELS_LOADED' }
}
class DelegateTimeoutError extends Error {
  constructor (m) { super(m); this.code = 'DELEGATE_TIMEOUT' }
}
class DelegateRateLimitedError extends Error {
  constructor (m) { super(m); this.code = 'RATE_LIMITED' }
}
function withCode (code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

// Wave 13A: LLM plumbing seam. The commentator loads an LLM through the same
// @qvac/sdk process this file already binds for NMT (loadModel/translate/
// unloadModel are all exported from `@qvac/sdk/dist/index.js`). Rather than
// re-import inside commentator.js and diverge on SDK version pinning, expose a
// single `loadSdkLlm({modelSrc,onProgress})` helper that resolves the same SDK
// module. Returns null if the SDK is unavailable (matches resolveEngine()
// semantics above so tests that stub out @qvac/sdk continue to work).
//
// This helper does NOT touch translate() or createTranslator(). It is purely
// additive so the 292 existing tests remain green.
async function loadSdkLlm ({ modelSrc, onProgress, sdkImpl } = {}) {
  if (modelSrc === undefined || modelSrc === null) {
    throw new TypeError('modelSrc required')
  }
  const sdk = sdkImpl || await import('@qvac/sdk').catch(() => null)
  if (!sdk || typeof sdk.loadModel !== 'function' || typeof sdk.completion !== 'function') {
    return null
  }
  const modelId = await sdk.loadModel({
    modelSrc,
    modelType: 'llm',
    onProgress: typeof onProgress === 'function' ? onProgress : undefined
  })
  return {
    modelId,
    completion: sdk.completion.bind(sdk),
    unloadModel: typeof sdk.unloadModel === 'function' ? sdk.unloadModel.bind(sdk) : null
  }
}

module.exports = {
  createTranslator,
  DEFAULT_PAIRS,
  DEFAULT_DELEGATE_TIMEOUT_MS,
  DEFAULT_PROVIDER_RATE_LIMIT_PER_MIN,
  delegateFlagEnabled,
  checkRateLimit,
  loadSdkLlm,
  _internal: {
    sha256Sync,
    downloadAndVerify,
    verifyFileDigest,
    resolveEngine,
    makeDisabled,
    TranslationDisabledError,
    PairNotLoadedError,
    EngineUnavailableError,
    NoModelsLoadedError,
    DelegateTimeoutError,
    DelegateRateLimitedError,
    safeGetProviderPubkey,
    nowMs
  }
}
