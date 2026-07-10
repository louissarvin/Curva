# Curva - Code Review Guide

Written for judges reading the repository directly. Every claim below points at
a real file, line range, command, or endpoint. If a link 404s or a grep returns
nothing, that is a bug in this document, not in the code.

- **Team**: Indonesia
- **Contact**: eternate17@gmail.com
- **Track**: Pears (primary) with WDK and QVAC cameos
- **License**: MIT
- **DoraHacks entry**: (populated on submit)
- **Video walkthrough**: (populated on submit)

---

## 1. Quick start for a reviewer (5 minutes)

Two shells. Assume a laptop with Node 20+, Bun 1.0+, and Postgres 16 available.

### Shell 1 - the Pear client

```sh
cd pear-app
npm install
npm test
```

Expected tail: `# tests = 73 pass = 73` under the brittle runner (73 test
files under `pear-app/test/`, verify with `find pear-app/test -name '*.test.js' | wc -l`).

Then boot the app itself:

```sh
DEV_WALLET_PASSCODE=curva-dev-pw npm run start
```

Expected boot log includes `wallet ready { smartAddress, ownerAddress }`,
`corestore ready`, and `swarm joined`.

### Shell 2 - the Companion backend

```sh
cd backend
cp .env.example .env
bun install
bun run db:push
bun run dev
```

Expected boot log includes `Fastify listening on http://localhost:3700` and
`Backend metrics enabled` when `ENABLE_BACKEND_METRICS=true` is set.

### Verify the four public endpoints

```sh
curl -s http://localhost:3700/health | jq
curl -s http://localhost:3700/metrics | head -20
curl -s http://localhost:3700/rag/status | jq
curl -sS -X POST http://localhost:3700/rag/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Argentina","topK":2}' | jq
```

`/health` returns `success: true`. `/metrics` returns Prometheus text format.
`/rag/status` returns the FIFA 2026 fixtures index size. `/rag/search` returns
top-K hits ranked by cosine similarity.

No manual setup beyond copying `.env.example` to `.env`.

---

## 2. Where the depth lives (grep-friendly)

Every entry points at a file range you can open in an editor. All paths are
relative to the repo root unless prefixed.

### QVAC capabilities catalog (15+)

| Capability | File | Line anchor |
|---|---|---|
| LLM completion + streaming | `pear-app/bare/commentator.js` | boot around L950 |
| Structured output (`json_schema`) | `pear-app/bare/goalCard.js` | `GOAL_CARD_SCHEMA` L45 |
| Speech-to-text (Whisper) | `pear-app/bare/commentator.js` | `WHISPER_STT_CONFIG` |
| Speech-to-text (Parakeet) | `pear-app/bare/diarization.js` | `PARAKEET_STREAMING` L50 |
| VAD (Silero) | `pear-app/bare/commentator.js` | inline in transcribeStream |
| Speaker diarization (Sortformer) | `pear-app/bare/diarization.js` | `extractSpeakerId` (see exports L471) |
| Text-to-speech (Supertonic) | `pear-app/bare/announcer.js` | `speak()` |
| Voice-cloned TTS (Chatterbox) | `pear-app/bare/voiceClone.js` | `CHATTERBOX_MODEL_SRC_KEY` L44 |
| Translation (Bergamot + pivot) | `pear-app/bare/translate.js` | `pivotMultiple` region L208-L229 |
| Language detection | `pear-app/bare/langDetectRouter.js` | `SUPPORTED_ROUTING_LOCALES` L33 |
| Text embeddings | `pear-app/bare/semanticSearch.js` | `EMBEDDINGGEMMA_300M_Q4_0` L41 |
| RAG (ingest + search) | `pear-app/bare/rag.js` | `ragSearch` docs at L344 of askTheFrame |
| VLM caption | `pear-app/bare/vlmCaption.js` | inline caption() |
| OCR | `pear-app/bare/ocr.js` | `extractScore` L321 |
| LLM MCP tool routing | `pear-app/bare/mcpTools.js` | `invokeTool` L128 |
| Delegated provider fallback | `pear-app/bare/delegatedProvider.js` | whole module |

