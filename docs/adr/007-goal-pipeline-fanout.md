# ADR 007: Goal Pipeline Fan-Out (OCR to Six Capabilities)

## Context

The goal pipeline is Wave 4's "one trigger, six capabilities" demo. A frame
arriving from the video element flows through:

1. OCR: `bare/ocr.js` OCR_LATIN reader plus `extractScore` regex
2. Structured LLM: `bare/goalCard.js` schema-constrained goal card parse
3. MCP: `bare/mcpTools.js` `updateMatchState` (or duck-typed fallbacks)
4. Translation: `bare/translate.js` Bergamot NMT per configured locale
5. TTS: `bare/announcer.js` streaming Supertonic per locale
6. Autobase append: `chat.sendSystem({type: 'system:goal-card', ...})`

Failure modes are asymmetric: OCR + goalCard failures should abort (no goal =
nothing to announce); MCP + Bergamot + TTS failures for one locale should not
poison the other locales. And the whole thing should be idempotent for
overlapping triggers so a bounced frame from a scene cut does not double-fire.

Docs consulted:
- https://docs.qvac.tether.io/ai-capabilities/text-recognition/ (fetched 2026-07-10, OCR)
- https://docs.qvac.tether.io/ai-capabilities/text-generation/ (fetched 2026-07-10, structured output)
- https://docs.qvac.tether.io/ai-capabilities/translation/ (fetched 2026-07-10, Bergamot)
- https://docs.qvac.tether.io/ai-capabilities/text-to-speech/ (fetched 2026-07-10)

## Decision

`bare/goalPipeline.js` implements a single `trigger()` entry point with:

1. **Feature flag + busy gate.** `CURVA_GOAL_PIPELINE_ENABLED` gates the whole
   pipeline off by default. A single in-flight `trigger()` is allowed; overlap
   returns `{ ok: false, reason: 'BUSY' }` (`bare/goalPipeline.js:34-41`).
2. **30 s timeout with clean code.** The whole chain is wrapped in a 30 s
   budget. On expiry the pipeline resolves to `{ ok: false, code:
   'PIPELINE_TIMEOUT' }` so a caller can distinguish stuck-vs-error
   (`bare/goalPipeline.js:47`).
3. **Prompt-injection defense on OCR blocks.** OCR text is user-controlled (it
   comes from whatever frame the video player rendered). Before passing it to
   `goalCard.parse()` we (a) strip C0/C1 control chars, (b) drop blocks whose
   text starts with `ignore previous`, `system:`, `you are now`, `as an ai`,
   `###`, or `ignore all previous`, (c) cap at `MAX_OCR_CHARS = 2000` bytes
   (`bare/goalPipeline.js:45-91`). Defense-in-depth with `goalCard.sanitiseInput`
   at `bare/goalCard.js:100`.
4. **Fan-out best-effort per locale.** After a valid goalCard is produced,
   `DEFAULT_LOCALES = ['en', 'it', 'id']` are processed independently. A
   missing MCP client, a Bergamot translate failure, or a TTS session that
   fails to open for one locale is logged and skipped; other locales still
   fire. The goalCard append to Autobase happens once, regardless of per-locale
   fan-out results (`bare/goalPipeline.js:46-47` per-session budget +
   caller-level `Promise.allSettled` over locales).
5. **Structured LLM output.** `goalCard.parse()` uses the SDK's
   `responseFormat.json_schema` to constrain output to `{minute, scorer, team,
   assist}`. Documented at
   https://docs.qvac.tether.io/ai-capabilities/text-generation/ under
   "Structured output" (fetched 2026-07-10). Contract verified at
   `bare/goalCard.js:204`.

## Consequences

Positive:
- Six capabilities exercised per trigger. This is the primary judging metric
  for the QVAC track and it fires end-to-end from one user action.
- Injection defense is centralised at the OCR->goalCard boundary; a hostile
  scoreboard overlay cannot rewrite the coach's system prompt.
- Locale fan-out isolates failure. English demos still succeed if the Italian
  Bergamot artefact is missing on the host.
- `PIPELINE_TIMEOUT` code is stable so the diagnostics panel can render a
  useful reason.

Negative:
- 30 s budget is a wall-clock ceiling on the slowest device. On a hot Whisper
  boot with a cold Bergamot the pipeline can run close to that limit and drop
  a locale.
- Best-effort per-locale means a systematic Bergamot regression is silent to
  users if English keeps working. Mitigation: the Prometheus exporter
  (ADR 009) surfaces per-capability failure counters.

Alternatives rejected:
- **Fail-closed on any locale error.** Rejected because the demo would flake
  on the least-warm capability. Fan-out best-effort is the honest posture.
- **Separate OCR polling loop.** Rejected because it duplicates state (frame
  cadence, dedup) that the caller already tracks.

## References

- https://docs.qvac.tether.io/ai-capabilities/text-recognition/ (fetched 2026-07-10)
- https://docs.qvac.tether.io/ai-capabilities/text-generation/ (fetched 2026-07-10)
- https://docs.qvac.tether.io/ai-capabilities/translation/ (fetched 2026-07-10)
- https://docs.qvac.tether.io/ai-capabilities/text-to-speech/ (fetched 2026-07-10)
- `pear-app/bare/goalPipeline.js:34-47` (flag, busy gate, timeout)
- `pear-app/bare/goalPipeline.js:50-91` (suspicious prefix strip + joinBlocksForPrompt)
- `pear-app/bare/goalCard.js:204` (parse contract)
- `pear-app/bare/ocr.js:373-385` (createOcr + extractScore)
- `pear-app/bare/translate.js:496` (translate contract)
- `pear-app/bare/announcer.js:615` (openSpeakStream contract)
- `pear-app/bare/mcpTools.js:249` (invokeTool duck-typed surface)
