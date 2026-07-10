# Curva Semifinal Demo Video Script — 3 Minutes Max (FINAL)

**Purpose**: Round-of-16 resubmission for Tether Developers Cup 2026. Judges' brief is explicit: "a genuine walkthrough (your voice, your screen, the real product) lands far better than a synthetic one". This script is written for a single take with your real voice and the real product running.

**Format**: ONE take, QuickTime, 3 min max, uploaded UNLISTED to YouTube.

**Guiding principle from the judges' email**: "The video is maybe 20% of the effort you've put in, but it carries something like 80% of the impression your project makes." Every second earns its place. Narrate DECISIONS, not features. Own the trade-offs.

## Pre-recording checklist

- Backend companion running on `http://localhost:3700`
- Both peers booted with the command block from `pear-app/README.md` "Quick start"
- Peer B has Bergamot models cached
- Both peers show `writer promoted (Pattern B)` in worker logs
- RAG workspace pre-warmed on Peer A (glossary + first ingest done)
- MCP roomBot loaded, responding to `/ask` in chat
- Voice coach ready: Qwen3 LLM loaded, Whisper Tiny cached, Supertonic TTS ready
- SmolVLM2 500M + mmproj cached on Peer B (~521 MB first download)
- OCR_LATIN cached (15 MB)
- Delegated inference provider running on Peer A, pubkey advertised in Hyperbee
- `CURVA_OBSERVABILITY_ENABLED=true` on both peers, Prometheus at `http://127.0.0.1:4343/metrics`
- Sponsor treasury above 0.005 ETH; both peer wallets funded with USDT-branded token
- `PERMALINKS.md`, `CODE_REVIEW.md`, `TETHER_STACK.md` open in editor tabs for the closing beat
- `bun test` output cached ready to show

---

## THE SCRIPT — 180 seconds

### 0-15s: Product intro (Team Indonesia + tracks)

Both Curva windows side by side on the lobby.

> "Curva is a peer-to-peer World Cup watch-party. Team Indonesia, Tether Developers Cup 2026, primary tracks Pears and QVAC with a WDK cameo. Everything you're about to see runs on-device, between two friends, with no server in the middle."

**Fallback if this beat breaks**: skip to the boot beat. The intro copy is short; you can voice it over the boot.

### 15-30s: Boot both peers, verify chat sync

Run the command block from `pear-app/README.md` on Peer A and Peer B in parallel. Both windows show the lobby, then Peer A creates room `wc26-final`, Peer B joins. Both worker logs show `writer promoted (Pattern B)`. Peer A types "Halo dari Torino!"; it lands on Peer B in under a second.

> "Two `pear run` commands, two peers, no server. Host publishes a room to the STADIUM lobby, viewer joins as an indexed writer. Autobase Pattern B multi-writer chat, verified by our `autobase-divergence.test.js` — which reorders inputs across two writers and asserts both views deep-equal."

**Fallback if this beat breaks**: fall back to a single peer; narrate the room create only. Say "the bidirectional path is covered by the divergence test at `pear-app/test/autobase-divergence.test.js`".

### 30-60s: Pears depth (Pattern B + chat scrubber + apply middleware)

Both peers show green shield icons in Chat (keet-identity attestation working). Scroll chat, click the timeline scrubber. Chat rolls back to a prior version via `checkoutAt(v)`; the writer is refused when you try to type.

> "We chose Autobase Pattern B — the host controls writer promotion via an addWriter control block — because it prevents any dialed-in peer from silently promoting itself. The apply reducer stays pure so rebases converge. Chat scrubber uses `base.view.checkout(v)`, which returns a read-only snapshot: try to write to it and it throws."

Cut to editor with `pear-app/bare/room.js:698-961` visible for the Pattern B block. Then flash `pear-app/bare/lib/applyMiddleware.js:80-110` — the composeApply pattern.

