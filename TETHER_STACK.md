# Curva Tether Stack Accounting

Team Indonesia · Tether Developers Cup 2026 · Semifinal Round

## Purpose

The judges' brief was explicit: "Account for the whole Tether stack. Tell us about every piece of the Tether stack you're using, even the parts outside your specific track. For each one, we want to see: why you chose it, how you've implemented it, and why you did it that way. 'We used it' scores far below 'we chose it for X, wired it in like Y, and here's the trade-off we accepted'."

This document names every Tether-stack package Curva depends on, cites the version pinned in `pear-app/package.json` or `backend/package.json`, links to the exact wire-in point, and states the trade-off honestly.

Versions cited are the values in `pear-app/package.json` (semver caret) at commit `517cff080a013ec94dece86c02a35821cab7e726`. Where a package is fetched transitively (no top-level pin), the entry says "transitive via <parent>".

Sections:

1. Pears (Holepunch) primitives
2. QVAC on-device AI capabilities
3. WDK (cameo track — honest scope)

---

## 1. Pears (Holepunch)

Curva is primarily a Pears track submission. The stack breakdown below covers thirteen packages; the eight in the summary table are the load-bearing ones, and the five below the table are supporting instrumentation.

### 1.1 Summary table

| Package | Version | Role in Curva |
|---|---|---|
| `hyperswarm` | ^4.17.0 | Peer discovery on `sha256("curva/<slug>")` |
| `corestore` | ^7.11.0 | Per-room store, replication multiplexer |
| `hypercore` | transitive via autobase | Playhead + chat writers + sealed-prediction epochs |
| `hyperbee` | ^2.27.3 | Chat view + roomState with `sub()` namespaces |
| `autobase` | ^7.28.1 | Pattern B multi-writer chat + playhead |
| `hyperdrive` | ^13.3.2 | Per-peer clip filesystem |
| `hyperblobs` | ^2.12.1 | Clip thumbnails |
| `hypercore-blob-server` | ^1.15.0 | HTTP range serve for local clip playback |
| `blind-peering` | ^2.4.0 | Companion attachment for offline persistence |
| `keet-identity-key` | ^3.2.0 | Portable-device identity attestation |
| `hypertrace` | ^1 | Trace-counter instrumentation on every subsystem |
| `hypertrace-prometheus` | ^1 | Prometheus exporter (bound loopback-only) |
| `pear-runtime` | ^1.3.1 | The runtime shell that hosts the app |

Transitive stats packages (`hypercore-stats`, `hyperswarm-stats`, `hyperdht-stats`) are loaded dynamically in `observability.js` for gauge families.

### 1.2 hyperswarm

- **Where it lives**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/room.js
- **Why we chose it**: We needed peer discovery without a coordinator. Alternatives (libp2p, WebRTC + signaling) either force a signaling server (kills "no server" claim) or bring a bigger runtime for a smaller feature set.
- **How we wired it**: Every room joins the topic `sha256("curva/<slug>")` (canonical topic derivation per the Hyperswarm docs). Boot code passes `CURVA_FORCE_RELAY=1` in the demo path so hole-punching falls back to DHT relay when the LAN is unfriendly.
- **Trade-off we accepted**: Room slug is trivially guessable, so we defend the room at the writer-invitation layer (see `writerInvitation.js`) rather than at discovery. Any peer can dial in; only invited peers become writers.

### 1.3 HyperDHT (transitive)

- **Where it lives**: Used by hyperswarm; surfaced through `keyPair`/`relayThrough` in room boot.
- **Why we chose it**: Hyperswarm's DHT layer is what makes zero-server operation credible. HyperDHT hole-punching + `relayThrough` is a full fallback ladder.
- **How we wired it**: `relayThrough` is set when `CURVA_FORCE_RELAY=1` is in env so we can prove the fallback path in the demo.
- **Trade-off we accepted**: `relayThrough` mode is measurably slower than direct hole-punching. We only enable it for demo determinism.

### 1.4 Corestore

- **Where it lives**: `pear-app/bare/room.js` (room bootstrap creates a per-room corestore rooted at the pear data directory).
- **Why we chose it**: Autobase and every Hypercore in Curva need to share a replication pipe; corestore is the canonical multiplexer.
- **How we wired it**: One corestore per room, namespaced by slug. Chat autobase, playhead autobase, roomState hyperbee, clips hyperdrive all live in the same store so `store.replicate()` handles all of them.
- **Trade-off we accepted**: Namespacing by slug means room storage is not shared across rooms even if the same peer joins many rooms. We chose isolation over reuse.

