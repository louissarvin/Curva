import { useCallback, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Check, Copy, Cpu, ExternalLink, Play, Radio, Zap } from 'lucide-react'
import AnimateComponent from '@/components/elements/AnimateComponent'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/')({ component: CurvaLanding })

// ─── Types ────────────────────────────────────────────────────────────────────

interface PillarCard {
  icon: React.ReactNode
  pillar: string
  product: string
  summary: string
  evidence: Array<string>
  docsUrl: string
  docsLabel: string
}

// ─── Data (sourced from README.md + SUBMISSION.md) ────────────────────────────

const PILLARS: Array<PillarCard> = [
  {
    icon: <Radio size={22} />,
    pillar: 'Pears',
    product: 'Holepunch Pears Stack',
    summary:
      '13 Holepunch primitives exercised at runtime — Hyperswarm discovery, Autobase Pattern B multi-writer sync, blind-peering unattended replication, keet-identity-key 3.2.0 attested chat, Hyperdrive P2P video reel, pear-updater OTA. Published as a versioned pear:// app link — judges can `pear run pear://...` from any machine.',
    evidence: [
      'pear run pear://0.22823.hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy',
      'blind peer key: nm5j8618…t1fy (workers/main.js:809)',
      'pear-app/bare/blindPeering.js — unattended replication',
      'pear-app/bare/keetIdentity.js:29 — keet-identity-key 3.2.0',
    ],
    docsUrl: 'https://docs.pears.com/reference/#building-blocks',
    docsLabel: 'docs.pears.com',
  },
  {
    icon: <Zap size={22} />,
    pillar: 'WDK',
    product: 'Wallet Development Kit',
    summary:
      'Gasless USDT tipping with two working paths: EIP-3009 authorised transfer (2-6s to Sepolia receipt) and ERC-4337 UserOperation via Candide bundler with onChainIdentifier: "curva" attribution. Seed encrypted at rest via wdk-secret-manager.',
    evidence: [
      'pear-app/bare/wallet/eip3009.js — EIP-3009 primary path',
      'pear-app/bare/wallet/worklet.js:125 — onChainIdentifier attribution',
    ],
    docsUrl: 'https://wdk.tether.io',
    docsLabel: 'wdk.tether.io',
  },
  {
    icon: <Cpu size={22} />,
    pillar: 'QVAC',
    product: 'QVAC Local AI',
    summary:
      'On-device Bergamot NMT translation via @qvac/sdk@0.14.0 with modelConfig.pivotModel chained pivot. Bahasa Indonesia to Italian goes ID-EN-IT in one SDK call, and the reverse pair works from the same catalog. 12 EN-hub language pairs staged. SHA-256 model integrity verified before load. Zero network calls during translation.',
    evidence: [
      'pear-app/bare/translate.js:208-229 — pivotModel wiring',
      'backend/src/routes/qvacRoutes.ts — SHA-256 catalog endpoint',
    ],
    docsUrl: 'https://qvac.tether.io',
    docsLabel: 'qvac.tether.io',
  },
]

const TIP_FLOW_STEPS = [
  {
    step: '01',
    label: 'Tip initiated',
    detail:
      'Torino friend-peer taps Tip 1 USDT to the Jakarta host. EIP-3009 TransferWithAuthorization signed EOA-side.',
    pillar: 'WDK',
    file: 'pear-app/bare/wallet/eip3009.js',
  },
  {
    step: '02',
    label: 'system:tip broadcasts',
    detail:
      'Autobase writes system:tip to Hyperbee. Every peer receives it within milliseconds.',
    pillar: 'Pears',
    file: 'pear-app/bare/tip.js',
  },
  {
    step: '03',
    label: 'system:tip-congrats (translated)',
    detail:
      'Host emits congratulations. QVAC translates per receiver locale. The Jakarta host reads Bahasa Indonesia, the Torino friend-peer reads Italian. Zero cloud.',
    pillar: 'QVAC',
    file: 'pear-app/bare/translate.js:208-229',
  },
  {
    step: '04',
    label: 'system:tip-ack (host signed)',
    detail:
      'Host signs ack over tx hash via EIP-191. Anti-spoofing: a promoted writer cannot forge this ack (test/wave8b.test.js).',
    pillar: 'Pears + WDK',
    file: 'pear-app/bare/tip.js + wallet/eip3009.js',
  },
]

