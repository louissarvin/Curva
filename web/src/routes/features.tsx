import { createFileRoute } from '@tanstack/react-router'
import { Cpu, ExternalLink, GitBranch, Radio, Zap } from 'lucide-react'
import AnimateComponent from '@/components/elements/AnimateComponent'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/features')({ component: FeaturesPage })

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#c8102e] mb-3">
      {children}
    </p>
  )
}

function Divider() {
  return <div className="h-px bg-[rgba(255,255,255,0.07)] my-20" />
}

// ─── Pears section ────────────────────────────────────────────────────────────

const PEARS_BLOCKS = [
  {
    name: 'Hyperswarm',
    role: 'Peer discovery',
    detail:
      'Joins the match room on a sha256-derived topic. relayThrough fallback for peers behind symmetric NAT, pubkey served at GET /relay/info.',
    file: 'pear-app/bare/swarmLifecycle.js',
  },
  {
    name: 'Corestore',
    role: 'Storage namespace',
    detail:
      'One disk root, many named cores per room. Peers share the same namespace so cross-peer replication is deterministic.',
    file: 'pear-app/bare/room.js',
  },
  {
    name: 'Hypercore',
    role: 'Append-only logs',
    detail:
      'Named cores for playhead state, chat messages, goal clips, and room metadata. Each has a distinct key.',
    file: 'pear-app/bare/playhead.js + chat.js',
  },
  {
    name: 'Autobase',
    role: 'Multi-writer sync',
    detail:
      'Pattern B addWriter with host-signed ed25519 invitations. Pure reducers for deterministic replay. Playhead and chat both use Autobase. New peers can write even after the host disconnects.',
    file: 'pear-app/bare/playhead.js + writerInvitation.js',
  },
  {
    name: 'Hyperbee',
    role: 'Key-value views',
    detail:
      'Chat view, tip log, writer roster, and reactions bucket all materialise into a Hyperbee. Deterministic merge via Autobase linearisation.',
    file: 'pear-app/bare/chat.js + tip.js',
  },
  {
    name: 'Hyperdrive',
    role: 'Per-peer clip sharing',
    detail:
      'Each peer hosts its own goal clip Hyperdrive. findingPeers waits for at least one remote peer before the first read so cold-start does not block the UI.',
    file: 'pear-app/bare/clips.js',
  },
  {
    name: 'Hyperblobs',
    role: 'Clip thumbnails',
    detail:
      '128x72 ffmpeg-baseline JPEG thumbnails stored as blobs and replicated alongside the Hyperdrive. Makes the clip gallery load before the full video.',
    file: 'pear-app/bare/clips.js',
  },
  {
    name: 'hypercore-crypto',
    role: 'Crypto primitives',
    detail:
      'sha256 topic derivation for the match room key. ed25519 keypairs for writer invitations, signed by the host and verified on addWriter.',
    file: 'pear-app/bare/topics.js + writerInvitation.js',
  },
  {
    name: 'pear-runtime-updater',
    role: 'OTA + seeder daemon',
    detail:
      'Renderer receives OTA update toast via pear-runtime-updater. Backend runs an in-process seeder daemon that joins the Hyperdrive discovery keys for all active rooms.',
    file: 'pear-app/electron/main.js',
  },
  {
    name: 'Match Prediction Pool',
    role: 'Football-native settlement',
    detail:
      'Host opens a pool for the fixture, peers stake 1 USDT via EIP-3009 on Sepolia, winners get paid on-chain by the sponsor after the host publishes the result. Autobase carries pool-opened, prediction, match-result, and pool-payout system messages; the three host-only variants are gated by writer pubkey. Real ERC-20 payouts, not simulated.',
    file: 'backend/src/routes/predictionRoutes.ts + pear-app/bare/chat.js',
  },
  {
    name: 'Attendance Ticket Tools',
    role: 'Per-peer EIP-191 attendance passes',
    detail:
      'When a peer joins the room, the host wallet signs an off-chain attendance pass over "curva-attendance-pass:v1:slug:matchId:peer:issuedAt". The pass lands in the room-state Hyperbee for late-joiner replay and in chat as system:attendance-issued (host-only writer gate). Any third party can verify via GET /wdk/verify-attendance/:slug/:address; the backend ecrecovers the signer and matches it against the registered hostOwnerAddress. No on-chain settlement, no gas, just a portable, off-chain-verifiable "I was there" receipt for the curva.',
    file: 'pear-app/bare/attendance.js + backend/src/routes/attendanceRoutes.ts',
  },
  {
    name: 'Blind-Peering resilience',
    role: 'Watch party survives peer churn',
    detail:
      'blind-peering registers each room’s chat + playhead Autobase discovery keys with a third-party seeder that replicates without read access. When the host closes their laptop and every human peer disconnects, the room stays alive: the next joiner catches up from the blind peer’s mirror. Chat contents never leave the peer group because no read key is transferred. Deploy your own seeder from holepunchto/blind-peering, or point CURVA_BLIND_PEER_KEY at a public one.',
    file: 'pear-app/bare/blindPeering.js + pear-app/bare/room.js',
  },
]