### 1.5 Hypercore

- **Where it lives**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/predictions.js#L31 and https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/tacticalChannel.js#L28
- **Why we chose it**: We needed append-only signed logs both inside Autobase (for chat and playhead) and as standalone encrypted epochs for sealed predictions.
- **How we wired it**: For sealed predictions, we open a per-epoch Hypercore with `encryptionKey: deriveSealKey({slug, epoch, hostSecret})` (BLAKE2b-256 via `hypercore-crypto.hash()`), so the epoch is opaque to peers until reveal time. See `pear-app/bare/predictions.js#L835-L870`.
- **Trade-off we accepted**: Encryption key rotation is per-epoch, not per-message. If the host secret leaks, every past epoch under that secret decrypts.

### 1.6 Hyperbee

- **Where it lives**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/room.js#L324-L365 (roomState + sub namespaces)
- **Why we chose it**: We needed range queries (`chat/<seq>`, `writers/<hex>`, `providers/<pubkey>`) with cheap prefix reads. Plain Hypercore reads would be O(n).
- **How we wired it**: `roomState.sub('room' | 'qvac' | 'providers' | 'presence')` gives four byte-prefixed namespaces over one Hyperbee. `readRoomKey()` falls back to the legacy flat prefix so old peers still read.
- **Trade-off we accepted**: We accepted a migration window where both sub and flat prefix are read. This costs one extra get() per read until every peer has migrated.

### 1.7 Autobase

- **Where it lives**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/chat.js#L234-L318 (apply reducer) and https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/room.js#L698-L961 (Pattern B addWriter plumbing)
- **Why we chose it**: Chat is bidirectional and needs deterministic linearization across all writers. Autobase's Pattern B (host-controlled `addWriter` via control-block append) is exactly this. Alternative: rolling our own CRDT. We rejected because Autobase already handles rebase safety.
- **How we wired it**:
  - apply() is PURE and rebase-safe (memo at `chat.js:234`).
  - `attachApplyMiddleware(chat, {slug})` attaches audit + system-guard middleware OUTSIDE the reducer via `base.on('update')`, so the reducer stays deterministic.
  - Ack cadence: 30 s background loop + post-append fire (see `startAckLoop` and `appendThenAck`).
  - `checkoutAt(v)` returns a read-only snapshot for chat scrubbing.
- **Trade-off we accepted**: Pattern B means only the host can promote writers. Losing the host's device without a backup mnemonic bricks writer promotions. We accepted this over Pattern A (auto-promote on presence) because Pattern A opens the room to any peer that dials in.

### 1.8 Hyperdrive

- **Where it lives**: Referenced in `pear-app/bare/clips.js` (per-peer clip filesystem).
- **Why we chose it**: Clips are big; we want a filesystem, not raw blocks. Hyperdrive gives us `put(path, buffer)` + range reads.
- **How we wired it**: Each peer owns a hyperdrive at `<store>/clips/<peerKeyHex>/`. Clip index Hyperbee stores `(clipId -> peerKeyHex + path)`. Playback reads via `hypercore-blob-server`.
- **Trade-off we accepted**: One hyperdrive per peer means a peer with 1000 clips has 1000 entries; we chose that over one shared drive to avoid write contention.

### 1.9 Hyperblobs

- **Where it lives**: `pear-app/bare/clips.js`.
- **Why we chose it**: Thumbnails are content-addressed image blobs, not filesystem entries. Hyperblobs is the canonical way.
- **How we wired it**: Each clip's thumbnail JPEG is stored as a hyperblob; the clip index Hyperbee stores the blob id.
- **Trade-off we accepted**: A missing thumbnail cannot be regenerated on-demand from the video without recomputing on peer B. We ship thumbnails eagerly.

### 1.10 hypercore-blob-server

- **Where it lives**: `pear-app/bare/clips.js` (clip playback HTTP server).
- **Why we chose it**: The renderer needs HTTP range requests on clip payloads so `<video>` can seek. Hypercore natively cannot do that.
- **How we wired it**: One `BlobServer` per peer, bound to loopback, serving all local hyperdrives. Renderer plays clips at `http://127.0.0.1:<port>/...`.
- **Trade-off we accepted**: The HTTP server is loopback-only, so the browser can play clips but remote peers cannot fetch them directly. That is by design; remote fetch goes through blind-peering.

