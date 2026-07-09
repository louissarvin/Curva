# ADR 003: Blind-Peering Per-Core Target Strategy

## Context

Curva rooms rely on a third-party blind peer (`blind-peering@2.4.0`) to keep
the chat + playhead Autobases seeded when every human peer disconnects. The
installed source (`pear-app/node_modules/blind-peering/index.js:130`) documents
`addAutobase(auto, {target, referrer, priority, announce, additionalViews,
pick, keys})` and defaults `target = auto.wakeupCapability.key`. The default is
correct in the common case but has failure modes:

1. Autobase shape drift: a future package version could rename or remove
   `wakeupCapability.key`. Silently registering under `undefined` corrupts the
   blind peer's mirror table with no error at our layer.
2. Cores outside Autobase (clip index Hyperbee, tactical drawings) also need
   seeding. `addCore(core, {target})` defaults `target = core.key`. Same
   drift risk on future versions.
3. Curva must reason about which key it registered so unregister + reboot
   flows work.

Docs consulted:
- https://docs.pears.com/how-to/blind-peering/add-blind-peering-to-a-chat-app/
- Installed source: `pear-app/node_modules/blind-peering/index.js` (lines
  130-157 for `addAutobase`, 196-215 for `addCore`, 82-102 for suspend/resume).

We also recorded two docs-fetch prompt-injection incidents in the Wave 15
implementation memo; the API surface below is derived from the installed
source, not from prose.

## Decision

Always pass an EXPLICIT `target`:

- `registerAutobase(base, extra)`: `target = extra.target || base.wakeupCapability?.key || base.discoveryKey || base.key`
- `registerCore(core, extra)`: `target = extra.target || core.key`

Log the target hex prefix at info level so a demo watcher can visually confirm
we registered the expected bytes.

Expose `suspend()` and `resume()` on the wrapper client so `workers/main.js`
can quiesce the DHT sockets before closing them. `close()` calls `suspend()`
internally as a belt-and-suspenders guard against a caller that skips the
explicit quiesce step.

Rate limit registrations to 5 per base per rolling minute so a churn attack
cannot flood the blind peer with `addAutobase` calls.

## Consequences

Positive:
- Package-version drift is caught at our layer: we KNOW which key we asked to
  seed. A missing target throws inside our wrapper instead of surfacing as a
  silent "mirror is empty" bug on the blind peer.
- `registerCore` gives non-Autobase subsystems (clip index) the same
  resilience guarantee.
- suspend/resume expose a clean quiesce path for Pear runtime background
  transitions.

Negative:
- The wrapper now duplicates a subset of the package's `addAutobase`
  signature. If future blind-peering versions add new opts we may need to
  forward them (currently done via `...extra` spread).
- Tests must mock the full surface (addAutobase, addCore, suspend, resume,
  close) instead of a single method.

Alternatives rejected:
- "Just trust the default": rejected because we cannot pin a package version
  more aggressively than the lockfile allows; a future minor bump could
  change the default without a semver signal.
- Sharing the room read key with the blind peer: rejected because the blind
  peer must NEVER decrypt chat contents. Discovery-key-only replication is
  the whole point of the primitive.

## References

- https://docs.pears.com/how-to/blind-peering/add-blind-peering-to-a-chat-app/
- https://github.com/holepunchto/blind-peering
- `pear-app/node_modules/blind-peering/index.js` (installed 2.4.0 source)
- `pear-app/bare/blindPeering.js` (per-core target implementation)
- `pear-app/test/blind-peering-lifecycle.test.js` (suspend-before-close order)