function PearsSection() {
  return (
    <section id="pears" aria-label="Pears features">
      <AnimateComponent onScroll entry="fadeInUp">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-[rgba(200,16,46,0.12)] border border-[rgba(200,16,46,0.2)] flex items-center justify-center text-[#c8102e]">
            <Radio size={20} aria-hidden="true" />
          </div>
          <div>
            <SectionLabel>Pillar 01</SectionLabel>
            <h2 className="font-display text-3xl md:text-4xl font-bold text-[#f5f5f0] curva-underline">
              Holepunch Pears Stack
            </h2>
          </div>
        </div>
        <p className="text-[#8a8a8a] text-base max-w-2xl leading-relaxed mb-12">
          Nine Pears building blocks exercised at runtime. Every block has file
          evidence. The app functions without the Companion, proving the P2P
          claim is real.
        </p>
      </AnimateComponent>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {PEARS_BLOCKS.map((block, i) => (
          <AnimateComponent
            key={block.name}
            onScroll
            entry="fadeInUp"
            delay={i * 50}
          >
            <article className="p-5 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.07)] hover:border-[rgba(255,255,255,0.14)] h-full flex flex-col gap-3 hover:-translate-y-0.5 transition-all duration-200 ease-out">
              <div>
                <p className="font-mono-code text-[11px] text-[#c8102e] font-semibold mb-0.5">
                  {block.name}
                </p>
                <p className="text-[#f5f5f0] text-sm font-medium">
                  {block.role}
                </p>
              </div>
              <p className="text-[#8a8a8a] text-xs leading-relaxed flex-1">
                {block.detail}
              </p>
              <p className="font-mono-code text-[9px] text-[rgba(212,175,55,0.6)] leading-snug">
                {block.file}
              </p>
            </article>
          </AnimateComponent>
        ))}
      </div>
    </section>
  )
}

// ─── WDK section ─────────────────────────────────────────────────────────────

const WDK_FEATURES = [
  {
    heading: 'EIP-3009 primary path',
    body: 'Peer EOA signs a TransferWithAuthorization off-chain. Backend facilitator submits to Sepolia. On-chain in 2-6 seconds. No gas paid by the tipper.',
    file: 'pear-app/bare/wallet/eip3009.js + backend/src/routes/facilitatorRoutes.ts',
  },
  {
    heading: 'ERC-4337 fallback path',
    body: 'Safe smart account via WalletManagerEvmErc4337. account.transfer() routes through the Candide bundler + paymaster at api.candide.dev. onChainIdentifier: "curva" appended per WDK docs (50-byte marker on UserOperation calldata).',
    file: 'pear-app/bare/wallet/worklet.js:125',
  },
  {
    heading: 'Seed encrypted at rest',
    body: 'wdk-secret-manager uses PBKDF2 + XSalsa20-Poly1305 to encrypt the mnemonic. PasscodePrompt enforces gate on first use and cold boot.',
    file: 'pear-app/bare/wallet/PasscodePrompt.js',
  },
  {
    heading: 'Tip pre-broadcast',
    body: "Pending row appears in the Hyperbee tip log within 200ms of tap, before the chain confirms. Makes the UX feel instant even during Sepolia's 2-6 second settlement window.",
    file: 'pear-app/bare/tip.js',
  },
  {
    heading: 'Verifiable on Etherscan',
    body: 'GET /wdk/verify/<txHash> on the Companion returns the Etherscan proof URL. Every Sepolia transaction is publicly auditable.',
    file: 'backend/src/routes/wdkRoutes.ts',
  },
  {
    heading: 'EIP-191 anti-spoofing ack',
    body: 'Host signs system:tip-ack over the tx hash using EIP-191. test/wave8b.test.js proves a promoted writer cannot forge this ack.',
    file: 'test/wave8b.test.js',
  },
  {
    heading: 'x402 VIP room slug reservation (semifinal)',
    body: 'Peer signs EIP-3009 for 5 USDT off-chain, backend facilitator settles on Sepolia. Prisma persists with @unique slug + @unique txHash. Fast-fails on already-reserved slug before issuing the 402 so no gas is wasted. Two on-chain proofs: kings-lounge and torino-fc. Second x402 paid-resource route on the same helpers as premium translations.',
    file: 'backend/src/routes/vipRoutes.ts + pear-app/bare/x402Client.js',
  },
  {
    heading: 'Etherscan-linked VIP UI',
    body: 'RoomBrowser renders a clickable View on Etherscan anchor on successful reservation. rel="noopener noreferrer" plus target="_blank" is the XSS defense on user-visible external links.',
    file: 'pear-app/renderer/components/RoomBrowser.js',
  },
]

function WdkSection() {
  return (
    <section id="wdk" aria-label="WDK features">
      <AnimateComponent onScroll entry="fadeInUp">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-[rgba(200,16,46,0.12)] border border-[rgba(200,16,46,0.2)] flex items-center justify-center text-[#c8102e]">
            <Zap size={20} aria-hidden="true" />
          </div>
          <div>
            <SectionLabel>Pillar 02</SectionLabel>
            <h2 className="font-display text-3xl md:text-4xl font-bold text-[#f5f5f0] curva-underline">
              Wallet Development Kit
            </h2>
          </div>
        </div>
        <p className="text-[#8a8a8a] text-base max-w-2xl leading-relaxed mb-4">
          Gasless USDT tipping with two working paths. Dual-path architecture
          means the tip always lands even if one path degrades.
        </p>
        <div className="mb-12 flex flex-wrap gap-2">
          {[
            '@tetherto/wdk ^1.0.0-beta.12',
            '@tetherto/wdk-wallet-evm-erc-4337 ^1.0.0-beta.10',
            '@tetherto/wdk-secret-manager ^1.0.0-beta.3',
          ].map((pkg) => (
            <span
              key={pkg}
              className="font-mono-code text-[10px] text-[rgba(212,175,55,0.7)] bg-[#141414] border border-[rgba(255,255,255,0.07)] px-2.5 py-1 rounded"
            >
              {pkg}
            </span>
          ))}
        </div>
      </AnimateComponent>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {WDK_FEATURES.map((feat, i) => (
          <AnimateComponent
            key={feat.heading}
            onScroll
            entry="fadeInUp"
            delay={i * 60}
          >
            <article className="p-5 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.07)] hover:border-[rgba(255,255,255,0.14)] h-full flex flex-col gap-3 hover:-translate-y-0.5 transition-all duration-200 ease-out">
              <p className="text-[#f5f5f0] text-sm font-semibold">
                {feat.heading}
              </p>
              <p className="text-[#8a8a8a] text-xs leading-relaxed flex-1">
                {feat.body}
              </p>
              <p className="font-mono-code text-[9px] text-[rgba(212,175,55,0.6)] leading-snug">
                {feat.file}
              </p>
            </article>
          </AnimateComponent>
        ))}
      </div>

      <AnimateComponent onScroll entry="fadeInUp" delay={120}>
        <div className="mt-6 p-4 rounded-lg border border-[rgba(200,16,46,0.2)] bg-[rgba(200,16,46,0.05)]">
          <p className="text-xs text-[#8a8a8a] leading-relaxed">
            <span className="text-[#f5f5f0] font-medium">Chain:</span> Sepolia
            (chainId 11155111). USDT at{' '}
            <span className="font-mono-code text-[rgba(212,175,55,0.7)]">
              0xd077a400968890eacc75cdc901f0356c943e4fdb
            </span>
            . Tip receipts verifiable at{' '}
            <span className="font-mono-code text-[#c8102e]">
              GET /wdk/verify/&lt;txHash&gt;
            </span>
            .
          </p>
        </div>
      </AnimateComponent>
    </section>
  )
}

// ─── QVAC section ─────────────────────────────────────────────────────────────

const QVAC_FEATURES = [
  {
    heading: 'modelConfig.pivotModel chain',
    body: 'Bahasa Indonesia to Italian goes ID-EN-IT in one @qvac/sdk call, and the reverse pair works from the same catalog. SDK BlockingService.pivotMultiple handles the English pivot internally. No manual intermediate step.',
    file: 'pear-app/bare/translate.js:208-229',
  },
  {
    heading: '12 EN-hub language pairs',
    body: '12 Bergamot model pairs staged, all using English as the hub for cross-pair pivoting. Pair list served via GET /qvac/catalog with SHA-256 hashes for on-device integrity check.',
    file: 'backend/src/routes/qvacRoutes.ts',
  },
  {
    heading: 'SHA-256 model integrity',
    body: 'Before any model loads, the Bare worker computes its SHA-256 hash and compares against the QVAC catalog entry. Corrupt or tampered model files are rejected.',
    file: 'pear-app/bare/translate.js',
  },
  {
    heading: 'Zero network calls during translation',
    body: "Model is fetched once and cached in the Pear app data directory. After that, translation runs on Bare with no outbound calls. The model runs on the peer's CPU, not a remote GPU.",
    file: 'pear-app/bare/translate.js',
  },
  {
    heading: 'Per-message locale detection',
    body: 'Identity locale from identity.js auto-picks the translation pair for each peer. Jakarta host peer gets Bahasa Indonesia renditions, Torino friend peer gets Italian. Both get the original text toggled by UI.',
    file: 'pear-app/bare/identity.js',
  },
  {
    heading: 'modelMirrorSyncWorker',
    body: 'Companion worker mirrors the Bergamot model files at startup and keeps them fresh. Peers that cannot reach the upstream QVAC CDN can pull from the Companion mirror.',
    file: 'backend/src/workers/modelMirrorSyncWorker.ts',
  },
  {
    heading: 'P2P Delegated Inference',
    body: 'Guest peers on low-power devices delegate translation to the host laptop over Hyperswarm DHT via @qvac/sdk startQVACProvider. On timeout or provider unreachable, guests fall back to local Bergamot in the same tick. See docs.qvac.tether.io/p2p-capabilities/delegated-inference.',
    file: 'pear-app/bare/delegatedProvider.js',
  },
  {
    heading: 'On-device LLM room commentator',
    body: 'Host-only Qwen3 0.6B (Q4) via @qvac/sdk completion({ stream: true }) writes color commentary into chat as a system:commentary pill. Triggers on goal-clusters and 60s ticks; rate-limited to 1 per 30s; three tone presets. Ships QVAC primitive #2 alongside NMT translation.',
    file: 'pear-app/bare/commentator.js',
  },
  {
    heading: 'Heavy language auto-detect (semifinal)',
    body: 'tinyld heavy detector picks the source language per inbound chat message before Bergamot fires. Keeps the pivot chain honest for it -> id via en. No manual locale pick, no network call.',
    file: 'pear-app/bare/translate.js + pear-app/bare/llmTranslate.js',
  },
  {
    heading: 'Voice-clone Play Sample (semifinal)',
    body: 'After voice enrollment saves, a chip row lets the user replay the cloned voice across 6 Chatterbox locales (EN, IT, ES, FR, DE, PT) via curva.voiceClone.speak() with WebAudio playback. Confirms the enrollment landed and previews the voice a peer hears in commentary. Allowlist enforced client-side and worker-side.',
    file: 'pear-app/renderer/components/VoiceEnrollmentModal.js + pear-app/workers/main.js',
  },
  {
    heading: '9 QVAC plugins registered on Bare (semifinal)',
    body: 'llamacpp-completion, llamacpp-embedding, nmtcpp-translation, whispercpp-transcription, parakeet-transcription, tts-ggml, ggml-vla, ggml-ocr, ggml-classification. All registered at Bare boot against @qvac/sdk 0.14.0. HOME env isolation gives each peer its own .qvac model cache.',
    file: 'pear-app/bare/backend.js + backend/src/lib/qvac/registry.ts',
  },
]

function QvacSection() {
  return (
    <section id="qvac" aria-label="QVAC features">
      <AnimateComponent onScroll entry="fadeInUp">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-[rgba(200,16,46,0.12)] border border-[rgba(200,16,46,0.2)] flex items-center justify-center text-[#c8102e]">
            <Cpu size={20} aria-hidden="true" />
          </div>
          <div>
            <SectionLabel>Pillar 03</SectionLabel>
            <h2 className="font-display text-3xl md:text-4xl font-bold text-[#f5f5f0] curva-underline">
              QVAC Local AI
            </h2>
          </div>
        </div>
        <p className="text-[#8a8a8a] text-base max-w-2xl leading-relaxed mb-4">
          On-device Bergamot NMT via @qvac/sdk@0.14.0. Privacy-first: no API
          key, no cloud call during translation. Fits QVAC's "privacy-first
          replacement for cloud translators" idea slot.
        </p>
        <div className="mb-12 flex flex-wrap gap-2">
          {['@qvac/sdk ^0.14.0', '@qvac/translation-nmtcpp'].map((pkg) => (
            <span
              key={pkg}
              className="font-mono-code text-[10px] text-[rgba(212,175,55,0.7)] bg-[#141414] border border-[rgba(255,255,255,0.07)] px-2.5 py-1 rounded"
            >
              {pkg}
            </span>
          ))}
        </div>
      </AnimateComponent>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {QVAC_FEATURES.map((feat, i) => (
          <AnimateComponent
            key={feat.heading}
            onScroll
            entry="fadeInUp"
            delay={i * 60}
          >
            <article className="p-5 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.07)] hover:border-[rgba(255,255,255,0.14)] h-full flex flex-col gap-3 hover:-translate-y-0.5 transition-all duration-200 ease-out">
              <p className="text-[#f5f5f0] text-sm font-semibold">
                {feat.heading}
              </p>
              <p className="text-[#8a8a8a] text-xs leading-relaxed flex-1">
                {feat.body}
              </p>
              <p className="font-mono-code text-[9px] text-[rgba(212,175,55,0.6)] leading-snug">
                {feat.file}
              </p>
            </article>
          </AnimateComponent>
        ))}
      </div>

      <AnimateComponent onScroll entry="fadeInUp" delay={120}>
        <blockquote className="mt-8 pl-5 border-l-2 border-[rgba(200,16,46,0.4)]">
          <p className="font-display text-xl italic text-[#f5f5f0] leading-snug mb-2">
            "If you need an API key to use your AI, it doesn't really belong to
            you."
          </p>
          <footer className="text-xs text-[#8a8a8a]">
            <cite>Paolo Ardoino</cite> (qvac-api-key,
            backend/src/data/phrasebook.json)
          </footer>
        </blockquote>
      </AnimateComponent>
    </section>
  )
}

// ─── Wave 2-5 section ────────────────────────────────────────────────────────

const ORCHESTRATION_FLOWS = [
  {
    name: 'Voice-controlled coach',
    caps: 5,
    chain: 'STT (Whisper + Silero VAD) → RAG (EmbeddingGemma) → LLM (Qwen3) → MCP tools → TTS (Supertonic streaming)',
    trigger: 'Push-to-talk button; Cancel button calls sdk.cancel barge-in',
    file: 'pear-app/bare/voiceCoach.js',
  },
  {
    name: 'Ask-the-frame',
    caps: 5,
    chain: 'VLM (SmolVLM2 + MobileNetV3 pre-filter) → RAG → LLM → MCP tools → TTS',
    trigger: 'Pause gesture + question; player gets the frame caption read aloud',
    file: 'pear-app/bare/askTheFrame.js',
  },
  {
    name: 'Goal pipeline',
    caps: 6,
    chain: 'OCR (CRAFT + Latin recogniser) → goalCard (Qwen3 shared handle) → MCP tools → Bergamot → TTS + Autobase system:goal-confirmed',
    trigger: 'Paused scoreboard frame; result distributed to all peers via Autobase',
    file: 'pear-app/bare/goalPipeline.js',
  },
]

const QVAC_CAPABILITIES = [
  { n: 1, name: 'Bergamot NMT translation', file: 'bare/translate.js' },
  { n: 2, name: 'Qwen3 0.6B LLM (sharedLlmHandle)', file: 'bare/commentator.js + voiceCoach.js + askTheFrame.js' },
  { n: 3, name: 'Whisper Tiny + Silero VAD STT', file: 'bare/voiceCoach.js' },
  { n: 4, name: 'Supertonic multilingual TTS + streaming', file: 'bare/voiceCoach.js (sdk.textToSpeechStream)' },
  { n: 5, name: 'Chatterbox voice cloning (EN/IT only)', file: 'bare/voiceCoach.js — honest limitation: EN/IT pairs only' },
  { n: 6, name: 'Llama-3.2 streaming commentator', file: 'bare/commentator.js (contentDelta + thinkingDelta + completionStats)' },
  { n: 7, name: 'SmolVLM2 500M multimodal + mmproj', file: 'bare/askTheFrame.js — VLM frame captioning' },
  { n: 8, name: 'MobileNetV3 pre-filter (@qvac/classification-ggml)', file: 'bare/askTheFrame.js — cheap classifier gates VLM' },
  { n: 9, name: 'OCR_LATIN two-stage CRAFT + Latin recogniser', file: 'bare/goalPipeline.js (defaultRotationAngles for rotated jerseys)' },
  { n: 10, name: 'Parakeet CTC 0.6B EN-only fallback STT', file: 'bare/voiceCoach.js — tight-RAM alternative to Whisper' },
  { n: 11, name: 'EmbeddingGemma 300M Q4 RAG', file: 'bare/ragStore.js (ingest + search + embed + workspace lifecycle)' },
  { n: 12, name: 'MCP tool calling (in-process McpClient)', file: 'bare/mcpClient.js — 7 backend tools' },
  { n: 13, name: 'Delegated inference (sdk.startQVACProvider)', file: 'bare/delegatedProvider.js — fail-closed allow-list firewall' },
  { n: 14, name: 'sdk.cancel barge-in', file: 'bare/voiceCoach.js + bare/askTheFrame.js — Cancel buttons' },
  { n: 15, name: '@qvac/diagnostics native report', file: 'renderer/components/DiagnosticsPanel.js — Report tab' },
]

const PEARS_TECHNIQUES = [
  {
    name: 'Autobase apply purity + host-only writer gate',
    detail: 'Pattern B reducers are pure: no side effects inside apply(). Host-only message types verified by writer pubkey before the Hyperbee write.',
    file: 'bare/chat.js + bare/playhead.js',
  },
  {
    name: 'base.ack() cadence',
    detail: '2500ms background loop calls base.ack() on indexer writers to advance the Autobase view when no user append is pending. Also called immediately post-append.',
    file: 'bare/chat.js (ADR 004)',
  },
  {
    name: 'Autobase view.checkout(v) chat scrubber',
    detail: 'Read-only snapshot of the linearised Autobase view at version v. Enables the match chat history scrubber without corrupting the live head.',
    file: 'bare/chat.js',
  },
  {
    name: 'Apply middleware chain (koa-style compose)',
    detail: 'Middleware observes base.on("update") events; it never runs inside apply(). Compose chains are stateless so replay is deterministic.',
    file: 'bare/middleware.js (ADR 006)',
  },
  {
    name: 'Hyperbee sub() namespacing',
    detail: 'One Bee on the Autobase view, four sub() buckets: chat, tip-log, writer-roster, reactions. Legacy fallback reads from the root namespace for old rooms.',
    file: 'bare/chat.js + bare/tip.js',
  },
  {
    name: 'Hypercore block encryption (sealed predictions)',
    detail: 'Prediction commits use BLAKE2b-256 key derivation on the host mnemonic to encrypt each block. Peers cannot read the plaintext until the host publishes the reveal key.',
    file: 'bare/prediction.js (ADR 008)',
  },
  {
    name: 'Blind-peering explicit target + suspend/resume',
    detail: 'Each Autobase discovery key is registered with an explicit target peer so blind replication is deterministic. suspend() / resume() on network change prevents stale DHT registrations.',
    file: 'bare/blindPeering.js (ADR 003)',
  },
  {
    name: 'Prometheus federation (loopback-only exporter)',
    detail: 'hypertrace-prometheus runs on 127.0.0.1 only. Federates hypercore-stats + hyperswarm-stats + hyperdht-stats under curva_backend_* counter families. curva_backend_tip_submitted_total tracks every EIP-3009 submission.',
    file: 'backend/src/lib/metrics.ts (ADR 009)',
  },
]

const BACKEND_DEPTH = [
  {
    name: 'Match-clip Hyperdrive',
    detail: 'Backend seeds a shared Hyperdrive of match highlights. Peers resolve clips over DHT without downloading from a CDN.',
    file: 'backend/src/workers/clipSeedWorker.ts',
  },
  {
    name: '7 MCP tools',
    detail: 'score.getLive, ref.discipline, stadium.getFixtures, roster.getSquad, venue.getDetails, standings.getTable, broadcast.getRegions — all callable from in-app McpClient.',
    file: 'backend/src/lib/mcp/tools.ts',
  },
  {
    name: 'Delegated QVAC provider with fail-closed firewall',
    detail: 'sdk.startQVACProvider exposes the host GPU to guest peers. An explicit capability allow-list denies any capability not in the approved set before the request reaches QVAC.',
    file: 'backend/src/lib/qvac/delegatedProvider.ts',
  },
  {
    name: 'FIFA 2026 shared RAG corpus',
    detail: '166 fixtures, full squad lists, venue details, broadcast regions — pre-embedded with EmbeddingGemma and served as a Hyperbee snapshot peers can sync on join.',
    file: 'backend/src/data/qvac-models.json + ragIngestion.ts',
  },
  {
    name: 'Prometheus federation',
    detail: 'curva_backend_* counter families (tip_submitted_total, mcp_tool_call_total, qvac_inference_ms_histogram). GET /metrics federates all registered prom-client collectors.',
    file: 'backend/src/lib/metrics.ts',
  },
]

function Wave25Section() {
  return (
    <section id="wave25" aria-label="Wave 2-5 depth">
      {/* Orchestration flows */}
      <AnimateComponent onScroll entry="fadeInUp">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-[rgba(200,16,46,0.12)] border border-[rgba(200,16,46,0.2)] flex items-center justify-center text-[#c8102e]">
            <GitBranch size={20} aria-hidden="true" />
          </div>
          <div>
            <SectionLabel>Pillar 04</SectionLabel>
            <h2 className="font-display text-3xl md:text-4xl font-bold text-[#f5f5f0] curva-underline">
              Wave 2-5 depth
            </h2>
          </div>
        </div>
        <p className="text-[#8a8a8a] text-base max-w-2xl leading-relaxed mb-12">
          15 on-device QVAC capabilities, 3 cross-capability orchestration flows
          (5-6 caps per gesture), 8 advanced Pears techniques, and a backend
          companion with 7 MCP tools and a FIFA 2026 RAG corpus.
        </p>
      </AnimateComponent>

      <AnimateComponent onScroll entry="fadeInUp" delay={40}>
        <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#8a8a8a] mb-6">
          Cross-capability orchestration flows
        </p>
      </AnimateComponent>

      <div className="grid sm:grid-cols-3 gap-4 mb-16">
        {ORCHESTRATION_FLOWS.map((flow, i) => (
          <AnimateComponent key={flow.name} onScroll entry="fadeInUp" delay={i * 60}>
            <article className="p-5 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.07)] hover:border-[rgba(255,255,255,0.14)] h-full flex flex-col gap-3 hover:-translate-y-0.5 transition-all duration-200 ease-out">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[#f5f5f0] text-sm font-semibold">{flow.name}</p>
                <span className="flex-shrink-0 font-mono-code text-[10px] px-1.5 py-0.5 rounded bg-[rgba(200,16,46,0.15)] border border-[rgba(200,16,46,0.3)] text-[#c8102e]">
                  {flow.caps} caps
                </span>
              </div>
              <p className="font-mono-code text-[10px] text-[rgba(212,175,55,0.75)] leading-relaxed flex-1">
                {flow.chain}
              </p>
              <p className="text-[#8a8a8a] text-xs leading-relaxed">{flow.trigger}</p>
              <p className="font-mono-code text-[9px] text-[rgba(212,175,55,0.5)]">{flow.file}</p>
            </article>
          </AnimateComponent>
        ))}
      </div>

      {/* QVAC capabilities */}
      <AnimateComponent onScroll entry="fadeInUp">
        <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#8a8a8a] mb-6">
          15 QVAC capabilities on-device
        </p>
      </AnimateComponent>

      <AnimateComponent onScroll entry="fadeInUp" delay={40}>
        <ul className="space-y-2 mb-16">
          {QVAC_CAPABILITIES.map((cap) => (
            <li
              key={cap.n}
              className="flex items-start gap-3 px-4 py-3 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.06)] hover:border-[rgba(255,255,255,0.1)] transition-colors"
            >
              <span className="flex-shrink-0 font-mono-code text-[10px] text-[#c8102e] w-5 text-right mt-0.5">
                {String(cap.n).padStart(2, '0')}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[#f5f5f0] font-medium">{cap.name}</p>
                <p className="font-mono-code text-[9px] text-[rgba(212,175,55,0.6)] mt-0.5 leading-snug">
                  {cap.file}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </AnimateComponent>

      {/* Pears techniques */}
      <AnimateComponent onScroll entry="fadeInUp">
        <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#8a8a8a] mb-6">
          8 Pears techniques on top of 13 primitives
        </p>
      </AnimateComponent>

      <div className="grid sm:grid-cols-2 gap-4 mb-16">
        {PEARS_TECHNIQUES.map((t, i) => (
          <AnimateComponent key={t.name} onScroll entry="fadeInUp" delay={i * 50}>
            <article className="p-5 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.07)] hover:border-[rgba(255,255,255,0.14)] h-full flex flex-col gap-2 hover:-translate-y-0.5 transition-all duration-200 ease-out">
              <p className="text-[#f5f5f0] text-sm font-semibold">{t.name}</p>
              <p className="text-[#8a8a8a] text-xs leading-relaxed flex-1">{t.detail}</p>
              <p className="font-mono-code text-[9px] text-[rgba(212,175,55,0.6)]">{t.file}</p>
            </article>
          </AnimateComponent>
        ))}
      </div>

      {/* Backend depth */}
      <AnimateComponent onScroll entry="fadeInUp">
        <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#8a8a8a] mb-6">
          Backend companion depth
        </p>
      </AnimateComponent>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {BACKEND_DEPTH.map((item, i) => (
          <AnimateComponent key={item.name} onScroll entry="fadeInUp" delay={i * 50}>
            <article className="p-5 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.07)] hover:border-[rgba(255,255,255,0.14)] h-full flex flex-col gap-2 hover:-translate-y-0.5 transition-all duration-200 ease-out">
              <p className="text-[#f5f5f0] text-sm font-semibold">{item.name}</p>
              <p className="text-[#8a8a8a] text-xs leading-relaxed flex-1">{item.detail}</p>
              <p className="font-mono-code text-[9px] text-[rgba(212,175,55,0.6)]">{item.file}</p>
            </article>
          </AnimateComponent>
        ))}
      </div>
    </section>
  )
}

// ─── Page composition ─────────────────────────────────────────────────────────

function FeaturesPage() {
  return (
    <div className="bg-[#0a0a0a] min-h-screen">
      {/* Page hero */}
      <div
        className={cnm(
          'relative px-6 md:px-12 pt-36 pb-20 overflow-hidden curva-stripes',
        )}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 right-0 w-[600px] h-[600px] rounded-full opacity-[0.04]"
          style={{
            background: 'radial-gradient(circle, #c8102e 0%, transparent 70%)',
          }}
        />
        {/* CURVA texture word */}
        <span
          aria-hidden="true"
          className="pointer-events-none select-none absolute right-[-4%] top-1/2 -translate-y-1/2 font-display font-bold text-[#f5f5f0] leading-none hidden lg:block"
          style={{ fontSize: '140px', opacity: 0.06, letterSpacing: '-0.04em' }}
        >
          FEATURES
        </span>
        <div className="max-w-[1100px] mx-auto">
          <AnimateComponent entry="fadeInUp" duration={600}>
            <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#c8102e] mb-4">
              Features
            </p>
          </AnimateComponent>
          <AnimateComponent entry="fadeInUp" delay={60} duration={700}>
            <h1
              className="font-display font-bold text-[#f5f5f0] leading-[1.02] tracking-tight mb-6"
              style={{ fontSize: 'clamp(40px, 5vw, 72px)' }}
            >
              13 Pears primitives + 8 techniques,
              <br className="hidden md:block" /> 15 QVAC capabilities.
            </h1>
          </AnimateComponent>
          <AnimateComponent entry="fadeInUp" delay={120} duration={600}>
            <p className="text-[#8a8a8a] text-lg max-w-2xl leading-relaxed">
              Three pillars, four waves of depth. Every claim maps to a file and
              line number in the codebase.
            </p>
          </AnimateComponent>
        </div>
      </div>

      {/* Main content */}
      <div className="px-6 md:px-12 py-20 max-w-[1100px] mx-auto">
        <PearsSection />
        <Divider />
        <WdkSection />
        <Divider />
        <QvacSection />
        <Divider />
        <Wave25Section />
      </div>

      {/* Cross-pillar callout */}
      <div className="px-6 md:px-12 pb-10 max-w-[1100px] mx-auto">
        <AnimateComponent onScroll entry="fadeInUp">
          <div className="p-8 rounded-xl bg-[#141414] border border-[rgba(255,255,255,0.07)]">
            <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#c8102e] mb-3">
              Cross-pillar moment
            </p>
            <p className="font-display text-2xl md:text-3xl font-bold text-[#f5f5f0] mb-4">
              system:tip. system:tip-congrats. system:tip-ack.
            </p>
            <p className="text-[#8a8a8a] text-sm leading-relaxed max-w-xl">
              All three pillars fire in one 15-second frame. Torino friend-peer
              tips the Jakarta host via WDK EIP-3009. Autobase broadcasts
              system:tip to every peer. QVAC translates the congratulations per
              receiver locale. Host signs the ack over the tx hash with EIP-191. Anti-spoofing tested in
              test/wave8b.test.js.
            </p>
            <a
              href="https://github.com/placeholder-curva-repo"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 inline-flex items-center gap-1.5 text-xs text-[#8a8a8a] hover:text-[#f5f5f0] transition-colors curva-focus rounded"
            >
              <ExternalLink size={11} aria-hidden="true" />
              View source (placeholder, populate before submission)
            </a>
          </div>
        </AnimateComponent>
      </div>

      {/* Compose flow */}
      <div className="px-6 md:px-12 pb-24 max-w-[1100px] mx-auto">
        <AnimateComponent onScroll entry="fadeInUp">
          <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#c8102e] mb-4">
            How they compose
          </p>
          <h2 className="font-display text-2xl md:text-3xl font-bold text-[#f5f5f0] mb-8">
            Three pillars. One demo beat.
          </h2>
        </AnimateComponent>

        <AnimateComponent onScroll entry="fadeInUp" delay={60}>
          <div className="flex flex-col md:flex-row items-stretch gap-3">
            {[
              {
                step: '1',
                pillar: 'WDK',
                action:
                  'Torino friend-peer signs EIP-3009 transfer to Jakarta host, backend submits, on-chain in 2-6s.',
                color: 'rgba(200,16,46,0.12)',
                border: 'rgba(200,16,46,0.25)',
                text: '#c8102e',
              },
              {
                step: '2',
                pillar: 'Pears',
                action:
                  'Autobase writes system:tip to Hyperbee. Every peer receives it in milliseconds.',
                color: 'rgba(255,255,255,0.04)',
                border: 'rgba(255,255,255,0.1)',
                text: '#f5f5f0',
              },
              {
                step: '3',
                pillar: 'QVAC',
                action:
                  'Host emits system:tip-congrats. QVAC translates per locale. Zero cloud.',
                color: 'rgba(124,227,193,0.06)',
                border: 'rgba(124,227,193,0.18)',
                text: '#7ce3c1',
              },
              {
                step: '4',
                pillar: 'Pears + WDK',
                action:
                  'Host signs system:tip-ack via EIP-191 over tx hash. Anti-spoofing tested.',
                color: 'rgba(200,16,46,0.08)',
                border: 'rgba(200,16,46,0.2)',
                text: '#c8102e',
              },
            ].map((item, i) => (
              <div
                key={item.step}
                className="flex-1 flex flex-col md:flex-row items-stretch gap-3"
              >
                <div
                  className="flex-1 p-4 rounded-lg border flex flex-col gap-2"
                  style={{ background: item.color, borderColor: item.border }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="font-mono-code text-[9px] font-bold px-1.5 py-0.5 rounded"
                      style={{
                        color: item.text,
                        background: 'rgba(0,0,0,0.3)',
                      }}
                    >
                      {item.step}
                    </span>
                    <span
                      className="font-mono-code text-[10px] font-semibold"
                      style={{ color: item.text }}
                    >
                      {item.pillar}
                    </span>
                  </div>
                  <p className="text-[#8a8a8a] text-xs leading-relaxed">
                    {item.action}
                  </p>
                </div>
                {i < 3 && (
                  <div
                    aria-hidden="true"
                    className="hidden md:flex items-center text-[rgba(255,255,255,0.15)] text-xs self-center"
                  >
                    &#8594;
                  </div>
                )}
              </div>
            ))}
          </div>
        </AnimateComponent>
      </div>
    </div>
  )
}

export default FeaturesPage
