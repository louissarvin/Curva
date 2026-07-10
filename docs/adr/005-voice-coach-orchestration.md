# ADR 005: Voice Coach Chains Five QVAC Capabilities in One Push-to-Talk Turn

## Context

The voice coach is Curva's headline demo of QVAC composition. A single push-to-talk
turn must go from raw microphone PCM to a spoken reply that can also invoke room
side-effects (tip, prediction, x402 pay). That single turn touches FIVE distinct
QVAC capabilities:

1. STT: `@qvac/sdk` `transcribeStream()` with Whisper or Parakeet
2. RAG: `bare/rag.js` search over the room glossary and chat workspace
3. LLM: `@qvac/sdk` `completion()` streamed via `run.events`
4. MCP: the Curva Companion MCP server plus in-process room tools
5. TTS: `bare/announcer.js` `speak()` with Supertonic multilingual

The obvious alternative is to ship these as five independent flows in the renderer
and let the user chain them by hand. That splits state (partial transcript, turn
budget, mic gate) across renderer, worker, and MCP client boundaries, which makes
prompt-injection defense and idempotency near impossible to reason about.

The SDK contract for `transcribeStream` returns a
`TranscribeStreamConversationSession` whose events are a discriminated union
including `type: 'endOfTurn'` (see
`pear-app/node_modules/@qvac/sdk/dist/schemas/transcription.d.ts:243`). The
completion contract is documented at
`pear-app/node_modules/@qvac/sdk/dist/schemas/completion-event.d.ts` and returns
a `CompletionRun` synchronously with an async-iterable `run.events`.

Docs consulted:
- https://docs.qvac.tether.io/ai-capabilities/transcription/ (fetched 2026-07-10)
- https://docs.qvac.tether.io/ai-capabilities/text-generation/ (fetched 2026-07-10)
- https://docs.qvac.tether.io/ai-capabilities/voice-assistant/ (fetched 2026-07-10)

## Decision

`bare/voiceCoach.js` owns the full 5-capability chain inside a single factory
(`createVoiceCoach`). One `startTurn -> pushAudio* -> endTurn` cycle is one turn.
The coach enforces:

1. **Turn idempotency via Sets.** `state.endedTurns: Set<turnId>` short-circuits
   duplicate `endTurn` calls; `pipelineRunOnce: Set<turnId>` guards the LLM ->
   MCP -> TTS pipeline against a re-entrant `endOfTurn` event replay
   (`bare/voiceCoach.js:255`, `:442`, `:464-468`). Both sets are cleared on close.
2. **Audio safety envelope.** 16 kHz mono f32le at 30 s cap is 1,920,000 bytes
   (`AUDIO_MAX_BYTES`). The SDK's internal VAD would eventually cut this on its
   own, but the local fuse guards against a mis-wired renderer exhausting Bare
   worker memory before the SDK reacts (`bare/voiceCoach.js:71-75`).
3. **Push rate limit.** `AUDIO_MAX_PUSHES_PER_SEC = 64` with a 1 s window rejects
   any tight-loop burst designed to trip the byte fuse and force LLM firings
   (audit fix H1, `bare/voiceCoach.js:81`, `:385-405`).
4. **Prompt-injection defense.** Retrieved RAG hits are wrapped in
   `<retrieved_untrusted>...</retrieved_untrusted>` tags. Before wrapping, each
   snippet is NFKC-normalised (homoglyph fold) and stripped of Unicode bidi
   controls, zero-width chars, and BOM (`bare/voiceCoach.js:509-523`, audit fix
   M4). The system prompt states explicitly that write-tools require a current-
   user request, not implied intent from retrieved text
   (`bare/voiceCoach.js:96-108`).
5. **Turn timeout.** 45 s end-to-end hard cap on a single turn plus a 300 ms TTS
   cooldown to keep the coach's own voice out of the next mic frame per the
   voice-assistant recipe (`bare/voiceCoach.js:88-91`).

## Consequences

Positive:
- One place to reason about turn state, budget, and injection posture. The
  reducer contract for any downstream chat append (system:bot-reply) stays pure
  because side effects live inside the coach factory, not inside apply().
- The 5-capability composition is exercised end-to-end by a single API surface
  (`startTurn / pushAudio / endTurn / close`), so the renderer preload has one
  namespace to expose.
- Prompt-injection posture is testable in isolation (`sanitizePrompt`,
  `meaningfulTranscript`).

Negative:
- The factory is ~730 lines and holds refs to `sdk`, `sharedLlmHandle`, `chat`,
  `mcpClient`, `roomMcpClient`, `ragHandle`, `announcer`. Injecting a null for
  any of them degrades to a documented reason code, but the surface is wide.
- The turn budget is fixed at boot. A future streaming-TTS integration will want
  to overlap `endOfTurn` with TTS start, which the current pipelineRunOnce set
  will need to be extended to gate correctly.

Alternatives rejected:
- Separate renderer flows per capability: rejected because injection defense
  cannot be applied consistently across renderer/worker/MCP boundaries.
- Reusing `roomBot.js` as-is: rejected because roomBot is chat-triggered
  (Autobase append) and cannot own live audio session state.

## References

- https://docs.qvac.tether.io/ai-capabilities/transcription/ (fetched 2026-07-10)
- https://docs.qvac.tether.io/ai-capabilities/text-generation/ (fetched 2026-07-10)
- https://docs.qvac.tether.io/ai-capabilities/voice-assistant/ (fetched 2026-07-10)
- `pear-app/node_modules/@qvac/sdk/dist/schemas/transcription.d.ts:243`
- `pear-app/node_modules/@qvac/sdk/dist/schemas/completion-event.d.ts`
- `pear-app/bare/voiceCoach.js:71-108` (safety envelopes + system prompt)
- `pear-app/bare/voiceCoach.js:255, 442, 464-468` (idempotency Sets)
- `pear-app/bare/voiceCoach.js:509-523` (retrieved-untrusted wrap + NFKC + bidi strip)