> "Apply middleware is observational only. `attachApplyMiddleware` binds to `base.on('update')`, never inside apply itself, so audit and system-guard middleware run without breaking Autobase's determinism guarantee. That's ADR-006."

**Fallback if this beat breaks**: if chat scrubber refuses to render, skip to the middleware code walkthrough and say "checkoutAt is at `chat.js:697`, one-line snapshot".

### 60-105s: QVAC breadth — voice coach 5-cap flow, goal pipeline 6-cap fanout, MobileNetV3 pre-filter

Peer B holds Space bar. Says: "Who tipped the most in this room?"

Coach panel shows:
1. Live partial Whisper transcript growing
2. `endOfTurn` detected, transcript freezes
3. `retrieved 3 hits` badge appears (RAG grounding)
4. Streaming answer growing token-by-token
5. Supertonic TTS speaks the reply
6. Transcript + answer both appear as `system:coach` pills, replicated to Peer A

> "Voice coach chains five QVAC capabilities in one turn: Whisper transcribes, EmbeddingGemma retrieves, Qwen3 answers with MCP tools available, Supertonic speaks. Every RAG hit is wrapped in `<retrieved_untrusted>` tags before the LLM sees it — that's the prompt-injection defense at `pear-app/bare/voiceCoach.js:511-540`. It's a real defense: sanitize NFKC, strip bidi and zero-width characters, tag the untrusted region, and instruct the LLM to obey only the user turn."

Then trigger a goal event (staged trigger via demo timeline). Diagnostics tab visible with a MobileNetV3 pre-filter counter incrementing next to the SmolVLM2 counter.

> "Goal pipeline is six capabilities: OCR reads the scoreboard, score-change guard rejects noisy re-fires, goalCard uses QVAC's `json_schema` structured output mode with a frozen four-field schema, MCP updates the match state, translate + speak per locale. And MobileNetV3-Small pre-filters every frame in 50ms before we spend cycles on SmolVLM2 — you can see the counter climbing."

**Fallback if this beat breaks**: if voice coach STT fails to load, fall back to typing in the coach panel and narrate "the RAG + MCP + streaming flow is the same; only Whisper is skipped". If goal pipeline stalls, skip to the pre-filter counter alone.

### 105-140s: WDK cameo — real Sepolia EIP-3009 tip with tx receipt

Peer B clicks TIP HOST, picks 1 USDT-branded token, signs. Backend facilitator submits the authorization. Tx confirms; both windows show updated balances. Etherscan tab opens on the tx hash showing `AuthorizationUsed` + `Transfer` events on our EIP-3009 token.

> "This is the WDK cameo. Peer B signs an EIP-3009 authorization off-chain — no ETH needed. Our backend facilitator submits it and pays gas from the sponsor treasury. The token is a USDT-branded EIP-3009 ERC-20 on Sepolia. Not real mainnet USDT — cup rules disallow that — but the wire is identical to what mainnet ship would look like. The trade-off we accepted: sponsor treasury must be funded; when it dries up, tips queue."

**Fallback if this beat breaks**: skip to Etherscan tab with a previous tx and narrate the wire-in from `pear-app/bare/wallet/eip3009.js`. Say "the `onChainIdentifier: 'curva'` marker at line 57 lets any downstream indexer attribute this back to us."

### 140-165s: Code review pitch — tests + PERMALINKS.md + CODE_REVIEW.md

Terminal: flash `bun test` output. Point at the pass count.

```
# tests = 472+ pass
```

Then Cmd+Tab to editor with `PERMALINKS.md` open on the Pears architecture section, then `CODE_REVIEW.md` open on the depth summary, then `TETHER_STACK.md` open on the trade-offs.

> "For the code review round: 472 tests pass. Every claim in this demo has a permalink in `PERMALINKS.md`, commit-pinned so the links never drift. `CODE_REVIEW.md` walks the subsystems in prose. `TETHER_STACK.md` names every Tether-stack package we use, why we chose it, how we wired it, and what trade-off we accepted."