Cross-capability orchestrators (each fans out multiple QVAC calls in one
trigger):

- `pear-app/bare/voiceCoach.js` (STT + RAG + LLM + MCP + TTS, five caps per turn) - ADR-005
- `pear-app/bare/askTheFrame.js` (VLM + RAG + LLM + MCP + TTS, five caps per `?` press)
- `pear-app/bare/goalPipeline.js` (OCR + goalCard + MCP + Bergamot + TTS + Autobase, six caps per goal) - ADR-007

### Pears primitives (13) + observability + view.checkout + sub() + encryption

| Primitive | File | Anchor |
|---|---|---|
| Hyperswarm | `pear-app/bare/swarmLifecycle.js` | `swarm.join` |
| HyperDHT | consumed transitively by Hyperswarm | see `GET /pears/status` |
| Corestore | `pear-app/bare/room.js` | `openRoom` boot region |
| Hypercore | `pear-app/bare/playhead.js`, `pear-app/bare/chat.js` | named cores |
| Hyperbee | `pear-app/bare/chat.js`, `pear-app/bare/room.js` | Hyperbee view build |
| Autobase (Pattern B) | `pear-app/bare/writerInvitation.js` | ed25519 invite - ADR-001 |
| Hyperdrive | `pear-app/bare/clips.js` | per-peer drive |
| Hyperblobs | `pear-app/bare/clips.js` | thumbnail store |
| hypercore-blob-server | `pear-app/bare/clips.js` | HTTP loopback |
| blind-peering | `pear-app/bare/blindPeering.js` | `target` per core - ADR-003 |
| keet-identity-key 3.2.0 | `pear-app/bare/keetIdentity.js` | attestation - ADR-002 |
| pear-updater | `pear-app/electron/main.js` | OTA subscribe |
| pear-electron (dual runtime) | `pear-app/electron/main.js` + `pear-app/workers/main.js` | FramedStream IPC |

Deep-cut Pears usage:

- **Observability** (hypertrace + hypertrace-prometheus + hypercore-stats +
  hyperswarm-stats + hyperdht-stats): `pear-app/bare/observability.js` L1-L100
  is a doc-verification memo citing installed package files by path and line.
  ADR-009.
- **view.checkout** for chat determinism: exercised by
  `pear-app/test/chat-checkout.test.js`.
- **sub()** on Hyperbee for room-scoped keyspaces: exercised by
  `pear-app/test/room-state-sub.test.js`.
- **Hypercore encryption** for sealed predictions: exercised by
  `pear-app/test/predictions-encryption.test.js`. ADR-008.
- **base.ack() cadence**: 2500 ms periodic ack plus post-append immediate ack
  gated on `base.ackable`. ADR-004.
- **Apply middleware chain** (observational): `pear-app/bare/lib/applyMiddleware.js`
  is wired via `attachApplyMiddleware` in `pear-app/bare/room.js:125-186`. The
  chain runs from `base.on('update')` so it never enters the reducer path,
  preserving Autobase's replay determinism contract. ADR-006.

### Prompt-injection defenses

Every LLM entry point that consumes untrusted text applies the same three
defenses. Grep to see them:

```sh
grep -n "retrieved_untrusted" pear-app/bare/*.js
grep -n "NFKC" pear-app/bare/*.js
grep -n "bidi\|zero-width\|C0/C1" pear-app/bare/*.js
```

The three anchoring files:

- `pear-app/bare/voiceCoach.js:516-530` - NFKC normalize, strip bidi/zw/BOM, wrap RAG snippets in `<retrieved_untrusted>`.
- `pear-app/bare/askTheFrame.js:83-99, 293` - same defense plus a
  `<current_frame_untrusted>` tag for the VLM caption. System prompt at L77
  explicitly forbids treating either tag as a command.
- `pear-app/bare/roomBot.js:396-408` - identical shape, used by the room bot.
- `pear-app/bare/goalPipeline.js:50-57` - `SUSPICIOUS_PREFIXES` blocklist for OCR text before it becomes an LLM prompt.

