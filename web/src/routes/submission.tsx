import { createFileRoute } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import AnimateComponent from '@/components/elements/AnimateComponent'

export const Route = createFileRoute('/submission')({
  component: SubmissionPage,
})

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

// ─── Data from SUBMISSION.md ──────────────────────────────────────────────────

const QA = [
  {
    q: 'Q1. Which Tether platform does your project use, and how?',
    a: 'Curva ships all three pillars live in one three-minute demo, with Pears as the primary track. Pears layer: nine building blocks exercised — Hyperswarm for peer discovery on a sha256 match-room topic with relayThrough NAT fallback, Corestore managing per-room namespaces, Autobase Pattern B multi-writer with signed ed25519 invitations for playhead and chat, pure reducers with deterministic replay tests, Hyperbee views for chat/tip-log/room-state/writer-roster/reactions, per-peer Hyperdrives with findingPeers for clip sharing, 128x72 Hyperblobs thumbnails, hypercore-crypto for topic derivation and writer invitations, pear-runtime-updater for OTA toast and an in-process seeder daemon on drive discovery keys. WDK layer: two working paths — EIP-3009 TransferWithAuthorization signed EOA-side and settled through a backend facilitator (primary, 2-6s to receipt), plus ERC-4337 UserOperation via account.transfer() through Candide bundler + paymaster with onChainIdentifier: "curva" attribution appended per WDK docs. QVAC layer: native @qvac/sdk@0.14.0 with @qvac/translation-nmtcpp addon, modelConfig.pivotModel chained pivot (Italian into Bahasa Indonesia goes IT-EN-ID in one SDK call), 12 EN-hub language pairs staged, SHA-256 model integrity verified on device, zero network calls during translation.',
  },
  {
    q: 'Q2. One-line problem statement',
    a: 'Watching the World Cup with friends across borders should not require a server, an API key, or a platform that geoblocks half the world.',
  },
  {
    q: 'Q3. Country/region',
    a: 'Indonesia. Curva submits from Team Indonesia. The home peer is Curva Nord Jakarta, where Indonesian ultras culture (The Jakmania at Persija, Bonek at Persebaya, Aremania at Arema, Slemania at PSS Sleman) meets global football fandom. Timnas Indonesia is not in the 2026 World Cup but 275M+ Indonesians still watch, often through fragmented broadcast rights (Vidio, MolaTV, Emtek) and geoblocked streams. Curva\'s peer-to-peer sync is the answer to that reality. The demo\'s Torino side is our friend across continents, not our origin. The name "Curva" and the Italian phrases in the pitch are cultural respect for Ardoino, Tether, and Lugano heritage, not identity claims.',
  },
  {
    q: 'Q4. Biggest blocker (and mitigation)',
    a: "Pear runtime DHT cold-start latency on first peer connection can take 5 to 45 seconds. Mitigated by the Curva Companion, a public-good backend that seeds every announced match-room topic 24/7 (spawned via seederReconcileWorker at 60-second reconciliation), positioned the same way Tether positions Keet's public seeders. Peers behind symmetric NAT fall back to relayThrough using the pubkey served at GET /relay/info.",
  },
  {
    q: 'Q5. Demo video link',
    a: '[Populate at submission with 3-minute Final pitch YouTube URL.]',
    placeholder: true,
  },
  {
    q: 'Q6. Twitter post link',
    a: '[Populate at submission with the launch tweet URL from the Bahasa Indonesia + Italian quote-tweet chain.]',
    placeholder: true,
  },
]

const RUBRIC = [
  {
    axis: 'Real use of the chosen platform (Pears)',
    weight: 'Deepest weight',
    evidence:
      '13 primitives + 8 advanced techniques exercised at runtime, each with file evidence. Pattern B Autobase, ed25519 writer invitations, relayThrough NAT fallback, base.ack() cadence, view.checkout() scrubber, koa-style middleware chain, Hyperbee sub() namespacing, BLAKE2b-256 sealed predictions, Prometheus federation.',
    score: 'Strong',
  },
  {
    axis: 'Technical ambition',
    weight: '',
    evidence:
      'Cross-pillar demo beat: system:tip, system:tip-congrats (QVAC translated), system:tip-ack (EIP-191 host signed). All three pillars in 15 seconds. Three orchestration flows chaining 5-6 QVAC capabilities per gesture (voice coach, ask-the-frame, goal pipeline). 10 ADRs. Anti-spoofing proved in test/wave8b.test.js.',
    score: 'Strong',
  },
  {
    axis: 'Real-world utility',
    weight: '',
    evidence:
      'Watch-party is a native World Cup ritual. 104 matches, 48 teams seeded from wc2026-seed.json. QR code room invites. Auto-language locale detection. Tip pre-broadcast for instant UX.',
    score: 'Strong',
  },
  {
    axis: 'User experience',
    weight: '',
    evidence:
      'Two-window sync in 30 seconds. npm run demo:4peer judge reproducibility. One-tap 1 USDT tip with 200ms pending feedback. Toggle original / translated per message.',
    score: 'Strong',
  },
  {
    axis: 'Creativity',
    weight: '',
    evidence:
      'Tip beat as signature creative moment. Three pillars land in one visible sequence. Cryptographic anti-spoofing tested.',
    score: 'Strong',
  },
]