**Fallback if this beat breaks**: if `bun test` output does not paste in cleanly, flash the editor tabs only. The point is that the reviewer knows where to click.

### 165-180s: Close

Both Curva windows still on screen. Coach mid-reply, chat active, verified badges lit, tip receipt visible on Etherscan.

> "Curva. Team Indonesia. For the full code walkthrough see `PERMALINKS.md` at the repo root. Bola untuk semua. Forza Curva."

Stop.

---

## Recording notes

- Speak fast. 180 seconds is not much for six beats. Cut narration if a beat runs over.
- The 140-165s beat is CRUCIAL. This is where the judge sees you treated this round as code review, not pitch.
- If any beat fails on camera, DO NOT redo the whole video. Continue past it, edit out failure in QuickTime.
- Export at 1080p, mp4, upload UNLISTED.

## Fallback beats if something breaks (consolidated)

- **VLM/OCR model download stalls**: skip that beat, go straight to voice coach + Etherscan.
- **Voice coach STT plugin missing**: fall back to typing in the coach panel. RAG + MCP + streaming still works.
- **Delegated inference does not connect**: it is not a demo beat this cut. Ignore.
- **Prometheus port collision**: skip DiagnosticsPanel; the MobileNetV3 counter can be voiced over the goal pipeline visuals.
- **Sepolia RPC slow**: use a previously confirmed tx hash and narrate the wire-in from the eip3009.js file.
- **`bun test` slow**: cache the output as a screenshot and Cmd-Tab to it.

## What NOT to say on camera

- Do not say "top 4" or "semifinal" or mention the judging round explicitly. Demo the product, not the pitch.
- Do not reference bugs we fixed. Judges do not care about the journey.
- Do not say "we could add X in the future". Every claim must be provable in code.

## Narration tips — the discipline the judges' email calls out

- **Your real voice.** No AI narration. The judges specifically flagged this in the email.
- **Decisions, not features.** For every beat, tell the judge WHY you chose the primitive, HOW you wired it, and WHAT trade-off you accepted. "We chose Pattern B because X, wired it like Y, gave up Z" scores far above "here is chat".
- **Own the trade-offs.** The judges reward honesty. The USDT-branded token is a testnet token; say so. Chatterbox is EN/IT only; say so. MobileNetV3 fails open; say so.
- **Every second earns its place.** If a beat is not helping the reviewer understand a decision, cut it.
- **Point at real code.** The "flash the editor with PERMALINKS.md" beat is the whole point of the round: a judge can pause the video, click the permalink, and land on the exact block you narrated.

## After recording

1. QuickTime → Edit → Trim to exactly 3 min or under
2. Export at 1080p mp4
3. Upload to YouTube as **Unlisted**
4. Copy the shareable URL
5. Paste into DoraHacks Round-of-16 resubmission form
6. Paste the `DORAHACKS_DETAILS_SEMIFINAL.md` content into the Details field
7. Submit before the round deadline

## Depth-signal summary the video communicates

Judges should walk away seeing these signals:

1. **Autobase Pattern B multi-writer** with real bidirectional sync, verified by the divergence test.
2. **keet-identity attestation** with visible verified badge.
3. **Autobase view.checkout()** driving a read-only chat scrubber.
4. **Apply middleware** as an observer, not a reducer mutator.
5. **QVAC 5-cap voice coach** with `<retrieved_untrusted>` prompt-injection defense.
6. **QVAC 6-cap goal pipeline** with `json_schema` structured output.
7. **MobileNetV3 pre-filter** as a cost saver in front of SmolVLM2.
8. **EIP-3009 gasless tip** with a real Sepolia tx receipt and `onChainIdentifier: 'curva'` marker.
9. **PERMALINKS.md** as the reviewer's clickable table of contents.
10. **472+ tests, 10 ADRs, three doc pillars** as visible code-review evidence.

That is the depth. Pears + QVAC in one product, provable in code, provable in tests, verifiable on Sepolia + `pear://` DHT.
