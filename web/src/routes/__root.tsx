import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import HeroUIProvider from '../providers/HeroUIProvider'
import LenisSmoothScrollProvider from '../providers/LenisSmoothScrollProvider'
import { ThemeProvider } from '../providers/ThemeProvider'
import ErrorPage from '../components/ErrorPage'
import PillNav from '../components/PillNav'
import Footer from '../components/Footer'

import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'

interface MyRouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  errorComponent: ({ error, reset }) => (
    <ErrorPage error={error} reset={reset} />
  ),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Curva - Watch the World Cup with friends, peer-to-peer' },
      {
        name: 'description',
        content:
          'Peer-to-peer World Cup watch-party built on Holepunch Pears. WDK gasless USDT tipping. QVAC on-device Bergamot translation. No server. No FIFA platform. No API keys.',
      },
      {
        property: 'og:title',
        content: 'Curva - Watch the World Cup with friends, peer-to-peer',
      },
      {
        property: 'og:description',
        content:
          'Two peers, two continents, one match, zero servers. Pears + WDK + QVAC, all three working live in one demo.',
      },
      { property: 'og:image', content: '/assets/images/og.png' },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
      {
        name: 'twitter:title',
        content: 'Curva - Watch the World Cup with friends, peer-to-peer',
      },
      {
        name: 'twitter:description',
        content: 'Two peers, two continents, one match, zero servers.',
      },
      { name: 'twitter:image', content: '/assets/images/og.png' },
      { name: 'theme-color', content: '#0a0a0a' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/assets/logo-index.svg' },
      { rel: 'apple-touch-icon', href: '/assets/logo-index.svg' },
      { rel: 'mask-icon', href: '/assets/logo-index.svg', color: '#c8102e' },
      {
        rel: 'preconnect',
        href: 'https://fonts.googleapis.com',
      },
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=Urbanist:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap',
      },
    ],
  }),

  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="bg-[#0a0a0a] text-[#f5f5f0] antialiased">
        <ThemeProvider>
          <HeroUIProvider>
            <LenisSmoothScrollProvider />
            <PillNav />
            <main id="main-content">{children}</main>
            <Footer />
            <TanStackDevtools
              config={{ position: 'bottom-right' }}
              plugins={[
                {
                  name: 'Tanstack Router',
                  render: <TanStackRouterDevtoolsPanel />,
                },
                TanStackQueryDevtools,
              ]}
            />
          </HeroUIProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  )
}
