import { createFileRoute } from '@tanstack/react-router'
import AnimateComponent from '@/components/elements/AnimateComponent'

export const Route = createFileRoute('/architecture')({
  component: ArchitecturePage,
})

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

// ─── Data ─────────────────────────────────────────────────────────────────────

const BUILDING_BLOCKS = [
  {
    block: 'Hyperswarm',
    file: 'pear-app/bare/swarmLifecycle.js',
    purpose:
      'Match-room discovery on sha256 topic. relayThrough NAT fallback via Companion relay pubkey.',
  },
  {
    block: 'Corestore',
    file: 'pear-app/bare/room.js',
    purpose:
      'One disk root per room. Named cores share a namespace for deterministic cross-peer replication.',
  },
  {
    block: 'Hypercore',
    file: 'pear-app/bare/playhead.js + chat.js',
    purpose:
      'Named append-only logs for playhead state, chat messages, goal clips, and room state.',
  },
  {
    block: 'Autobase',
    file: 'pear-app/bare/playhead.js + chat.js',
    purpose:
      'Pattern B multi-writer. Host-signed ed25519 invitations. Pure reducers with deterministic replay tests.',
  },
  {
    block: 'Hyperbee',
    file: 'pear-app/bare/chat.js + tip.js',
    purpose:
      'Chat view, tip log, writer roster, and reactions bucket materialised over Autobase output core.',
  },
  {
    block: 'Hyperdrive',
    file: 'pear-app/bare/clips.js',
    purpose:
      'Per-peer goal clip filesystem. findingPeers waits for remote peer before first read.',
  },
  {
    block: 'Hyperblobs',
    file: 'pear-app/bare/clips.js',
    purpose:
      '128x72 ffmpeg-baseline JPEG thumbnails. Replicated with the Hyperdrive.',
  },
  {
    block: 'hypercore-crypto',
    file: 'pear-app/bare/topics.js + writerInvitation.js',
    purpose:
      'sha256 topic derivation. ed25519 keypairs for writer invitations verified on addWriter.',
  },
  {
    block: 'pear-runtime-updater',
    file: 'pear-app/electron/main.js',
    purpose:
      'OTA renderer toast. Backend runs in-process seeder daemon on drive discovery keys.',
  },
]

const TECH_STACK = [
  {
    layer: 'Pear app shell',
    tech: 'Electron + Bare (pear-runtime)',
    version: 'pear-runtime ^3.x',
  },
  {
    layer: 'P2P transport',
    tech: 'Hyperswarm + Autobase + Hyperbee + Hyperdrive',
    version: 'pear-app/package.json',
  },
  {
    layer: 'WDK tipping',
    tech: '@tetherto/wdk + wdk-wallet-evm-erc-4337 + wdk-secret-manager',
    version: 'beta.12 / beta.10 / beta.3',
  },
  {
    layer: 'WDK primary path',
    tech: 'EIP-3009 TransferWithAuthorization via facilitator',
    version: 'Sepolia chainId 11155111',
  },
  {
    layer: 'WDK fallback path',
    tech: 'ERC-4337 UserOperation via Candide bundler',
    version: 'api.candide.dev/public/v3/11155111',
  },
  {
    layer: 'QVAC translation',
    tech: '@qvac/sdk + @qvac/translation-nmtcpp',
    version: '^0.14.0',
  },
  {
    layer: 'Translation model',
    tech: 'Bergamot NMT (17 MB per pair)',
    version: 'EN-hub, 12 pairs staged',
  },
  {
    layer: 'Backend Companion',
    tech: 'Fastify 5 on Bun',
    version: 'port 3700, 21 routes, 47 endpoints',
  },
  {
    layer: 'Database',
    tech: 'Prisma + SQLite (dev) / Postgres (prod)',
    version: 'backend/prisma/schema.prisma',
  },
  {
    layer: 'Video encode',
    tech: 'H.264 baseline + AAC LC',
    version: 'assets/sample-clip.mp4',
  },
]