const BUILDING_BLOCKS = [
  {
    block: 'Hyperswarm',
    file: 'workers/main.js:40,183',
    purpose: 'Match-room discovery on sha256 topic, relayThrough NAT fallback',
  },
  {
    block: 'HyperDHT',
    file: 'bare/blindPeering.js:142',
    purpose: 'DHT instance passed directly to blind-peering client',
  },
  {
    block: 'Corestore',
    file: 'workers/main.js:41,153',
    purpose: 'Per-room namespaces on one disk root',
  },
  {
    block: 'Hypercore',
    file: 'bare/playhead.js:17 + chat.js',
    purpose: 'Named append-only logs for playhead, chat, clips, room state',
  },
  {
    block: 'Hyperbee',
    file: 'bare/chat.js:17 + tip.js',
    purpose: 'Chat view, tip log, writer roster, reactions bucket',
  },
  {
    block: 'Autobase',
    file: 'bare/playhead.js:80 + chat.js',
    purpose: 'Pattern B multi-writer, pure reducers, deterministic replay',
  },
  {
    block: 'Hyperdrive',
    file: 'bare/clips.js:27,85',
    purpose: 'Per-peer clip filesystem, findingPeers cold-start',
  },
  {
    block: 'Hyperblobs',
    file: 'bare/clips.js:28,92',
    purpose: '128x72 ffmpeg-baseline clip thumbnails',
  },
  {
    block: 'hypercore-blob-server',
    file: 'bare/clips.js:36,111',
    purpose: 'Loopback HTTP server for RFC 7233 range-request clip streaming',
  },
  {
    block: 'blind-peering',
    file: 'bare/blindPeering.js:98 + workers/main.js:809',
    purpose: 'Registers chat + playhead Autobases; rooms persist without host',
  },
  {
    block: 'keet-identity-key',
    file: 'bare/keetIdentity.js:29',
    purpose: 'keet-identity-key 3.2.0: BIP-39 mnemonic-rooted peer identity',
  },
  {
    block: 'pear-updater',
    file: 'workers/main.js:313,371-374',
    purpose: 'OTA events: updating/updated; renderer toast on new version',
  },
  {
    block: 'pear-electron',
    file: 'electron/main.js:4,11',
    purpose: 'Electron + Bare dual-runtime; PearRuntime spawns Bare workers',
  },
]

// ─── Sub-components ───────────────────────────────────────────────────────────

function Chip({
  children,
  accent = false,
}: {
  children: React.ReactNode
  accent?: boolean
}) {
  return (
    <span
      className={cnm(
        'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium tracking-wide',
        accent
          ? 'bg-[rgba(200,16,46,0.15)] text-[#c8102e] border border-[rgba(200,16,46,0.35)]'
          : 'bg-[rgba(255,255,255,0.05)] text-[#8a8a8a] border border-[rgba(255,255,255,0.08)]',
      )}
    >
      {children}
    </span>
  )
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [value])

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Copied to clipboard' : 'Copy to clipboard'}
      className={cnm(
        'inline-flex items-center gap-2 px-4 py-2 rounded text-sm transition-all duration-200 curva-focus',
        'bg-[rgba(200,16,46,0.12)] border border-[rgba(200,16,46,0.3)] text-[#f5f5f0]',
        'hover:bg-[rgba(200,16,46,0.2)] hover:border-[rgba(200,16,46,0.5)]',
        'active:scale-95',
      )}
    >
      {copied ? (
        <Check size={14} className="text-[#c8102e]" />
      ) : (
        <Copy size={14} className="text-[#c8102e]" />
      )}
      <span className="font-mono-code">{value}</span>
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#c8102e] mb-3">
      {children}
    </p>
  )
}

function Divider() {
  return <div className="h-px bg-[rgba(255,255,255,0.07)] my-24" />
}

