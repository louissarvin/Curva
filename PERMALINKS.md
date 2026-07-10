# Curva Permalinks — Commit-Pinned Code Review Guide

Team Indonesia · Tether Developers Cup 2026 · Semifinal Round

## How to use this document

Every link below is pinned to a specific commit hash on `github.com/louissarvin/Curva`. GitHub freezes the file to that commit, so the exact line numbers cited will never drift even if `main` moves on.

Click any permalink, land on the exact block, verify the claim. A judge should be able to walk this document in five minutes and see every high-value decision Curva shipped.

- Repository: https://github.com/louissarvin/Curva
- HEAD at documentation freeze: `517cff080a013ec94dece86c02a35821cab7e726`
- All 12 commits on `main` are pushed and permalink-safe.
- See also: `CODE_REVIEW.md` (companion narrative), `TETHER_STACK.md` (per-package rationale), and `docs/adr/` (10 architecture decision records).

Sections:

1. Pears architecture depth (Pattern B, apply purity, ack cadence, view.checkout, sub() namespacing, sealed cores, apply middleware, keet-identity, blind-peering, divergence test)
2. QVAC breadth (voice coach 5-cap, goal pipeline 6-cap, ask-the-frame injection defense, RAG lifecycle, MobileNetV3 pre-filter, structured-output goal card, delegated inference, shared WC26 RAG)
3. Observability (Prometheus loopback bind)
4. Architecture Decision Records (ADRs 001-010)
5. Top-level architecture doc

---

## 1. Pears architecture depth

### 1.1 Autobase Pattern B addWriter (host-side control block)

- **What it is**: Host appends `{addWriter, indexer:true}` control blocks to the chat autobase; every reducer promotes writers deterministically via `host.addWriter()`.
- **Why click here**: This is the canonical Pattern B multi-writer flow from the Autobase README, wired end-to-end with rate limiting so a compromised host cannot brick the base by flooding writer promotions.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/room.js#L698-L961
- **Related test**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/test/autobase-divergence.test.js#L1-L240
- **Related ADR**: `docs/adr/001-autobase-pattern-b-multi-writer.md`

### 1.2 Chat apply() purity + writer promotion inside the reducer

- **What it is**: The chat reducer honours `{addWriter}` control blocks, but rejects any addWriter forged by a non-host writer, and stays PURE so rebases converge.
- **Why click here**: Look at the "apply() is PURE" memo at line 234 and the host-only addWriter gate right below it. This is what makes ADR-001 real.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/chat.js#L234-L318
- **Related ADR**: `docs/adr/001-autobase-pattern-b-multi-writer.md`

### 1.3 base.ack() cadence — background loop + post-append fire

- **What it is**: `startAckLoop(base, label)` and `appendThenAck(base, appendFn, label)` combine into the ack strategy documented in ADR-004.
- **Why click here**: Two hooks together give sub-second linearization without spamming the network. The 30 s background interval plus a post-append best-effort ack matches what Autobase asks for in its `docs/writer-management.md`.
- **Permalink (loop)**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/room.js#L74-L94
- **Permalink (post-append)**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/room.js#L100-L111
- **Related ADR**: `docs/adr/004-base-ack-cadence.md`

### 1.4 Autobase view.checkout(v) — read-only chat scrubber

- **What it is**: `checkoutAt(version)` takes a positive integer version, returns a read-only snapshot with a `refuseWrite` guard on any mutation attempt.
- **Why click here**: This is how Curva ships a time-travel chat scrubber without breaking Autobase's linearizer. Snapshot is a real `base.view.checkout(v)`, not a materialized copy.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/chat.js#L697-L735

### 1.5 Hyperbee sub() namespacing — four subs on one bee

- **What it is**: `roomState.sub('room' | 'qvac' | 'providers' | 'presence')` gives us four byte-prefixed namespaces over one Hyperbee, with a `readRoomKey()` migration helper that falls back to the legacy flat prefix.
- **Why click here**: Live migration path, not a fresh design. Old peers still read; new peers write to the sub.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/room.js#L324-L365

### 1.6 Hypercore-encrypted sealed predictions (BLAKE2b-256 key derivation)

- **What it is**: `deriveSealKey({slug, epoch, hostSecret})` derives a 32-byte encryption key via BLAKE2b-256 for a per-epoch Hypercore that seals predictions until reveal time.
- **Why click here**: Namespace-scoped key derivation, epoch and slug validation, minimum host-secret entropy check. Real key hygiene.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/predictions.js#L835-L870
- **Related ADR**: `docs/adr/008-hypercore-sealed-predictions.md`

### 1.7 Apply middleware — composeApply pattern

- **What it is**: `composeApply(middlewares)` is the koa-style middleware composer that returns an `apply(nodes, view, host)` callable. Multiple-`next()` guards throw `MiddlewareMustCallNext`.
- **Why click here**: This is the mechanism behind ADR-006. Middlewares run OUTSIDE the real reducer as observers (audit sink, system-message guard, terminal no-op) so apply() stays deterministic.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/lib/applyMiddleware.js#L80-L110
- **Related ADR**: `docs/adr/006-apply-middleware-observational.md`