const BACKEND_ROUTES = [
  '/matches',
  '/matches/today',
  '/matches/live',
  '/teams',
  '/rooms',
  '/tips',
  '/leaderboard',
  '/activity',
  '/dashboard',
  '/phrasebook',
  '/qvac/*',
  '/wdk/verify/*',
  '/relay/info',
  '/chains',
  '/demo',
  '/health',
  '/status',
  '/mcp',
  '/pricing',
  '/distribution',
  '/token-domain',
  '/facilitator',
]

const WORKERS = [
  {
    name: 'catalogSyncWorker',
    job: 'Refresh match catalog from external feed every 6 hours',
  },
  { name: 'tipIndexerWorker', job: 'Index confirmed Sepolia tip transactions' },
  { name: 'liveMatchPulseWorker', job: 'Push live match status updates' },
  {
    name: 'matchAutoWarmWorker',
    job: 'Pre-warm match room topics before kick-off',
  },
  {
    name: 'modelMirrorSyncWorker',
    job: 'Mirror Bergamot model files for QVAC peers',
  },
  { name: 'relayConfirmationWorker', job: 'Confirm relay pubkey is reachable' },
  { name: 'roomCleanupWorker', job: 'Expire inactive rooms after 24 hours' },
  {
    name: 'seederReconcileWorker',
    job: 'Reconcile active seeder set every 60s. Keeps all announced rooms seeded 24/7.',
  },
  { name: 'errorLogCleanup', job: 'Cap error log table at 10,000 records' },
]

// ─── Diagram: System overview ─────────────────────────────────────────────────