const PEARS_CHECKLIST = [
  { item: 'Hyperswarm', file: 'pear-app/bare/swarmLifecycle.js' },
  { item: 'Corestore', file: 'pear-app/bare/room.js' },
  { item: 'Hypercore', file: 'pear-app/bare/playhead.js + chat.js' },
  {
    item: 'Autobase (Pattern B)',
    file: 'pear-app/bare/playhead.js + writerInvitation.js',
  },
  { item: 'Hyperbee', file: 'pear-app/bare/chat.js + tip.js' },
  { item: 'Hyperdrive', file: 'pear-app/bare/clips.js' },
  { item: 'Hyperblobs', file: 'pear-app/bare/clips.js' },
  {
    item: 'hypercore-crypto',
    file: 'pear-app/bare/topics.js + writerInvitation.js',
  },
  { item: 'pear-runtime-updater', file: 'pear-app/electron/main.js' },
]

const IDEA_SLOTS = [
  {
    pillar: 'Pears',
    slot: 'Watch-party sync + peer-to-peer fan messaging (no central server)',
    evidence: 'pear-app/bare/playhead.js, chat.js, writerInvitation.js',
  },
  {
    pillar: 'Pears',
    slot: 'Group tools (clip sharing, tipping receipts)',
    evidence: 'pear-app/bare/clips.js, tip.js',
  },
  {
    pillar: 'WDK',
    slot: 'Tipping and creator payments',
    evidence:
      'pear-app/bare/wallet/eip3009.js, wallet/worklet.js, backend/src/routes/facilitatorRoutes.ts',
  },
  {
    pillar: 'WDK',
    slot: 'Smart accounts (account abstraction)',
    evidence: 'WalletManagerEvmErc4337 + Candide bundler + paymaster',
  },
  {
    pillar: 'QVAC',
    slot: 'Privacy-first replacements for cloud apps: translators',
    evidence: 'pear-app/bare/translate.js, backend/src/routes/qvacRoutes.ts',
  },
  {
    pillar: 'QVAC',
    slot: 'Clever optimisation making small models useful',
    evidence:
      'Bergamot ~17 MB per pair. EN-hub catalog reuses base model across pairs.',
  },
]

// ─── Page composition ─────────────────────────────────────────────────────────

