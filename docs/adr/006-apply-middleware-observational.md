# ADR 006: Apply Middleware Runs Observationally, Not Inside apply()

## Context

Wave 4 adds a middleware chain (audit log, chaos, system guard, replay recorder,
terminal) for the chat Autobase. The obvious way to wire it is to compose the
middlewares into a single function and pass that as the `apply` callback to
`new Autobase({..., apply})`. That path was rejected because two independent
constraints ruled it out:

1. **Chat.js is must-not-touch.** The chat reducer body (`bare/chat.js`) is the
   convergence-critical code path exercised by determinism tests
   (`test/chat-determinism.test.js`, `test/autobase-divergence.test.js`). Any
   change there risks divergence between peers.
2. **Autobase's purity contract.** The linearizer calls
   `await handlers.apply(nodes, view, host)` during BOTH first-time application
   AND rebase/replay. If apply is non-deterministic, peers diverge. This is
   documented in the Autobase reference:
   https://docs.pears.com/reference/building-blocks/autobase/ (fetched
   2026-07-10) and cross-checked against
   `pear-app/node_modules/autobase/index.js`. Injecting middlewares with any
   closure-captured mutable state, wall-clock reads, or external sink calls
   inside apply() would violate the purity requirement.

Docs consulted:
- https://docs.pears.com/reference/building-blocks/autobase/ (fetched 2026-07-10)
- https://github.com/holepunchto/autobase README, § API (fetched 2026-07-10)
- Installed `pear-app/node_modules/autobase/index.js`

## Decision

Compose the middleware chain with `composeApply([...])`
(`bare/lib/applyMiddleware.js:80-119`) but wire it OBSERVATIONALLY via
`base.on('update', ...)` from `bare/room.js:125-186`, not as the Autobase apply
callback. The terminal middleware in the chain is a no-op:
`terminalMiddleware(async () => { /* no-op: real reducer is inside chat.js */ })`
(`bare/room.js:163`).

Concretely:

1. `attachApplyMiddleware(chat, {slug})` is gated by
   `CURVA_APPLY_MIDDLEWARE_ENABLED` (default off). When off, boot is byte-
   identical to pre-Wave-4 (`bare/room.js:126-134`).
2. When on, the observer subscribes to `chatBase.on('update', ...)` and feeds a
   synthetic marker node through the composed chain per update. The chain runs
   its audit sink, system guard, and replay recorder against that marker
   (`bare/room.js:166-181`).
3. Sinks live outside the reducer path (`auditSink = { count, ring }` in a
   caller-owned Map). They cannot alter view state because the terminal step is
   a no-op.
4. `composeApply` enforces the middleware contract: every middleware MUST call
   `next()` exactly once. Missing or double invocations throw
   `MiddlewareMustCallNext` (`bare/lib/applyMiddleware.js:53-58`, `:112-114`).
5. The individual middleware factories are still pure (audit hashes with
   deterministic FNV-1a over stable JSON, chaos drops on deterministic hash of
   `salt + stableStringify(value)`), so if a future ADR moves the chain INTO
   apply() the primitives remain replay-safe.

## Consequences

Positive:
- Chat.js reducer body is unchanged. Determinism tests continue to pin the
  contract.
- Autobase's purity guarantee is preserved even when the audit sink writes to a
  process-owned ring buffer, because the sink lives OUTSIDE apply().
- Middlewares can be added or removed under the feature flag without a release
  cut. Chaos middleware in particular is only useful in dev/test.
- The composed pipeline is unit-testable in isolation (feed a fake `nodes`
  array, assert sinks fired).

Negative:
- Observational wiring cannot filter or transform the actual node stream. The
  chaos middleware's `next(kept)` output is discarded, because the marker feed
  is not the real apply invocation. This is documented at
  `bare/room.js:170-177` and is an accepted limitation.
- Two middleware layers exist in the codebase: the composed chain (observer)
  and the reducer body (chat.js). Future contributors must know which one is
  authoritative for a given concern.

Alternatives rejected:
- **Monkey-patch the linearizer.** Autobase's `_applyNodes` path is internal
  and not part of the documented surface. Patching it would break on the next
  package bump and defeat the point of a pure reducer contract.
- **Wrap chat.js's apply directly.** Rejected because chat.js is must-not-touch
  and because a wrapper with any external sink call inside apply() violates
  the purity contract (see Autobase README warning: "Autobase can reorder
  previously seen nodes when new causal information arrives. If apply is non-
  deterministic, different peers will diverge.").

## References

- https://docs.pears.com/reference/building-blocks/autobase/ (fetched 2026-07-10)
- https://github.com/holepunchto/autobase (README, § API, fetched 2026-07-10)
- `pear-app/node_modules/autobase/index.js` (apply invocation site)
- `pear-app/bare/lib/applyMiddleware.js:80-119` (composeApply)
- `pear-app/bare/lib/applyMiddleware.js:172-201` (auditLogMiddleware)
- `pear-app/bare/lib/applyMiddleware.js:217-242` (chaosMiddleware, deterministic drop)
- `pear-app/bare/lib/applyMiddleware.js:253-287` (systemGuardMiddleware)
- `pear-app/bare/room.js:125-186` (attachApplyMiddleware wiring)
- `pear-app/bare/chat.js:568` (existing `base.on('update', ...)` reactor)