// ─── Marquee Ticker ───────────────────────────────────────────────────────────

const MARQUEE_CONTENT =
  'PEARS + WDK + QVAC · WATCH THE WORLD CUP WITH FRIENDS · BOLA UNTUK SEMUA · COSI IL CALCIO DOVEVA ESSERE · FORZA CURVA · 13 BUILDING BLOCKS · JAKARTA · TORINO · ZERO SERVERS · '

function Marquee() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden border-y border-[rgba(255,255,255,0.05)] py-3 my-0"
    >
      <div className="marquee-track">
        {/* Doubled content so the loop is seamless */}
        <span className="font-display italic text-sm text-[rgba(200,16,46,0.45)] tracking-widest pr-8 whitespace-nowrap">
          {MARQUEE_CONTENT.repeat(4)}
        </span>
        <span
          aria-hidden="true"
          className="font-display italic text-sm text-[rgba(200,16,46,0.45)] tracking-widest pr-8 whitespace-nowrap"
        >
          {MARQUEE_CONTENT.repeat(4)}
        </span>
      </div>
    </div>
  )
}

// ─── Section: Hero ────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section
      id="hero"
      aria-label="Hero"
      className="relative flex flex-col justify-center px-6 md:px-12 pt-20 curva-stripes overflow-hidden"
      style={{ minHeight: '88vh' }}
    >
      {/* Background "CURVA" texture word */}
      <span
        aria-hidden="true"
        className="pointer-events-none select-none absolute right-[-2%] top-1/2 -translate-y-1/2 font-display font-bold text-[#f5f5f0] leading-none hidden lg:block"
        style={{ fontSize: '180px', opacity: 0.08, letterSpacing: '-0.04em' }}
      >
        CURVA
      </span>

      {/* Red radial glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/3 left-0 w-96 h-96 rounded-full opacity-10"
        style={{
          background: 'radial-gradient(circle, #c8102e 0%, transparent 70%)',
          transform: 'translateY(-50%)',
        }}
      />

      <div className="relative max-w-[1100px] mx-auto w-full py-32">
        <AnimateComponent entry="fadeInUp" duration={600}>
          <div className="flex flex-wrap gap-2 mb-8">
            <Chip accent>Pears Track</Chip>
            <Chip>Tether Developers Cup 2026</Chip>
            <Chip>Nation: Indonesia</Chip>
          </div>
        </AnimateComponent>

        <AnimateComponent entry="fadeInUp" delay={80} duration={700}>
          <h1
            className="font-display font-bold text-[#f5f5f0] leading-[1.02] tracking-tight mb-6"
            style={{ fontSize: 'clamp(52px, 7vw, 96px)' }}
          >
            Watch the World Cup
            <br className="hidden md:block" /> with friends,
            <br className="hidden md:block" /> peer-to-peer.
          </h1>
        </AnimateComponent>

        <AnimateComponent entry="fadeInUp" delay={160} duration={700}>
          <p className="text-[#8a8a8a] text-lg md:text-xl max-w-2xl leading-relaxed mb-10">
            Team Indonesia. Jakarta ultras energy meets the Italian vocabulary
            that gave the app its name. Holepunch Pears engine. WDK stablecoin
            tips. QVAC on-device translation. No server. No FIFA broadcast
            platform. No API keys.
          </p>
        </AnimateComponent>

        <AnimateComponent entry="fadeInUp" delay={240} duration={600}>
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            <CopyButton value="pear run pear://hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy" />
            <a
              href="#demo"
              className={cnm(
                'inline-flex items-center gap-2 px-4 py-2 rounded text-sm text-[#8a8a8a]',
                'hover:text-[#f5f5f0] transition-colors curva-focus',
              )}
            >
              <Play size={14} className="text-[#c8102e]" aria-hidden="true" />
              Watch the 3-minute demo
            </a>
          </div>
          <p className="mt-3 text-xs text-[#8a8a8a] font-mono-code">
            versioned:{' '}
            <span className="text-[rgba(212,175,55,0.7)]">
              pear://0.22823.hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy
            </span>
          </p>
        </AnimateComponent>

        {/* Scroll indicator */}
        <AnimateComponent entry="fadeIn" delay={600} duration={500}>
          <a
            href="#demo"
            aria-label="Scroll to demo"
            className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 text-[rgba(138,138,138,0.6)] hover:text-[#8a8a8a] transition-colors curva-focus rounded"
          >
            <span className="text-xs font-medium tracking-widest uppercase">
              scroll
            </span>
            <span className="w-px h-8 bg-[rgba(200,16,46,0.4)] animate-pulse" />
          </a>
        </AnimateComponent>
      </div>
    </section>
  )
}