### 1.11 blind-peering

- **Where it lives**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/blindPeering.js#L217-L305
- **Why we chose it**: Watch parties happen while friends are offline. Blind peering keeps someone's chat and clips replicated to a companion peer even after the host closes the laptop. Alternative: keeping the app on all the time (unfriendly).
- **How we wired it**: We pass an explicit `target` per base (`auto.wakeupCapability.key`) and per core (`core.key`), rather than relying on the package's default. Suspend/resume are wired to the Pear teardown path so blind peering does not leak workers on close.
- **Trade-off we accepted**: We pay a small extra dial cost by pinning the target explicitly. We chose that over silent breakage in a future `blind-peering` release that might change the default.

### 1.12 keet-identity-key

- **Where it lives**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/keetIdentity.js#L353-L400
- **Why we chose it**: We want portable identity across devices without a coordinator. `keet-identity-key` gives us an identity keypair + per-device subkey with a stateless verifier.
- **How we wired it**: `verifyPeerProof(proof, attestedData)` runs on every presence beacon; when it returns `ok`, the chat renders a green shield next to the peer name.
- **Trade-off we accepted**: If the peer's device attests but their identity keypair is compromised, the shield still shows green. We surface identity but do not gate authorization on it (roomState writer roster is what actually gates writes).

### 1.13 hypertrace + hypertrace-prometheus + stats packages

- **Where it lives**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/observability.js#L241-L385
- **Why we chose it**: We wanted production-grade counters, not `console.log`. Hypertrace is the Holepunch-native way, and hypertrace-prometheus turns it into `/metrics`.
- **How we wired it**: `startPrometheus()` binds an HTTP server explicitly to `127.0.0.1:<port>` (not `0.0.0.0`). `hypercore-stats`, `hyperswarm-stats`, `hyperdht-stats` are loaded dynamically and registered so their gauges surface too.
- **Trade-off we accepted**: Loopback-only means no LAN scrape from another peer. That is the point (security). Federation happens via the backend companion; each peer opts in.

### 1.14 pear-runtime

- **Where it lives**: `pear-app/electron/main.js` (spawns the runtime); `pear-app/package.json` declares `pear-runtime@^1.3.1`.
- **Why we chose it**: Pear is the whole distribution story. We ship via `pear seed dev .`; users install via `pear run pear://<key>`.
- **How we wired it**: Following the `holepunchto/hello-pear-electron@1.0.0` template. See `pear-app/ARCHITECTURE.md` for the electron -> workers -> bare -> renderer wire.
- **Trade-off we accepted**: Pear updater OTA path is documented but our production release cadence still relies on `pear stage` + `pear release`, so a mis-published stage cannot be silently rolled back.

---

## 2. QVAC on-device AI

Every capability below runs on-device via `@qvac/sdk@^0.14.0`. No fallback to a cloud API. The registry entries are pinned in `backend/src/data/qvac-models.json` with the SDK's registry constants where applicable.

### 2.1 Summary table

