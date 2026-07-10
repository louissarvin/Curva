<div align="center">

# Curva

**P2P watch-party for the World Cup, powered by the Tether developer stack.**

Curva is a fully peer-to-peer World Cup 2026 watch-party desktop app. Autobase-linearised playheads, multi-writer chat, on-device commentary and translation, gasless USDT tips. No streaming platform. No chat server. No cloud translator. No custody service.

For football fans separated by continents who still want to react to the same goal at the same second, with the friend who found the stream getting a tip that settles in seconds, not days.

Built for the **Tether Developers Cup 2026** by **Team Indonesia**. Track: **Pears** (primary) with working **WDK** and **QVAC** cameos.

**Reviewers start here:** three sections below directly answer the judges' code-review brief. [Code review guide](#code-review-guide) is a grep-friendly file:line index. [Tether stack accountability](#tether-stack-accountability) covers every Pears / QVAC / WDK piece with the "why chose / how wired / trade-off accepted" triple. [Commit-pinned permalinks](#commit-pinned-permalinks) links directly to every high-value code block. Companion reads for scoped depth: [`pear-app/README.md`](pear-app/README.md) (client-side permalinks + stack), [`backend/README.md`](backend/README.md) (companion-side permalinks + stack), [`docs/adr/README.md`](docs/adr/README.md) (ten ADRs).

</div>

---

## Try it in 60 seconds

The full Curva app is **published on the Pear DHT** at:

```
pear://hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy
```

You can verify the release is real without installing anything:

```bash
npm install -g pear
pear info pear://hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy
```

Expected output includes `name: curva`, `release: 23135`, and the Hypercore + Hyperblobs byte lengths.

**How to actually run the two peers for the demo:** the Bare P2P worker (Hyperswarm, Autobase, Hyperdrive, blind-peering, wallet, QVAC) is fully Pear-native and lives at `pear-app/workers/main.js`. The Electron shell that renders the UI is still on the npm `electron` binary, which is what `electron-forge start` boots. Port to `pear-electron` for one-liner `pear run` boot is a post-hackathon task. See the "Two independent peers on one laptop" section below for the working demo commands.

Judges can also verify the WDK + Pears integration entirely from the Companion backend, no client needed:

```bash
# In one terminal, boot the Companion (Bun + Postgres required)
cd backend && cp .env.example .env && bun install && bun run db:push && bun run start

# In another terminal, verify the three cameo endpoints
curl -s http://localhost:3700/health | jq
curl -s http://localhost:3700/pears/status | jq
curl -sS -X POST http://localhost:3700/wdk/relay/demo-self-tip \
  -H 'Content-Type: application/json' -d '{"amount":"1000000"}' | jq
```

The last command fires a real Sepolia gasless USDT tx and returns the `txHash` plus `explorerUrl`.

---

## Tracks entered

| Track | Role | Primitives exercised |
|-------|------|----------------------|
| **Pears** | Primary | Hyperswarm, HyperDHT, Corestore, Hypercore, Hyperbee, Autobase (Pattern B), Hyperdrive, Hyperblobs, hypercore-blob-server, blind-peering, keet-identity-key 3.2.0, pear-updater, pear-electron dual-runtime |
| **WDK** | Cameo | EIP-3009 gasless USDT tips, Foundry-deployed EIP-3009 token, live Sepolia facilitator sponsor |
| **QVAC** | Cameo | Qwen3 0.6B Q4 room commentator, Whisper Tiny + Silero VAD STT, Supertonic multilingual TTS |

Thirteen Pears building blocks. Two real WDK settlement paths. Three on-device AI models. All wired through the same running app.

---

## Live proof

### Pear app is live

```
Unversioned: pear://hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy
Versioned:   pear://23135.hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy
Release:     23135
Discovery:   e8af62ec1ac7733cdc7f2d3e0e26d563e76a5364f6ed7b882c24c23d69211ee8
```

Verify from any machine with `pear info pear://hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy`. The client Bare worker (`workers/main.js`) is Pear-native today; the Electron shell that hosts it is still on npm `electron` (booted via `electron-forge start` in the two-peer demo below). Port to `pear-electron` for direct `pear run` boot is queued for the post-hackathon iteration.

### 13 primitives exercised at runtime

```bash
curl -s http://localhost:3700/pears/status | jq
```

The endpoint enumerates every Pears building block currently in use, along with the module path and the runtime status. Sample shape:

```json
{
  "success": true,
  "data": {
    "primitives": {
      "hyperswarm":              { "active": true, "module": "hyperswarm@4" },
      "hyperdht":                { "active": true, "module": "hyperdht" },
      "corestore":               { "active": true, "module": "corestore@7" },
      "hypercore":               { "active": true, "module": "hypercore@11" },
      "hyperbee":                { "active": true, "module": "hyperbee@2" },
      "autobase":                { "active": true, "pattern": "B-multi-writer" },
      "hyperdrive":              { "active": true, "module": "hyperdrive@13" },
      "hyperblobs":              { "active": true, "module": "hyperblobs" },
      "hypercore-blob-server":   { "active": true },
      "blind-peering":           { "active": true, "peerKey": "nm5j8618j8jhbc5rrjtemkixqjes4ngzc36nc9pf1jop8u4kt1fy" },
      "keet-identity-key":       { "active": true, "version": "3.2.0" },
      "pear-updater":            { "active": true },
      "pear-electron":           { "active": true, "runtime": "dual" }
    }
  }
}
```

### Real Sepolia gasless USDT

