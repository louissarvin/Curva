# Curva ADR Index

Architecture Decision Records capture the *why* behind the load-bearing choices
in this codebase. Every ADR follows the same four-section shape so a reviewer
can scan it in under three minutes:

- **Context.** The constraints and forces at play when the decision was made,
  including the docs consulted with fetched dates.
- **Decision.** The choice we shipped, referenced against installed source
  (`file:line` where an API contract is verified).
- **Consequences.** Positive and negative outcomes, plus the alternatives
  considered and rejected.
- **References.** Verbatim URLs for every doc cited, plus source file paths
  inside the tree.

## When to write a new ADR

Write an ADR when a decision:

1. Touches a public contract (writer surface, encryption, wire format).
2. Is expensive to reverse (data on disk, key derivation, feature flag names).
3. Trades off two viable alternatives whose reasoning would be lost in commit
   history alone.
4. Cites external documentation whose fetched-date pin matters for future
   re-verification.

Skip ADRs for local refactors, dependency bumps without behavior change, and
purely additive features that leave every existing invariant intact.

## Index

| # | Title | Track | Key decision |
|---|-------|-------|--------------|
| 001 | [Autobase Pattern B multi-writer](001-autobase-pattern-b-multi-writer.md) | Pears | Host as sole initial indexer, peers promoted via signed invitation |
| 002 | [Keet identity attestation](002-keet-identity-attestation.md) | Pears | Attach identity proof to presence frames, not every message |
| 003 | [Blind-peering per-core target](003-blind-peering-target-strategy.md) | Pears | Pass explicit `target` to guard against package version drift |
| 004 | [base.ack() cadence](004-base-ack-cadence.md) | Pears | 2500 ms periodic ack plus post-append immediate ack, gated on `base.ackable` |
| 005 | [Voice coach orchestration](005-voice-coach-orchestration.md) | QVAC | Five capabilities (STT + RAG + LLM + MCP + TTS) in one push-to-talk turn |
| 006 | [Apply middleware observational](006-apply-middleware-observational.md) | Pears | Wire `composeApply` chain via `base.on('update')` to preserve reducer purity |
| 007 | [Goal pipeline fan-out](007-goal-pipeline-fanout.md) | QVAC | OCR to goalCard to MCP to Bergamot to TTS to Autobase, per-locale best-effort |
| 008 | [Sealed predictions via Hypercore encryption](008-hypercore-sealed-predictions.md) | Pears | BLAKE2b-256 key derivation, silent-null on decrypt failure |
| 009 | [Prometheus loopback federation](009-prometheus-loopback-federation.md) | Observability | Loopback bind plus shared `prom-client` registry, one `/metrics` |
| 010 | [Design tokens minimalism](010-design-tokens-minimalism.md) | Frontend | 4 px grid, 150/300 ms motion budget, `textContent`-only XSS discipline |

## Related documents

- `pear-app/ARCHITECTURE.md`: the full-system deep dive that cites these ADRs
  from its Cross-capability orchestration and Observability sections.
- `pear-app/README.md`: feature list and boot commands for operators.
