import { createFileRoute } from '@tanstack/react-router'
import { ExternalLink, Play } from 'lucide-react'
import AnimateComponent from '@/components/elements/AnimateComponent'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/demo')({ component: DemoPage })

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#c8102e] mb-3">
      {children}
    </p>
  )
}

function Divider() {
  return <div className="h-px bg-[rgba(255,255,255,0.07)] my-16" />
}

// ─── Data from DEMO_SCRIPT.md ─────────────────────────────────────────────────

const SCENES = [
  {
    id: '01',
    time: '0:00 - 0:25',
    title: 'Problem framing',
    pillar: 'Narrative',
    script:
      "FIFA broadcast platforms geoblock half the world. Chat servers get taken down. Payment processors take a cut. Cloud translators phone home with every message. That's how we watch football in 2026. It shouldn't be. Curva is a peer-to-peer World Cup watch-party. No FIFA platform. No chat server. No cloud translator. No custody service. Just peers.",
    screen: 'Curva landing page with match catalog from GET /matches/today.',
    quote: 'Freedom is not negotiable.',
    files: ['renderer/main.js'],
    endpoint: 'GET /matches/today',
  },
  {
    id: '02',
    time: '0:25 - 0:55',
    title: 'Two peers, two windows, one match',
    pillar: 'Pears',
    script:
      'Curva Nord, Jakarta. Home to The Jakmania and 275M+ Indonesians who watch football even when Timnas is not in the Cup. On the other continent, Curva Sud, Torino. Same match, opposite hemispheres. Both peers open the same pear-link. Autobase Pattern B - the host signs an ed25519 invitation, both peers become writers. New chat messages survive host disconnect.',
    screen:
      'Two Electron windows side by side, both on pear://curva?room=demo-final-2026.',
    quote: null,
    files: [
      'pear-app/bare/room.js',
      'pear-app/bare/swarmLifecycle.js',
      'pear-app/bare/writerInvitation.js',
    ],
    endpoint: 'GET /rooms/demo-final-2026/peers',
  },
  {
    id: '03',
    time: '0:55 - 1:30',
    title: 'Synced playhead + goal clip',
    pillar: 'Pears',
    script:
      "Jakarta presses play. Watch Torino catch up on the other continent. That's Autobase linearising the playhead. Pure reducer, deterministic replay. Jakarta captures a 10-second clip on the goal moment. Hyperdrive replicates it to Torino with findingPeers so the first read doesn't block. Hyperblobs stores the 128 by 72 thumbnail.",
    screen:
      'Both video elements in lockstep. Click "Clip last 10s" in Jakarta. Thumbnail appears in Torino within 3 seconds.',
    quote: 'Local is the new global.',
    files: ['pear-app/bare/playhead.js', 'pear-app/bare/clips.js'],
    endpoint: null,
  },
  {
    id: '04',
    time: '1:30 - 2:00',
    title: 'On-device translation',
    pillar: 'QVAC',
    script:
      "Jakarta types Bahasa Indonesia. Torino reads Italian. There is no cloud in the middle. QVAC's modelConfig.pivotModel wires bergamot-id-en into bergamot-en-it so the SDK's BlockingService pivots through English in one call. Model file hashed on device before load. Zero network calls during translation. The model runs on Bare, not on someone else's GPU.",
    screen:
      'Jakarta types "GOOOL! Untuk semua Nusantara!" Torino sees both the original and translated "GOL! Per tutta l\'arcipelago!" Toggle show original / show translated.',
    quote: 'Small models, dedicated jobs, real utility.',
    files: ['pear-app/bare/translate.js (lines 208-229)'],
    endpoint: 'GET /qvac/catalog',
  },
  {
    id: '05',
    time: '2:00 - 2:35',
    title: 'Cross-pillar tip beat',
    pillar: 'All three',
    script:
      "Torino taps Tip 1 USDT to the Jakarta host. Path A - EIP-3009 authorised transfer. Peer signs, backend facilitator submits, on-chain in 2 to 6 seconds. Watch the Autobase: system:tip lands in every peer's Hyperbee. Host emits system:tip-congrats, QVAC translates it into each receiver's language, host signs system:tip-ack over the tx hash with EIP-191. Three pillars, one 15-second frame. Anti-spoofing test proves a promoted writer cannot forge that ack.",
    screen:
      'Tap Tip 1 USDT in Torino, addressed to the Jakarta host. Pending row in tip log within 200ms. 3-5s later: confirmed with tx hash. Click hash, Etherscan opens via GET /wdk/verify/<txHash>.',
    quote: 'USDT is money. Peer to peer.',
    files: [
      'pear-app/bare/tip.js',
      'pear-app/bare/wallet/eip3009.js',
      'pear-app/bare/wallet/worklet.js',
    ],
    endpoint: 'GET /wdk/verify/<txHash>',
  },
  {
    id: '06',
    time: '2:35 - 3:00',
    title: 'Close',
    pillar: 'Narrative',
    script:
      '13 Holepunch primitives. Two WDK settlement paths. One QVAC pivot model. 414 backend tests and 246 pear-app tests, all green. Team Indonesia ships a synchronised watch-party where all three Tether pillars work in one demo. Bola untuk semua. And in the language of the SDK we chose: Cosi il calcio doveva essere. Forza Curva.',
    screen:
      'README building blocks table + test-status. Fade to pear://curva?room=demo-final-2026 deep link and QR code.',
    quote: null,
    files: ['README.md'],
    endpoint: 'GET /metrics/live',
  },
]

