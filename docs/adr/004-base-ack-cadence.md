# ADR 004: base.ack() Cadence for Indexer Writers

## Context

Autobase's convergence guarantee depends on indexers signalling "I have seen up
to here" via `base.ack()`. The Autobase docs state
(https://docs.pears.com/reference/building-blocks/autobase/):

> Only indexers can acknowledge. An ack appends a null node that references
> the known heads so peers can converge faster.

Installed source (`pear-app/node_modules/autobase/index.js:934`):

```
async ack(bg = false) { ... }
```

- `bg = true` schedules the ack through Autobase's own timer (`_ackTimer`);
  useful for cheap periodic acks.
- `bg = false` appends immediately, guaranteeing the head reference lands
  before the caller returns.

Autobase also exposes `base.ackable` (a getter at line 246 that checks
`localWriter.isActiveIndexer`). We use it to skip ack calls when we are not
actually an indexer (peers pre-promotion in Pattern B).

Without a cadence policy, peers can silently lag because no null-node ever
lands in low-traffic windows. Symptom: a peer joins mid-match, replays every
message, then stalls because no fresh head reference is coming.

## Decision

Every open room fires TWO ack streams per Autobase (chat + playhead):

1. **Periodic background ack**: `setInterval(() => base.ack(true), 2500)`.
   The 2500 ms cadence is the smallest interval that does not visibly perturb
   Bare's event loop under our workload (measured with the Wave 15 latency
   diag). `bg = true` lets Autobase coalesce with its own `_ackTimer` so we do
   not double-fire.
2. **Immediate post-append ack**: after every local `base.append()` that
   succeeds, we call `await base.ack(false)` synchronously. This matters most
   for playhead: a play/pause event is meaningless if the head reference
   lags 2 seconds behind. The post-append ack costs one extra null-node
   append.

Both streams are gated on `base.ackable` so a pre-promotion peer no-ops
cheaply.

Teardown clears both interval handles before the base closes so we do not
race a fresh ack against `base.close()`.

## Consequences

Positive:
- Late joiners see convergence within the 2500 ms cadence window at worst.
- Playhead events land at head immediately so late viewers do not seek to a
  stale position.
- The gate on `base.ackable` means the policy is safe to apply to every
  writer; peers who never get promoted pay no cost.

Negative:
- Extra null nodes on the writer core. On the chat autobase we estimate 24
  extra blocks per minute per indexer at idle. Over a 90-minute match at 3
  indexers that is ~6,500 null nodes. Autobase's linearizer handles this
  fine but the raw wire log grows.
- The post-append immediate ack duplicates one round-trip when the periodic
  timer was about to fire anyway. Acceptable given the correctness gain.

Alternatives rejected:
- Longer interval (10 s+): rejected because playhead convergence latency was
  visibly bad in our Phase 2 tests. A viewer that missed the 10 s window saw
  the playhead lag on join.
- `bg = false` for periodic acks: rejected because it does not integrate with
  Autobase's own `_ackTimer` coalescing, so ack storms are possible under
  many-indexer rooms.
- Ack only on post-append: rejected because idle indexers (host holding a
  paused stream) still need to signal liveness to keep late-joiners converging.

## References

- https://docs.pears.com/reference/building-blocks/autobase/
- `pear-app/node_modules/autobase/index.js:934` (`async ack(bg = false)`)
- `pear-app/node_modules/autobase/index.js:246` (`get ackable`)
- `pear-app/bare/room.js` (`startAckLoop`, teardown)
- `pear-app/bare/chat.js` (`send`, `sendSystem`, `appendGoal` post-append ack)
- `pear-app/bare/playhead.js` (`setState` post-append ack)
- `pear-app/test/chat-determinism.test.js` (`ADR-004: local indexer writer sees ack blocks appended after send`)