| Capability | SDK entrypoint | Wire-in file |
|---|---|---|
| Bergamot NMT (translation) | `@qvac/sdk` translate + langdetect routing | `pear-app/bare/translate.js`, `pear-app/bare/llmTranslate.js` |
| Qwen3 LLM (commentator + roomBot + voice coach + ask-frame + goal pipeline) | `completion` streaming + `json_schema` mode | `pear-app/bare/commentator.js`, `roomBot.js`, `voiceCoach.js`, `askTheFrame.js`, `goalCard.js` |
| Whisper Tiny STT | `whisperConfigSchema` + VAD Silero 5.1.2 | `pear-app/bare/voiceCoach.js`, `pear-app/bare/diarization.js` |
| Supertonic multilingual TTS | streaming synthesis | `pear-app/bare/announcer.js` |
| Chatterbox voice cloning (EN/IT only) | `voiceClone` API | `pear-app/bare/voiceClone.js` |
| Llama-3.2 (commentator streaming) | `contentDelta` + `thinkingDelta` + `completionStats` | `pear-app/bare/commentator.js` |
| SmolVLM2 500M (VLM captioning) + mmproj | multimodal `completion` | `pear-app/bare/vlmCaption.js` |
| MobileNetV3 pre-filter | `sdk.classify({modelId, image, topK})` | `pear-app/bare/vlmCaption.js#L234-L275` |
| OCR_LATIN | two-stage CRAFT + Latin recognizer | `pear-app/bare/ocr.js` |
| Parakeet CTC 0.6B (English fallback STT) | streaming partials | `pear-app/bare/diarization.js` |
| EmbeddingGemma-300M-Q4 (RAG + semantic search) | `ragIngest` + `ragSearch` + `embed` | `pear-app/bare/rag.js`, `pear-app/bare/semanticSearch.js`, `backend/src/lib/qvac/sharedRag.ts` |
| MCP tool calling | in-process McpClient shape | `pear-app/bare/mcpTools.js` |
| Delegated inference | `startQVACProvider` + firewall + `loadModel({delegate})` | `backend/src/lib/qvac/delegatedProvider.ts`, `pear-app/bare/delegatedProvider.js` |
| Streaming TTS + kvCache + reasoning_budget + remove_thinking_from_context | streaming pipeline | `pear-app/bare/announcer.js`, `pear-app/bare/commentator.js` |
| RAG workspace lifecycle | ragChunk + ragReindex + ragCloseWorkspace + ragDeleteWorkspace | `pear-app/bare/rag.js#L105-L165` |
| `@qvac/langdetect-text` auto Bergamot routing | language detection -> pivot pair | `pear-app/bare/langDetectRouter.js` |

### 2.2 Bergamot NMT

- **Package**: `@qvac/sdk@^0.14.0` (Bergamot models pulled per language pair).
- **Where it lives**: `pear-app/bare/translate.js`
- **Why we chose it**: On-device translation with no data egress. Alternative (Google Translate API) fails the "no servers" property.
- **How we wired it**: `translate({from, to, text})` uses installed language pairs. EN-hub pivot for IT<->ID / IT<->EN / EN<->ID via `modelConfig.pivotModel` per the SDK plugin schema.
- **Trade-off we accepted**: Bergamot's language coverage is smaller than a cloud translator. We support EN, IT, ID (the target audience) and pivot elsewhere.

### 2.3 Qwen3 LLM (multi-purpose)

- **Package**: `@qvac/sdk` (Qwen3 GGUF from the registry).
- **Where it lives**: Voice coach, roomBot, ask-the-frame, goalCard parser.
- **Why we chose it**: Qwen3 supports MCP tool calling + `json_schema` structured output, which are the two features we depend on most.
- **How we wired it**: One shared `sharedLlmHandle` (constructed at boot) is passed to every consumer so we do not reload the model. `json_schema` mode with a frozen schema for goalCard, `contentDelta` streaming for the commentator.
- **Trade-off we accepted**: Qwen3 is memory-heavy. On a 8GB device we can only load one LLM at a time; commentator and voice coach share.

### 2.4 Whisper Tiny STT

- **Package**: `@qvac/sdk` (Whisper Tiny GGML + VAD Silero 5.1.2).
- **Where it lives**: `pear-app/bare/voiceCoach.js` and `pear-app/bare/diarization.js`
- **Why we chose it**: Streaming STT with VAD gives us end-of-turn detection for the push-to-talk coach. Alternative (Web Speech API) needs a cloud round-trip.
- **How we wired it**: `whisperConfigSchema.vadModelSrc = VAD_SILERO_5_1_2`; VAD tuned per voice-assistant docs (threshold 0.6, min_speech 300 ms, min_silence 700 ms).
- **Trade-off we accepted**: Whisper Tiny is less accurate than Whisper Base. We chose speed over accuracy for the push-to-talk flow.

### 2.5 Supertonic Multilingual TTS

- **Package**: `@qvac/sdk` (Supertonic multilingual Q8_0).
- **Where it lives**: `pear-app/bare/announcer.js`
- **Why we chose it**: On-device streaming TTS in EN/IT/ID (our target audience). Alternative (cloud TTS) fails the on-device property.
- **How we wired it**: Streaming pipeline that emits audio chunks as they synthesize; announcer plays via WebAudio in the renderer.
- **Trade-off we accepted**: First-token latency is higher than a cloud TTS. We hide this behind a "thinking" indicator.

### 2.6 Chatterbox voice cloning