### Security audit fixes

Every audit fix in the code is tagged with a searchable comment:

```sh
grep -rn "audit fix" pear-app/bare pear-app/workers
```

Currently returns:

- `pear-app/bare/observability.js:259` (C1: hypertrace-prometheus loopback bind)
- `pear-app/bare/roomBot.js:400` (M4: strip Unicode direction/formatting)
- `pear-app/bare/voiceCoach.js:76, 240, 305, 398, 516` (H1 rate limit and M4 bidi strip)
- `pear-app/workers/main.js:962` (C1: startPrometheus is async because it binds a listener)
- `pear-app/workers/main.js:1046` (C2: ensureVoiceCoach guarded against concurrent init races)

### Documentation completeness

- **10 ADRs** in `docs/adr/`:
  1. Autobase Pattern B multi-writer
  2. Keet identity attestation
  3. Blind-peering per-core target
  4. `base.ack()` cadence
  5. Voice coach orchestration
  6. Apply middleware observational
  7. Goal pipeline fan-out
  8. Sealed predictions via Hypercore encryption
  9. Prometheus loopback federation
  10. Design tokens minimalism

  Each follows the same four-section shape (Context, Decision, Consequences,
  References). Every "Decision" section cites an installed source path with a
  `file:line` anchor.

- **ARCHITECTURE.md** at `pear-app/ARCHITECTURE.md` covers the full-system
  view, IPC contract, threat model, and cites each ADR from the relevant
  section.

- **README** at `pear-app/README.md` covers feature flags and boot commands
  including the semifinal max-out flag set.

---

## 3. What each test file proves

Grouped by concern. Every file listed exists under `pear-app/test/`.

### Autobase determinism (Pattern B, replay parity)

- `chat-determinism.test.js` - two peers replaying the same node stream produce identical view.
- `autobase-divergence.test.js` - deterministic-drop chaos middleware keeps replay identical across peers.
- `chat-checkout.test.js` - Autobase view.checkout works at arbitrary indices.
- `chat-goal.test.js` - system:goal messages linearize correctly with concurrent chat writes.
- `chat.test.js` - baseline chat reducer + Hyperbee view invariants.
- `playhead-determinism.test.js` - playhead reducer parity across replay.
- `apply-middleware.test.js` - middleware chain composition, `next()`-once guarantee, purity.

### QVAC completion behavior (SDK contract adherence)

- `voice-coach.test.js` + `integration/voice-coach-e2e.test.js` - STT + RAG + LLM + MCP + TTS turn.
- `ask-the-frame.test.js` + `integration/ask-the-frame-e2e.test.js` - VLM + RAG + LLM + TTS one-press orchestration.
- `goal-pipeline.test.js` + `integration/goal-pipeline-e2e.test.js` - OCR + goalCard + MCP + Bergamot + TTS + Autobase fan-out.
- `goal-card.test.js` - structured `json_schema` completion, additionalProperties:false discipline.
- `commentator.test.js`, `commentator-streaming.test.js`, `commentator-stt.test.js` - Qwen3 room commentator.
- `voice-clone.test.js` - Chatterbox enrolment and locale gate.
- `diarization.test.js` - Parakeet Sortformer speaker-cache lifecycle.
- `semantic-search.test.js` - embed() cosine ranking, LRU eviction.
- `translate.test.js`, `llmTranslate.test.js`, `llm-completion-polish.test.js` - Bergamot pivot and LLM polish.
- `lang-detect-router.test.js` - langdetect-text routing with confidence floor.
- `vlm-caption.test.js`, `vlm-caption-prefilter.test.js` - MobileNetV3 pre-filter skips non-match frames.
- `ocr.test.js` - scoreboard extractor for the goal pipeline.
- `announcer.test.js`, `announcer-streaming.test.js` - Supertonic TTS output.
- `mcp-tools.test.js` - MCP tool router shape and write-tool guard.
- `delegated-inference.test.js` - fallback to backend as delegated QVAC provider.
- `wave8b.test.js` - late-wave QVAC integration smoke.

