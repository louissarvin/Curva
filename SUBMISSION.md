# Curva - Tether Developers Cup 2026 Submission

## Track and team

| Field | Value |
|-------|-------|
| Primary track | **Pears** (Holepunch P2P stack) |
| Cameo tracks | **WDK** (gasless USDT tips), **QVAC** (on-device AI) |
| Team | Indonesia |
| Contact | `eternate17@gmail.com` |
| Submission deadline | 2026-07-08 23:59 GMT-7 |
| Live pitch date | 2026-07-15 |

## Elevator pitch

Curva is a peer-to-peer World Cup 2026 watch-party where two fans anywhere in the world open the same room on a `pear://` link and share a synced playhead, on-device translated chat, and gasless USDT tips. Thirteen Pears building blocks run in every session. A real Sepolia EIP-3009 facilitator settles USDT tips in seconds without the tipper holding gas.

## What we built

**Pears layer.** A Pear Electron dual-runtime app that exercises Hyperswarm, HyperDHT, Corestore, Hypercore, Hyperbee, Autobase (Pattern B multi-writer), Hyperdrive, Hyperblobs, hypercore-blob-server, blind-peering, keet-identity-key 3.2.0, pear-updater, and pear-electron. Every one is verifiable at runtime via `GET /pears/status`. Rooms survive host disconnect through blind peer replication against key `nm5j8618j8jhbc5rrjtemkixqjes4ngzc36nc9pf1jop8u4kt1fy`.

**WDK layer.** A Curva-branded EIP-3009 USDT token at `0x6F51d2428AD208eb1cdE38e5CF7C0D7E2c5E7739` on Sepolia, deployed via Foundry from [`contracts/src/CurvaUSDT.sol`](contracts/src/CurvaUSDT.sol). Tipping peers sign `TransferWithAuthorization` in the browser; a funded sponsor at `0x56aD1b91861e4aFf723bAFD8C42723F70F4D2C58` (1M USDT + 0.018 ETH) submits it. Sample transaction: [`0xf2a04d0126068769d88d027e5407bdd578ed6986a220907bc7bc5960b963f40e`](https://sepolia.etherscan.io/tx/0xf2a04d0126068769d88d027e5407bdd578ed6986a220907bc7bc5960b963f40e).

**QVAC layer.** Three real on-device models shipped with the app, all through `@qvac/sdk@0.14`. Qwen3 0.6B Q4 (about 364 MB) drives a room commentator. Whisper Tiny plus Silero VAD handles STT. Supertonic multilingual TTS voices goal announcements. Every capability is feature-flag gated and runs with zero network calls after initial download.

## Live artifacts

| Artifact | Value |
|----------|-------|
| Pear versioned link | `pear://0.22823.hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy` |
| Pear unversioned link | `pear://hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy` |
| Sepolia contract | [`0x6F51d2428AD208eb1cdE38e5CF7C0D7E2c5E7739`](https://sepolia.etherscan.io/address/0x6F51d2428AD208eb1cdE38e5CF7C0D7E2c5E7739) |
| Facilitator sponsor | [`0x56aD1b91861e4aFf723bAFD8C42723F70F4D2C58`](https://sepolia.etherscan.io/address/0x56aD1b91861e4aFf723bAFD8C42723F70F4D2C58) |
| Sample gasless tip tx | [`0xf2a04d0126068769d88d027e5407bdd578ed6986a220907bc7bc5960b963f40e`](https://sepolia.etherscan.io/tx/0xf2a04d0126068769d88d027e5407bdd578ed6986a220907bc7bc5960b963f40e) |
| Blind peer key | `nm5j8618j8jhbc5rrjtemkixqjes4ngzc36nc9pf1jop8u4kt1fy` |
| Web site | Deployed via [`web/vercel.json`](web/vercel.json) on Vercel |
| Repo | This repository |
| Demo video | Populated on submit |

## What runs where

The Pear app runs on the peer's machine. Every P2P primitive (Hyperswarm room discovery, Autobase multi-writer playhead and chat, per-peer Hyperdrive for clips, QVAC inference, WDK signing) executes locally.

The Companion backend is Fastify 5 on Bun at port 3700. It is optional public-good infra: it seeds room topics through blind peering, indexes Sepolia USDT tips, mirrors QVAC models, and hosts the EIP-3009 facilitator that sponsors gas for signed transfer authorisations. When it is unreachable, peers still find each other through the DHT and rooms still work; only sponsored tips and indexed leaderboards degrade.

The Sepolia contract is the EIP-3009-capable Curva USDT token. It is the only piece of infrastructure Curva does not own end to end, by design.

## Novelty

- **All three Tether pillars in one running app.** Not three separate demos. The same `pear run` command boots the Pears runtime, wakes the WDK wallet, loads the QVAC commentator, and connects to the blind peer. Judges do not switch contexts.
- **Real gasless USDT with a Curva-issued EIP-3009 token.** We deployed a `Tether USD` symbol token on Sepolia with real EIP-3009 metadata (name, symbol, decimals, version) so the WDK flow is not a mock. The facilitator sponsor is funded and submitting on chain.
- **Blind peering keeps rooms alive when the host leaves.** Both the chat Autobase and the playhead Autobase register with our blind peer. The host can close their laptop and other peers continue chatting and staying in sync. That is not the default Pears path; it is a deliberate integration.

## Judge quick-verify

Three commands. Under two minutes. Nothing rehearsed.

```bash
# 1. Run the live Pear app (requires pear-runtime)
pear run pear://hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy
```

```bash
# 2. Prove 13 Pears primitives are alive at runtime
curl -s http://localhost:3700/pears/status | jq
```

```bash
# 3. Fire a real Sepolia gasless USDT tip (facilitator sponsors gas)
curl -sS -X POST http://localhost:3700/wdk/relay/demo-self-tip \
  -H 'Content-Type: application/json' \
  -d '{"amount":"1000000"}'
```

The last response returns a Sepolia tx hash. Open it on Etherscan to see the `AuthorizationUsed` and `Transfer` events.

For the current Pear alias without hardcoding, run `curl -s http://localhost:3700/distribution` and read the `pear://` key it returns.

## Known limitations

- Cross-machine NAT hole-punching is not yet proven across public networks; the `relayThrough` fallback exists in code but has not been stress-tested at scale.
- The blind peer currently runs on the host laptop, not on a dedicated always-on node. Room survival works but is only as reliable as the machine hosting it.
- QVAC models add about 500 MB to first-run download. Subsequent runs are instant, but judges on a hotel WiFi should expect the first `pear run` to take a few minutes for model fetch.
- Every USDT figure and transaction in the submission is on Sepolia testnet only. No mainnet path is enabled.
- Desktop builds shipped as `.dmg` are unsigned; macOS Gatekeeper will warn on first open.

## Roadmap

- Mainnet EIP-3009 facilitator with a permissioned sponsor allowance and per-user daily caps.
- Ingest real HLS broadcast segments for hosts with rights, with the Autobase playhead pinning segment offsets instead of local-file timestamps.
- Signed DMG and MSI installers for macOS and Windows.
- Dedicated always-on blind peer node with health checks and a public status page.
- Full QVAC translation pivot (12 EN-hub Bergamot pairs) wired end to end into the chat lane.

---

**Bola untuk semua. Forza Curva.**