// ─── Section: Demo video ──────────────────────────────────────────────────────

function DemoVideo() {
  return (
    <section
      id="demo"
      aria-label="Demo video"
      className="px-6 md:px-12 py-24 max-w-[1100px] mx-auto w-full"
    >
      <AnimateComponent onScroll entry="fadeInUp">
        <SectionLabel>Live demo</SectionLabel>
        <h2 className="font-display text-3xl md:text-4xl font-bold text-[#f5f5f0] mb-10 curva-underline">
          Two peers, two continents, one match, zero servers.
        </h2>
      </AnimateComponent>

      <AnimateComponent onScroll entry="scaleIn" delay={100}>
        <div
          className="relative w-full rounded-lg overflow-hidden border border-[rgba(255,255,255,0.07)]"
          style={{ aspectRatio: '16/9' }}
        >
          <div
            className="absolute inset-0 flex flex-col items-center justify-center bg-[#141414] curva-stripes"
            aria-label="Demo video placeholder"
          >
            <div className="w-14 h-14 rounded-full bg-[rgba(200,16,46,0.15)] border border-[rgba(200,16,46,0.3)] flex items-center justify-center mb-4">
              <Play
                size={22}
                className="text-[#c8102e] ml-1"
                aria-hidden="true"
              />
            </div>
            <p className="text-[#8a8a8a] text-sm font-mono-code">
              [populate YouTube unlisted URL after recording]
            </p>
            <p className="text-[rgba(138,138,138,0.5)] text-xs mt-2">
              3-minute Final pitch
            </p>
          </div>
        </div>
        <p className="mt-4 text-sm text-[#8a8a8a] leading-relaxed">
          Scene 5 at 2:00 shows all three pillars in 15 seconds: system:tip
          lands on Autobase, QVAC translates the congrats message per receiver
          locale, host EIP-191 signs the ack over the tx hash.
        </p>
      </AnimateComponent>
    </section>
  )
}

// ─── Section: Three pillars ───────────────────────────────────────────────────

