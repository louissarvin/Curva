<div align="center">

<img src="./src/logo.svg" alt="Curva" width="96" height="96" />

# Curva Web

**The Curva pitch and documentation microsite for Tether Developers Cup 2026.**

Landing page, architecture explainer, demo walkthrough, features, docs, and submission
pages for the Curva peer-to-peer World Cup watch-party. This is the public-facing site
that judges land on. The actual Pear app lives in [`../pear-app/`](../pear-app/).

<sub>[What This Site Is](#what-this-site-is) · [Pages](#pages) · [Architecture](#architecture) · [How It Works](#how-it-works) · [Tech Stack](#tech-stack) · [Quick Start](#quick-start) · [Deployment](#deployment)</sub>

</div>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/React-19.2-61DAFB?logo=react&logoColor=white" alt="React 19" />
  <img src="https://img.shields.io/badge/TanStack_Start-1.132-FF4154?logo=react&logoColor=white" alt="TanStack Start" />
  <img src="https://img.shields.io/badge/TanStack_Router-1.132-FF4154" alt="TanStack Router" />
  <img src="https://img.shields.io/badge/TanStack_Query-5.66-FF4154" alt="TanStack Query" />
  <img src="https://img.shields.io/badge/HeroUI-2.8-006FEE" alt="HeroUI" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-4.0-38BDF8?logo=tailwindcss&logoColor=white" alt="Tailwind CSS 4" />
  <img src="https://img.shields.io/badge/GSAP-3.14-88CE02?logo=greensock&logoColor=white" alt="GSAP" />
  <img src="https://img.shields.io/badge/Lenis-1.3-000000" alt="Lenis" />
  <img src="https://img.shields.io/badge/Motion-12.25-FF0080" alt="Framer Motion" />
  <img src="https://img.shields.io/badge/Vite-7.1-646CFF?logo=vite&logoColor=white" alt="Vite 7" />
  <img src="https://img.shields.io/badge/Bun-1.1+-000000?logo=bun&logoColor=white" alt="Bun" />
  <img src="https://img.shields.io/badge/Nitro-nightly-FFCC00" alt="Nitro" />
</p>

---

## What This Site Is

Curva Web is a single job: convince judges in under five minutes that Curva ships all
three Tether Developers Cup pillars (Pears, WDK, QVAC) in one working peer-to-peer app.

It is a marketing plus reference microsite. Not the Curva app. The site walks visitors
through the pitch, the architecture, the live demo path, and links out to the DoraHacks
submission, demo video, and the Curva monorepo.

Content is code-driven: pillar summaries, evidence bullets, and route inventories are
hardcoded in the route files with citations pointing back to real paths in
[`../pear-app/`](../pear-app/) and [`../backend/`](../backend/), so anything a judge
reads on the site can be verified in the repo in one click.

---

## Pages

| Route | File | Purpose |
|---|---|---|
| `/` | `src/routes/index.tsx` | Landing. Hero, three pillar cards (Pears / WDK / QVAC), evidence bullets, CTAs. |
| `/architecture` | `src/routes/architecture.tsx` | System architecture: how the Pear app, WDK worklet, and QVAC SDK compose. |
| `/features` | `src/routes/features.tsx` | Feature breakdown: sync, tipping, translation, chat, clip sharing. |
| `/demo` | `src/routes/demo.tsx` | Demo walkthrough matching the recorded video. |
| `/docs` | `src/routes/docs.tsx` | Technical reference and integration notes. |
| `/submission` | `src/routes/submission.tsx` | DoraHacks submission bundle, links, hackathon meta. |

Root shell (`src/routes/__root.tsx`) provides `PillNav`, `Footer`, meta/OG tags, and the
provider stack for every page.

---

## Architecture

### Component tree

```mermaid
graph TD
    Root[__root.tsx<br/>createRootRouteWithContext] --> Theme[ThemeProvider]
    Theme --> HeroUI[HeroUIProvider]
    HeroUI --> Lenis[LenisSmoothScrollProvider]
    HeroUI --> Nav[PillNav]
    HeroUI --> Main[main#main-content]
    HeroUI --> Foot[Footer]
    Main --> Router[TanStack Router Outlet]
    Router --> Index[/index.tsx/]
    Router --> Arch[/architecture.tsx/]
    Router --> Feat[/features.tsx/]
    Router --> Demo[/demo.tsx/]
    Router --> Docs[/docs.tsx/]
    Router --> Sub[/submission.tsx/]
    Root -.context.-> QC[QueryClient<br/>TanStack Query]
```

### Rendering pipeline

```mermaid
flowchart LR
    Dev[bun dev<br/>Vite 7] --> RP[TanStack Router Plugin<br/>generates routeTree.gen.ts]
    RP --> Start[TanStack Start<br/>React 19 SSR]
    Start --> Nitro[Nitro server<br/>renders HTML shell]
    Nitro --> Browser[Browser<br/>hydrates + Lenis takes over scroll]
    Browser --> GSAP[AnimateComponent<br/>GSAP scroll triggers]
```

---

## How It Works

### File-based routing

TanStack Router discovers every `.tsx` file in `src/routes/` and writes
`src/routeTree.gen.ts` at dev and build time. Each page exports a `Route` created with
`createFileRoute('/path')({ component })`. To add a new page, drop a file. No manual
route registration.

The root route uses `createRootRouteWithContext<{ queryClient: QueryClient }>()` so
every route can pull the shared `QueryClient` off `Route.useRouteContext()`.

### Providers layer

Order matters. `ThemeProvider` sits outermost, then `HeroUIProvider` (needs the
`dark` class on `<html>`, already set), then `LenisSmoothScrollProvider` which
initialises Lenis once on mount so smooth scroll works everywhere.

`TanStackDevtools` mounts a floating panel in dev only, wiring the Router and Query
devtools.

### Design tokens

- Body: `bg-[#0a0a0a] text-[#f5f5f0]` on `<html class="dark">`.
- Fonts: Inter Variable (`@fontsource-variable/inter`), Playfair Display
  (`@fontsource/playfair-display`), and Urbanist via Google Fonts loaded from the
  root head links.
- Tailwind CSS 4 via `@tailwindcss/vite`, using the `@import "tailwindcss"` syntax
  in `src/styles.css`. Custom scrollbar and selection styles live in the same file.
- HeroUI 2.8 supplies `Button`, `Input`, `Modal`, and friends. Class merging uses
  `cnm()` from `src/utils/style.ts` (clsx + tailwind-merge).

### Animations

- **GSAP 3.14** powers scroll-triggered reveals via
  `src/components/elements/AnimateComponent.tsx`.
- **Lenis 1.3** runs a global smooth scroll loop.
- **Motion 12.25** (Framer Motion) is available for component-level animation.
- **Lucide React** for icons.

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Framework | TanStack Start 1.132 | React 19 meta-framework, SSR-capable |
| Runtime | React 19.2 + React DOM 19.2 | UI runtime |
| Router | TanStack Router 1.132 (file-based) | Routing with generated tree |
| Server state | TanStack Query 5.66 | Fetching, caching, SSR hydration |
| Forms | TanStack Form 1.0 | Typed forms |
| Tables | TanStack Table 8.21 | Data grids in docs pages |
| UI kit | HeroUI 2.8 | Accessible React components |
| Styling | Tailwind CSS 4.0 + `@tailwindcss/vite` | Utility CSS |
| Animation | GSAP 3.14, Motion 12.25, Lenis 1.3 | Scroll, transitions, smooth scroll |
| Icons | Lucide React 0.561 | Icon set |
| Fonts | Inter Variable, Playfair Display, Urbanist | Typography |
| Env | `@t3-oss/env-core` 0.13 + Zod 4.1 | Typed env vars |
| Build | Vite 7.1, Nitro nightly | Bundler and SSR server |
| Language | TypeScript 5.7 (strict) | Type safety |
| Test | Vitest 3.0, Testing Library 16.2, jsdom 27 | Unit and component tests |
| Lint | ESLint (`@tanstack/eslint-config`), Prettier 3.5 | Style enforcement |
| Package manager | Bun 1.1+ | Install and scripts |

Full versions are pinned in [`package.json`](./package.json).

---

## Project Structure

```
web/
├── src/
│   ├── routes/                 # File-based pages (TanStack Router)
│   │   ├── __root.tsx          # Shell: providers, PillNav, Footer, meta
│   │   ├── index.tsx           # Landing with pillar cards
│   │   ├── architecture.tsx
│   │   ├── demo.tsx
│   │   ├── docs.tsx
│   │   ├── features.tsx
│   │   └── submission.tsx
│   ├── components/             # Site components (PillNav, Footer, ErrorPage, elements/)
│   ├── providers/              # HeroUIProvider, LenisSmoothScrollProvider, ThemeProvider
│   ├── hooks/                  # Custom React hooks
│   ├── utils/                  # style.ts (cnm), format.ts
│   ├── lib/                    # External integrations
│   ├── integrations/           # TanStack Query wiring, devtools
│   ├── config/                 # Site config
│   ├── config.ts               # App-wide constants and links
│   ├── env.ts                  # T3Env schema (server + client vars)
│   ├── router.tsx              # Router factory
│   ├── routeTree.gen.ts        # Generated by @tanstack/router-plugin
│   ├── styles.css              # Tailwind entry, tokens, scrollbar
│   └── logo.svg
├── public/                     # Static assets served at /
├── vite.config.ts              # Vite + Tailwind + Router plugin + Nitro
├── vercel.json                 # SPA rewrite for Vercel
├── tsconfig.json               # Strict TypeScript, @/ alias
├── eslint.config.js
├── prettier.config.js
└── package.json
```

---

## Quick Start

### Prerequisites

- **Bun 1.1+** (primary package manager and runner)
- **Node.js 20+** (Nitro and Vite runtime)

### Install

```bash
bun install
```

### Develop

```bash
bun dev
```

Dev server runs on **port 3200**: <http://localhost:3200>.

Hot reload is on. The route tree regenerates automatically when you add or move a file
in `src/routes/`.

### Build

```bash
bun build
```

Output lands in `.output/` (Nitro build). This is what gets deployed.

### Preview

```bash
bun preview
```

Serves the production build locally to sanity-check SSR before shipping.

---

## Commands

<details>
<summary><strong>All scripts</strong></summary>

| Command | What it does |
|---|---|
| `bun dev` | Vite dev server on port 3200 |
| `bun build` | Production build to `.output/` |
| `bun preview` | Preview the production build |
| `bun test` | Run Vitest suite |
| `bun lint` | Run ESLint |
| `bun format` | Run Prettier |
| `bun check` | `prettier --write . && eslint --fix` |

</details>

---

## Deployment

**Vercel** is the default target. `vercel.json` rewrites every path to `/` so the
TanStack Router client picks up deep links after hydration. Push to `main`, Vercel
picks it up.

**Any Node 20+ host** works too. Run `bun build` and serve the resulting `.output/`
directory. Nitro produces a standard Node server entry.

Meta tags, OG image (`/assets/images/og.png`), and Twitter card are declared in
`src/routes/__root.tsx` inside the `head()` return.

---

## Environment Variables

Managed by `@t3-oss/env-core` in [`src/env.ts`](./src/env.ts). Vars are validated
with Zod at build time.

| Variable | Scope | Required | Purpose |
|---|---|---|---|
| `SERVER_URL` | server | optional | Backend origin used by SSR loaders |
| `VITE_APP_TITLE` | client | optional | Overrides the default document title |

To add a new variable, extend the schema in `src/env.ts` under `server` or `client`.
Client vars must be prefixed with `VITE_`. Empty strings are treated as `undefined`.

---

## Related

- [`../README.md`](../README.md), Curva monorepo overview
- [`../pear-app/`](../pear-app/), the actual Curva Pear app (Bare + Autobase + WDK + QVAC)
- [`../backend/`](../backend/), support services: QVAC catalog, x402 facilitator, seeder
- [`../SUBMISSION.md`](../SUBMISSION.md), DoraHacks submission text
- [`../DEMO_SCRIPT.md`](../DEMO_SCRIPT.md), walkthrough matching `/demo`

---

<div align="center">

**Tether Developers Cup 2026** · Pears track · Indonesia · Final **2026-07-15**

Built on the Kwek Labs Web Starter.

</div>