- **Package**: `@qvac/sdk` (Chatterbox model).
- **Where it lives**: `pear-app/bare/voiceClone.js`
- **Why we chose it**: Personal announcer voice makes the watch-party feel like your friends' voices. Alternative (cloud voice clone) is a privacy nightmare.
- **How we wired it**: Clone from a 10-second sample recorded in the app; store the voice profile locally.
- **Trade-off we accepted**: Chatterbox currently supports EN and IT only. ID voice cloning is on the roadmap but not shipped. We call this out honestly in the UI.

### 2.7 Llama-3.2 commentator (streaming)

- **Package**: `@qvac/sdk` (Llama-3.2 GGUF).
- **Where it lives**: `pear-app/bare/commentator.js`
- **Why we chose it**: Smaller than Qwen3, streaming-optimized. Good enough for narration-style commentary on 60-second ticks.
- **How we wired it**: `contentDelta`, `thinkingDelta`, `completionStats` all surfaced in the UI; kvCache session key means sub-100ms time-to-first-token per tick after warmup.
- **Trade-off we accepted**: Llama-3.2 does not do MCP tool calling as reliably as Qwen3. We accept that; commentator is monologue only.

### 2.8 SmolVLM2 500M + mmproj

- **Package**: `@qvac/sdk` (SmolVLM2 500M Video-Instruct GGUF Q8_0 + matching mmproj).
- **Where it lives**: `pear-app/bare/vlmCaption.js`
- **Why we chose it**: The only on-device VLM at ~500 MB that captions football scenes coherently. Alternatives (LLaVA-1.5) are 4x bigger.
- **How we wired it**: We caption a paused frame via `sdk.completion` with the projection model. Caption goes into chat as `system:vlm-caption` and into the ask-the-frame RAG workspace.
- **Trade-off we accepted**: First download is ~521 MB. We fall back to text-only ask-the-frame if the model is not yet cached.

### 2.9 MobileNetV3 pre-filter

- **Package**: `@qvac/sdk` (bundled MobileNetV3-Small via `@qvac/classification-ggml`).
- **Where it lives**: `pear-app/bare/vlmCaption.js#L234-L275`
- **Why we chose it**: Running SmolVLM2 on every paused frame is expensive. MobileNetV3 gates it in ~50ms.
- **How we wired it**: `preFilter(imageBuffer)` runs `sdk.classify({modelId, image, topK: PREFILTER_TOP_K})` and decides whether the frame is worth handing to SmolVLM2. Fails open on any classifier error (correctness over cost).
- **Trade-off we accepted**: Fail-open means a broken classifier is silently ignored. We accept that because the pre-filter is a cost saver, not a correctness gate.

### 2.10 OCR_LATIN

- **Package**: `@qvac/sdk` (registry constant `OCR_LATIN`).
- **Where it lives**: `pear-app/bare/ocr.js`
- **Why we chose it**: Reading jersey numbers and scoreboards on-device. Two-stage (CRAFT text detection + Latin recognizer) handles rotated jerseys via `defaultRotationAngles`.
- **How we wired it**: `sdk.ocr({image})` returns blocks with confidence. `extractScore(blocks)` is a regex that turns `"MAN 2 - 1 LIV"` into `{home: 2, away: 1}`.
- **Trade-off we accepted**: Latin-only. Arabic and CJK jerseys are out of scope; we skip those matches.

### 2.11 Parakeet Sortformer (English fallback STT)

- **Package**: `@qvac/sdk` (Parakeet CTC 0.6B GGML Q8_0).
- **Where it lives**: `pear-app/bare/diarization.js`
- **Why we chose it**: Whisper Tiny plus VAD is our default, but on English-only rooms with tight RAM, Parakeet is smaller and streams partials at 1s chunks.
- **How we wired it**: Loaded only when Whisper is unavailable or the room language is EN.
- **Trade-off we accepted**: Parakeet is English-only. We do not attempt multilingual coverage from it.

### 2.12 EmbeddingGemma 300M Q4 (RAG + semantic search)