function SystemDiagram() {
  return (
    <AnimateComponent onScroll entry="scaleIn">
      <div className="rounded-xl border border-[rgba(255,255,255,0.07)] bg-[#141414] p-6 md:p-8 overflow-x-auto">
        <p className="text-xs font-medium tracking-[0.15em] uppercase text-[#8a8a8a] mb-6">
          System overview
        </p>

        <div className="grid md:grid-cols-5 gap-3 min-w-[640px]">
          {/* Peers */}
          <div className="md:col-span-2 space-y-2">
            <div className="rounded-lg bg-[rgba(200,16,46,0.08)] border border-[rgba(200,16,46,0.25)] p-3 text-center">
              <p className="text-[#c8102e] text-xs font-semibold font-mono-code">
                Pear App (primary)
              </p>
              <p className="text-[rgba(138,138,138,0.7)] text-[9px] mt-0.5">
                pear-app/bare/
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {['Autobase', 'Hyperbee', 'Hyperdrive'].map((b) => (
                <div
                  key={b}
                  className="rounded bg-[#1c1c1c] border border-[rgba(255,255,255,0.06)] p-2 text-center"
                >
                  <p className="text-[#f5f5f0] text-[9px] font-mono-code">
                    {b}
                  </p>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded bg-[rgba(200,16,46,0.06)] border border-[rgba(200,16,46,0.15)] p-2 text-center">
                <p className="text-[#c8102e] text-[9px] font-mono-code">WDK</p>
                <p className="text-[rgba(138,138,138,0.5)] text-[8px]">
                  EIP-3009 + ERC-4337
                </p>
              </div>
              <div className="rounded bg-[rgba(200,16,46,0.06)] border border-[rgba(200,16,46,0.15)] p-2 text-center">
                <p className="text-[#c8102e] text-[9px] font-mono-code">QVAC</p>
                <p className="text-[rgba(138,138,138,0.5)] text-[8px]">
                  pivotModel
                </p>
              </div>
            </div>
          </div>

          {/* Arrows */}
          <div className="flex flex-col items-center justify-center gap-2">
            <div className="text-[rgba(255,255,255,0.2)] text-xs text-center leading-tight">
              <div>Hyperswarm</div>
              <div className="text-[8px] text-[#8a8a8a]">DHT</div>
            </div>
            <div className="flex-1 flex items-center">
              <div className="h-px w-full bg-[rgba(255,255,255,0.1)]" />
            </div>
            <div className="text-[rgba(255,255,255,0.2)] text-xs text-center leading-tight">
              <div>EIP-3009</div>
              <div className="text-[8px] text-[#8a8a8a]">optional</div>
            </div>
          </div>

          {/* Backend */}
          <div className="md:col-span-2 space-y-2">
            <div className="rounded-lg bg-[#1c1c1c] border border-[rgba(255,255,255,0.08)] p-3 text-center">
              <p className="text-[#f5f5f0] text-xs font-semibold font-mono-code">
                Backend Companion
              </p>
              <p className="text-[rgba(138,138,138,0.7)] text-[9px] mt-0.5">
                optional, Fastify 5 / port 3700
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'Seeder daemon', sub: 'seederReconcileWorker' },
                { label: 'DHT relay', sub: 'GET /relay/info' },
                { label: 'Sepolia facilitator', sub: 'EIP-3009 path' },
                { label: 'QVAC catalog', sub: 'SHA-256 mirror' },
              ].map((item) => (
                <div
                  key={item.label}
                  className="rounded bg-[#1c1c1c] border border-[rgba(255,255,255,0.06)] p-2"
                >
                  <p className="text-[#f5f5f0] text-[9px] font-medium">
                    {item.label}
                  </p>
                  <p className="text-[rgba(138,138,138,0.5)] text-[8px] font-mono-code">
                    {item.sub}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <p className="mt-6 text-[10px] text-[rgba(138,138,138,0.5)] leading-relaxed">
          App is fully functional if Companion is unreachable. Chat, playhead,
          and clips go peer-to-peer via Hyperswarm. Companion adds persistent
          seeding, DHT relay for hostile NAT, and Etherscan-verifiable tip logs.
        </p>
      </div>
    </AnimateComponent>
  )
}

// ─── Page composition ─────────────────────────────────────────────────────────

function ArchitecturePage() {
  return (
    <div className="bg-[#0a0a0a] min-h-screen">
      {/* Page hero */}
      <div className="relative px-6 md:px-12 pt-36 pb-20 overflow-hidden curva-stripes">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] opacity-[0.03]"
          style={{
            background: 'radial-gradient(ellipse, #c8102e 0%, transparent 70%)',
          }}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none select-none absolute right-[-2%] top-1/2 -translate-y-1/2 font-display font-bold text-[#f5f5f0] leading-none hidden lg:block"
          style={{ fontSize: '120px', opacity: 0.06, letterSpacing: '-0.04em' }}
        >
          ARCH
        </span>
        <div className="max-w-[1100px] mx-auto">
          <AnimateComponent entry="fadeInUp" duration={600}>
            <p className="text-xs font-medium tracking-[0.2em] uppercase text-[#c8102e] mb-4">
              Architecture
            </p>
          </AnimateComponent>
          <AnimateComponent entry="fadeInUp" delay={60} duration={700}>
            <h1
              className="font-display font-bold text-[#f5f5f0] leading-[1.02] tracking-tight mb-6"
              style={{ fontSize: 'clamp(40px, 5vw, 72px)' }}
            >
              P2P + Companion.
              <br className="hidden md:block" /> No lock-in.
            </h1>
          </AnimateComponent>
          <AnimateComponent entry="fadeInUp" delay={120} duration={600}>
            <p className="text-[#8a8a8a] text-lg max-w-2xl leading-relaxed">
              21 route modules, 47 endpoints, 9 workers. The Backend Companion
              is positioned the same way Tether positions Keet's public seeders:
              public-good infrastructure, not a platform.
            </p>
          </AnimateComponent>
        </div>
      </div>

      <div className="px-6 md:px-12 py-20 max-w-[1100px] mx-auto space-y-20">
        {/* System diagram */}
        <section aria-label="System diagram">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Overview</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-8 curva-underline">
              The full picture.
            </h2>
          </AnimateComponent>
          <SystemDiagram />
        </section>

        <Divider />

        {/* Building blocks table */}
        <section id="building-blocks" aria-label="Pears building blocks">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Pears</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              Nine building blocks.
            </h2>
            <p className="text-[#8a8a8a] text-base max-w-xl leading-relaxed mb-8">
              All nine, exercised at runtime. File evidence for each.
            </p>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm"
                aria-label="Pears building blocks table"
              >
                <thead>
                  <tr className="border-b border-[rgba(255,255,255,0.07)]">
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3 pr-4">
                      Block
                    </th>
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3 pr-4 hidden md:table-cell">
                      File
                    </th>
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3">
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
                      <td className="py-3 pr-4 font-mono-code text-[11px] text-[#c8102e] whitespace-nowrap align-top">
                        {b.block}
                      </td>
                      <td className="py-3 pr-4 font-mono-code text-[10px] text-[rgba(212,175,55,0.65)] hidden md:table-cell align-top">
                        {b.file}
                      </td>
                      <td className="py-3 text-xs text-[#8a8a8a] align-top">
                        {b.purpose}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Tech stack table */}
        <section id="stack" aria-label="Tech stack">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Stack</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-8 curva-underline">
              Full tech stack.
            </h2>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Tech stack table">
                <thead>
                  <tr className="border-b border-[rgba(255,255,255,0.07)]">
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3 pr-4">
                      Layer
                    </th>
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3 pr-4">
                      Technology
                    </th>
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3 hidden md:table-cell">
                      Version / Detail
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {TECH_STACK.map((row) => (
                    <tr
                      key={row.layer}
                      className="border-b border-[rgba(255,255,255,0.04)] hover:bg-[rgba(255,255,255,0.02)] transition-colors"
                    >
                      <td className="py-3 pr-4 text-xs text-[#f5f5f0] font-medium align-top whitespace-nowrap">
                        {row.layer}
                      </td>
                      <td className="py-3 pr-4 text-xs text-[#8a8a8a] align-top">
                        {row.tech}
                      </td>
                      <td className="py-3 font-mono-code text-[10px] text-[rgba(212,175,55,0.6)] hidden md:table-cell align-top">
                        {row.version}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Backend Companion: routes + workers */}
        <section id="companion" aria-label="Backend Companion">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Companion</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              Backend Companion.
            </h2>
            <p className="text-[#8a8a8a] text-base max-w-xl leading-relaxed mb-8">
              Fastify 5 on Bun, port 3700. Public-good infrastructure. 21 route
              modules, 47 endpoints, 9 workers.
            </p>
          </AnimateComponent>

          <div className="grid md:grid-cols-2 gap-8">
            <AnimateComponent onScroll entry="fadeInUp">
              <div>
                <p className="text-xs font-medium text-[#f5f5f0] mb-3">
                  Route inventory
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  {BACKEND_ROUTES.map((route) => (
                    <div
                      key={route}
                      className="font-mono-code text-[10px] text-[#8a8a8a] bg-[#141414] border border-[rgba(255,255,255,0.06)] px-2.5 py-1.5 rounded"
                    >
                      {route}
                    </div>
                  ))}
                </div>
              </div>
            </AnimateComponent>

            <AnimateComponent onScroll entry="fadeInUp" delay={80}>
              <div>
                <p className="text-xs font-medium text-[#f5f5f0] mb-3">
                  Workers
                </p>
                <div className="space-y-2">
                  {WORKERS.map((w) => (
                    <div
                      key={w.name}
                      className="flex gap-3 p-3 rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.06)]"
                    >
                      <p className="font-mono-code text-[10px] text-[#c8102e] whitespace-nowrap mt-0.5">
                        {w.name}
                      </p>
                      <p className="text-[10px] text-[#8a8a8a] leading-relaxed">
                        {w.job}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </AnimateComponent>
          </div>
        </section>
      </div>
    </div>
  )
}

export default ArchitecturePage