### Pears primitives

- `chat-checkout.test.js` - Autobase `view.checkout()` at a specific length.
- `room-state-sub.test.js` - Hyperbee `sub()` scoped keyspaces per room concern.
- `predictions-encryption.test.js` - Hypercore encryption seals predictions until reveal.
- `blind-peering-lifecycle.test.js`, `blind-peering.test.js` - blind-peer attach/detach with explicit per-core `target`.
- `swarm-lifecycle.test.js` - Hyperswarm join, `relayThrough` fallback, teardown.
- `topics.test.js` - sha256 topic derivation stability.
- `writer-invitation.test.js` - ed25519 signed writer invitations.
- `pear-link.test.js` - `pear://` deep-link parsing.
- `keet-identity.test.js` - identity attestation shape + verify.
- `identity-proof-shapes.test.js` - proof envelope schema.
- `room-bot.test.js`, `bot-message-shapes.test.js` - roomBot MCP client + prompt-injection posture.
- `room.test.js`, `room-browser.test.js` - room lifecycle and browser view.
- `clips.test.js`, `clips-findingpeers.test.js`, `clip-blob-server.test.js` - Hyperdrive clips + Hyperblobs + loopback server.
- `demo-argv.test.js`, `demo-timeline.test.js`, `backend.test.js` - demo argv and companion contract.
- `pear-link.test.js` - pear URL parsing.
- `reader-tier.test.js` - spectator (reader-only) tier gating.

### Observability

- `observability.test.js` - installTracer + startPrometheus lifecycle, idempotency, stop().
- `observability-stats.test.js` - hypercore-stats + hyperswarm-stats + hyperdht-stats deduplication.
- `model-snapshot.test.js` - getModelSnapshot and model-log ring buffer.
- `diagnostics.test.js` - DiagnosticsPanel telemetry snapshot.

### Security (prompt-injection defense assertions)

- `integration/voice-coach-e2e.test.js`, `integration/ask-the-frame-e2e.test.js`, `integration/goal-pipeline-e2e.test.js` assert that a hostile retrieval snippet or crafted OCR text does NOT trigger MCP write tools.
- `keet-identity.test.js` verifies attestation binding so a peer cannot spoof another's writer identity.
- `voice-coach.test.js` and `ask-the-frame.test.js` include per-call rate limit assertions (H1 audit fix).

### Wallet + tips

- `tip.test.js`, `batch-tip.test.js` - EIP-712 typedData shape + facilitator POST.
- `wallet-onchain-identifier.test.js` - WDK `onChainIdentifier: 'curva'` marker.
- `wallet-semver-patch.test.js` - dependency version guard.
- `wallet-worklet.test.js` - Bare wallet worklet init.
- `x402-client.test.js` - x402 client resource pay flow.

### Attendance, predictions, tactical, branding

- `attendance.test.js`, `attendance-batch.test.js` - attendance ping cadence.
- `predictions.test.js`, `predictions-client.test.js`, `predictions-demo.test.js`, `predictions-encryption.test.js` - sealed predictions Hypercore encryption pipeline.
- `tactical-channel.test.js` - tactical side-channel routing.
- `branding-assets.test.js` - brand asset manifest.
- `rag.test.js`, `rag-lifecycle.test.js` - RAG ingest + search + workspace lifecycle.

---

## 4. Docs-first discipline evidence

Every wave-3 to wave-5 module opens with a "Docs-verification memo" that
cites the installed `.d.ts` file by path and line, and a WebFetch URL with a
`fetched YYYY-MM-DD` date. Concrete anchors:

- **completion `responseFormat` union** verified against
  `pear-app/node_modules/@qvac/sdk/dist/schemas/completion-stream.d.ts:38-50`,
  cited by `pear-app/bare/goalCard.js:7-16`.