- **Package**: `@qvac/sdk` (`ragIngest` + `ragSearch` + `embed` APIs).
- **Where it lives**: `pear-app/bare/rag.js` (per-peer) and `backend/src/lib/qvac/sharedRag.ts` (companion-shared WC26 fixtures).
- **Why we chose it**: We wanted true RAG (not "prompt stuffing") for voice coach, ask-the-frame, and the shared WC26 fixtures. EmbeddingGemma is small enough to co-load with Qwen3.
- **How we wired it**: Debounced reindex bookkeeping per workspace (`REINDEX_INGEST_THRESHOLD` + `REINDEX_DEBOUNCE_MS`); timers cleared on `close()` so stray reindexes cannot fire against a closed workspace. Backend shares WC26 fixtures via the companion.
- **Trade-off we accepted**: HyperDB requires >= 16 docs before reindex is meaningful. We degrade `reindexed:false` with a reason until the workspace crosses the threshold.

### 2.13 MCP tool calling

- **Package**: `@qvac/sdk` MCP adapter shape.
- **Where it lives**: `pear-app/bare/mcpTools.js`
- **Why we chose it**: Turning the LLM into an on-device agent. Alternative (function calling only) is coupled to a specific model.
- **How we wired it**: In-process McpClient shape `{listTools, callTool}`. Tool schema derived straight off `listTools()` output. Backend exposes room MCP tools; peer exposes local tools.
- **Trade-off we accepted**: In-process only. We do not expose the MCP surface over the swarm because that would require the tool sender to trust the room.

### 2.14 Delegated inference (P2P GPU sharing)

- **Package**: `@qvac/sdk` `startQVACProvider` + `loadModel({delegate})`.
- **Where it lives**: `backend/src/lib/qvac/delegatedProvider.ts#L1-L313` and `pear-app/bare/delegatedProvider.js`.
- **Why we chose it**: A peer with a strong GPU can serve a peer with a weak one. Real P2P inference, no cloud.
- **How we wired it**: `startQVACProvider({firewall: {mode: 'allow', publicKeys: [...]}}`. Provider refuses to start if allow-list is empty (unless `QVAC_FIREWALL_MODE=allow-all` is explicitly set). Peer advertises pubkey in Hyperbee; consumer calls `loadModel({delegate: providerPublicKey})`; streaming events still flow via the DHT.
- **Trade-off we accepted**: A malicious provider could theoretically return garbage tokens. We do not have integrity attestation on delegated inference yet; trust is at the friendship layer.

### 2.15 Streaming knobs (kvCache + reasoning_budget + remove_thinking_from_context)

- **Where it lives**: `pear-app/bare/commentator.js` and `pear-app/bare/announcer.js`.
- **Why we chose it**: Every millisecond of first-token latency shows on camera. kvCache session keying halves the warmup cost per tick. `reasoning_budget` bounds the thinking phase. `remove_thinking_from_context` keeps successive turns tight.
- **How we wired it**: `deleteCache` on room close so the kv is not leaked between rooms.
- **Trade-off we accepted**: kvCache is per-session; a peer switching rooms starts cold on the new one.

### 2.16 langdetect-text -> Bergamot routing

- **Package**: `@qvac/langdetect-text` (transitive via SDK).
- **Where it lives**: `pear-app/bare/langDetectRouter.js`
- **Why we chose it**: We need to auto-route translation without asking the user "what language is this?".
- **How we wired it**: Detect on incoming chat text; look up the installed pair; pivot via EN hub if the direct pair is not installed.
- **Trade-off we accepted**: Very short strings (< 8 chars) are unreliable to detect; we skip translation on those.

---

## 3. WDK (cameo — honest scope)

Curva is primarily a Pears + QVAC submission. WDK is a cameo, but every piece we ship is real and provable on Sepolia.

### 3.1 Summary table

| Package | Version | Role |
|---|---|---|
| `@tetherto/wdk` | ^1.0.0-beta.12 | Umbrella meta-package |
| `@tetherto/wdk-wallet-evm-erc-4337` | ^1.0.0-beta.10 | Safe smart account + Candide bundler fallback |
| `@tetherto/wdk-secret-manager` | ^1.0.0-beta.3 | PBKDF2 + XSalsa20-Poly1305 seed encryption |

### 3.2 @tetherto/wdk (meta)

- **Where it lives**: `pear-app/bare/wallet/`
- **Why we chose it**: Curva ships a wallet inside the app so tipping requires no external wallet install. WDK is the Tether-native way.
- **How we wired it**: The bare worker (`pear-app/bare/wallet/worklet.js`) imports the wallet factory and constructs it with the object-form `onChainIdentifier: {name: 'curva', version: '0.1.0'}` so any WDK-instrumented telemetry can attribute usage back to us.
- **Trade-off we accepted**: We bind our wallet to a specific WDK beta line, so beta churn can break our boot. We accept that as a cost of being on the frontier.