function PillarCard({ card, index }: { card: PillarCard; index: number }) {
  return (
    <AnimateComponent onScroll entry="fadeInUp" delay={index * 80}>
      <article
        className={cnm(
          'card-top-line p-6 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.07)]',
          'flex flex-col gap-4 h-full',
          'hover:border-[rgba(255,255,255,0.14)] hover:-translate-y-0.5 transition-all duration-200 ease-out',
        )}
        aria-label={`${card.pillar} pillar`}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-[rgba(200,16,46,0.12)] border border-[rgba(200,16,46,0.2)] flex items-center justify-center text-[#c8102e]">
            {card.icon}
          </div>
          <div>
            <p className="font-semibold text-[#f5f5f0] text-sm leading-tight">
              {card.pillar}
            </p>
            <p className="text-[#8a8a8a] text-xs">{card.product}</p>
          </div>
        </div>

        <p className="text-[#8a8a8a] text-sm leading-relaxed flex-1">
          {card.summary}
        </p>

        <div className="space-y-1.5">
          {card.evidence.map((e) => (
            <p
              key={e}
              className="font-mono-code text-[10px] text-[rgba(212,175,55,0.75)] leading-snug"
            >
              {e}
            </p>
          ))}
        </div>

        <a
          href={card.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-[#8a8a8a] hover:text-[#f5f5f0] transition-colors curva-focus rounded"
        >
          <ExternalLink size={11} aria-hidden="true" />
          {card.docsLabel}
        </a>
      </article>
    </AnimateComponent>
  )
}

function Pillars() {
  return (
    <section
      id="pillars"
      aria-label="Three pillars"
      className="px-6 md:px-12 py-24 max-w-[1100px] mx-auto w-full"
    >
      <AnimateComponent onScroll entry="fadeInUp">
        <SectionLabel>Architecture</SectionLabel>
        <h2 className="font-display text-3xl md:text-4xl font-bold text-[#f5f5f0] mb-12 curva-underline">
          Three pillars, one demo.
        </h2>
      </AnimateComponent>

      <div className="grid md:grid-cols-3 gap-6">
        {PILLARS.map((card, i) => (
          <PillarCard key={card.pillar} card={card} index={i} />
        ))}
      </div>
    </section>
  )
}

// ─── Section: Cross-pillar tip beat ───────────────────────────────────────────

function PillarBadge({ label }: { label: string }) {
  return (
    <span className="inline-block text-[10px] font-medium px-2 py-0.5 rounded-full bg-[rgba(200,16,46,0.1)] border border-[rgba(200,16,46,0.25)] text-[#c8102e] font-mono-code">
      {label}
    </span>
  )
}

function CrossPillarBeat() {
  return (
    <section
      id="beat"
      aria-label="Cross-pillar tip beat"
      className="px-6 md:px-12 py-24 max-w-[1100px] mx-auto w-full"
    >
      <AnimateComponent onScroll entry="fadeInUp">
        <SectionLabel>Cross-pillar moment</SectionLabel>
        <h2 className="font-display text-3xl md:text-4xl font-bold text-[#f5f5f0] mb-4 curva-underline">
          15 seconds. Three pillars. On screen.
        </h2>
        <p className="text-[#8a8a8a] text-base mb-12 max-w-2xl leading-relaxed">
          No other Cup entrant has confirmed all three Tether pillars live in
          one sequence. The tip beat is the signature creative moment.
        </p>
      </AnimateComponent>

      <div className="relative">
        <div
          aria-hidden="true"
          className="absolute left-[27px] top-10 bottom-10 w-px bg-[rgba(200,16,46,0.25)]"
        />

        <ol className="space-y-0" aria-label="Tip beat sequence">
          {TIP_FLOW_STEPS.map((step, i) => (
            <AnimateComponent
              key={step.step}
              onScroll
              entry="fadeInLeft"
              delay={i * 80}
            >
              <li className="relative flex gap-5 pb-10 last:pb-0">
                <div
                  aria-hidden="true"
                  className="relative z-10 flex-shrink-0 w-14 h-14 rounded-full bg-[#141414] border border-[rgba(200,16,46,0.3)] flex flex-col items-center justify-center"
                >
                  <span className="text-[10px] font-mono-code text-[#c8102e] font-bold">
                    {step.step}
                  </span>
                </div>

                <div className="pt-1 pb-6">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-[#f5f5f0] font-semibold text-sm">
                      {step.label}
                    </p>
                    <PillarBadge label={step.pillar} />
                  </div>
                  <p className="text-[#8a8a8a] text-sm leading-relaxed mb-2">
                    {step.detail}
                  </p>
                  <p className="font-mono-code text-[10px] text-[rgba(212,175,55,0.6)]">
                    {step.file}
                  </p>
                </div>
              </li>
            </AnimateComponent>
          ))}
        </ol>
      </div>
    </section>
  )
}

// ─── Section: Architecture at a glance ────────────────────────────────────────

function ArchBlock({
  label,
  sub,
  accent = false,
}: {
  label: string
  sub: string
  accent?: boolean
}) {
  return (
    <div
      className={cnm(
        'rounded-lg p-4 border text-center',
        accent
          ? 'bg-[rgba(200,16,46,0.08)] border-[rgba(200,16,46,0.3)]'
          : 'bg-[#141414] border-[rgba(255,255,255,0.07)]',
      )}
    >
      <p
        className={cnm(
          'text-sm font-semibold',
          accent ? 'text-[#c8102e]' : 'text-[#f5f5f0]',
        )}
      >
        {label}
      </p>
      <p className="text-[10px] text-[#8a8a8a] mt-0.5 font-mono-code">{sub}</p>
    </div>
  )
}

function ArchitectureGlance() {
  return (
    <section
      id="architecture"
      aria-label="Architecture at a glance"
      className="px-6 md:px-12 py-24 max-w-[1100px] mx-auto w-full"
    >
      <AnimateComponent onScroll entry="fadeInUp">
        <SectionLabel>System</SectionLabel>
        <h2 className="font-display text-3xl md:text-4xl font-bold text-[#f5f5f0] mb-4 curva-underline">
          Architecture at a glance.
        </h2>
        <p className="text-[#8a8a8a] text-base mb-12 max-w-2xl leading-relaxed">
          Companion is optional infrastructure. Chat, playhead, and clips never
          touch it.
        </p>
      </AnimateComponent>

      <AnimateComponent onScroll entry="scaleIn" delay={80}>
        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-3">
            <ArchBlock accent label="Pear App (primary)" sub="pear-app/bare/" />
            <div className="grid grid-cols-3 gap-2">
              <ArchBlock label="Autobase" sub="playhead + chat" />
              <ArchBlock label="Hyperdrive" sub="clips" />
              <ArchBlock label="Hyperswarm" sub="discovery" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <ArchBlock label="WDK" sub="EIP-3009 + ERC-4337" />
              <ArchBlock label="QVAC" sub="modelConfig.pivotModel" />
            </div>
          </div>

          <div className="space-y-3">
            <ArchBlock
              label="Backend Companion (optional)"
              sub="backend/ — Fastify 5 on Bun, port 3700"
            />
            <div className="grid grid-cols-2 gap-2">
              <ArchBlock label="Seeder daemon" sub="seederReconcileWorker" />
              <ArchBlock label="DHT relay" sub="GET /relay/info" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <ArchBlock label="Sepolia" sub="EIP-3009 facilitator" />
              <ArchBlock label="QVAC catalog" sub="SHA-256 mirror" />
            </div>
          </div>
        </div>

        <div className="mt-8 p-4 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.07)]">
          <p className="text-xs text-[#8a8a8a] leading-relaxed">
            <span className="text-[#f5f5f0] font-medium">
              13 Holepunch primitives exercised at runtime.
            </span>{' '}
            Hyperswarm, HyperDHT, Corestore, Hypercore, Hyperbee, Autobase,
            Hyperdrive, Hyperblobs, hypercore-blob-server, blind-peering,
            keet-identity-key, pear-updater, pear-electron.
          </p>
        </div>
      </AnimateComponent>

      <AnimateComponent onScroll entry="fadeInUp" delay={120}>
        <div className="mt-10 overflow-x-auto">
          <table className="w-full text-sm" aria-label="Pears building blocks">
            <thead>
              <tr className="border-b border-[rgba(255,255,255,0.07)]">
                <th className="text-left text-xs font-medium text-[#8a8a8a] py-2 pr-4">
                  Block
                </th>
                <th className="text-left text-xs font-medium text-[#8a8a8a] py-2 pr-4 hidden md:table-cell">
                  File
                </th>
                <th className="text-left text-xs font-medium text-[#8a8a8a] py-2">
                  Purpose
                </th>
              </tr>
            </thead>
            <tbody>
              {BUILDING_BLOCKS.map((b) => (
                <tr
                  key={b.block}
                  className="border-b border-[rgba(255,255,255,0.04)] hover:bg-[rgba(255,255,255,0.02)] transition-colors"
                >
                  <td className="py-2.5 pr-4 font-mono-code text-[11px] text-[#c8102e] whitespace-nowrap">
                    {b.block}
                  </td>
                  <td className="py-2.5 pr-4 font-mono-code text-[10px] text-[rgba(212,175,55,0.6)] hidden md:table-cell">
                    {b.file}
                  </td>
                  <td className="py-2.5 text-xs text-[#8a8a8a]">{b.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AnimateComponent>
    </section>
  )
}

// ─── Section: Try Curva ───────────────────────────────────────────────────────

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-[#141414] border border-[rgba(255,255,255,0.07)] rounded-lg p-5 overflow-x-auto">
      <code className="font-mono-code text-sm text-[#f5f5f0] whitespace-pre leading-relaxed">
        {children}
      </code>
    </pre>
  )
}

function TryCurva() {
  return (
    <section
      id="try"
      aria-label="Try Curva"
      className="px-6 md:px-12 py-24 max-w-[1100px] mx-auto w-full"
    >
      <AnimateComponent onScroll entry="fadeInUp">
        <SectionLabel>Run it</SectionLabel>
        <h2 className="font-display text-3xl md:text-4xl font-bold text-[#f5f5f0] mb-4 curva-underline">
          Three steps to the watch-party.
        </h2>
        <p className="text-[#8a8a8a] text-base mb-12 max-w-2xl leading-relaxed">
          Two paths. Path A is one command on any machine. Path B requires the
          Companion or a fresh seeder on the topic.
        </p>
      </AnimateComponent>

      <div className="space-y-8">
        <AnimateComponent onScroll entry="fadeInUp" delay={0}>
          <div>
            <p className="text-[#f5f5f0] font-semibold text-sm mb-2 flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-[rgba(200,16,46,0.2)] border border-[rgba(200,16,46,0.4)] text-[#c8102e] text-[10px] font-mono-code flex items-center justify-center">
                1
              </span>
              Path A: local reproducible demo (judges)
            </p>
            <CodeBlock>{`git clone <repo-url> curva\ncd curva/pear-app\nnpm install\nnpm run demo:4peer`}</CodeBlock>
            <p className="text-xs text-[#8a8a8a] mt-2">
              Four windows open. Jakarta host peer plays the sample clip, three
              friend peers (including Torino) sync. Send a chat, tip 1 USDT,
              watch the full cross-pillar beat.
            </p>
          </div>
        </AnimateComponent>

        <AnimateComponent onScroll entry="fadeInUp" delay={80}>
          <div>
            <p className="text-[#f5f5f0] font-semibold text-sm mb-2 flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.12)] text-[#8a8a8a] text-[10px] font-mono-code flex items-center justify-center">
                2
              </span>
              Path B: published Pear alias (requires seeder live)
            </p>
            <CodeBlock>{`npm install -g pear-runtime\npear run pear://curva?room=demo-final-2026`}</CodeBlock>
          </div>
        </AnimateComponent>

        <AnimateComponent onScroll entry="fadeInUp" delay={160}>
          <div>
            <p className="text-[#f5f5f0] font-semibold text-sm mb-2 flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.12)] text-[#8a8a8a] text-[10px] font-mono-code flex items-center justify-center">
                3
              </span>
              Optional: spin up Backend Companion locally
            </p>
            <CodeBlock>{`cd backend\nbun install\nbun run db:push\nbun run dev\ncurl http://localhost:3700/health`}</CodeBlock>
          </div>
        </AnimateComponent>

        <AnimateComponent onScroll entry="fadeInUp" delay={240}>
          <div className="p-4 rounded-lg bg-[rgba(200,16,46,0.05)] border border-[rgba(200,16,46,0.15)]">
            <p className="text-sm text-[#8a8a8a] leading-relaxed">
              <span className="text-[#f5f5f0] font-medium">Test status:</span>{' '}
              <span className="font-mono-code text-[#c8102e]">414/414</span>{' '}
              backend asserts (1,783) +
              <span className="font-mono-code text-[#c8102e] ml-1">
                246/246
              </span>{' '}
              pear-app asserts (817). Total: 2,600 asserts green.
            </p>
          </div>
        </AnimateComponent>
      </div>
    </section>
  )
}

// ─── Section: Numbers band ────────────────────────────────────────────────────

const NUMBERS = [
  {
    value: '802',
    label: 'Tests passing',
    sub: '414 backend + 246 pear-app + 142 integration',
  },
  {
    value: '2,600',
    label: 'Asserts green',
    sub: '1,783 backend + 817 pear-app',
  },
  {
    value: '5 / 5',
    label: 'Pears idea slots',
    sub: 'All five track slots filled',
  },
  {
    value: '13',
    label: 'Building blocks',
    sub: 'All 13 Holepunch primitives at runtime',
  },
]

function Numbers() {
  return (
    <section
      aria-label="By the numbers"
      className="px-6 md:px-12 py-20 max-w-[1100px] mx-auto w-full"
    >
      <AnimateComponent onScroll entry="fadeInUp">
        <SectionLabel>By the numbers</SectionLabel>
        <h2 className="font-display text-3xl md:text-4xl font-bold text-[#f5f5f0] mb-12 curva-underline">
          The proof is in the tests.
        </h2>
      </AnimateComponent>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {NUMBERS.map((n, i) => (
          <AnimateComponent
            key={n.value}
            onScroll
            entry="fadeInUp"
            delay={i * 60}
          >
            <div
              className={[
                'p-6 rounded-lg border text-center',
                i === 0
                  ? 'bg-[rgba(124,227,193,0.04)] border-[rgba(124,227,193,0.15)]'
                  : 'bg-[#141414] border-[rgba(255,255,255,0.07)]',
              ].join(' ')}
            >
              <p
                className={[
                  'font-display font-bold text-4xl md:text-5xl leading-none mb-2',
                  i === 0 ? 'text-[#7ce3c1]' : 'text-[#c8102e]',
                ].join(' ')}
              >
                {n.value}
              </p>
              <p className="text-[#f5f5f0] text-sm font-semibold mb-1">
                {n.label}
              </p>
              <p className="text-[#8a8a8a] text-[10px] leading-snug">{n.sub}</p>
            </div>
          </AnimateComponent>
        ))}
      </div>
    </section>
  )
}

// ─── Section: Sign-off ────────────────────────────────────────────────────────

function SignOff() {
  return (
    <section
      id="signoff"
      aria-label="Curva sign-off"
      className="px-6 md:px-12 py-24 max-w-[1100px] mx-auto w-full"
    >
      <AnimateComponent onScroll entry="fadeInUp">
        <blockquote className="relative pl-6 border-l-2 border-[#c8102e] mb-10">
          <p className="font-display text-2xl md:text-3xl font-bold text-[#f5f5f0] italic leading-snug mb-3">
            "Trillions of self-custodial wallets. No string attached. Pure
            freedom."
          </p>
          <footer className="text-xs text-[#8a8a8a]">
            <cite>Paolo Ardoino</cite> , X post,{' '}
            <a
              href="https://x.com/paoloardoino/status/1974361565978915242"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#f5f5f0] transition-colors curva-focus rounded"
            >
              2025-10-04
            </a>{' '}
            (wdk-trillions-self-custodial, backend/src/data/phrasebook.json)
          </footer>
        </blockquote>
      </AnimateComponent>

      <AnimateComponent onScroll entry="fadeInUp" delay={80}>
        <div className="text-center py-16">
          <p className="font-display text-4xl md:text-5xl font-bold italic text-[#f5f5f0] mb-3">
            Cosi il calcio doveva essere.
          </p>
          <p className="text-[#8a8a8a] text-sm">
            "This is how football was always supposed to be."
          </p>
          <p className="mt-4 text-base font-semibold text-[#c8102e] tracking-wide">
            Forza Curva.
          </p>
        </div>
      </AnimateComponent>
    </section>
  )
}

// ─── Page composition ─────────────────────────────────────────────────────────

export default function CurvaLanding() {
  return (
    <div className="bg-[#0a0a0a] min-h-screen">
      <Hero />
      <Marquee />
      <DemoVideo />
      <div className="max-w-[1100px] mx-auto px-6 md:px-12">
        <Divider />
      </div>
      <Pillars />
      <Marquee />
      <CrossPillarBeat />
      <div className="max-w-[1100px] mx-auto px-6 md:px-12">
        <Divider />
      </div>
      <ArchitectureGlance />
      <Marquee />
      <Numbers />
      <div className="max-w-[1100px] mx-auto px-6 md:px-12">
        <Divider />
      </div>
      <TryCurva />
      <div className="max-w-[1100px] mx-auto px-6 md:px-12">
        <Divider />
      </div>
      <SignOff />
    </div>
  )
}
