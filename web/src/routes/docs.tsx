import { createFileRoute } from '@tanstack/react-router'
import AnimateComponent from '@/components/elements/AnimateComponent'

export const Route = createFileRoute('/docs')({ component: DocsPage })

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

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-[#141414] border border-[rgba(255,255,255,0.07)] rounded-lg p-5 overflow-x-auto">
      <code className="font-mono-code text-sm text-[#f5f5f0] whitespace-pre leading-relaxed">
        {children}
      </code>
    </pre>
  )
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[#f5f5f0] font-semibold text-base mb-3 mt-8 first:mt-0">
      {children}
    </h3>
  )
}

function Para({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[#8a8a8a] text-sm leading-relaxed mb-4">{children}</p>
  )
}

// ─── Content ──────────────────────────────────────────────────────────────────

const REPO_LAYOUT = `curva/
  README.md                      # Run instructions, building-block index
  CURVA_TECHNICAL_SPEC.md        # Data models, endpoint inventory, package versions
  SUBMISSION.md                  # DoraHacks positioning + Q&A
  DEMO_SCRIPT.md                 # 3-minute live pitch choreography
  pear-app/                      # Pears app (primary deliverable)
    package.json  ARCHITECTURE.md
    electron/  renderer/  bare/  scripts/  test/
  backend/                       # Curva Companion (optional)
    package.json  ARCHITECTURE.md
    prisma/  data/  src/
  web/                           # This site
  memory/                        # Research notes (gitignored)`

const PEAR_APP_SETUP = `git clone <repo-url> curva
cd curva/pear-app
npm install`

const DEMO_4PEER = `npm run demo:4peer`

const BACKEND_SETUP = `cd curva/backend
bun install
# Requires DATABASE_URL in .env
bun run db:push
bun run dev
curl http://localhost:3700/health`

const PEAR_ALIAS = `npm install -g pear-runtime
pear run pear://curva?room=demo-final-2026`

const TEST_COMMANDS = `# Backend tests
cd curva/backend
bun test
# Expected: 414/414 pass, 1783 asserts

# Pear-app tests
cd curva/pear-app
npm test
# Expected: 246/246 pass, 817 asserts`

const JUDGE_SEQUENCE = `# 1. Run all tests
cd backend && bun test && cd ../pear-app && npm test

# 2. Start 4-peer local demo
cd pear-app && npm run demo:4peer

# 3. (Optional) Start Backend Companion
cd ../backend && bun run dev

# 4. In one of the Pear windows: tip 1 USDT
#    Watch: system:tip -> system:tip-congrats (translated) -> system:tip-ack (signed)
#    All three pillars in under 15 seconds`

// ─── Page composition ─────────────────────────────────────────────────────────

function DocsPage() {
  return (
    <div className="bg-[#0a0a0a] min-h-screen">
      {/* Page hero */}
      <div className="relative px-6 md:px-12 pt-36 pb-20 overflow-hidden curva-stripes">
        <span
          aria-hidden="true"
          className="pointer-events-none select-none absolute right-[-2%] top-1/2 -translate-y-1/2 font-display font-bold text-[#f5f5f0] leading-none hidden lg:block"
          style={{ fontSize: '130px', opacity: 0.06, letterSpacing: '-0.04em' }}
        >
          DOCS
        </span>
        <div className="max-w-[1100px] mx-auto">
          <AnimateComponent entry="fadeInUp" duration={600}>
            <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#c8102e] mb-4">
              Docs
            </p>
          </AnimateComponent>
          <AnimateComponent entry="fadeInUp" delay={60} duration={700}>
            <h1
              className="font-display font-bold text-[#f5f5f0] leading-[1.02] tracking-tight mb-6"
              style={{ fontSize: 'clamp(40px, 5vw, 72px)' }}
            >
              Run Curva in
              <br className="hidden md:block" /> three commands.
            </h1>
          </AnimateComponent>
          <AnimateComponent entry="fadeInUp" delay={120} duration={600}>
            <p className="text-[#8a8a8a] text-lg max-w-2xl leading-relaxed">
              Judge experience: clone, install, demo:4peer. Everything else is
              optional.
            </p>
          </AnimateComponent>
        </div>
      </div>

      <div className="px-6 md:px-12 py-16 max-w-[800px] mx-auto">
        {/* Judge one-command experience */}
        <section aria-label="Judge one-command experience">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Judge experience</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              One command. Full demo.
            </h2>
            <Para>
              npm run demo:4peer opens four Electron windows on one machine.
              Jakarta host peer plays the sample clip; three friend peers
              (including Torino) sync. Send a chat,
              watch QVAC translate it, tip 1 USDT, watch the full cross-pillar
              beat.
            </Para>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <CodeBlock>{JUDGE_SEQUENCE}</CodeBlock>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Install */}
        <section aria-label="Installation">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Install</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-8 curva-underline">
              Pear app setup.
            </h2>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <H3>1. Clone and install</H3>
            <CodeBlock>{PEAR_APP_SETUP}</CodeBlock>

            <H3>2. Run the 4-peer scripted demo</H3>
            <Para>
              This is the primary judge path. No additional configuration
              required. All four peers run on localhost with separate Corestore
              namespaces.
            </Para>
            <CodeBlock>{DEMO_4PEER}</CodeBlock>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Backend Companion */}
        <section aria-label="Backend Companion setup">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Optional</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              Backend Companion.
            </h2>
            <Para>
              The Companion is optional. Curva works without it. Spinning it up
              locally adds: 24/7 seeder daemon, DHT relay for hostile NAT, match
              catalog, Etherscan-verifiable tip log, QVAC model mirror.
            </Para>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <Para>
              Requires: Bun runtime, a DATABASE_URL (SQLite works locally), and
              optionally the Sepolia RPC URL for facilitator functionality.
            </Para>
            <CodeBlock>{BACKEND_SETUP}</CodeBlock>
            <Para>
              Health check at http://localhost:3700/health returns:
              <span className="font-mono-code text-[#c8102e] ml-1">
                {"{ success: true, data: { status: 'ok' } }"}
              </span>
            </Para>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Published alias */}
        <section aria-label="Published Pear alias">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Pear alias</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              Published alias.
            </h2>
            <Para>
              The pear://curva alias is kept live through the live-pitch
              window (2026-07-15 to 2026-07-18) and up to the winners
              announcement (2026-07-19). Requires the Companion seeder to be
              running on the topic, or a manual seeder.
            </Para>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <CodeBlock>{PEAR_ALIAS}</CodeBlock>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Tests */}
        <section aria-label="Running tests">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Tests</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              2,600 asserts green.
            </h2>
            <Para>
              414/414 backend + 246/246 pear-app. Total 2,600 asserts.
              test/wave8b.test.js specifically proves that a promoted writer
              cannot forge system:tip-ack.
            </Para>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <CodeBlock>{TEST_COMMANDS}</CodeBlock>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Repo layout */}
        <section aria-label="Repository layout">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Repo layout</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              What's where.
            </h2>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <CodeBlock>{REPO_LAYOUT}</CodeBlock>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Sponsor wallet funding checklist */}
        <section aria-label="Sponsor wallet funding checklist">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Sponsor wallet</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              WDK tip funding checklist.
            </h2>
            <Para>
              For judges who want to see live USDT tips land on Sepolia rather
              than the simulated pending-only path, complete this checklist
              before running demo:4peer.
            </Para>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <ul className="space-y-2 mb-6">
              {[
                {
                  item: 'Get Sepolia ETH',
                  detail:
                    'Claim from sepoliafaucet.com. The EIP-3009 facilitator pays gas so the tipper pays zero, but the facilitator wallet needs ETH.',
                },
                {
                  item: 'Get Sepolia USDT',
                  detail:
                    'Contract: 0xd077a400968890eacc75cdc901f0356c943e4fdb on chainId 11155111. Mint via the contract directly or ask a team member for a test amount.',
                },
                {
                  item: 'Set FACILITATOR_PRIVATE_KEY in backend/.env',
                  detail:
                    'The facilitator wallet is the one that submits EIP-3009 TransferWithAuthorization transactions. Keep it funded with 0.05+ Sepolia ETH.',
                },
                {
                  item: 'Verify balance',
                  detail:
                    'curl http://localhost:3700/wdk/balance returns the facilitator ETH balance. Must be above 0 for live tips.',
                },
                {
                  item: 'Confirm Etherscan link works',
                  detail:
                    'After a tip, click the tx hash in the Pear app UI. It opens GET /wdk/verify/<txHash> which redirects to sepolia.etherscan.io.',
                },
              ].map((check) => (
                <li
                  key={check.item}
                  className="flex items-start gap-3 p-3 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.06)]"
                >
                  <span className="mt-0.5 w-4 h-4 rounded-full bg-[rgba(200,16,46,0.12)] border border-[rgba(200,16,46,0.3)] flex items-center justify-center flex-shrink-0">
                    <span className="text-[8px] font-bold text-[#c8102e]">
                      &#10003;
                    </span>
                  </span>
                  <div>
                    <p className="text-sm font-medium text-[#f5f5f0] mb-0.5">
                      {check.item}
                    </p>
                    <p className="text-xs text-[#8a8a8a] leading-relaxed">
                      {check.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <Para>
              If the facilitator wallet is unfunded, tips still appear instantly
              as pending rows in the Hyperbee log. The cross-pillar beat
              sequence is still fully observable; only the on-chain confirmation
              and Etherscan link are skipped.
            </Para>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Reference links */}
        <section aria-label="Reference documentation">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>References</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-8 curva-underline">
              External docs.
            </h2>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <ul className="space-y-3">
              {[
                {
                  label: 'Pears building blocks reference',
                  url: 'https://docs.pears.com/reference/#building-blocks',
                },
                { label: 'WDK documentation', url: 'https://wdk.tether.io' },
                {
                  label: 'QVAC SDK documentation',
                  url: 'https://qvac.tether.io',
                },
                {
                  label: 'Candide ERC-4337 bundler',
                  url: 'https://docs.candide.dev',
                },
                {
                  label: 'Sepolia Etherscan',
                  url: 'https://sepolia.etherscan.io',
                },
              ].map((link) => (
                <li key={link.url}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-[#8a8a8a] hover:text-[#f5f5f0] transition-colors curva-focus rounded group"
                  >
                    <span className="w-1 h-1 rounded-full bg-[#c8102e] group-hover:bg-[#c8102e]" />
                    {link.label}
                    <span className="font-mono-code text-[9px] text-[rgba(138,138,138,0.4)]">
                      {link.url}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </AnimateComponent>
        </section>
      </div>
    </div>
  )
}

export default DocsPage
