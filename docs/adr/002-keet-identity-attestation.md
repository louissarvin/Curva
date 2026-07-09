# ADR 002: Keet Identity Attestation Attaches to Presence, Not Every Message

## Context

Curva peers can hold a portable identity backed by `keet-identity-key@3.2.0`.
A user's identity is a 24-word BIP-39 mnemonic that survives reinstall; each
install has a fresh device keypair signed under the identity via
`IdentityKey.bootstrap(devicePublicKey)`. The public verify path
(`pear-app/node_modules/keet-identity-key/index.js:138`) returns:

```
null | { receipt, identityPublicKey, devicePublicKey }
```

The naive design is to attach an `identity_proof` field to every chat message
and re-verify on the receiver. That works but has real cost: each proof is
130-4096 bytes on the wire and each verify walks the identity chain
(non-trivial in a hot chat loop).

Docs consulted: https://github.com/holepunchto/keet-identity-key (README:
"info = IdentityKey.verify(proof, attestedData, opts)").

## Decision

Attach the identity proof to PRESENCE frames only. Verify once at presence
time, cache the resolved `{identityPublicKeyHex, devicePublicKeyHex}` in a
room-scoped `verifiedPeerCache` (Map<peerId, verifyResult>), and reference the
cache when rendering messages.

Implementation:

1. `bare/keetIdentity.js` exports a stateless `verifyPeerProof(proof, attestedData)`
   that returns `{ok: true, identityPublicKeyHex, devicePublicKeyHex}` or
   `{ok: false}`.
2. `bare/room.js` owns `verifiedPeerCache`. `registerPeerProof(peerId, proof,
   attestedData)` verifies + caches; `getVerifiedPeer(peerId)` reads;
   `forgetPeer(peerId)` clears on disconnect. All entries dropped on room close.
3. Presence frames from remote peers carry `identityProof` + `attestedData`.
   The room verifies and emits `peer:verified` + `peer:verified-count` events
   through the existing preload surface.
4. Chat rows lookup sender in the presence cache and render a verified shield
   next to the handle when the sender's peer id has a cached verify result.

Sensitive messages (system:tip, system:attendance-issued) still carry a
per-message `identity_proof` because the receiver may not have seen the
sender's presence frame yet (join-after-tip race).

## Consequences

Positive:
- Message-path stays cheap: chat rendering does NOT walk the identity chain.
- Verify-once means the trust decision is stable for the session; the
  renderer paints a consistent shield.
- The room presence cache is the single source of truth for the
  "N verified" subheader in `RoomHeader.js`.

Negative:
- A peer that disconnects then reconnects with a stolen device seed and no
  proof would be marked "unverified" until it re-attests. This is desirable
  from a trust perspective but requires the presence frame to be re-sent on
  every reconnect (already true in Wave 15).
- The cache is per-room; a peer that hops rooms re-verifies on each join.

Alternatives rejected:
- Per-message attestation everywhere: rejected on cost, plus makes retrofitting
  legacy peers hard because they cannot produce a proof.
- Trust-on-first-use with no verify: rejected because it defeats the point of
  the Keet identity primitive.

## References

- https://github.com/holepunchto/keet-identity-key (README, § API)
- `pear-app/node_modules/keet-identity-key/index.js:138-193` (verify contract)
- `pear-app/bare/keetIdentity.js` (`verifyPeerProof` export)
- `pear-app/bare/room.js` (`verifiedPeerCache` + presence surface)
- `pear-app/test/keet-identity.test.js` (tampered-proof rejection tests)