### 3.3 @tetherto/wdk-wallet-evm-erc-4337

- **Where it lives**: `pear-app/bare/wallet/eip3009.js` (EIP-3009 primary path) and `pear-app/bare/wallet/worklet.js` (Safe smart-account boot).
- **Why we chose it**: Two paths: EIP-3009 (peer signs authorization off-chain, backend facilitator submits and pays gas) for the primary tip flow, and ERC-4337 Safe smart-account via Candide bundler as fallback for chains that do not support EIP-3009.
- **How we wired it**:
  - EIP-3009: peer's WDK signs `transferWithAuthorization`; backend `facilitatorRoutes.ts` submits it and pays gas. Marker on-chain uses the `onChainIdentifier: 'curva'` string (see `pear-app/bare/wallet/eip3009.js#L34-L57`).
  - ERC-4337 fallback: Safe smart account + Candide bundler for chains without EIP-3009.
- **Trade-off we accepted**: Our token is a **USDT-branded EIP-3009 token on Sepolia**, not real mainnet USDT. This is honest: cup rules disallow real mainnet spend, and Sepolia has no real USDT. We deploy a compatible ERC-20 with the EIP-3009 extension so the code path is identical to the mainnet version we would ship at production.

### 3.4 @tetherto/wdk-secret-manager

- **Where it lives**: `pear-app/bare/wallet/worklet.js` (seed storage).
- **Why we chose it**: PBKDF2 + XSalsa20-Poly1305 is the WDK-native way to store seeds. Alternative (raw file + OS keychain) is platform-specific and less portable.
- **How we wired it**: User password derives the KDF; the encrypted seed lives inside the pear data directory.
- **Trade-off we accepted**: If the user forgets their password, the seed is unrecoverable. This is a feature (no backdoor) but a bad UX; we compensate with a recovery-phrase export.

### 3.5 EIP-3009 primary tip path

- **Where it lives**: `pear-app/bare/wallet/eip3009.js`
- **Why we chose it**: Gasless tips. The tipper does not need ETH. This matches the WDK philosophy of "money-native UX" for a watch-party.
- **How we wired it**: Peer signs an authorization off-chain; backend `facilitatorRoutes.ts` submits it via the sponsor treasury and takes the gas hit.
- **Trade-off we accepted**: The backend must have gas. If the sponsor treasury dries up, tips queue. We surface treasury state in `curl localhost:3700/pears/status`.

### 3.6 ERC-4337 fallback via Candide bundler

- **Where it lives**: `pear-app/bare/wallet/worklet.js`
- **Why we chose it**: For chains where EIP-3009 is not available, ERC-4337 Safe smart account + Candide bundler is the account-abstraction path.
- **How we wired it**: Same WDK wallet factory; different `chainId` triggers the ERC-4337 branch. `onChainIdentifier: 'curva'` marker still surfaces on the bundler side.
- **Trade-off we accepted**: The two paths have different UX (single sign vs userOp signing) and different failure modes. We route by chain, not by user preference.

### 3.7 USDT-branded EIP-3009 Sepolia token

- **Where it lives**: `contracts/` (Foundry project).
- **Why we chose it**: Real mainnet USDT is not available on Sepolia. Rather than skip the WDK track entirely, we deploy a USDT-branded ERC-20 with the EIP-3009 extension so the code path is 1:1 with what mainnet ship would look like.
- **How we wired it**: Standard OpenZeppelin `ERC20Permit` + EIP-3009 extension; deployed on Sepolia; contract address wired into `backend/src/config/main-config.ts`.
- **Trade-off we accepted**: It is not real USDT. It is a USDT-branded testnet token. We are explicit about this in the video and in the DoraHacks details. The wire-in code (WDK + facilitator + on-chain marker) is real.

---

## Closing note

If a judge scrubs `pear-app/package.json` or `backend/package.json`, everything above should reconcile against the pinned versions at commit `517cff080a013ec94dece86c02a35821cab7e726`. Anything we omitted is not shipping; anything we shipped is documented here with why + how + trade-off.

See also: `PERMALINKS.md` for exact file:line links to the code, and `docs/adr/` for the ten architecture decision records.