### 1.8 Apply middleware wire-in — observational path attached to chat base

- **What it is**: `attachApplyMiddleware(chat, {slug})` reads `CURVA_APPLY_MIDDLEWARE_ENABLED`, composes an audit + system-guard + terminal chain, and attaches it to `base.on('update', ...)`. Never runs inside apply().
- **Why click here**: Observation without mutation. If the flag is off it is a total no-op; if on, the audit sink bounds itself to a 256-event ring.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/room.js#L125-L187
- **Related ADR**: `docs/adr/006-apply-middleware-observational.md`

### 1.9 keet-identity verifyPeerProof — portable-device attestation

- **What it is**: Stateless verifier that takes `(proof, attestedData)` and returns `{ok, identityPublicKeyHex, devicePublicKeyHex}` or `{ok:false}`. All inputs coerced defensively.
- **Why click here**: Verified against installed source at `pear-app/node_modules/keet-identity-key/index.js:138-193`. Hex validation, buffer coercion, try/catch swallow. This is what makes the green shield in Chat trustworthy.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/keetIdentity.js#L353-L400
- **Related ADR**: `docs/adr/002-keet-identity-attestation.md`

### 1.10 blind-peering registerAutobase + registerCore + suspend/resume

- **What it is**: Companion-attachment layer. Passes an explicit `target` per base and per core (not relying on the package default), plus a suspend/resume path wired to Pear teardown.
- **Why click here**: Rate-limited on discovery key, target computed via `auto.wakeupCapability.key` explicitly. Also see the suspend/resume block at 349-380.
- **Permalink (autobase register)**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/blindPeering.js#L217-L260
- **Permalink (core register)**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/blindPeering.js#L275-L305
- **Permalink (suspend/resume)**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/blindPeering.js#L343-L380
- **Related ADR**: `docs/adr/003-blind-peering-target-strategy.md`

### 1.11 Autobase divergence + reorder resilience test

- **What it is**: Two in-process corestores wired via `base.replicate()`, interleaved sends, causal reordering, assertion that both chats' observable histories deep-equal.
- **Why click here**: This is the flagship correctness test for ADR-001. Uses `wakeupProtocol.addStream` under the hood via `base.replicate()` so heads propagate.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/test/autobase-divergence.test.js#L1-L240

---

## 2. QVAC breadth

### 2.1 Voice coach — 5-capability orchestration (STT + RAG + LLM + MCP + TTS)

- **What it is**: `createVoiceCoach(opts)` returns a factory that runs Whisper -> RAG grounding -> Qwen3 LLM (with MCP tools available) -> Supertonic TTS, replicating both transcript and answer through chat.
- **Why click here**: One push-to-talk turn touches five QVAC capabilities. The block at 511-540 is the RAG-hit sanitizer (NFKC + bidi + zero-width strip) and the `<retrieved_untrusted>` tagging that makes the prompt-injection defense work.
- **Permalink (factory)**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/voiceCoach.js#L205-L235
- **Permalink (injection defense)**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/voiceCoach.js#L511-L540
- **Related ADR**: `docs/adr/005-voice-coach-orchestration.md`

### 2.2 Goal pipeline — 6-capability fanout (OCR + parse + score guard + MCP + translate + TTS)

- **What it is**: `runPipeline(image, currentScore)` runs OCR, extracts score, guards against no-change frames, parses goal card, calls MCP `updateMatchState`, then translates and speaks per locale.
- **Why click here**: Six capabilities in one linear function with explicit fail-fast reasons at every step. Also the score-change guard at line 312 is the OCR-noise defense.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/goalPipeline.js#L298-L370
- **Related ADR**: `docs/adr/007-goal-pipeline-fanout.md`

### 2.3 Ask-the-frame — prompt-injection defense with `<current_frame_untrusted>` + `<retrieved_untrusted>` tags

- **What it is**: `sanitizeUntrusted(raw, maxLen)` and the caption-wrapping path that fences BOTH the current frame caption and every RAG snippet in explicit "untrusted" tags before feeding them to the LLM.
- **Why click here**: The block at 82-107 does NFKC + C0/C1 + bidi + zero-width strip in a single pass; the wrap at line 259 is where the tag fence goes on.
- **Permalink (sanitizer)**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/askTheFrame.js#L82-L107
- **Permalink (caption tag fence)**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/askTheFrame.js#L250-L295

### 2.4 RAG workspace lifecycle — reindex bookkeeping, close, delete

- **What it is**: Per-workspace ingest counter that debounces a periodic reindex, plus a status shape that surfaces `pendingReindexes` for observability. Timers cleared on `close()` so a stray reindex cannot fire against a closed workspace.
- **Why click here**: This is not a feature; this is workspace hygiene. Debounced timers, close-safe teardown, feature-flagged.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/rag.js#L105-L165