function SubmissionPage() {
  return (
    <div className="bg-[#0a0a0a] min-h-screen">
      {/* Page hero */}
      <div className="relative px-6 md:px-12 pt-36 pb-20 overflow-hidden curva-stripes">
        <span
          aria-hidden="true"
          className="pointer-events-none select-none absolute right-[-2%] top-1/2 -translate-y-1/2 font-display font-bold text-[#f5f5f0] leading-none hidden lg:block"
          style={{ fontSize: '100px', opacity: 0.06, letterSpacing: '-0.04em' }}
        >
          SUBMIT
        </span>
        <div className="max-w-[1100px] mx-auto">
          <AnimateComponent entry="fadeInUp" duration={600}>
            <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#c8102e] mb-4">
              Submission
            </p>
          </AnimateComponent>
          <AnimateComponent entry="fadeInUp" delay={60} duration={700}>
            <h1
              className="font-display font-bold text-[#f5f5f0] leading-[1.02] tracking-tight mb-6"
              style={{ fontSize: 'clamp(40px, 5vw, 72px)' }}
            >
              Tether Developers Cup 2026.
              <br className="hidden md:block" /> Pears Track.
            </h1>
          </AnimateComponent>
          <AnimateComponent entry="fadeInUp" delay={120} duration={600}>
            <div className="flex flex-wrap gap-4 mb-4">
              <div>
                <p className="text-[9px] text-[#8a8a8a] uppercase tracking-wider mb-1">
                  Test status
                </p>
                <div className="flex gap-3">
                  <span className="font-mono-code text-[#c8102e] text-sm font-bold">
                    500+
                  </span>
                  <span className="text-xs text-[#8a8a8a] self-end mb-0.5">
                    tests across backend + pear-app
                  </span>
                </div>
                <div className="flex gap-3 mt-1">
                  <span className="font-mono-code text-[#c8102e] text-sm font-bold">
                    15
                  </span>
                  <span className="text-xs text-[#8a8a8a] self-end mb-0.5">
                    QVAC capabilities + 3 orchestration flows
                  </span>
                </div>
              </div>
              <div className="self-center h-12 w-px bg-[rgba(255,255,255,0.07)]" />
              <div>
                <p className="text-[9px] text-[#8a8a8a] uppercase tracking-wider mb-1">
                  Pears depth
                </p>
                <div className="flex gap-3">
                  <span className="font-mono-code text-[#f5f5f0] text-2xl font-bold">
                    13+8
                  </span>
                </div>
                <p className="text-[9px] text-[#8a8a8a] mt-0.5">
                  primitives + advanced techniques
                </p>
              </div>
              <div className="self-center h-12 w-px bg-[rgba(255,255,255,0.07)]" />
              <div>
                <p className="text-[9px] text-[#8a8a8a] uppercase tracking-wider mb-1">
                  Docs + commit
                </p>
                <div className="flex gap-3">
                  <span className="font-mono-code text-[#f5f5f0] text-sm font-bold">
                    10 ADRs
                  </span>
                  <span className="text-xs text-[#8a8a8a] self-end mb-0.5">
                    60+ pinned permalinks
                  </span>
                </div>
                <div className="mt-1">
                  <a
                    href="https://github.com/louissarvin/Curva/commit/9723e82"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 font-mono-code text-[10px] px-2 py-0.5 rounded bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.1)] text-[rgba(212,175,55,0.8)] hover:text-[rgba(212,175,55,1)] transition-colors curva-focus"
                  >
                    HEAD 9723e82
                  </a>
                </div>
              </div>
            </div>
          </AnimateComponent>
        </div>
      </div>

      <div className="px-6 md:px-12 py-16 max-w-[1100px] mx-auto">
        {/* Pears building-blocks checklist */}
        <section aria-label="Pears track checklist">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Pears Track</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-8 curva-underline">
              13 primitives + 8 techniques. All verified.
            </h2>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <ul className="space-y-2" aria-label="Building blocks checklist">
              {PEARS_CHECKLIST.map((item) => (
                <li
                  key={item.item}
                  className="flex items-start gap-3 p-3 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.06)]"
                >
                  <span className="mt-0.5 w-4 h-4 rounded-full bg-[rgba(200,16,46,0.15)] border border-[rgba(200,16,46,0.35)] flex items-center justify-center flex-shrink-0">
                    <Check
                      size={10}
                      className="text-[#c8102e]"
                      aria-hidden="true"
                    />
                  </span>
                  <div className="flex-1 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                    <p className="text-sm font-medium text-[#f5f5f0] whitespace-nowrap">
                      {item.item}
                    </p>
                    <p className="font-mono-code text-[9px] text-[rgba(212,175,55,0.65)]">
                      {item.file}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Idea-slot mapping */}
        <section aria-label="Track idea-line mapping">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Idea mapping</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-8 curva-underline">
              One idea slot per pillar.
            </h2>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm"
                aria-label="Idea line mapping table"
              >
                <thead>
                  <tr className="border-b border-[rgba(255,255,255,0.07)]">
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3 pr-4">
                      Pillar
                    </th>
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3 pr-4">
                      Idea slot filled
                    </th>
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3 hidden md:table-cell">
                      Curva evidence
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {IDEA_SLOTS.map((row, i) => (
                    <tr
                      key={i}
                      className="border-b border-[rgba(255,255,255,0.04)] hover:bg-[rgba(255,255,255,0.02)] transition-colors"
                    >
                      <td className="py-3 pr-4 font-mono-code text-[11px] text-[#c8102e] align-top whitespace-nowrap">
                        {row.pillar}
                      </td>
                      <td className="py-3 pr-4 text-xs text-[#8a8a8a] align-top">
                        {row.slot}
                      </td>
                      <td className="py-3 font-mono-code text-[9px] text-[rgba(212,175,55,0.6)] align-top hidden md:table-cell">
                        {row.evidence}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Judging rubric */}
        <section aria-label="Judging rubric alignment">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Rubric</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-8 curva-underline">
              Five axes. Evidence-backed.
            </h2>
          </AnimateComponent>

          <div className="space-y-4">
            {RUBRIC.map((row, i) => (
              <AnimateComponent
                key={row.axis}
                onScroll
                entry="fadeInUp"
                delay={i * 60}
              >
                <div className="p-5 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.07)]">
                  <div className="flex items-start justify-between gap-4 mb-2">
                    <p className="text-[#f5f5f0] font-semibold text-sm">
                      {row.axis}
                    </p>
                    <span className="flex-shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full bg-[rgba(200,16,46,0.15)] border border-[rgba(200,16,46,0.3)] text-[#c8102e]">
                      {row.score}
                    </span>
                  </div>
                  {row.weight && (
                    <p className="text-[9px] text-[#8a8a8a] uppercase tracking-wider mb-1">
                      {row.weight}
                    </p>
                  )}
                  <p className="text-xs text-[#8a8a8a] leading-relaxed">
                    {row.evidence}
                  </p>
                </div>
              </AnimateComponent>
            ))}
          </div>
        </section>

        <Divider />

        {/* DoraHacks Q&A */}
        <section aria-label="DoraHacks submission Q&A">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>DoraHacks Q&A</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              Submission form, pre-written.
            </h2>
            <p className="text-[#8a8a8a] text-base max-w-xl leading-relaxed mb-12">
              Questions Q5 and Q6 require population at submission time (video
              URL and tweet link).
            </p>
          </AnimateComponent>

          <div className="space-y-6">
            {QA.map((item, i) => (
              <AnimateComponent
                key={item.q}
                onScroll
                entry="fadeInUp"
                delay={i * 50}
              >
                <div className="rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.07)] overflow-hidden">
                  <div className="px-5 py-3 border-b border-[rgba(255,255,255,0.05)]">
                    <p className="text-xs font-semibold text-[#f5f5f0]">
                      {item.q}
                    </p>
                  </div>
                  <div className="px-5 py-4">
                    <p
                      className={`text-sm leading-relaxed ${item.placeholder ? 'text-[rgba(138,138,138,0.5)] font-mono-code text-xs' : 'text-[#8a8a8a]'}`}
                    >
                      {item.a}
                    </p>
                  </div>
                </div>
              </AnimateComponent>
            ))}
          </div>
        </section>

        <Divider />

        {/* Why we chose Pears */}
        <section aria-label="Why we chose Pears">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Why Pears</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-6 curva-underline">
              No string attached.
            </h2>
            <div className="p-6 rounded-xl bg-[#141414] border border-[rgba(255,255,255,0.07)] max-w-2xl">
              <p className="text-[#8a8a8a] text-sm leading-relaxed mb-5">
                Pears is the only platform in the competition that makes the
                no-server claim a technical reality rather than a marketing
                position. Hyperswarm handles NAT traversal. Autobase handles
                multi-writer consensus. Hyperdrive handles clip distribution.
                Every piece that in a traditional app would require a server now
                runs on the peer's machine. The Companion is genuinely optional:
                pulling its network cable changes the demo from "fast" to
                "slower on first connect" but never from "working" to "broken."
                That is exactly what Ardoino means by pure freedom.
              </p>
              <blockquote className="pl-4 border-l-2 border-[rgba(124,227,193,0.4)]">
                <p className="font-display italic text-base text-[#f5f5f0] leading-snug mb-2">
                  "No string attached, pure freedom."
                </p>
                <footer className="text-xs text-[#8a8a8a]">
                  <cite>Paolo Ardoino</cite> (all-three-no-string-attached,
                  backend/src/data/phrasebook.json)
                </footer>
              </blockquote>
            </div>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Ardoino quote */}
        <AnimateComponent onScroll entry="fadeInUp">
          <blockquote className="pl-6 border-l-2 border-[#c8102e]">
            <p className="font-display text-2xl md:text-3xl font-bold text-[#f5f5f0] italic leading-snug mb-3">
              "Trillions of self-custodial wallets. No string attached. Pure
              freedom."
            </p>
            <footer className="text-xs text-[#8a8a8a]">
              <cite>Paolo Ardoino</cite>
              {', '}
              <a
                href="https://x.com/paoloardoino/status/1974361565978915242"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[#f5f5f0] transition-colors curva-focus rounded"
              >
                X post, 2025-10-04
              </a>{' '}
              (wdk-trillions-self-custodial, backend/src/data/phrasebook.json)
            </footer>
          </blockquote>
        </AnimateComponent>

        <div className="mt-20 text-center py-12">
          <AnimateComponent onScroll entry="fadeInUp">
            <p className="font-display text-4xl font-bold italic text-[#f5f5f0] mb-3">
              Bola untuk semua.
            </p>
            <p className="text-[#8a8a8a] text-sm mb-2">
              Bahasa Indonesia: "Football for all."
            </p>
            <p className="font-display text-2xl font-bold italic text-[#f5f5f0] mb-3 mt-6">
              Cosi il calcio doveva essere.
            </p>
            <p className="text-[#8a8a8a] text-sm mb-4">
              Italian tribute to the SDK's origin: "This is how football was
              always supposed to be."
            </p>
            <p className="text-base font-semibold text-[#c8102e] tracking-wide">
              Forza Curva.
            </p>
          </AnimateComponent>
        </div>
      </div>
    </div>
  )
}

export default SubmissionPage