- **`TranscribeStreamConversationSession` surface** verified against
  `pear-app/node_modules/@qvac/sdk/dist/schemas/transcription.d.ts:254`,
  cited by `pear-app/bare/voiceCoach.js:14-21`.

- **`parakeetStreamingConfig` fields** verified against
  `pear-app/node_modules/@qvac/sdk/dist/schemas/transcription-config.d.ts:120-126`,
  cited by `pear-app/bare/diarization.js:10-16`.

- **Chatterbox language set** verified against
  `pear-app/node_modules/@qvac/sdk/dist/schemas/text-to-speech.d.ts:2`,
  cited by `pear-app/bare/voiceClone.js:6-14`.

- **`embed()` overloads** verified against
  `pear-app/node_modules/@qvac/sdk/dist/client/api/embed.d.ts:13-40`,
  cited by `pear-app/bare/semanticSearch.js:10-16`.

- **`hypertrace-prometheus` is called as a function** (not `new`) verified
  against `pear-app/node_modules/hypertrace-prometheus/index.js:6`, cited by
  `pear-app/bare/observability.js:37-45`.

- **Docs URL citations** appear in every wave-3 to wave-5 module header:
  `docs.qvac.tether.io/ai-capabilities/{transcription,text-generation,rag,
  text-embeddings,multimodal,voice-assistant,text-to-speech}/`,
  `docs.pears.com/reference/building-blocks/`, and the Holepunch GitHub
  READMEs for `hypertrace`, `hypertrace-prometheus`, `hypercore-stats`,
  `hyperswarm-stats`, `hyperdht-stats`. All fetched 2026-07-10.

- **Docs-lied rejection**: Hyperdrive's `.mount()` was documented but not
  implemented in the installed package. Instead of writing a broken shim, the
  wave-3 clip Hyperdrive story ships as an operator-populated drop folder
  under `pear-app/assets/match-clips-source/`. See "What we did not build"
  below.

Every ADR's References section carries an installed source line reference
(for example, ADR-004 pins `base.ackable` at `node_modules/autobase/index.js`
by line) and a verbatim URL with a fetched date.

---

## 5. What we intentionally did NOT build

Honest list, so reviewers can focus on what shipped.

- **`hyperdb` refactor.** Skipped. Hyperbee `sub()` already covers our
  keyspace separation needs and the hyperdb schema build step would add a
  compile-time trap that pear-native Bare bundles do not yet handle
  cleanly.

- **`blind-push` FCM push notifications.** Skipped. Requires an FCM sender
  token to be embedded in the client, which is outside the peer-to-peer
  trust model. Would also require App Store review workflow.

- **BCI, video generation, image upscale, model fine-tuning.** Skipped.
  Per the QVAC SDK's own capability matrix these are off-domain for a
  football watch-party. See the QVAC docs section list.

- **Match-clip Hyperdrive auto-fill.** The `wc-reel/` drive expects an
  operator to drop MP4 files in `pear-app/assets/match-clips-source/`. This
  is companion infrastructure (a broadcaster feed), not user-generated
  content, so we did not build an in-app importer.