const CUTS = [
  {
    name: '3-minute Final version',
    scenes: 6,
    target: '3:00 with 5s slack',
    note: 'Full six-scene script. Matches the 3-minute-max cap in the DoraHacks submission rules; used for the July 8 first cut and the July 15 to 18 live pitch window.',
  },
  {
    name: '90-second social cut',
    scenes: 4,
    target: '1:30',
    note: 'For a Twitter/X launch thread or the between-cut window. Drop Scene 1. Merge Scenes 3 + 4 into one beat.',
  },
  {
    name: '60-second teaser cut',
    scenes: 3,
    target: '1:00',
    note: 'Short-form clip. Three beats: show + tell, tip beat, close. Speak fast.',
  },
]

const SEPOLIA_TX =
  '0xf2a04d0126068769d88d027e5407bdd578ed6986a220907bc7bc5960b963f40e'

const PEARS_TIMELINE = [
  {
    time: '0:00',
    moment: 'App launch',
    primitives: 'pear-electron, pear-updater',
  },
  {
    time: '0:20',
    moment: 'Room join — swarm discovery',
    primitives: 'Hyperswarm, HyperDHT, Corestore',
  },
  {
    time: '0:35',
    moment: 'Autobase writer promotion',
    primitives: 'Autobase (Pattern B), Hypercore',
  },
  {
    time: '0:50',
    moment: 'Blind peer registration',
    primitives: 'blind-peering, HyperDHT',
  },
  {
    time: '1:05',
    moment: 'Chat messages sync',
    primitives: 'Autobase, Hyperbee',
  },
  {
    time: '1:30',
    moment: 'Goal clip captured + replicated',
    primitives: 'Hyperdrive, Hyperblobs, hypercore-blob-server',
  },
  {
    time: '1:55',
    moment: 'Friend-peer deep link join (Autobase writer promotion)',
    primitives: 'Autobase, keet-identity-key',
  },
  {
    time: '2:15',
    moment: 'OTA update notification',
    primitives: 'pear-updater',
  },
  {
    time: '2:25',
    moment: 'Cross-pillar tip beat (EIP-3009 on Sepolia)',
    primitives: 'Autobase, Hyperbee (system:tip write)',
  },
]

// ─── Components ───────────────────────────────────────────────────────────────

