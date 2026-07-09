# ADR 001: Autobase Pattern B for Multi-Writer Chat + Playhead

## Context

Curva rooms need a shared, tamper-resistant chat and playhead log that survives
the host disconnecting mid-match. Every peer must be able to append (chat
messages, playhead events, tips) and every peer must see the same causally-
merged view. Autobase supports two writer patterns:

- Pattern A: a single indexer (the host) explicitly `ackWriter`s each optimistic
  block from peers. Peers must be online with the host to make progress.
- Pattern B: the host promotes peers to indexers via `base.append({addWriter:
  peerKey, indexer: true})`. Promoted peers can independently append and their
  blocks converge without host mediation.

The Autobase README (`pear-app/node_modules/autobase/README.md`, lines 20-52
and 311) documents Pattern B as:

> `if (value.addWriter) { await host.addWriter(value.addWriter, { indexer: true }) }`

and warns:

> Autobase can reorder previously seen nodes when new causal information
> arrives. If apply is non-deterministic, different peers will diverge.

We also verified the installed source (`pear-app/node_modules/autobase/index.js:934`)
for the `base.ack(bg = false)` API and confirmed that `base.local.keyPair` is
NOT part of the documented export surface.

Docs consulted: https://docs.pears.com/reference/building-blocks/autobase/

## Decision

We ship Pattern B for chat + playhead. The host is the sole initial indexer;
peers submit a signed invitation via `signMyWriterInvitations()` and, once
verified, are promoted with a control block appended by the host.

Consequences of the choice:

1. Signed invitations use an ed25519 keypair derived from a per-room seed
   persisted in `roomState` (`bare/room.js:loadOrCreateInvitationSeeds`). We
   avoid touching `base.local.keyPair` because that field is not documented on
   the Autobase public surface and could drift.
2. The peer's ACTUAL writer core key (`base.local.key`) is transported
   alongside the invitation payload as `chatWriterKey` / `playheadWriterKey`.
   The invitation seed proves ownership; the writer key is what the host
   promotes.
3. `addWriter` is rate-limited to 20 promotions per peer per hour so a
   churn-attack host cannot brick its own room.
4. Reducer purity is enforced: rate-limit state lives at ingress (`send()`),
   `tip-writer` bindings live in the Hyperbee view (idempotent puts). This is
   required because Autobase replays nodes during rebase.

## Consequences

Positive:
- Chat + playhead survive host disconnect. Peers append directly.
- Peer promotion is signed + rate-limited, so a promoted peer cannot smuggle
  its accomplices.

Negative:
- Two writer surfaces to secure (chat + playhead). We pay the invitation
  ceremony cost twice per join.
- Reducer must stay pure. We flagged this in `chat-determinism.test.js` and
  `autobase-divergence.test.js` so future changes cannot silently regress.

Alternatives rejected:
- Pattern A alone was rejected because host-offline breaks the room. The Fix
  Wave B review found that a viewer waiting on Pattern A gets a black screen
  the moment the host closes the laptop.
- A single Autobase with two view keyspaces (chat + playhead in the same base)
  was rejected because chat rate limits would leak into playhead events.

## References

- https://github.com/holepunchto/autobase (README, § API)
- https://docs.pears.com/reference/building-blocks/autobase/
- `pear-app/node_modules/autobase/index.js:934` (verified `ack` signature)
- `pear-app/bare/chat.js` (apply-is-pure enforcement)
- `pear-app/bare/room.js` (invitation ceremony + rate limit)