- **Direct `pear run` boot of the Electron shell.** The Bare P2P worker at
  `pear-app/workers/main.js` is fully Pear-native, but the Electron shell
  still boots via `electron-forge start`. Porting to `pear-electron`'s
  window API is queued for post-hackathon (see README "What is real vs
  staged" table at repo root).

- **Cross-machine NAT hole-punching at scale.** `relayThrough` fallback
  ships and works locally, but we have not stress-tested it across
  arbitrary NAT topologies.

- **Mainnet USDT settlement.** Sepolia only for the Cup submission window.

- **Signed desktop builds.** If a `.dmg` is attached to the submission it
  is unsigned. Verify the SHA-256 posted in the submission thread.

---

## 6. Feature-flag boot matrix

Judges can pick a subset for a shallow review or the full set for a deep
dive. All flags are read at boot in `pear-app/workers/main.js` and gate
the corresponding subsystem.

| Flag | Feature | Depth touched |
|---|---|---|
| `CURVA_MULTIWRITER` | Autobase Pattern B addWriter path | ADR-001 |
| `CURVA_KEET_IDENTITY_ENABLED` | keet-identity attestation on presence | ADR-002 |
| `CURVA_QVAC_COMMENTATOR_ENABLED` | Qwen3 room commentator | wave 1 |
| `CURVA_QVAC_STT_ENABLED` | Whisper Tiny + Silero VAD | wave 1 |
| `CURVA_QVAC_TTS_ENABLED` | Supertonic multilingual TTS | wave 1 |
| `CURVA_QVAC_LLM_TRANSLATE_ENABLED` | LLM polish over Bergamot pivot | wave 2 |
| `CURVA_VOICE_CLONE_ENABLED` | Chatterbox voice clone (EN/IT) | wave 3 |
| `CURVA_DIARIZE_ENABLED` | Parakeet Sortformer diarization | wave 3 |
| `CURVA_GOAL_CARD_ENABLED` | LLM structured output via `json_schema` | wave 3 |
| `CURVA_LANGDETECT_ENABLED` | Auto Bergamot pair via `@qvac/langdetect-text` | wave 3 |
| `CURVA_SEMSEARCH_ENABLED` | Semantic search via `sdk.embed()` | wave 3 |
| `CURVA_ASK_FRAME_ENABLED` | Five-cap ask-the-frame orchestrator | wave 3 |
| `CURVA_VLM_PREFILTER_ENABLED` | MobileNetV3 pre-filter | wave 4 |
| `CURVA_GOAL_PIPELINE_ENABLED` | Six-cap goal fan-out (ADR-007) | wave 4 |
| `CURVA_APPLY_MIDDLEWARE_ENABLED` | Apply middleware observer (ADR-006) | wave 4 |
| `CURVA_OBSERVABILITY_ENABLED` | hypertrace + Prometheus loopback | ADR-009 |
| `CURVA_PROMETHEUS_PORT` | Exporter port (default 4343) | ADR-009 |
| `CURVA_PREDICTIONS_ENABLED` | Sealed predictions via Hypercore encryption | ADR-008 |
| `CURVA_ATTENDANCE_ENABLED` | Attendance ping cadence | wave 2 |
| `CURVA_DELEGATED_INFERENCE_ENABLED` | Backend as fallback QVAC provider | wave 2 |
| `CURVA_TACTICAL_ENABLED` | Tactical side channel | wave 2 |
| `CURVA_DEMO_HUD_ENABLED` | Overlay HUD for the semifinal recording | demo |
| `CURVA_FORCE_RELAY=1` | Route Hyperswarm via backend `relayThrough` | dev-only |
| `CURVA_DEMO_MODE=true` | Enable demo timeline replay | demo |
| `CURVA_CHAOS_ENABLED` | Deterministic node-drop for divergence testing | ADR-006 |
| `ENABLE_BACKEND_METRICS` | Backend Prometheus federation on `/metrics` | backend |
| `ENABLE_SHARED_RAG` | FIFA 2026 fixtures RAG on `/rag/search` | backend |
| `FACILITATOR_ENABLED` | WDK EIP-3009 facilitator | backend |
| `PEAR_DISTRIBUTION_ENABLED` | `pear://` invite QR strip | backend |

**Shallow review boot** (just the P2P layer): `CURVA_MULTIWRITER=true`
plus a two-peer demo.

**Deep dive boot** (semifinal recording rig): see the "Full feature demo
(semifinal max-out)" section of `pear-app/README.md`. Every flag above
except the ones marked "off by default" is set.

---

## 7. Contact and submission

- **Team**: Indonesia
- **Contact**: eternate17@gmail.com
- **License**: MIT (see `LICENSE`)
- **DoraHacks submission**: (populated on submit)
- **Video walkthrough**: (populated on submit)
- **Pear DHT release**: `pear://hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy`

Verify the release without installing anything:

```sh
npm install -g pear
pear info pear://hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy
```

Expected output includes `name: curva`, release length, and the Hypercore +
Hyperblobs byte counts.