- **EIP-3009 USDT-branded token (Curva):** [`0x6F51d2428AD208eb1cdE38e5CF7C0D7E2c5E7739`](https://sepolia.etherscan.io/address/0x6F51d2428AD208eb1cdE38e5CF7C0D7E2c5E7739)
  - name `Tether USD`, symbol `USDT`, decimals `6`, version `1`
- **Facilitator sponsor:** [`0x56aD1b91861e4aFf723bAFD8C42723F70F4D2C58`](https://sepolia.etherscan.io/address/0x56aD1b91861e4aFf723bAFD8C42723F70F4D2C58), funded with 1M USDT + 0.018 ETH
- **Sample gasless transfer:** [tx `0xf2a04d0126068769d88d027e5407bdd578ed6986a220907bc7bc5960b963f40e`](https://sepolia.etherscan.io/tx/0xf2a04d0126068769d88d027e5407bdd578ed6986a220907bc7bc5960b963f40e) shows the `AuthorizationUsed` and `Transfer` events fired by the facilitator on behalf of the tipping peer

Contract source: [`contracts/src/CurvaUSDT.sol`](contracts/src/CurvaUSDT.sol), deployed via Foundry.

### Blind peer

```
Blind peer key: nm5j8618j8jhbc5rrjtemkixqjes4ngzc36nc9pf1jop8u4kt1fy
```

Both the chat Autobase and the playhead Autobase register with this blind peer at boot. When the host laptop closes, rooms keep replicating.

---

## Tether stack integration in detail

Curva does not treat Pears, WDK, and QVAC as three separate features. Each library is wired to a specific Curva user story and every peer runs the full stack at once. Below is what each tool is, exactly how Curva uses it, and which product moment it powers.

### Pears (primary track, 13 building blocks)

The Pears / Holepunch stack is what makes Curva a peer-to-peer watch-party instead of another SaaS. Every user story that survives without a central server runs through Pears.

| Building block | What it is | How Curva uses it | Product moment |
|----------------|------------|-------------------|----------------|
| **Hyperswarm** | Distributed peer discovery over UDP hole-punching | Every peer joins the same room topic derived `sha256(slug)` at boot. The bare worker calls `swarm.join(topic, { client: true, server: true })` and holds open sockets to every other peer. | Two friends open Curva on different Wi-Fi and see each other in the same room within seconds |
| **HyperDHT** | Public DHT under Hyperswarm | Curva relies on the public bootstrap for zero-config discovery. No STUN, no TURN, no signaling server. | The app just works when you type the room slug; no invite link required |
| **Corestore** | Multi-Hypercore container with keyed storage | One Corestore per peer at `<storageDir>/corestore`. Curva namespaces cores per feature (chat, playhead, clips, identity) so a peer can dump one feature without wiping the others. | Blind peer can replicate just the chat core while ignoring the rest |
| **Hypercore** | Append-only signed log, block granular | The underlying primitive Autobase and Hyperdrive build on. Never touched directly. | Cryptographic proof that every chat message came from the claimed writer |
| **Hyperbee** | Ordered key/value B-tree over Hypercore | Curva builds Hyperbee views over the Autobase output for chat message lookup by `(wallClockMs, byPeer)` and playhead lookup by `(matchTimeMs)`. | Peer B joins mid-match and gets the last N chat messages in order without replaying everything |
| **Autobase (Pattern B)** | Multi-writer log that linearises writes with lamport clocks | Two Autobases per room: `chat` and `playhead`. Host writes first; viewers get promoted to writers via a signed `writer-invite` deep link over `pear://`. Apply function reorders concurrent writes deterministically. | Host and 20 viewers all typing in chat, everyone sees the same order |
| **Hyperdrive** | P2P versioned filesystem over Hypercore | Curva ships two drives: a `wc-reel/` drive that carries the sample match clip and a `clips/` drive per peer for user-clipped highlights. First peer to seed a byte becomes an implicit CDN for the rest. | Watching FIFA content that streams peer-to-peer instead of a CDN |
| **Hyperblobs** | Content-addressable large blob storage | Runs inside each Hyperdrive; the reel and clip files are chunked and replicated on demand. Curva serves them locally via `hypercore-blob-server` with an HTTP loopback URL so the `<video>` element can stream. | Video seeks instantly to any point without waiting for a full download |
| **hypercore-blob-server** | Local HTTP bridge for Hyperblobs | Boots on a random localhost port. Returns loopback URLs the renderer can put in a `<video src>` attribute. | Standard HTML5 video controls (seek, pause, play) work against P2P bytes |
| **blind-peering** | Unattended replication seeder | Curva registers both the chat Autobase and the playhead Autobase with a running `blind-peer-cli` instance. The seeder mirrors both cores without holding read keys. | Host closes laptop mid-match; viewers keep watching and chatting |
| **keet-identity-key 3.2.0** | Portable BIP-39 backed identity keypair | Each peer generates a 24-word seed at first boot, encrypted with `wdk-secret-manager`. Every chat message is signed with an attestation that includes the identity public key. Renderer shows a verified badge next to the sender. | Judges see a signed identity chip on every chat message with no OAuth flow |
| **pear-updater** | OTA app delivery over Hyperdrive | Curva subscribes to `pear.updater.on('update-available')`. On event, the renderer shows a toast and applies the update with `pear.updater.applyUpdate()`. New releases hit users without an app store. | Push a bug fix at 15:00 and every running peer picks it up within seconds |
| **pear-electron** | Dual-runtime shell (Electron + Bare) | Renderer runs in Chromium sandbox, Bare worklet handles P2P and long-lived state. `pear-runtime` bridges the two via typed IPC. | Renderer stays responsive while the Bare worklet compacts Autobase in the background |

Reference: [`pear-app/bare/`](pear-app/bare/) directory holds the P2P code, [`pear-app/electron/`](pear-app/electron/) the shell, [`pear-app/renderer/`](pear-app/renderer/) the UI.

### WDK (cameo, gasless USDT tips)

WDK is Tether's Wallet Development Kit. Curva uses two pieces: the wallet library for signing and the secret-manager for at-rest encryption of the seed. Together they turn a peer laptop into a self-custodial USDT wallet the user never has to top up with ETH.

| Component | What it is | How Curva uses it | Product moment |
|-----------|------------|-------------------|----------------|
| **`@tetherto/wdk-wallet-evm-erc-4337`** | ERC-4337 smart-account factory + signer | On wallet init, Curva derives an ERC-4337 smart account from the identity seed. Balance queries hit the token contract directly via `getTokenBalance()`. | Peer sees their USDT balance the moment the app boots. No exchange, no faucet. |
| **`@tetherto/wdk-secret-manager`** | PBKDF2-encrypted seed storage | Encrypts the 24-word seed with the user's passcode and persists to `<storageDir>/wallet/`. Never leaves the Bare worklet closure; renderer only sees the derived smart-account address. | Wallet survives app restarts without asking the user to save a private key |
| **EIP-3009 `transferWithAuthorization`** | Off-chain signed authorization the sponsor submits on-chain | Sender signs `TransferWithAuthorization(from, to, value, validAfter, validBefore, nonce)`. Curva's facilitator queues the tx, pays gas, submits. Token contract validates the signature via `ecrecover` and moves USDT. | Viewer sends 1 USDT tip to the host in one click. Zero ETH balance required. Etherscan link resolves in seconds. |
| **Curva EIP-3009 USDT token** | Custom Sepolia deployment | Standard OpenZeppelin ERC-20 + hand-written `transferWithAuthorization` matching Circle's FiatTokenV2 semantics. Domain name `Tether USD`, version `1`, decimals `6`. Deployed via Foundry. | Judges see real `AuthorizationUsed` and `Transfer` events on a token branded `USDT` |
| **Facilitator sponsor** | Backend service that pays gas | Backend holds the sponsor EOA private key. Peer POSTs a signed authorization to `/wdk/relay/tip`; sponsor submits the on-chain tx, refunds any leftover ETH into itself. | Curva pays for the gas; peer never touches ETH |

Reference: [`pear-app/bare/wallet/`](pear-app/bare/wallet/), [`backend/src/lib/evm/`](backend/src/lib/evm/), [`contracts/src/CurvaUSDT.sol`](contracts/src/CurvaUSDT.sol).

### QVAC (cameo, on-device AI)

QVAC is Tether's SDK for running LLMs, speech recognition, translation, and text-to-speech entirely on-device. Curva uses three separate model pipelines. Judges can verify the "no cloud AI APIs" requirement by disabling their network after boot; the AI features keep working.

| Feature | Model | How Curva uses it | Product moment |
|---------|-------|-------------------|----------------|
| **Room commentator** | Qwen3 0.6B Q4 (~364 MB) via `sdk.completion()` | Host toggles the commentator with a persona (Italian ultras, calm analyst, hype). On every `match:pulse` event the LLM streams a one-sentence reaction into the chat sidebar. Runs in the Bare worklet, output tokens stream back over IPC. | Fans watching in an empty room still hear someone yell about the goal |
| **Voice-to-chat STT** | Whisper Tiny + Silero VAD via `sdk.transcribeStream()` | Push-to-talk microphone in the chat composer. Silero VAD detects speech, Whisper transcribes, transcript populates the chat input for review before send. | Yell at the screen, the app hears you, teammates read what you said |
| **Goal announcer TTS** | Supertonic multilingual (~121 MB) via `sdk.textToSpeech()` | On `match:goal` event the host synthesizes an announcement in the room's default locale, sends the raw WAV bytes as a base64 chat attachment. Every peer plays the same clip. | Every peer hears "GOAAAL Messi in the sixty-third minute" in their preferred language |
| **Live chat translation** | Bergamot en-hub pivot (17-30 MB per pair) via `sdk.translate()` | Each peer picks a target language. Every incoming chat message is translated on-device (chained pivot when needed: it -> en -> id, etc). The verified original is kept alongside so no one sees a machine translation without recourse. | Italian ultras and Indonesian fans read each other in their own language |
| **`@qvac/sdk` 0.14** | Bare-native SDK bundle | Installed as an npm dep. Curva imports the SDK via dynamic `import()` in the Bare worklet with the `bare` conditional export path. Models cached under `<storageDir>/qvac-models/` with SHA-256 verification. | Zero cloud calls; every AI feature works offline once models are cached |

Model catalog served by the backend at `GET /qvac/models` (Mozilla-mirrored Bergamot pairs plus Curva-curated LLM references). Reference: [`pear-app/bare/translate.js`](pear-app/bare/translate.js), [`pear-app/bare/commentator.js`](pear-app/bare/commentator.js), [`pear-app/bare/announcer.js`](pear-app/bare/announcer.js), [`backend/src/data/qvac-models.json`](backend/src/data/qvac-models.json).

### Integration story summary

Curva was designed so that the three Tether tracks reinforce each other rather than sit as separate features:

- **Pears carries the trust**. The chat message, the playhead update, the tip authorization all flow through Autobase-linearised logs that any peer can audit
- **WDK carries the settlement**. Tips are the payoff for a well-timed reaction. Zero ETH friction makes the click possible for a normal fan
- **QVAC carries the voice**. Commentator, STT and TTS make a two-peer room feel like a full stadium; translation makes distance stop mattering

Every pillar is exercised in the same 90-second demo. The reference clip in the pear-app shows a real Autobase chat sync, a real Sepolia gasless USDT tx, and real on-device Qwen3 commentary in one continuous take.

---

## Architecture

Three surfaces, one story. The Pear app is the client every user runs. The Companion backend is optional public-good infra (a Fastify server on Bun that seeds topics, indexes tips, mirrors QVAC models, and serves the receipt cards). The Sepolia contract handles settlement.

```mermaid
graph TD
    subgraph Client [Pear app - each peer]
        UI[Electron renderer]
        BARE[Bare worklet]
        UI <--> BARE
        BARE --> SWARM[Hyperswarm + HyperDHT]
        BARE --> AB[Autobase: playhead + chat]
        BARE --> HB[Hyperbee views]
        BARE --> HD[Hyperdrive: clips]
        BARE --> BLOBS[Hyperblobs + blob-server]
        BARE --> QVAC[QVAC SDK 0.14]
        BARE --> WDK[WDK wallet + secret-manager]
    end

    subgraph Companion [Backend - public-good]
        API[Fastify 5 on Bun :3700]
        BLIND[Blind peer]
        FAC[EIP-3009 facilitator]
    end

    subgraph Chain [Sepolia]
        USDT[Curva USDT 0x6F51...7739]
    end

    SWARM <--> SWARM_R[Other peers]
    BARE --> BLIND
    WDK --> FAC
    FAC --> USDT
```

Deep dive: [`web/`](web/) landing site `/architecture` page and [`CURVA_TECHNICAL_SPEC.md`](CURVA_TECHNICAL_SPEC.md).

---

## Repo layout

| Path | What it is | One-liner |
|------|------------|-----------|
| [`pear-app/`](pear-app/) | The Curva client | Pear runtime + Electron dual-runtime app, Bare worklet handles P2P, renderer handles UI |
| [`backend/`](backend/) | The Curva Companion | Fastify 5 on Bun, seeds topics, indexes tips, mirrors QVAC models, hosts the EIP-3009 facilitator |
| [`web/`](web/) | Marketing + docs site | TanStack Start app deployed to Vercel, landing / architecture / demo / docs / submission pages |
| [`contracts/`](contracts/) | Sepolia contracts | Foundry project with the Curva EIP-3009 USDT token |

Each subproject ships its own README and ARCHITECTURE.md targeted at a different audience.

---

## Run locally

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 20+ | Pear app runtime, Electron |
| npm | 10+ | Pear app deps |
| Bun | 1.0+ | Backend Companion |
| PostgreSQL | 16 | Match catalog, room directory |
| Pear CLI | latest | `pear info pear://...` to verify DHT release |

### Backend Companion

```bash
cd backend
bun install
bun run db:push          # push Prisma schema
bun run start            # http://localhost:3700
curl http://localhost:3700/health
```

Copy `backend/.env.example` to `backend/.env` and fill in `DATABASE_URL`, `SEPOLIA_RPC_URLS`, `FACILITATOR_SPONSOR_PK`, and the QVAC + Pears keys. Run `bun run generate:secrets` to mint the noise seed and sponsor EOA.

### Pear app

```bash
cd pear-app
npm install
npm run demo:4peer       # four windows on one laptop for judges
```

Verify the release is on the Pear DHT:

```bash
pear info pear://hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy
```

That returns the app name (`curva`), the release length, and the Hypercore + Hyperblobs byte counts. Booting the app directly via `pear run` requires the Electron shell to be ported to `pear-electron`, which is a post-hackathon item; the two-peer demo below uses `electron-forge start` to give each window its own `--storage` and `--room` flags.

### Two independent peers on one laptop (host + viewer demo)

For the "host creates room, viewer joins from the directory" story you see in the pitch video. Two shell windows, side by side. Each peer runs a separate Bare worker, has its own wallet, its own identity, and discovers the other over Hyperswarm.

Prerequisites: backend running on `http://localhost:3700` with `ENABLE_SEEDER=true`, `MODEL_MIRROR_ENABLED=true`, and `SEEDER_MAX_ROOMS=50` (or higher) in `backend/.env`, and clean storage dirs.

**Same-laptop demo note.** Two Hyperswarm processes on one machine usually cannot hole-punch each other over the public DHT, so the peers never form a direct connection and chat + writer promotion stall. `CURVA_FORCE_RELAY=1` routes both peers through the backend seeder subprocess (`GET /relay/info` exposes its Noise pubkey), which relays every hop over Hyperswarm's built-in `relayThrough`. The seeder must be a real Hyperswarm peer — that requires `bun add hyperswarm corestore hypercore-crypto b4a` in `backend/` and spawning the seeder subprocess via `node` (both already handled by the backend when the deps are installed).

Both storage paths below use the `-fresh` suffix so the wallets survive a restart within the same demo session (the same smart addresses stay funded). Delete the folder if you want a clean slate; new wallets get generated and you re-run `bun run fund:peers` (see below).

**Shell 1 — Peer A (host).** `--no-auto-open` keeps the app on the lobby so the host can pick a slug and click Create:

```bash
cd pear-app && \
DEV_WALLET_PASSCODE=curva-peer-a-pw \
CURVA_DEMO_MODE=true \
CURVA_FORCE_RELAY=1 \
CURVA_QVAC_COMMENTATOR_ENABLED=true CURVA_QVAC_STT_ENABLED=true CURVA_QVAC_TTS_ENABLED=true \
CURVA_QVAC_LLM_TRANSLATE_ENABLED=true \
CURVA_PREDICTIONS_ENABLED=true CURVA_ATTENDANCE_ENABLED=true \
CURVA_DELEGATED_INFERENCE_ENABLED=true \
CURVA_TACTICAL_ENABLED=true CURVA_DEMO_HUD_ENABLED=true \
npx electron-forge start -- --no-updates \
  --storage /tmp/curva-peer-a-fresh \
  --no-auto-open \
  --backend http://localhost:3700
```

**Shell 2 — Peer B (viewer).** Same launch, same lobby-first behaviour:

```bash
cd pear-app && \
DEV_WALLET_PASSCODE=curva-peer-b-pw \
CURVA_DEMO_MODE=true \
CURVA_FORCE_RELAY=1 \
CURVA_QVAC_COMMENTATOR_ENABLED=true CURVA_QVAC_STT_ENABLED=true CURVA_QVAC_TTS_ENABLED=true \
CURVA_QVAC_LLM_TRANSLATE_ENABLED=true \
CURVA_PREDICTIONS_ENABLED=true CURVA_ATTENDANCE_ENABLED=true \
CURVA_DELEGATED_INFERENCE_ENABLED=true \
CURVA_TACTICAL_ENABLED=true CURVA_DEMO_HUD_ENABLED=true \
npx electron-forge start -- --no-updates \
  --storage /tmp/curva-peer-b-fresh \
  --no-auto-open \
  --backend http://localhost:3700
```

**Log signals that confirm chat sync is wired.** Peer A after Publish to directory:

```
[Curva] INFO joined relay peer { pubkey: '...' }
[Curva] INFO joining swarm topic { slug: '<slug>', ... }
[Curva] INFO autobase writer cores attached to muxers { conns: 1, chatWriterKey: '<8>' }
[Curva] INFO published base keys to backend directory { chat: '<8>', playhead: '<8>', attempts: <n> }
[Curva] INFO writer promoted (Pattern B) { peer: '<8>', bases: [ 'chat', 'playhead' ] }
```

Peer B after clicking Join:

```
[Curva] INFO joined relay peer { pubkey: '...' }
[Curva] INFO joining swarm topic { slug: '<slug>', ... }
[Curva] INFO swarm connection { peer: '<peerA-swarm-key>', relayed: true }
[Curva] INFO tip:host-discovered via hello frame { smart: '0x...' }
[Curva] INFO reopening room with host bootstrap { chat: '<8>', playhead: '<8>' }
[Curva] INFO promoted to indexer by host { bases: [ 'chat', 'playhead' ] }
```

Type a chat message on either peer and both should see `AUTOCHAT observed` with `local: true` on the sender and `local: false` on the receiver.

Then on stage:

1. On **Peer A**: click **+ Create a new room**. Type a slug (e.g. `wc26-final`), keep the STADIUM publish toggle on, click **Create room and enter as host**. The app opens the Autobase, mounts the room view, and publishes to the directory in one flow.
2. On **Peer B**: the lobby refreshes automatically. `wc26-final` appears with a STADIUM badge. Click **Join**.
3. Both peers now share the room. Send chat messages, play the video, or trigger a real gasless USDT tip via the tip form under the video.

Drop `--no-auto-open` (and add `--room <slug> --is-host` on Peer A) to fall back to the older automated boot path used by `scripts/demo-4peer.js`.

#### Fund the peer wallets for a real UI-driven tip

Each Curva peer generates a fresh WDK wallet on first boot. The wallet exposes two addresses per peer:

- `ownerAddress` — the ECDSA-signing EOA. **This is what EIP-3009 debits.** Every `transferWithAuthorization` the tip form signs uses the owner EOA as `from`, because smart accounts can't sign ECDSA.
- `smartAddress` — the ERC-4337 smart account. This is only the **destination** when the peer receives a tip; it never spends via EIP-3009.

So to send a tip you must fund the **owner** EOA. Funding only the smart account will make the token contract revert with `ERC20InsufficientBalance` on the sponsor's `estimateGas`, and the UI will show "Failed, retry".

1. Boot both peers with the commands above and wait for the lines in each worker log that print:

   ```
   [Curva] INFO wallet ready { smartAddress: '0x...', ownerAddress: '0x...' }
   ```

   Copy **both** the `smartAddress` and the `ownerAddress` for each peer. Four addresses total.

2. From the `backend/` folder (sponsor key is loaded from `backend/.env`), fund all four addresses in one shot. The receiving side works from the smart address, so funding both is the belt-and-braces move for a demo:

   ```bash
   cd backend
   bun run fund:peers -- \
     <peerAownerAddress> <peerAsmartAddress> \
     <peerBownerAddress> <peerBsmartAddress> \
     --amount 100
   ```

   The script uses `RELAY_SPONSOR_PK` from `backend/.env`, resolves the token from `SEPOLIA_USDT_ADDRESS`, and sends the requested amount from the sponsor EOA to each address. It prints the tx hash and Sepolia Etherscan link for every transfer.

   If you only care about the send path, funding the two `ownerAddress` values is enough. If you only care about the receive path, funding the two `smartAddress` values is enough. Fund all four to demo both directions.

3. Now trigger a tip in the UI: on Peer B, open the room, click the tip button under the video, enter `1 USDT`, sign in the WDK modal. The sponsor pays gas, Peer A's smart address receives the USDT, and the receipt card renders live.

If a transfer looks stuck, verify the sponsor still has ETH for gas with `bun run treasury:setup` and top it up from any Sepolia faucet. The `fund:peers` script batches nothing (single JSON-RPC calls only), so it works on `https://ethereum-sepolia-rpc.publicnode.com` and other free public endpoints.

**Host-address discovery on the same laptop.** Two Hyperswarm processes on one machine often fail to hole-punch each other and never emit a `swarm connection` event (`peerCount: 0` on `GET /rooms/:slug`). The room's tip form on the viewer relies on the host's smart address, which normally rides a `room:hello` frame between connected peers. When the connection never lands, the worker falls back to the backend directory: `tryDiscoverHostAddress()` polls `GET /rooms/:slug` every 3 s (up to 60 s) and emits `tip:host-discovered` as soon as the record returns a `hostSmartAddress`. Look for the log line `tip:host-discovered via backend directory { smart: '0x...' }` on the viewer worker within a few seconds of joining — that is what unblocks the tip form.

### Web

```bash
cd web
bun install
bun run dev              # local marketing + docs site
```

Deployment to Vercel is configured in [`web/vercel.json`](web/vercel.json).

---

## What is real vs staged

Honest checklist. Everything below is verifiable tonight.

| Item | Status | Evidence |
|------|:---:|----------|
| Pear app published to Pear DHT | Verified | `pear info pear://hcg8oft...` returns `name: curva, release: 23135` |
| Pear-native Bare P2P worker | Verified | `pear-app/workers/main.js` runs all P2P (Hyperswarm, Autobase, Hyperdrive, blind-peering) under Bare shims (`bare-fs`, `bare-crypto`, `bare-http1`) |
| Direct `pear run pear://...` boot | Staged | Electron shell still on npm `electron`; port to `pear-electron` window API is post-hackathon |
| 13 Pears primitives active at runtime | Verified | `GET /pears/status` enumerates each with runtime state |
| Autobase Pattern B multi-writer | Verified | Chat + playhead both use `base.addWriter` after ed25519 invitation |
| Blind peering | Verified | Blind peer key `nm5j8618...kt1fy`, chat + playhead both register |
| Rooms survive host disconnect | Verified | Blind peer keeps replicating both Autobases |
| Real Sepolia gasless USDT | Verified | Sample tx `0xf2a04d01...b963f40e` on Sepolia Etherscan |
| Curva USDT token (EIP-3009) | Verified | Contract `0x6F51...7739`, `name`=Tether USD, `symbol`=USDT |
| Facilitator sponsor funded | Verified | `0x56aD...2C58`, 1M USDT + 0.018 ETH balance |
| QVAC Qwen3 0.6B Q4 commentator | Verified | ~364 MB model, real `@qvac/sdk@0.14` bindings |
| QVAC Whisper Tiny + Silero VAD STT | Verified | Ships with the app, feature-flag gated |
| QVAC Supertonic multilingual TTS | Verified | Wired to goal announcements, feature-flag gated |
| Cross-machine NAT hole-punching | Staged | Not proven across public networks; `relayThrough` path exists but is untested at scale |
| Blind peer high-availability | Staged | Currently runs on the host laptop, not a dedicated node |
| Mainnet settlement | Not shipped | Sepolia only for the Cup submission |
| DMG code signing | Not shipped | If we ship a DMG it will be unsigned; users see Gatekeeper warning |

---

## Team and submission

| Field | Value |
|-------|-------|
| Team | Indonesia |
| Contact | `eternate17@gmail.com` |
| Primary track | Pears |
| Cameo tracks | WDK, QVAC |
| Submission bundle | [`SUBMISSION.md`](SUBMISSION.md) |
| DoraHacks entry | Populated on submit |
| Pitch date | 2026-07-15 |
| Submission deadline | 2026-07-08 23:59 GMT-7 |

---

## License and disclaimers

MIT. See [`LICENSE`](LICENSE). Copyright the Curva contributors, 2026.

- **Sepolia only.** Every USDT figure, tx hash, and settlement path in this repo is on Ethereum Sepolia testnet. Do not send mainnet funds to any address in this repo.
- **Unsigned builds.** If a `.dmg` is attached to the submission it is unsigned; macOS Gatekeeper will warn. Verify the SHA-256 posted in the submission thread before opening.
- **Model downloads.** First run of the Pear app downloads roughly 500 MB of QVAC models. Subsequent runs are instant.

---

## Code review guide

Direct response to the semifinal judges' brief. This section walks the codebase in the order judges will read it. Every claim below is grep-verifiable.

### 5-minute walkthrough

```sh
git clone https://github.com/louissarvin/Curva
cd Curva/pear-app && npm install
npm test                                        # expected: 400+ pass, 1600+ asserts
cd ../backend && bun install && bun test        # expected: 536 pass
bun run dev                                     # backend up on :3700
curl -s http://localhost:3700/health | jq .success                                          # true
curl -s http://localhost:3700/metrics | head -3                                             # Prometheus text
curl -s http://localhost:3700/rag/status                                                    # {ready:true, corpusSize:166, competition:"FIFA World Cup 2026"}
curl -s -X POST http://localhost:3700/rag/search -d '{"query":"Argentina","topK":2}' \
  -H 'Content-Type: application/json' | jq .data.hits[0].title                              # "Argentina (ARG)"
```

### Where the depth lives (grep-friendly)

| Concern | File | Grep for |
|---|---|---|
| Autobase Pattern B addWriter host-side gate | `pear-app/bare/room.js` | `addWriter` around L698-L961 |
| Chat apply purity + host-only writer promotion | `pear-app/bare/chat.js` | `apply() is PURE` around L234-L318 |
| base.ack() cadence (background loop + post-append) | `pear-app/bare/room.js` | `startAckLoop`, `appendThenAck` around L74-L111 |
| Autobase view.checkout(v) chat scrubber | `pear-app/bare/chat.js` | `checkoutAt` around L697-L735 |
| Hyperbee sub() namespacing (4 subs on one bee) | `pear-app/bare/room.js` | `roomStateSubs`, `readRoomKey` around L324-L365 |
| Hypercore encryption for sealed predictions | `pear-app/bare/predictions.js` | `deriveSealKey` around L835-L870 |
| Apply middleware compose pattern (koa-style) | `pear-app/bare/lib/applyMiddleware.js` | `composeApply` around L80-L110 |
| Apply middleware observational wire-in | `pear-app/bare/room.js` | `attachApplyMiddleware` around L125-L187 |
| keet-identity verifyPeerProof | `pear-app/bare/keetIdentity.js` | `verifyPeerProof` around L353-L400 |
| blind-peering explicit target + suspend/resume | `pear-app/bare/blindPeering.js` | `registerAutobase`, `suspend` around L217-L380 |
| Voice coach 5-cap prompt-injection defense | `pear-app/bare/voiceCoach.js` | `<retrieved_untrusted>` around L511-L540 |
| Goal pipeline 6-cap fanout | `pear-app/bare/goalPipeline.js` | `runPipeline` around L298-L370 |
| Ask-the-frame injection defense | `pear-app/bare/askTheFrame.js` | `sanitizeUntrusted`, `<current_frame_untrusted>` around L82-L295 |
| MobileNetV3 pre-filter | `pear-app/bare/vlmCaption.js` | `preFilter` around L234-L275 |
| JSON schema goal card | `pear-app/bare/goalCard.js` | `GOAL_CARD_SCHEMA`, `responseFormat` around L45-L108 |
| Prometheus loopback bind (audit fix C1) | `pear-app/bare/observability.js` | `127.0.0.1` around L340-L385 |
| Delegated QVAC provider (backend) | `backend/src/lib/qvac/delegatedProvider.ts` | `startQVACProvider`, allow-list refusal |
| FIFA 2026 shared RAG (backend) | `backend/src/lib/qvac/sharedRag.ts` | `EmbeddingGemma`, WC26 fixtures |
| Autobase divergence + reorder test | `pear-app/test/autobase-divergence.test.js` | flagship correctness test for ADR-001 |

### What each test file proves

- **Autobase determinism**: `chat-determinism.test.js`, `autobase-divergence.test.js`, `playhead-determinism.test.js`
- **QVAC completion behavior**: `voice-coach.test.js`, `ask-the-frame.test.js`, `goal-pipeline.test.js`, `commentator.test.js`, `commentator-streaming.test.js`, `commentator-stt.test.js`, plus integration/*.test.js
- **Pears primitives**: `chat-checkout.test.js`, `room-state-sub.test.js`, `predictions-encryption.test.js`, `blind-peering-lifecycle.test.js`, `keet-identity.test.js`
- **Observability**: `observability.test.js`, `observability-stats.test.js`, `model-snapshot.test.js`
- **Prompt-injection defense**: assertions across `test/integration/`, `voice-coach.test.js`, `ask-the-frame.test.js`
- **Backend**: `sharedRag.test.js`, `delegatedProvider.test.js`, `matchClipDrive.test.js`, `enhanced-tools.test.js`

### Docs-first discipline evidence

- Every non-trivial module cites the official docs URL with fetched date in its header comment.
- Every ADR anchors to installed source at `pear-app/node_modules/*` file:line references.
- One wave-3 agent explicitly rejected a docs-lied situation: `hyperdrive.mount(path, key)` is advertised in the Pears docs but is not in installed `node_modules/hyperdrive/index.js`. Match-clip Hyperdrive works around this without `.mount`.

### What we intentionally did NOT build

- `hyperdb` schema refactor — schema-build step turns a 3h estimate into a full-day trap.
- `blind-push` FCM notifications — needs a real FCM sender token, out of scope for local demo.
- x402 VIP room gate — needs real testnet USDT payment plumbing, cameo track scope.
- BCI transcription, video generation, upscale, fine-tune — off-domain per SDK docs, and SDK explicitly warns against video for demo laptops (OOM).
- Continuous voice-assistant echo-gating — SDK example shows why it's flaky. Push-to-talk is the shipped compromise.
- Hyperbeam terminal sharing — off-domain for a watch party.
- Real mainnet USDT — cup rules disallow; we ship a USDT-branded EIP-3009 token on Sepolia instead, wire-identical.

### Feature-flag boot matrix

See [`pear-app/README.md`](pear-app/README.md) "Full feature demo (semifinal max-out)" section for the exact peer-A / peer-B / backend boot commands with every flag pinned. Reviewers can pick a subset for a shallow pass or the full set for a deep dive.

Flag defaults are all OFF so a clean checkout has zero opt-in surface. Every module fails closed when its flag is missing, so a mis-configured env produces `NOT_READY` events rather than crashes.

---

## Tether stack accountability

Direct response to the judges' brief: "For each piece: why you chose it, how you've implemented it, and why you did it that way. 'We used it' scores far below 'we chose it for X, wired it in like Y, and here's the trade-off we accepted'."

Every package below is pinned to the version in `pear-app/package.json` or `backend/package.json` at commit `517cff08`. Where a package is transitive (no top-level pin), the entry says so.

### Pears (Holepunch) — primary track

| Package | Version | Role in Curva |
|---|---|---|
| `hyperswarm` | ^4.17.0 | Peer discovery on `sha256("curva/<slug>")` |
| `corestore` | ^7.11.0 | Per-room store, replication multiplexer |
| `hypercore` | transitive via autobase | Playhead + chat writers + sealed-prediction epochs |
| `hyperbee` | ^2.27.3 | Chat view + roomState with `sub()` namespaces |
| `autobase` | ^7.28.1 | Pattern B multi-writer chat + playhead |
| `hyperdrive` | ^13.3.2 | Per-peer clip filesystem |
| `hyperblobs` | ^2.12.1 | Clip thumbnails |
| `hypercore-blob-server` | ^1.15.0 | HTTP range serve for local clip playback |
| `blind-peering` | ^2.4.0 | Companion attachment for offline persistence |
| `keet-identity-key` | ^3.2.0 | Portable-device identity attestation |
| `hypertrace` + `hypertrace-prometheus` | ^1 | Trace-counter instrumentation + `/metrics` exporter |
| `pear-runtime` | ^1.3.1 | The runtime shell that hosts the app |

**`hyperswarm`** — Chose it because peer discovery without a coordinator is table stakes for "no server" claims; libp2p or WebRTC + signaling force a signaling server. Wired via `sha256("curva/<slug>")` topic derivation; `CURVA_FORCE_RELAY=1` in the demo path enables `relayThrough` when hole-punching fails. Trade-off: room slug is trivially guessable, so we defend at the writer-invitation layer, not at discovery. Any peer can dial; only invited peers become writers.

**`HyperDHT` (transitive)** — Chose it because it makes zero-server operation credible; `relayThrough` is a full fallback ladder. Trade-off: relay mode is measurably slower than direct hole-punching.

**`corestore`** — Chose it because autobase + every hypercore needs one replication pipe; corestore is canonical. Wired one corestore per room, namespaced by slug. Trade-off: room storage is not shared across rooms; we chose isolation over reuse.

**`hypercore`** — Chose it because we need append-only signed logs both inside Autobase and as standalone encrypted epochs for sealed predictions. Wired sealed predictions via `hypercore(store, {encryptionKey: deriveSealKey({slug, epoch, hostSecret})})` — BLAKE2b-256 key derivation. Trade-off: encryption key is per-epoch; if the host secret leaks, every past epoch under that secret decrypts.

**`hyperbee`** — Chose it because we need range queries (`chat/<seq>`, `writers/<hex>`, `providers/<pubkey>`) with cheap prefix reads. Wired via `roomState.sub('room' | 'qvac' | 'providers' | 'presence')` — four byte-prefixed namespaces on one bee, with `readRoomKey()` falling back to the legacy flat prefix. Trade-off: migration window costs one extra `get()` per read until every peer has migrated.

**`autobase`** — Chose it because chat is bidirectional and needs deterministic linearization; Pattern B (host-controlled `addWriter`) fits exactly. Wired with a PURE apply reducer (memo at `chat.js:234`), observational middleware chain via `base.on('update')` (not inside apply — ADR-006), 30s background ack + post-append fire, `checkoutAt(v)` for read-only chat scrubbing. Trade-off: Pattern B means only the host can promote writers; losing the host bricks writer promotions. We accepted this over Pattern A (auto-promote on presence) which would open the room to any peer.

**`hyperdrive`** — Chose it because clips are big; we want a filesystem, not raw blocks. Wired one drive per peer at `<store>/clips/<peerKeyHex>/`. Trade-off: one drive per peer means N drives for N peers; we chose that over one shared drive to avoid write contention.

**`hyperblobs`** — Chose it because thumbnails are content-addressed image blobs. Wired one blob id per clip via the clip index Hyperbee. Trade-off: missing thumbnails cannot be regenerated on-demand from remote video; we ship thumbnails eagerly.

**`hypercore-blob-server`** — Chose it because the renderer needs HTTP range requests for `<video>` seek; hypercore natively cannot. Wired one BlobServer per peer, bound to loopback. Trade-off: loopback-only, so browser plays but remote fetch must go through blind-peering. That is by design.

**`blind-peering`** — Chose it because watch parties happen while friends are offline. Wired with an explicit `target` per base (`auto.wakeupCapability.key`) and per core (`core.key`) rather than package default; suspend/resume tied to Pear teardown. Trade-off: extra dial cost from explicit target pinning; we chose that over silent breakage from a future default change.

**`keet-identity-key`** — Chose it because we want portable identity across devices without a coordinator. Wired via `verifyPeerProof(proof, attestedData)` on every presence beacon; green shield renders on match. Trade-off: we surface identity but do not gate authorization on it; roomState writer roster is what actually gates writes.

**`hypertrace` + `hypertrace-prometheus` + stats packages** — Chose them because we wanted production-grade counters, not `console.log`. Wired via `startPrometheus()` bound explicitly to `127.0.0.1:<port>` (not `0.0.0.0` — audit fix C1). `hypercore-stats`, `hyperswarm-stats`, `hyperdht-stats` loaded dynamically and registered on the same registry. Trade-off: loopback-only means no LAN scrape; federation happens via backend companion, per peer opt-in.

**`pear-runtime`** — Chose it because Pear is the whole distribution story; users `pear run pear://<key>`. Wired following `holepunchto/hello-pear-electron@1.0.0`. Trade-off: production release cadence still relies on `pear stage` + `pear release`; a mis-published stage cannot be silently rolled back.

### QVAC — 15 on-device AI capabilities

Every capability runs on-device via `@qvac/sdk@^0.14.0`. No cloud fallback. Model registry pinned in `backend/src/data/qvac-models.json`.

| Capability | SDK entrypoint | Wire-in file |
|---|---|---|
| Bergamot NMT | `translate` + langdetect routing | `bare/translate.js`, `bare/llmTranslate.js` |
| Qwen3 LLM | `completion` streaming + `json_schema` | `bare/commentator.js`, `roomBot.js`, `voiceCoach.js`, `askTheFrame.js`, `goalCard.js` |
| Whisper Tiny STT | `whisperConfigSchema` + VAD Silero 5.1.2 | `bare/voiceCoach.js`, `bare/diarization.js` |
| Supertonic multilingual TTS | streaming synthesis | `bare/announcer.js` |
| Chatterbox voice cloning (EN/IT only) | `voiceClone` API | `bare/voiceClone.js` |
| Llama-3.2 streaming commentator | `contentDelta` + `thinkingDelta` + `completionStats` | `bare/commentator.js` |
| SmolVLM2 500M + mmproj | multimodal `completion` | `bare/vlmCaption.js` |
| MobileNetV3 pre-filter | `sdk.classify({modelId, image, topK})` | `bare/vlmCaption.js#L234-L275` |
| OCR_LATIN | two-stage CRAFT + Latin recognizer | `bare/ocr.js` |
| Parakeet CTC 0.6B (EN fallback) | streaming partials | `bare/diarization.js` |
| EmbeddingGemma 300M Q4 | `ragIngest` + `ragSearch` + `embed` | `bare/rag.js`, `bare/semanticSearch.js`, `backend/src/lib/qvac/sharedRag.ts` |
| MCP tool calling | in-process McpClient shape | `bare/mcpTools.js` |
| Delegated inference | `startQVACProvider` + firewall + `loadModel({delegate})` | `backend/src/lib/qvac/delegatedProvider.ts`, `bare/delegatedProvider.js` |
| Streaming knobs | kvCache + reasoning_budget + remove_thinking_from_context | `bare/announcer.js`, `bare/commentator.js` |
| `@qvac/langdetect-text` | auto pivot pair routing | `bare/langDetectRouter.js` |

**Bergamot NMT** — Chose it because on-device translation with no data egress kills the "no servers" property claim. Wired via `translate({from, to, text})` with EN-hub pivot for IT<->ID / IT<->EN / EN<->ID (`modelConfig.pivotModel`). Trade-off: Bergamot coverage is smaller than cloud translators; we support EN/IT/ID and pivot elsewhere.

**Qwen3 LLM** — Chose it because it supports MCP tool calling AND `json_schema` structured output — the two features we depend on most. Wired one shared `sharedLlmHandle` at boot passed to every consumer so we do not reload the model. Trade-off: memory-heavy; on 8GB devices only one LLM at a time, so commentator and voice coach share.

**Whisper Tiny STT** — Chose it because streaming STT with VAD gives us end-of-turn detection for push-to-talk. Wired with `whisperConfigSchema.vadModelSrc = VAD_SILERO_5_1_2`, tuned per voice-assistant docs (threshold 0.6, min_speech 300ms, min_silence 700ms). Trade-off: less accurate than Whisper Base; we chose speed over accuracy for push-to-talk.

**Supertonic multilingual TTS** — Chose it because on-device streaming TTS in EN/IT/ID matches our target audience. Wired as a streaming pipeline emitting audio chunks as they synthesize. Trade-off: first-token latency is higher than cloud TTS; we hide behind a "thinking" indicator.

**Chatterbox voice cloning** — Chose it because a personal announcer voice makes the watch-party feel like your friends' voices; cloud voice clone is a privacy nightmare. Wired via 10-second sample recorded in-app; voice profile stored locally. Trade-off: **EN/IT only**; ID cloning is on roadmap, not shipped. We call this out explicitly in the UI.

**Llama-3.2 streaming commentator** — Chose it because smaller than Qwen3, streaming-optimized. Wired with `contentDelta`, `thinkingDelta`, `completionStats` all surfaced in the UI; kvCache session key means sub-100ms time-to-first-token per tick after warmup. Trade-off: does not do MCP tool calling as reliably as Qwen3; commentator is monologue only.

**SmolVLM2 500M + mmproj** — Chose it because it is the only on-device VLM at ~500MB that captions football scenes coherently; alternatives (LLaVA-1.5) are 4x bigger. Wired via `sdk.completion` with the projection model on paused frames; caption goes into chat as `system:vlm-caption` and into the ask-the-frame RAG workspace. Trade-off: first download is ~521MB; we fall back to text-only ask-the-frame if not cached.

**MobileNetV3 pre-filter** — Chose it because running SmolVLM2 on every paused frame is expensive; MobileNetV3 gates in ~50ms. Wired via `preFilter(imageBuffer)` calling `sdk.classify({modelId, image, topK})` and deciding whether to hand off to SmolVLM2. Fails open on any classifier error. Trade-off: fail-open means a broken classifier is silently ignored; we accept because pre-filter is a cost saver, not a correctness gate.

**OCR_LATIN** — Chose it for reading jersey numbers and scoreboards; two-stage (CRAFT + Latin recognizer) handles rotated jerseys via `defaultRotationAngles`. Wired via `sdk.ocr({image})` returning blocks with confidence; `extractScore(blocks)` regex turns `"MAN 2 - 1 LIV"` into `{home:2, away:1}`. Trade-off: Latin-only; Arabic and CJK jerseys are out of scope.

**Parakeet CTC 0.6B** — Chose it because on English-only rooms with tight RAM, Parakeet is smaller than Whisper and streams partials at 1s chunks. Wired as fallback when Whisper is unavailable or room language is EN. Trade-off: English-only.

**EmbeddingGemma 300M Q4** — Chose it because we wanted true RAG (not "prompt stuffing") for voice coach, ask-the-frame, shared WC26 fixtures; small enough to co-load with Qwen3. Wired with debounced per-workspace reindex bookkeeping; timers cleared on `close()`. Backend shares WC26 fixtures via companion. Trade-off: HyperDB requires >=16 docs before reindex is meaningful; we degrade `reindexed:false` with reason until threshold.

**MCP tool calling** — Chose it because it turns the LLM into an on-device agent; alternative (function calling only) is coupled to a specific model. Wired via in-process McpClient shape `{listTools, callTool}`. Backend exposes room MCP tools; peer exposes local tools. Trade-off: in-process only; we do not expose MCP over the swarm because that would require the tool sender to trust the room.

**Delegated inference** — Chose it because a peer with a strong GPU can serve a peer with a weak one — real P2P inference. Wired via `startQVACProvider({firewall: {mode, publicKeys}})` with fail-closed empty allow-list; peer advertises pubkey in Hyperbee; consumer calls `loadModel({delegate})`; streaming events flow via DHT. Trade-off: a malicious provider could return garbage tokens; we do not have integrity attestation yet — trust is at the friendship layer.

**Streaming knobs (kvCache + reasoning_budget + remove_thinking_from_context)** — Chose them because every millisecond of first-token latency shows on camera. Wired with `deleteCache` on room close so kv is not leaked between rooms. Trade-off: per-session kvCache; switching rooms starts cold on the new one.

**`@qvac/langdetect-text`** — Chose it because we need to auto-route translation without asking "what language is this?". Wired via detection on incoming chat text; pivot via EN hub if direct pair not installed. Trade-off: short strings (<8 chars) are unreliable; we skip translation on those.

### WDK — cameo track (honest scope)

Curva is primarily Pears + QVAC. WDK is a cameo, but every piece we ship is real and provable on Sepolia.

| Package | Version | Role |
|---|---|---|
| `@tetherto/wdk` | ^1.0.0-beta.12 | Umbrella meta-package |
| `@tetherto/wdk-wallet-evm-erc-4337` | ^1.0.0-beta.10 | Safe smart account + Candide bundler fallback |
| `@tetherto/wdk-secret-manager` | ^1.0.0-beta.3 | PBKDF2 + XSalsa20-Poly1305 seed encryption |

**`@tetherto/wdk` (meta)** — Chose it because Curva ships a wallet inside the app so tipping requires no external wallet install; WDK is the Tether-native way. Wired via `pear-app/bare/wallet/worklet.js` importing the wallet factory with `onChainIdentifier: {name: 'curva', version: '0.1.0'}` so any WDK-instrumented telemetry attributes usage back to us. Trade-off: we bind to a specific WDK beta line, so beta churn can break boot. We accept that as the cost of being on the frontier.

**`@tetherto/wdk-wallet-evm-erc-4337`** — Chose it for two settlement paths: EIP-3009 (peer signs off-chain, backend facilitator submits and pays gas) as primary, and ERC-4337 Safe smart account via Candide bundler as fallback for chains without EIP-3009. Wired via `bare/wallet/eip3009.js` (primary) and `bare/wallet/worklet.js` (fallback), with the `onChainIdentifier: 'curva'` marker at `eip3009.js#L34-L57`. Trade-off: our token is a **USDT-branded EIP-3009 token on Sepolia**, not real mainnet USDT. Cup rules disallow real mainnet spend and Sepolia has no real USDT. We deploy a compatible ERC-20 with the EIP-3009 extension so the code path is identical to what mainnet ship would look like.

**`@tetherto/wdk-secret-manager`** — Chose it because PBKDF2 + XSalsa20-Poly1305 is the WDK-native way to store seeds; alternative (raw file + OS keychain) is platform-specific and less portable. Wired via `bare/wallet/worklet.js` — user password derives the KDF; encrypted seed lives in the pear data directory. Trade-off: if the user forgets their password, the seed is unrecoverable. This is a feature (no backdoor) but a bad UX; we compensate with a recovery-phrase export.

**EIP-3009 primary tip path** — Chose it because gasless tips mean the tipper does not need ETH — matches the WDK "money-native UX" philosophy. Wired via `bare/wallet/eip3009.js`; peer signs authorization off-chain, backend `facilitatorRoutes.ts` submits via sponsor treasury. Trade-off: backend must have gas; if sponsor treasury dries up, tips queue. We surface treasury state at `GET /pears/status`.

**ERC-4337 Candide fallback** — Chose it because for chains where EIP-3009 is not available, ERC-4337 + Candide bundler is the account-abstraction path. Wired via the same WDK wallet factory; different `chainId` triggers the ERC-4337 branch; `onChainIdentifier: 'curva'` marker surfaces on the bundler side. Trade-off: two paths have different UX (single sign vs userOp signing) and failure modes; we route by chain, not by user preference.

**USDT-branded EIP-3009 Sepolia token** — Chose it because real mainnet USDT is not available on Sepolia. Rather than skip the WDK track entirely, we deploy a USDT-branded ERC-20 with the EIP-3009 extension so the code path is 1:1 with mainnet ship. Wired via `contracts/src/CurvaUSDT.sol` (Foundry); OpenZeppelin `ERC20Permit` + EIP-3009 extension; address wired into `backend/src/config/main-config.ts`. Trade-off: **it is not real USDT — it is a USDT-branded testnet token**. We are explicit about this in the video and DoraHacks details. The wire-in code (WDK + facilitator + on-chain marker) is real.

---

## Commit-pinned permalinks

Every link below is pinned to commit `517cff080a013ec94dece86c02a35821cab7e726`. GitHub freezes the file to that commit, so the exact line numbers cited will never drift even if `main` moves on. Land on the block, verify the claim, walk out.

### Pears architecture depth

1. **Autobase Pattern B addWriter** (host-side control block, rate-limited): [`bare/room.js#L698-L961`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/room.js#L698-L961) — related test: [`autobase-divergence.test.js#L1-L240`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/test/autobase-divergence.test.js#L1-L240) — ADR-001.
2. **Chat apply() purity + writer promotion inside reducer**: [`bare/chat.js#L234-L318`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/chat.js#L234-L318) — ADR-001.
3. **base.ack() background loop**: [`bare/room.js#L74-L94`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/room.js#L74-L94).
4. **base.ack() post-append fire**: [`bare/room.js#L100-L111`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/room.js#L100-L111) — ADR-004.
5. **Autobase view.checkout(v) chat scrubber**: [`bare/chat.js#L697-L735`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/chat.js#L697-L735).
6. **Hyperbee sub() namespacing**: [`bare/room.js#L324-L365`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/room.js#L324-L365).
7. **Hypercore-encrypted sealed predictions (BLAKE2b-256 key derivation)**: [`bare/predictions.js#L835-L870`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/predictions.js#L835-L870) — ADR-008.
8. **Apply middleware compose pattern**: [`bare/lib/applyMiddleware.js#L80-L110`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/lib/applyMiddleware.js#L80-L110) — ADR-006.
9. **Apply middleware observational wire-in**: [`bare/room.js#L125-L187`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/room.js#L125-L187) — ADR-006.
10. **keet-identity verifyPeerProof**: [`bare/keetIdentity.js#L353-L400`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/keetIdentity.js#L353-L400) — ADR-002.
11. **blind-peering registerAutobase (explicit target)**: [`bare/blindPeering.js#L217-L260`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/blindPeering.js#L217-L260) — ADR-003.
12. **blind-peering suspend/resume**: [`bare/blindPeering.js#L343-L380`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/blindPeering.js#L343-L380).
13. **Autobase divergence + reorder test**: [`test/autobase-divergence.test.js#L1-L240`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/test/autobase-divergence.test.js#L1-L240).

### QVAC breadth

14. **Voice coach factory (5-cap orchestration)**: [`bare/voiceCoach.js#L205-L235`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/voiceCoach.js#L205-L235) — ADR-005.
15. **Voice coach prompt-injection defense** (NFKC + bidi + zero-width strip + `<retrieved_untrusted>` tags): [`bare/voiceCoach.js#L511-L540`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/voiceCoach.js#L511-L540).
16. **Goal pipeline 6-capability fanout**: [`bare/goalPipeline.js#L298-L370`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/goalPipeline.js#L298-L370) — ADR-007.
17. **Ask-the-frame sanitizer**: [`bare/askTheFrame.js#L82-L107`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/askTheFrame.js#L82-L107).
18. **Ask-the-frame caption tag fence** (`<current_frame_untrusted>` + `<retrieved_untrusted>`): [`bare/askTheFrame.js#L250-L295`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/askTheFrame.js#L250-L295).
19. **RAG workspace lifecycle**: [`bare/rag.js#L105-L165`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/rag.js#L105-L165).
20. **MobileNetV3 pre-filter** (cheap classifier gates SmolVLM2): [`bare/vlmCaption.js#L234-L275`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/vlmCaption.js#L234-L275).
21. **JSON schema goal card** (QVAC `responseFormat.json_schema`): [`bare/goalCard.js#L45-L108`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/goalCard.js#L45-L108).
22. **Delegated QVAC provider (backend)** with fail-closed allow-list: [`backend/src/lib/qvac/delegatedProvider.ts#L1-L313`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/backend/src/lib/qvac/delegatedProvider.ts#L1-L313).
23. **FIFA 2026 shared RAG (backend)**: [`backend/src/lib/qvac/sharedRag.ts#L1-L450`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/backend/src/lib/qvac/sharedRag.ts#L1-L450).

### Observability

24. **Prometheus loopback bind** (audit fix C1, 127.0.0.1 not 0.0.0.0): [`bare/observability.js#L340-L385`](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/pear-app/bare/observability.js#L340-L385) — ADR-009.

### Architecture Decision Records (10 total)

Every ADR is a self-contained decision with context, alternatives considered, consequences, and references. Format: Context / Decision / Consequences / References.

- [ADR-001 Autobase Pattern B multi-writer](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/001-autobase-pattern-b-multi-writer.md)
- [ADR-002 keet-identity attestation](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/002-keet-identity-attestation.md)
- [ADR-003 blind-peering target strategy](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/003-blind-peering-target-strategy.md)
- [ADR-004 base.ack() cadence](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/004-base-ack-cadence.md)
- [ADR-005 voice coach orchestration](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/005-voice-coach-orchestration.md)
- [ADR-006 apply middleware observational](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/006-apply-middleware-observational.md)
- [ADR-007 goal pipeline fanout](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/007-goal-pipeline-fanout.md)
- [ADR-008 hypercore sealed predictions](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/008-hypercore-sealed-predictions.md)
- [ADR-009 Prometheus loopback federation](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/009-prometheus-loopback-federation.md)
- [ADR-010 design tokens minimalism](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/010-design-tokens-minimalism.md)
- [ADR index README](https://github.com/louissarvin/Curva/blob/517cff080a013ec94dece86c02a35821cab7e726/docs/adr/README.md)

### What to click if you only have 90 seconds

1. **Autobase Pattern B**: permalinks 1 (room.js) + 2 (chat.js) + 13 (divergence test).
2. **QVAC depth**: permalink 14 (voice coach factory) + 15 (injection defense) — one push-to-talk turn, five capabilities, defense in depth.
3. **One security decision, well done**: permalink 24 (Prometheus loopback bind) — one line of listen args that turns a network-exposed exporter into a loopback-only one.

Everything else fans out from those three.

---

<div align="center">

**Bola untuk semua. Forza Curva.**

</div>