### 2.5 MobileNetV3 pre-filter — cheap classifier gates SmolVLM2

- **What it is**: `preFilter(imageBuffer)` runs the bundled MobileNetV3-Small via `sdk.classify({modelId, image, topK})` and decides whether the frame is worth handing to SmolVLM2. Fails open on any classifier error.
- **Why click here**: This is the cost-saver that lets Curva keep VLM captioning on-device without burning battery on garbage frames.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/vlmCaption.js#L234-L275

### 2.6 JSON schema goal card — QVAC `json_schema` structured-output mode

- **What it is**: `GOAL_CARD_SCHEMA` is a frozen JSON Schema (minute, scorer, team, assist) fed to `completion({responseFormat: {type: 'json_schema', json_schema: {name, schema, strict}}})`. Verified against the SDK types at `pear-app/node_modules/@qvac/sdk/dist/schemas/completion-stream.d.ts:38-50`.
- **Why click here**: Structured output done the way QVAC ships it, not a JSON.parse over free-form text. `additionalProperties:false`, integer bounds, and a nullable assist union so an unassisted goal returns `null` explicitly.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/goalCard.js#L45-L108

### 2.7 Delegated QVAC provider (backend companion)

- **What it is**: TypeScript wrapper around `sdk.startQVACProvider({firewall: {mode, publicKeys}})`. Reads `QVAC_ALLOWED_PUBKEYS` from env, refuses to start if the allow-list is empty (unless explicitly opted into `allow-all` mode).
- **Why click here**: A firewall is not a boolean; it is an allow-list. This code refuses to boot in a mis-configured state, and the report shape at line 57 gives ops a clean status page.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/backend/src/lib/qvac/delegatedProvider.ts#L1-L313

### 2.8 FIFA 2026 shared RAG (backend companion)

- **What it is**: Backend-side EmbeddingGemma-Q4 RAG service seeded with WC26 fixtures, squads, venues, broadcasts. Peer clients call this via companion routes.
- **Why click here**: Match summaries, standings computed from scheduled fixtures, discipline records. Every data file at `backend/src/data/wc26-*.json` is called out at line 447 and honestly labeled (sample vs verified).
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/backend/src/lib/qvac/sharedRag.ts#L1-L450

---

## 3. Observability

### 3.1 Prometheus loopback bind (C1 audit fix)

- **What it is**: Instead of accepting the upstream hypertrace-prometheus server default (which listens on `0.0.0.0`), Curva starts its own HTTP server bound explicitly to `127.0.0.1:<port>` for `/metrics`.
- **Why click here**: A LAN peer cannot scrape another peer's metrics. This is one line of listen args that turns a network-exposed exporter into a loopback-only one.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/observability.js#L340-L385
- **Related ADR**: `docs/adr/009-prometheus-loopback-federation.md`

---

## 4. Architecture Decision Records

All ten ADRs live at `docs/adr/`. Each is a self-contained decision with context, alternatives considered, and consequences.

- **ADR-001** Autobase Pattern B multi-writer: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/001-autobase-pattern-b-multi-writer.md
- **ADR-002** keet-identity attestation: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/002-keet-identity-attestation.md
- **ADR-003** blind-peering target strategy: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/003-blind-peering-target-strategy.md
- **ADR-004** base.ack() cadence: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/004-base-ack-cadence.md
- **ADR-005** voice coach orchestration: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/005-voice-coach-orchestration.md
- **ADR-006** apply middleware observational: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/006-apply-middleware-observational.md
- **ADR-007** goal pipeline fanout: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/007-goal-pipeline-fanout.md
- **ADR-008** hypercore sealed predictions: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/008-hypercore-sealed-predictions.md
- **ADR-009** Prometheus loopback federation: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/009-prometheus-loopback-federation.md
- **ADR-010** design tokens minimalism: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/010-design-tokens-minimalism.md
- **ADR index (README)**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/README.md

---

## 5. Top-level architecture

### 5.1 pear-app ARCHITECTURE.md (system overview)

- **What it is**: 1259-line architecture doc covering the electron shell + workers + bare runtime layout, pear.updater flow, and the mapping from user actions to Autobase / Hyperbee / Hyperdrive / Corestore surfaces.
- **Why click here**: If you want the "how it all fits together" reading before diving into the code, start here.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/ARCHITECTURE.md

### 5.2 CODE_REVIEW.md (companion narrative)

- **What it is**: Repo-root code-review companion, structured around the same claims called out here, but with prose depth per subsystem.
- **Permalink**: https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/CODE_REVIEW.md

---

## What to click if you only have 90 seconds

1. **Autobase Pattern B**: section 1.1 (room.js) + 1.2 (chat.js) + 1.11 (divergence test).
2. **QVAC depth**: section 2.1 (voice coach factory + injection defense).
3. **A single security decision**: section 3.1 (loopback bind).

Everything else fans out from those three.