function PillarBadge({ label }: { label: string }) {
  const isAll = label === 'All three'
  return (
    <span
      className={cnm(
        'inline-block text-[10px] font-medium px-2 py-0.5 rounded-full font-mono-code',
        isAll
          ? 'bg-[rgba(200,16,46,0.15)] border border-[rgba(200,16,46,0.35)] text-[#c8102e]'
          : 'bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.1)] text-[#8a8a8a]',
      )}
    >
      {label}
    </span>
  )
}

function SceneCard({
  scene,
  index,
}: {
  scene: (typeof SCENES)[0]
  index: number
}) {
  return (
    <AnimateComponent onScroll entry="fadeInUp" delay={index * 60}>
      <article className="flex gap-5">
        {/* Scene number */}
        <div className="flex-shrink-0">
          <div className="w-12 h-12 rounded-full bg-[#141414] border border-[rgba(200,16,46,0.25)] flex items-center justify-center">
            <span className="font-mono-code text-[10px] text-[#c8102e] font-bold">
              {scene.id}
            </span>
          </div>
          {index < SCENES.length - 1 && (
            <div
              aria-hidden="true"
              className="w-px h-full bg-[rgba(200,16,46,0.2)] mx-auto mt-2"
            />
          )}
        </div>

        {/* Content */}
        <div className="pb-10 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <p className="text-[#f5f5f0] font-semibold text-sm">
              {scene.title}
            </p>
            <PillarBadge label={scene.pillar} />
            <span className="font-mono-code text-[9px] text-[#8a8a8a]">
              {scene.time}
            </span>
          </div>

          <p className="text-[#8a8a8a] text-sm leading-relaxed mb-3">
            {scene.script}
          </p>

          <div className="p-3 rounded bg-[#141414] border border-[rgba(255,255,255,0.06)] mb-3">
            <p className="text-[9px] font-medium text-[rgba(138,138,138,0.6)] uppercase tracking-wider mb-1">
              On screen
            </p>
            <p className="text-xs text-[#8a8a8a] leading-relaxed">
              {scene.screen}
            </p>
          </div>

          <div className="flex flex-wrap gap-3 items-start">
            <div className="flex flex-wrap gap-1.5">
              {scene.files.map((f) => (
                <span
                  key={f}
                  className="font-mono-code text-[9px] text-[rgba(212,175,55,0.65)] bg-[#141414] border border-[rgba(255,255,255,0.06)] px-2 py-1 rounded"
                >
                  {f}
                </span>
              ))}
            </div>
            {scene.endpoint && (
              <span className="font-mono-code text-[9px] text-[#c8102e] bg-[rgba(200,16,46,0.08)] border border-[rgba(200,16,46,0.2)] px-2 py-1 rounded">
                {scene.endpoint}
              </span>
            )}
          </div>

          {scene.quote && (
            <p className="mt-3 font-display italic text-base text-[rgba(200,16,46,0.7)]">
              "{scene.quote}"
              <span className="not-italic text-[9px] text-[#8a8a8a] ml-2 font-sans">
                — Ardoino overlay (phrasebook.json)
              </span>
            </p>
          )}
        </div>
      </article>
    </AnimateComponent>
  )
}

// ─── Page composition ─────────────────────────────────────────────────────────

function DemoPage() {
  return (
    <div className="bg-[#0a0a0a] min-h-screen">
      {/* Page hero */}
      <div className="relative px-6 md:px-12 pt-36 pb-20 overflow-hidden curva-stripes">
        <span
          aria-hidden="true"
          className="pointer-events-none select-none absolute right-[-2%] top-1/2 -translate-y-1/2 font-display font-bold text-[#f5f5f0] leading-none hidden lg:block"
          style={{ fontSize: '130px', opacity: 0.06, letterSpacing: '-0.04em' }}
        >
          DEMO
        </span>
        <div className="max-w-[1100px] mx-auto">
          <AnimateComponent entry="fadeInUp" duration={600}>
            <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#c8102e] mb-4">
              Demo
            </p>
          </AnimateComponent>
          <AnimateComponent entry="fadeInUp" delay={60} duration={700}>
            <h1
              className="font-display font-bold text-[#f5f5f0] leading-[1.02] tracking-tight mb-6"
              style={{ fontSize: 'clamp(40px, 5vw, 72px)' }}
            >
              3 minutes.
              <br className="hidden md:block" /> Three pillars. One sequence.
            </h1>
          </AnimateComponent>
          <AnimateComponent entry="fadeInUp" delay={120} duration={600}>
            <p className="text-[#8a8a8a] text-lg max-w-2xl leading-relaxed">
              Six scenes. Scene 5 at 2:00 is the signature moment: system:tip,
              QVAC translation, EIP-191 ack. All three Tether pillars in 15
              seconds of screen time.
            </p>
          </AnimateComponent>
        </div>
      </div>

      <div className="px-6 md:px-12 py-16 max-w-[1100px] mx-auto">
        {/* Video embed placeholder */}
        <section aria-label="Demo video">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Video</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-8 curva-underline">
              Two peers, two continents, one match.
            </h2>
          </AnimateComponent>

          <AnimateComponent onScroll entry="scaleIn" delay={80}>
            <div
              className="relative w-full rounded-lg overflow-hidden border border-[rgba(255,255,255,0.07)] mb-4"
              style={{ aspectRatio: '16/9' }}
            >
              {/* Placeholder until YouTube URL is populated */}
              <div
                className="absolute inset-0 flex flex-col items-center justify-center bg-[#141414] curva-stripes"
                aria-label="Demo video placeholder"
              >
                <div className="w-16 h-16 rounded-full bg-[rgba(200,16,46,0.15)] border border-[rgba(200,16,46,0.3)] flex items-center justify-center mb-4">
                  <Play
                    size={24}
                    className="text-[#c8102e] ml-1"
                    aria-hidden="true"
                  />
                </div>
                <p className="text-[#8a8a8a] text-sm font-mono-code mb-1">
                  [populate YouTube unlisted URL before submission]
                </p>
                <p className="text-[rgba(138,138,138,0.5)] text-xs">
                  3-minute Final pitch — 2026-07-15
                </p>
              </div>
            </div>
            <p className="text-xs text-[#8a8a8a]">
              Video recorded at 1280x720 60fps H.264 baseline, hosted YouTube
              unlisted. Link added at submission time.
            </p>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Six scenes transcript */}
        <section aria-label="Six-scene transcript">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Script</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              3-minute Final version.
            </h2>
            <p className="text-[#8a8a8a] text-base max-w-xl leading-relaxed mb-12">
              Six scenes. Timings assume live delivery with 5-10 seconds buffer
              for network jitter. Last rehearsed 2026-07-03. Final: 2026-07-15.
            </p>
          </AnimateComponent>

          <div className="relative">
            <div
              aria-hidden="true"
              className="absolute left-6 top-6 bottom-6 w-px bg-[rgba(200,16,46,0.15)]"
            />
            {SCENES.map((scene, i) => (
              <SceneCard key={scene.id} scene={scene} index={i} />
            ))}
          </div>
        </section>

        <Divider />

        {/* Cut variants */}
        <section aria-label="Shorter cuts">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Shorter cuts</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-8 curva-underline">
              Rehearsal timing.
            </h2>
          </AnimateComponent>

          <div className="grid sm:grid-cols-3 gap-4">
            {CUTS.map((cut, i) => (
              <AnimateComponent
                key={cut.name}
                onScroll
                entry="fadeInUp"
                delay={i * 60}
              >
                <div className="p-5 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.07)]">
                  <p className="text-[#f5f5f0] font-semibold text-sm mb-2">
                    {cut.name}
                  </p>
                  <div className="flex gap-4 mb-3">
                    <div>
                      <p className="text-[8px] text-[#8a8a8a] uppercase tracking-wider">
                        Scenes
                      </p>
                      <p className="font-mono-code text-[#c8102e] text-sm font-bold">
                        {cut.scenes}
                      </p>
                    </div>
                    <div>
                      <p className="text-[8px] text-[#8a8a8a] uppercase tracking-wider">
                        Target
                      </p>
                      <p className="font-mono-code text-[#f5f5f0] text-sm font-bold">
                        {cut.target}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-[#8a8a8a] leading-relaxed">
                    {cut.note}
                  </p>
                </div>
              </AnimateComponent>
            ))}
          </div>
        </section>

        <Divider />

        {/* Pears primitives timeline */}
        <section aria-label="Pears primitives exercised">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Pears</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              Primitives exercised.
            </h2>
            <p className="text-[#8a8a8a] text-base max-w-xl leading-relaxed mb-8">
              Which Holepunch primitives fire at each moment of the 3-minute
              demo. 13 building blocks, all live.
            </p>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm"
                aria-label="Pears primitives timeline"
              >
                <thead>
                  <tr className="border-b border-[rgba(255,255,255,0.07)]">
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3 pr-4 whitespace-nowrap">
                      Time
                    </th>
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3 pr-4">
                      Moment
                    </th>
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3">
                      Primitives
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {PEARS_TIMELINE.map((row) => (
                    <tr
                      key={row.time}
                      className="border-b border-[rgba(255,255,255,0.04)] hover:bg-[rgba(255,255,255,0.02)] transition-colors"
                    >
                      <td className="py-3 pr-4 font-mono-code text-[11px] text-[#c8102e] whitespace-nowrap align-top">
                        {row.time}
                      </td>
                      <td className="py-3 pr-4 text-xs text-[#f5f5f0] align-top">
                        {row.moment}
                      </td>
                      <td className="py-3 font-mono-code text-[10px] text-[rgba(212,175,55,0.75)] align-top leading-relaxed">
                        {row.primitives}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={120}>
            <div className="mt-8 p-4 rounded-lg bg-[rgba(200,16,46,0.04)] border border-[rgba(200,16,46,0.15)]">
              <p className="text-xs text-[#8a8a8a] leading-relaxed mb-3">
                <span className="text-[#f5f5f0] font-medium">
                  WDK path confirmed live on Sepolia.
                </span>{' '}
                The tip at t=2:25 lands on-chain via our custom EIP-3009 USDT
                contract (0x6F51d2…7739). The sample tx shows both
                AuthorizationUsed and Transfer events.
              </p>
              <a
                href={`https://sepolia.etherscan.io/tx/${SEPOLIA_TX}`}
                target="_blank"
                rel="noopener noreferrer"
                className={cnm(
                  'inline-flex items-center gap-2 text-xs font-mono-code',
                  'text-[rgba(212,175,55,0.8)] hover:text-[rgba(212,175,55,1)] transition-colors',
                )}
              >
                <ExternalLink size={11} aria-hidden="true" />
                {SEPOLIA_TX.slice(0, 18)}...{SEPOLIA_TX.slice(-8)}
                <span className="text-[#8a8a8a] font-sans not-italic">
                  (sepolia.etherscan.io)
                </span>
              </a>
            </div>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Try it section */}
        <section aria-label="Try it yourself">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Run it</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-8 curva-underline">
              One command. Four peers.
            </h2>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <div className="space-y-4">
              <pre className="bg-[#141414] border border-[rgba(255,255,255,0.07)] rounded-lg p-5 overflow-x-auto">
                <code className="font-mono-code text-sm text-[#f5f5f0] whitespace-pre leading-relaxed">
                  {`git clone <repo-url> curva\ncd curva/pear-app\nnpm install\nnpm run demo:4peer`}
                </code>
              </pre>
              <p className="text-xs text-[#8a8a8a] leading-relaxed max-w-xl">
                Four windows open. Jakarta host peer plays the sample clip,
                three friend peers (including Torino) sync. Send a chat, watch
                translation land, tip 1 USDT, and watch the full system:tip,
                system:tip-congrats, system:tip-ack sequence complete.
              </p>
            </div>
          </AnimateComponent>
        </section>
      </div>
    </div>
  )
}

export default DemoPage
