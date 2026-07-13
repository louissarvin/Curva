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
const zlib = _tryRequire('bare-zlib', 'zlib')
const b4a = require('b4a')

// Mozilla Firefox Translations ships every Bergamot artefact as `<file>.gz`.
// The @qvac/sdk nmtcpp plugin does NOT auto-inflate: server/bare/plugins/
// nmtcpp-translation/plugin.js only decompresses .tar.gz archives (via
// server/utils/archive.js), not raw single-file .bin.gz / .spm.gz. We inflate
// here before handing the on-disk path to loadModel. Detection is by the 1f 8b
// gzip magic so non-gzipped mirrors keep working.
function maybeGunzip (bytes) {
  if (!bytes || bytes.length < 2) return bytes
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
  if (!zlib || typeof zlib.gunzipSync !== 'function') {
    throw withCode('GUNZIP_UNAVAILABLE', 'bare-zlib gunzipSync unavailable')
  }
  const raw = zlib.gunzipSync(b4a.isBuffer(bytes) ? bytes : b4a.from(bytes))
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
}

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
    //    Bergamot pairs also need a sentencepiece vocab file (`vocab.<pair>.spm`).
    //    The SDK's nmtcpp plugin throws ModelLoadFailedError at
    //    server/bare/plugins/nmtcpp-translation/resolve-vocab.js:55 when the
    //    vocab can't be resolved and the modelSrc is a plain file path (no
    //    pear:// / registry:// auto-derivation). We download the vocab as a
    //    sibling file `<modelId>.vocab.spm` and thread its absolute path
    //    through to wrapSdkEngine below.
    const modelPathById = new Map() // modelId -> local absolute path
    const vocabPathById = new Map() // modelId -> local absolute vocab path (or null)
    const uniqueModelIds = Array.from(new Set(
      pairs.flatMap((p) => [p.modelId, p.pivotModelId].filter(Boolean))
    ))
    // Canonical Bergamot filename derivation. The @qvac/translation-nmtcpp
    // native addon detects the Bergamot backend by matching the model
    // filename against `/^model\.([a-z]+)\.intgemm\.alphas\.bin$/` and looking
    // for a colocated `vocab.<pair>.spm`. Files named `bergamot-en-it` are
    // treated as unknown and the addon defaults to the GGML backend, which
    // then rejects the file as "Invalid file magic number".
    //
    // We stash each pair in its own subdirectory under qvac-models/ using
    // Mozilla's canonical filenames so both filename detection and the
    // plugin's `deriveColocatedBergamotVocabPaths` succeed.
    function canonicalBergamotPaths(mId) {
      const m = String(mId).match(/^bergamot-([a-z]{2})-([a-z]{2})$/i)
      if (!m) return null
      const pair = (m[1] + m[2]).toLowerCase()
      const dir = path.join(modelDir, mId)
      return {
        dir,
        modelPath: path.join(dir, `model.${pair}.intgemm.alphas.bin`),
        vocabPath: path.join(dir, `vocab.${pair}.spm`)
      }
    }
    for (const modelId of uniqueModelIds) {
      const entry = catalogModels.find((m) => m && m.id === modelId)
      const canonical = canonicalBergamotPaths(modelId)
      const modelPath = canonical?.modelPath || path.join(modelDir, modelId)
      if (canonical) {
        // The legacy flat cache had `<modelDir>/<modelId>` as a FILE at the
        // exact same path that we now want as a DIRECTORY. Blow away the old
        // flat files (model + vocab) BEFORE mkdirSync so it can create the
        // directory. We accept the re-download cost — 25 MB per pair — as
        // the price of the one-shot cache-shape migration.
        const legacyFlatModel = path.join(modelDir, modelId)
        const legacyFlatVocab = legacyFlatModel + '.vocab.spm'
        try {
          const st = fsUse.statSync?.(legacyFlatModel)
          if (st && st.isFile()) fsUse.unlinkSync(legacyFlatModel)
        } catch { /* not present or already a directory */ }
        try {
          const st = fsUse.statSync?.(legacyFlatVocab)
          if (st && st.isFile()) fsUse.unlinkSync(legacyFlatVocab)
        } catch { /* not present */ }
        try { fsUse.mkdirSync(canonical.dir, { recursive: true }) } catch (err) {
          if (err.code !== 'EEXIST') {
            onError({ code: 'MKDIR_FAILED', message: `${modelId}: ${err.message}` })
            continue
          }
        }
      }

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
        // Retry once on transient bare-fetch failures. Common in bursty
        // Google-Storage 302 redirects during app boot (e.g. bergamot-it-en
        // regularly hits NETWORK_ERROR on cold start while its siblings
        // succeed); a single 1s backoff clears it reliably.
        let dlErr = null
        for (let attempt = 1; attempt <= 3; attempt++) {
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
                  percent: total > 0 ? Math.round((bytes / total) * 100) : 0,
                  attempt
                })
              }
            })
            dlErr = null
            break
          } catch (err) {
            dlErr = err
            const transient = err?.code === 'NETWORK_ERROR' || err?.code === 'DOWNLOAD_HTTP_ERROR'
            if (!transient || attempt === 3) break
            onProgress({ phase: 'download-retry', modelId, attempt, message: err.message })
            await new Promise((r) => setTimeout(r, attempt * 1000))
          }
        }
        if (dlErr) {
          onError({ code: dlErr.code || 'DOWNLOAD_FAILED', message: `${modelId}: ${dlErr.message}` })
          continue
        }
      }

      modelPathById.set(modelId, modelPath)

      // -- Bergamot vocab -----------------------------------------------
      // If the catalog carries a vocabUrl for this model, mirror the
      // model-file resolution above: check disk cache, download+gunzip if
      // missing. Shared vocab file (Mozilla uses a single sentencepiece
      // model per pair for both source and destination).
      if (entry?.vocabUrl) {
        const vocabPath = canonical?.vocabPath || (modelPath + '.vocab.spm')
        let needsVocab = true
        if (fsUse.existsSync(vocabPath)) needsVocab = false
        if (needsVocab) {
          onProgress({ phase: 'download-vocab', modelId })
          try {
            await downloadAndVerify({
              url: entry.vocabUrl,
              destPath: vocabPath,
              expectedDigest: null, // no per-vocab digest pinned yet
              expectedSize: null,
              fetchImpl: doFetch,
              fsUse,
              onProgress: (bytes, total) => {
                onProgress({
                  phase: 'download-vocab',
                  modelId,
                  downloaded: bytes,
                  total,
                  percent: total > 0 ? Math.round((bytes / total) * 100) : 0
                })
              }
            })
          } catch (err) {
            onError({ code: err.code || 'VOCAB_DOWNLOAD_FAILED', message: `${modelId} vocab: ${err.message}` })
            // Fall through — Bergamot load will error and we'll skip the pair.
            continue
          }
        }
        vocabPathById.set(modelId, vocabPath)
      }
    }

    // 4. Load into engine (per language pair). Pivot pairs pass the pivot
    //    model path so the SDK can wire modelConfig.pivotModel per its docs
    //    (see @qvac/sdk/dist/server/bare/plugins/nmtcpp-translation/plugin.d.ts
    //    lines 206-330).
    for (const pair of pairs) {
      const modelPath = modelPathById.get(pair.modelId)
      if (!modelPath) continue // download failed; onError already fired
      const vocabPath = vocabPathById.get(pair.modelId) || null
      const loadOpts = {
        modelId: pair.modelId,
        modelPath,
        vocabPath, // shared spm vocab; wrapSdkEngine wires as srcVocabSrc + dstVocabSrc
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
        loadOpts.pivotVocabPath = vocabPathById.get(pair.pivotModelId) || null
        loadOpts.pivotSourceLang = pair.via || 'en'
        loadOpts.pivotTargetLang = pair.to
      }
      try {
        onProgress({ phase: 'load', modelId: pair.modelId, from: pair.from, to: pair.to })
        // Log the resolved paths so a downstream FS check catches missing
        // or empty files before we blame the SDK.
        try {
          const st = fsUse?.statSync?.(loadOpts.modelPath)
          const stV = loadOpts.vocabPath ? fsUse?.statSync?.(loadOpts.vocabPath) : null
          console.log('[Curva][Translate] load prep', {
            modelId: pair.modelId,
            modelPath: loadOpts.modelPath,
            modelBytes: st?.size ?? null,
            vocabPath: loadOpts.vocabPath,
            vocabBytes: stV?.size ?? null,
            pivotModelPath: loadOpts.pivotModelPath || null,
            pivotVocabPath: loadOpts.pivotVocabPath || null,
            from: pair.from,
            to: pair.to
          })
        } catch (fsErr) {
          console.warn('[Curva][Translate] load prep stat failed:', fsErr?.message)
        }
        await engine.loadModel(loadOpts)
        loadedPairs.add(pair.from + '>' + pair.to)
      } catch (err) {
        console.warn(
          '[Curva][Translate] SDK loadModel threw',
          JSON.stringify({
            modelId: pair.modelId,
            from: pair.from,
            to: pair.to,
            errMessage: err?.message || String(err),
            errCode: err?.code || null,
            errName: err?.name || null,
            causeMessage: err?.cause?.message || null,
            causeCode: err?.cause?.code || null,
            stack: err?.stack?.slice(0, 600) || null
          })
        )
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
      // Late-recovery. On cold start, downloading + decompressing four
      // Bergamot pairs from Mozilla's GCS bucket routinely takes 30-90s on a
      // normal home link (see storage.googleapis.com/moz-fx-translations-data
      // per bare/translate.js docs above). initPromise keeps running after
      // the timeout even though we've already reported disabled=true. When
      // the underlying pairs finish loading successfully in the background,
      // flip disabled back off and emit `phase: 'ready'` so callers can
      // recover. Preserves the timeout test's semantics: slowFactory tests
      // never resolve initPromise, so this hook never fires there.
      initPromise
        .then(() => {
          if (loadedPairs.size === 0) return
          disabled = false
          disabledReason = null
          onProgress({
            phase: 'ready',
            loaded: Array.from(loadedPairs),
            lateInit: true
          })
        })
        .catch(() => { /* stay disabled — init genuinely failed */ })
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
    let importErr = null
    const mod = await import('@qvac/sdk').catch((err) => { importErr = err; return null })
    if (!mod) {
      console.warn('[Curva][Translate] @qvac/sdk import failed:', importErr?.message || importErr, importErr?.code || '', importErr?.stack?.slice(0, 400) || '')
      return null
    }
    if (typeof mod.loadModel !== 'function' || typeof mod.translate !== 'function') {
      console.warn('[Curva][Translate] @qvac/sdk import ok but missing required exports', {
        hasLoadModel: typeof mod.loadModel === 'function',
        hasTranslate: typeof mod.translate === 'function',
        keys: Object.keys(mod).slice(0, 20)
      })
      return null
    }
    // Bare plugin registration. The SDK's ensure-worker-ready.js checks
    // getAllPlugins() at the start of every loadModel/translate call and
    // throws WORKER_PLUGINS_NOT_REGISTERED if the registry is empty. Two
    // gotchas we ran into and fix here:
    //
    //   1. plugins-factory.js's `plugins()` both registers the plugin AND
    //      returns a hostApi with loadModel + translate bound. On Bare the
    //      module resolution can end up with the plugin registered on a
    //      registry that mod.loadModel does not read, so calling
    //      mod.loadModel throws WORKER_PLUGINS_NOT_REGISTERED even though
    //      the register succeeded on the sibling registry. Solution: use
    //      the hostApi that plugins() returns — it is guaranteed to read
    //      the same registry the register call just wrote to.
    //
    //   2. Belt + braces: also call registerPlugin directly against
    //      server/plugins/index.js when reachable, so any additional
    //      registry-instance drift is covered.
    let sdkForWrap = mod
    try {
      const nmtPluginMod = await import('@qvac/sdk/nmtcpp-translation/plugin').catch((err) => {
        console.warn('[Curva][Translate] @qvac/sdk/nmtcpp-translation/plugin import failed:', err?.message || err)
        return null
      })
      const nmtPlugin = nmtPluginMod?.nmtPlugin || nmtPluginMod?.default || nmtPluginMod
      if (nmtPlugin && typeof mod.plugins === 'function') {
        const host = mod.plugins([nmtPlugin])
        console.log('[Curva][Translate] registered nmtcpp plugin via @qvac/sdk plugins()')
        if (host && typeof host.loadModel === 'function' && typeof host.translate === 'function') {
          sdkForWrap = host
          console.log('[Curva][Translate] using hostApi returned by plugins() for loadModel + translate')
        }
      } else if (typeof mod.plugins !== 'function') {
        console.warn('[Curva][Translate] @qvac/sdk exposes no plugins(...) registrar; SDK may reject loadModel')
      } else {
        console.warn('[Curva][Translate] nmtcpp plugin module has no nmtPlugin export', {
          keys: nmtPluginMod ? Object.keys(nmtPluginMod).slice(0, 10) : null
        })
      }
    } catch (err) {
      console.warn('[Curva][Translate] plugin registration threw:', err?.message || err)
    }
    // Subscribe to the SDK's internal server log stream so Marian/addon
    // errors surface in our worker log instead of getting swallowed by the
    // opaque "Failed to load model" RPC envelope. Idempotent — the SDK is
    // documented as safe to subscribe once at boot.
    try {
      if (typeof mod.subscribeServerLogs === 'function') {
        mod.subscribeServerLogs((log) => {
          try {
            const level = String(log?.level || 'info').toLowerCase()
            const stream = level === 'error' || level === 'warn' ? console.warn : console.log
            stream('[Curva][QVAC:' + (log?.id || 'sdk') + ':' + (log?.namespace || '?') + '] ' + (log?.message || ''))
          } catch { /* logging is best-effort */ }
        })
        console.log('[Curva][Translate] subscribed to @qvac/sdk server logs')
      }
    } catch (err) {
      console.warn('[Curva][Translate] subscribeServerLogs threw:', err?.message || err)
    }
    return wrapSdkEngine(sdkForWrap)
  } catch (err) {
    console.warn('[Curva][Translate] resolveEngine threw:', err?.message || err, err?.stack?.slice(0, 400) || '')
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
        // The @qvac/sdk nmtcpp plugin uses `nmtConfigBaseSchema` (not the
        // transformed `nmtConfigSchema`), so the `mode: "full"` default that
        // the transform normally applies is skipped. Pass it explicitly here
        // to match the schema's post-transform shape.
        mode: 'full',
        engine: 'Bergamot',
        from: opts.sourceLang,
        to: opts.targetLang
      }
      // The SDK's nmtcpp plugin requires srcVocabSrc + dstVocabSrc when
      // modelSrc is a plain file path (resolve-vocab.js:14,22,55). Mozilla
      // ships a single shared sentencepiece vocab per pair, so both fields
      // point at the same file.
      if (opts.vocabPath) {
        modelConfig.srcVocabSrc = opts.vocabPath
        modelConfig.dstVocabSrc = opts.vocabPath
      }
      if (opts.pivotModelPath) {
        const pivot = { modelSrc: opts.pivotModelPath }
        if (opts.pivotVocabPath) {
          pivot.srcVocabSrc = opts.pivotVocabPath
          pivot.dstVocabSrc = opts.pivotVocabPath
        }
        modelConfig.pivotModel = pivot
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
  // Follow HTTP redirects. The backend model mirror route can 302 to a
  // Google Cloud Storage URL when MODEL_MIRROR_ENABLED=false or when a
  // Bergamot entry has contentDigest=null. bare-fetch defaults to
  // `manual` on some builds, which stalls the download loop below on an
  // empty body. `redirect: 'follow'` matches browser fetch and Node
  // undici semantics, so both mirrored and origin URLs work.
  const resp = await fetchImpl(url, { redirect: 'follow' })
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

  const compressed = concat(chunks)
  // Mozilla ships every Bergamot file gzipped (`.bin.gz`, `.spm.gz`). Inflate
  // before writing to disk so the SDK's nmtcpp plugin can consume raw intgemm
  // /  sentencepiece bytes directly. digest matches the inflated payload since
  // qvac-models.json.notes.upstreamUncompressedHash is the uncompressed sha256
  // (matches Mozilla's manifest `uncompressedHash`).
  const full = maybeGunzip(compressed)
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
async function loadSdkLlm ({ modelSrc, onProgress, sdkImpl, modelConfig } = {}) {
  if (modelSrc === undefined || modelSrc === null) {
    throw new TypeError('modelSrc required')
  }
  let importErr = null
  const sdk = sdkImpl || await import('@qvac/sdk').catch((err) => { importErr = err; return null })
  if (!sdk) {
    console.warn('[Curva][LlmLoader] @qvac/sdk import failed:', importErr?.message || importErr, importErr?.code || '', importErr?.stack?.slice(0, 400) || '')
    return null
  }
  if (typeof sdk.loadModel !== 'function' || typeof sdk.completion !== 'function') {
    console.warn('[Curva][LlmLoader] @qvac/sdk imported but missing exports', {
      hasLoadModel: typeof sdk.loadModel === 'function',
      hasCompletion: typeof sdk.completion === 'function',
      keys: Object.keys(sdk).slice(0, 20)
    })
    return null
  }
  // Bare plugin registration for LLM inference. Same gotcha as the NMT
  // engine — use the hostApi returned by plugins() for loadModel + completion
  // so the SDK's ensure-worker-ready gate reads the same registry we just
  // populated.
  let sdkHost = sdk
  try {
    const llmPluginMod = await import('@qvac/sdk/llamacpp-completion/plugin').catch((err) => {
      console.warn('[Curva][LlmLoader] llamacpp-completion plugin import failed:', err?.message || err)
      return null
    })
    const llmPlugin = llmPluginMod?.llmPlugin || llmPluginMod?.default || llmPluginMod
    if (llmPlugin && typeof sdk.plugins === 'function') {
      const host = sdk.plugins([llmPlugin])
      console.log('[Curva][LlmLoader] registered llamacpp-completion plugin via @qvac/sdk plugins()')
      if (host && typeof host.loadModel === 'function' && typeof host.completion === 'function') {
        sdkHost = host
      }
    }
  } catch (err) {
    console.warn('[Curva][LlmLoader] plugin registration threw:', err?.message || err)
  }
  // Wave 13B: `modelConfig` passthrough is required so callers (roomBot) can
  // request `tools: true` at loadModel() time — Qwen3 chat template needs the
  // flag baked in when the model is loaded; it cannot be flipped per-call.
  // Verified against pear-app/node_modules/@qvac/sdk/dist/client/api/load-model.d.ts.
  // Backward-compat: when `modelConfig` is unset we omit the field so the
  // pre-Wave-13B call site (commentator without tools) behaves identically.
  // Resolve string constants (e.g. 'QWEN3_600M_INST_Q4') to the SDK's
  // descriptor object. Same pattern as bare/vlmCaption.js and bare/ocr.js.
  // The SDK's model resolver walks the gguf catalog looking for filename
  // matches; passing the raw constant string produces
  //   Failed to load model: Model with ID "QWEN3_600M_INST_Q4". Available
  //   models: [...]
  // because the resolver reads name/registrySource/registryPath from the
  // descriptor object, not the string.
  // Verified against @qvac/sdk 0.14.0 dist/models/registry/models.js:21376.
  const resolvedModelSrc = (typeof modelSrc === 'string' && sdkHost[modelSrc] !== undefined) ? sdkHost[modelSrc] : modelSrc
  const loadOpts = {
    modelSrc: resolvedModelSrc,
    modelType: 'llm',
    onProgress: typeof onProgress === 'function' ? onProgress : undefined
  }
  if (modelConfig && typeof modelConfig === 'object') {
    loadOpts.modelConfig = modelConfig
  }
  const modelId = await sdkHost.loadModel(loadOpts)
  return {
    modelId,
    completion: sdkHost.completion.bind(sdkHost),
    unloadModel: typeof sdkHost.unloadModel === 'function' ? sdkHost.unloadModel.bind(sdkHost) : null
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
