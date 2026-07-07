import { useCallback, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Check, Copy } from 'lucide-react'
import AnimateComponent from '@/components/elements/AnimateComponent'
import { cnm } from '@/utils/style'

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

const PEAR_LINK_VERSIONED =
  'pear://0.22823.hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy'
const PEAR_LINK_UNVERSIONED = 'pear://hcg8oftrk7hps1z4x9pprf4jhk7mitohjort6csfpjwjjo3ynomy'
const BLIND_PEER_KEY = 'nm5j8618j8jhbc5rrjtemkixqjes4ngzc36nc9pf1jop8u4kt1fy'

// ─── Data ─────────────────────────────────────────────────────────────────────

const BUILDING_BLOCKS = [
  {
    block: 'Hyperswarm',
    file: 'workers/main.js:40,183',
    purpose:
      'Match-room discovery on sha256 topic. relayThrough NAT fallback via Companion relay pubkey.',
    docsUrl: 'https://docs.pears.com/reference/building-blocks/hyperswarm/',
  },
  {
    block: 'HyperDHT',
    file: 'bare/blindPeering.js:142',
    purpose:
      'DHT instance (swarm.dht) passed directly to the blind-peering client constructor.',
    docsUrl: 'https://docs.pears.com/reference/building-blocks/hyperdht/',
  },
  {
    block: 'Corestore',
    file: 'workers/main.js:41,153',
    purpose:
      'One disk root per room. Named cores share a namespace for deterministic cross-peer replication.',
    docsUrl: 'https://docs.pears.com/reference/helpers/corestore/',
  },
  {
    block: 'Hypercore',
    file: 'bare/playhead.js:17 + chat.js',
    purpose:
      'Named append-only logs for playhead state, chat messages, goal clips, and room state.',
    docsUrl: 'https://docs.pears.com/reference/building-blocks/hypercore/',
  },
  {
    block: 'Hyperbee',
    file: 'bare/chat.js:17 + tip.js',
    purpose:
      'Chat view, tip log, writer roster, and reactions bucket materialised over Autobase output core.',
    docsUrl: 'https://docs.pears.com/reference/building-blocks/hyperbee/',
  },
  {
    block: 'Autobase',
    file: 'bare/playhead.js:80 + chat.js',
    purpose:
      'Pattern B multi-writer. Host-signed ed25519 invitations. Pure reducers with deterministic replay tests.',
    docsUrl: 'https://docs.pears.com/reference/building-blocks/autobase/',
  },
  {
    block: 'Hyperdrive',
    file: 'bare/clips.js:27,85',
    purpose:
      'Per-peer goal clip filesystem. findingPeers waits for remote peer before first read.',
    docsUrl: 'https://docs.pears.com/reference/building-blocks/hyperdrive/',
  },
  {
    block: 'Hyperblobs',
    file: 'bare/clips.js:28,92',
    purpose:
      '128x72 ffmpeg-baseline JPEG thumbnails. Replicated alongside the Hyperdrive.',
    docsUrl: 'https://github.com/holepunchto/hyperblobs',
  },
  {
    block: 'hypercore-blob-server',
    file: 'bare/clips.js:36,111',
    purpose:
      'Loopback HTTP server (RFC 7233 range requests) for streaming clip bytes to the renderer.',
    docsUrl: 'https://github.com/holepunchto/hypercore-blob-server',
  },
  {
    block: 'blind-peering',
    file: 'bare/blindPeering.js:98 + workers/main.js:809',
    purpose:
      'Registers both chat and playhead Autobases with a blind peer so rooms survive host disconnects.',
    docsUrl:
      'https://docs.pears.com/how-to/blind-peering/add-blind-peering-to-a-chat-app/',
  },
  {
    block: 'keet-identity-key',
    file: 'bare/keetIdentity.js:29',
    purpose:
      'keet-identity-key 3.2.0: BIP-39 mnemonic-rooted Ed25519 identity. Device keypair attested to identity root.',
    docsUrl: 'https://github.com/holepunchto/keet-identity-key',
  },
  {
    block: 'pear-updater',
    file: 'workers/main.js:313,371-374',
    purpose:
      'OTA events (updating/updated). Renderer receives a toast. Seeder daemon joins drive discovery key.',
    docsUrl: 'https://github.com/holepunchto/pear-updater',
  },
  {
    block: 'pear-electron',
    file: 'electron/main.js:4,11',
    purpose:
      'Dual-runtime: Electron UI process + Bare worker threads via PearRuntime. Single pear:// entry point.',
    docsUrl: 'https://github.com/holepunchto/pear-electron',
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

// ─── Sub-components ───────────────────────────────────────────────────────────

function InlineCopy({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [value])

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
      className={cnm(
        'inline-flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-all duration-200',
        'bg-[rgba(200,16,46,0.08)] border border-[rgba(200,16,46,0.2)] text-[#f5f5f0]',
        'hover:bg-[rgba(200,16,46,0.16)] hover:border-[rgba(200,16,46,0.4)]',
        'active:scale-95 font-mono-code',
      )}
    >
      {copied ? (
        <Check size={12} className="text-[#c8102e] flex-shrink-0" />
      ) : (
        <Copy size={12} className="text-[#c8102e] flex-shrink-0" />
      )}
      <span>{label ?? value}</span>
    </button>
  )
}

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
              13 Holepunch primitives, 21 route modules, 47 endpoints, 9
              workers. The Backend Companion is positioned the same way Tether
              positions Keet's public seeders: public-good infrastructure, not a
              platform.
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

        {/* pear:// link section */}
        <section id="pear-link" aria-label="The pear:// link">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Run Curva</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              The pear:// link.
            </h2>
            <p className="text-[#8a8a8a] text-base max-w-2xl leading-relaxed mb-6">
              Any peer with pear-runtime installed can run Curva from anywhere.
              Content, updates, and room state distribute peer-to-peer via the
              13 building blocks below.
            </p>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <div className="rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.07)] p-5 space-y-4">
              <div>
                <p className="text-[10px] font-medium text-[#8a8a8a] uppercase tracking-wider mb-2">
                  Unversioned (always latest)
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <code className="font-mono-code text-xs text-[rgba(212,175,55,0.85)] break-all">
                    pear run {PEAR_LINK_UNVERSIONED}
                  </code>
                  <InlineCopy
                    value={`pear run ${PEAR_LINK_UNVERSIONED}`}
                    label="Copy"
                  />
                </div>
              </div>
              <div className="h-px bg-[rgba(255,255,255,0.05)]" />
              <div>
                <p className="text-[10px] font-medium text-[#8a8a8a] uppercase tracking-wider mb-2">
                  Versioned (pinned to staged build)
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <code className="font-mono-code text-xs text-[rgba(212,175,55,0.65)] break-all">
                    pear run {PEAR_LINK_VERSIONED}
                  </code>
                  <InlineCopy
                    value={`pear run ${PEAR_LINK_VERSIONED}`}
                    label="Copy"
                  />
                </div>
              </div>
            </div>
          </AnimateComponent>
        </section>

        <Divider />

        {/* Building blocks table */}
        <section id="building-blocks" aria-label="Pears building blocks">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Pears</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              13 building blocks.
            </h2>
            <p className="text-[#8a8a8a] text-base max-w-xl leading-relaxed mb-8">
              All 13, exercised at runtime. File evidence for each.
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
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3 pr-4">
                      Purpose
                    </th>
                    <th className="text-left text-xs font-medium text-[#8a8a8a] py-3 hidden lg:table-cell">
                      Docs
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
                      <td className="py-3 pr-4 font-mono-code text-[10px] text-[rgba(212,175,55,0.65)] hidden md:table-cell align-top whitespace-nowrap">
                        {b.file}
                      </td>
                      <td className="py-3 pr-4 text-xs text-[#8a8a8a] align-top">
                        {b.purpose}
                      </td>
                      <td className="py-3 align-top hidden lg:table-cell">
                        <a
                          href={b.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-[#8a8a8a] hover:text-[#f5f5f0] transition-colors underline underline-offset-2 decoration-[rgba(255,255,255,0.2)]"
                        >
                          ref
                        </a>
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

        <Divider />

        {/* Blind peering section */}
        <section id="blind-peering" aria-label="Blind peering">
          <AnimateComponent onScroll entry="fadeInUp">
            <SectionLabel>Persistence</SectionLabel>
            <h2 className="font-display text-3xl font-bold text-[#f5f5f0] mb-4 curva-underline">
              Blind peering — persistence without a server.
            </h2>
          </AnimateComponent>

          <AnimateComponent onScroll entry="fadeInUp" delay={60}>
            <div className="space-y-6 max-w-3xl">
              <p className="text-[#8a8a8a] text-base leading-relaxed">
                Curva registers both the chat Autobase and the playhead Autobase
                with a blind peer at startup. A blind peer holds encrypted
                Hypercore blocks without being able to read them — it only
                replicates. This means when the Jakarta host closes their
                laptop, room state (chat log, tip history, goal clips index)
                remains available on the DHT for any peer that reconnects. No
                relay server, no cloud bucket, no database write.
              </p>

              <div className="rounded-lg bg-[#141414] border border-[rgba(255,255,255,0.07)] p-5 space-y-3">
                <div>
                  <p className="text-[10px] font-medium text-[#8a8a8a] uppercase tracking-wider mb-1.5">
                    Active blind peer key
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <code className="font-mono-code text-xs text-[rgba(212,175,55,0.85)]">
                      {BLIND_PEER_KEY}
                    </code>
                    <InlineCopy value={BLIND_PEER_KEY} label="Copy key" />
                  </div>
                </div>
                <div className="h-px bg-[rgba(255,255,255,0.05)]" />
                <div>
                  <p className="text-[10px] font-medium text-[#8a8a8a] uppercase tracking-wider mb-1">
                    Implementation
                  </p>
                  <p className="font-mono-code text-[10px] text-[rgba(212,175,55,0.65)]">
                    pear-app/bare/blindPeering.js (createBlindPeeringClient)
                  </p>
                  <p className="font-mono-code text-[10px] text-[rgba(212,175,55,0.65)] mt-0.5">
                    pear-app/workers/main.js:809 (registration at room open)
                  </p>
                </div>
              </div>

              <p className="text-xs text-[#8a8a8a] leading-relaxed">
                blind-peering@2.4.0 is installed in pear-app/node_modules.
                The client receives the DHT instance from{' '}
                <code className="font-mono-code text-[rgba(212,175,55,0.65)]">
                  swarm.dht
                </code>{' '}
                and calls{' '}
                <code className="font-mono-code text-[rgba(212,175,55,0.65)]">
                  bp.addAutobase(base)
                </code>{' '}
                for each Autobase. A rate limiter (5 registrations per Autobase
                per minute) guards against churn attacks. Source:{' '}
                <a
                  href="https://docs.pears.com/how-to/blind-peering/add-blind-peering-to-a-chat-app/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#8a8a8a] hover:text-[#f5f5f0] transition-colors underline underline-offset-2 decoration-[rgba(255,255,255,0.2)]"
                >
                  docs.pears.com blind peering guide
                </a>
                .
              </p>
            </div>
          </AnimateComponent>
        </section>
      </div>
    </div>
  )
}

export default ArchitecturePage
