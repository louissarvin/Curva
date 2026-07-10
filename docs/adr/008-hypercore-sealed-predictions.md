# ADR 008: Sealed Predictions via Hypercore Block Encryption

## Context

Wave 3 F3 adds sealed-bid predictions: a peer submits their pick to a per-peer
hypercore BEFORE kickoff, and the host reveals the encryption key at kickoff.
The design requirements are:

1. Peers replicating another peer's hypercore MUST NOT be able to decode picks
   before reveal.
2. After reveal, anyone with the key can decode. Non-repudiation comes from
   Autobase's ordered append, not from the encryption layer.
3. The host must not need to persist a per-epoch key; it should be derivable.
4. Failed decrypts (wrong key, unrevealed epoch) MUST NOT let a caller
   distinguish "wrong key" from "not yet revealed" via error text.

Docs consulted:
- https://docs.pears.com/reference/building-blocks/hypercore/#new-hypercorestorage-options (fetched 2026-07-10)
- Installed `pear-app/node_modules/hypercore/index.js:1394` (`getEncryptionOption`)
- Installed `pear-app/node_modules/hypercore-crypto/index.js:127` (`hash([buffers])`)
- Hypercore default encryption cipher: XChaCha20-poly1305 (see
  `pear-app/node_modules/hypercore/lib/default-encryption.js`)

The reveal path has an additional constraint: the chat reducer body
(`bare/chat.js`) does not currently accept a `system:reveal` type. Adding a new
system type touches the reducer, which is must-not-touch under ADR 006. So the
reveal must ride an alternate path.

## Decision

1. **Symmetric key derivation via BLAKE2b-256.** `deriveSealKey({slug, epoch,
   hostSecret})` returns a 32-byte Buffer:
   ```
   hcCrypto.hash([SEALED_PREDICTIONS_NAMESPACE, slug, epoch, hostSecret])
   ```
   (`bare/predictions.js:849-869`). The namespace prefix
   (`curva/sealed-predictions`) prevents key reuse across subsystems that also
   feed the same tuple into BLAKE2b. `hostSecret` MUST be at least
   `HOST_SECRET_MIN_BYTES = 16` (`bare/predictions.js:69`, `:860-861`).
2. **Per-peer hypercore with block encryption.** Each peer opens
   `store.get({name: sealedCoreName({slug, epoch, peerPubkey}), encryptionKey})`
   where `encryptionKey` is the 32-byte derived Buffer. Hypercore encrypts each
   block with XChaCha20-poly1305 at write time (`bare/predictions.js:942`).
   Peer-scoping the core by pubkey lets the reader attribute picks after
   reveal without leaking who wrote what before reveal.
3. **`encryptionKey` field (legacy), not `encryption`.** Hypercore supports
   both `encryptionKey` (legacy) and `encryption` (new) in `getEncryptionOption`.
   We use `encryptionKey` because it is stable across the current Pear
   runtime and matches the installed default cipher path
   (`bare/predictions.js:57`).
4. **Silent-null on decrypt failure.** `readSealedPrediction` returns `null`
   for both wrong-key and not-yet-revealed cases. The caller MUST NOT
   pattern-match on error strings; a `null` means "unrevealed OR undecryptable
   from this peer's vantage" (`bare/predictions.js:957`). This blocks a timing
   or error-text side-channel that would let a caller distinguish the two.
5. **Reveal via renderer broadcast, not chat reducer.**
   `revealPredictions({chat, slug, epoch, encryptionKey, myPubkey})` broadcasts
   the reveal event on the renderer's IPC channel because `chat.sendSystem`
   would need a new `system:reveal` type inside the reducer, and adding new
   system types is out of scope while ADR 006's must-not-touch posture holds.
   Documented at `bare/predictions.js:1009-1032`.

## Consequences

Positive:
- Peers can pre-seed their sealed cores freely; there is nothing to decode
  until reveal. The blind peer (ADR 003) can also mirror the encrypted cores
  without ever seeing plaintext.
- Key derivation is stateless. A restart of the host reproduces the exact same
  key from `(slug, epoch, hostSecret)` so a crash between seal and reveal is
  recoverable.
- Silent-null closes the "when-was-this-revealed" side-channel.

Negative:
- Symmetric key means any peer with the reveal broadcast can decrypt every
  entry in the epoch. This is intentional (see `bare/predictions.js:64-67`)
  but must be understood by callers: sealed predictions hide until reveal,
  they do not enforce per-viewer permissions after reveal.
- The reveal-via-renderer path bypasses Autobase's replay guarantees. A peer
  that missed the renderer broadcast has to re-request the epoch key on
  rejoin. Acceptable for the current watch-party session lifetime.
- A future `system:reveal` chat type would supersede this design. It is
  explicitly staged behind the ADR 006 chat-reducer moratorium.

Alternatives rejected:
- **Asymmetric key per pick.** Rejected because it would need per-peer key
  distribution before submission, defeating the "pre-seed freely" property.
- **`system:reveal` chat append now.** Rejected because it forces a reducer
  change under ADR 006.
- **Persisted per-epoch keys.** Rejected because derivable keys survive a host
  crash without a separate secure-store dependency.

## References

- https://docs.pears.com/reference/building-blocks/hypercore/#new-hypercorestorage-options (fetched 2026-07-10)
- `pear-app/node_modules/hypercore/index.js:1394` (getEncryptionOption)
- `pear-app/node_modules/hypercore-crypto/index.js:127` (BLAKE2b-256 hash)
- `pear-app/node_modules/hypercore/lib/default-encryption.js` (XChaCha20-poly1305)
- `pear-app/bare/predictions.js:68-71` (namespace + constants)
- `pear-app/bare/predictions.js:849-869` (deriveSealKey)
- `pear-app/bare/predictions.js:875-879` (sealedCoreName)
- `pear-app/bare/predictions.js:908-957` (write + read sealed prediction)
- `pear-app/bare/predictions.js:1009-1032` (revealPredictions broadcast)
