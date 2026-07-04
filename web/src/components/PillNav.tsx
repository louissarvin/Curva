import { Link, useRouterState } from '@tanstack/react-router'
import { Github } from 'lucide-react'
import { cnm } from '@/utils/style'

const NAV_LINKS = [
  { to: '/', label: 'Home', exact: true },
  { to: '/features', label: 'Features', exact: false },
  { to: '/architecture', label: 'Architecture', exact: false },
  { to: '/demo', label: 'Demo', exact: false },
  { to: '/submission', label: 'Submission', exact: false },
  { to: '/docs', label: 'Docs', exact: false },
] as const

export default function PillNav() {
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname

  return (
    <>
      {/* Skip-to-content for accessibility */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-[#c8102e] focus:text-white focus:rounded focus:text-sm focus:font-medium"
      >
        Skip to content
      </a>

      <header role="banner" className="pill-nav-wrap">
        <nav aria-label="Main navigation" className="pill-nav">
          {/* Logo */}
          <Link
            to="/"
            className="font-display font-bold text-[15px] text-[#f5f5f0] tracking-tight mr-3 hover:text-white transition-colors curva-focus rounded"
            aria-label="Curva home"
          >
            Curva
          </Link>

          {/* Separator */}
          <div
            aria-hidden="true"
            className="w-px h-4 bg-[rgba(255,255,255,0.1)] mx-1"
          />

          {/* Nav links */}
          <div className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map(({ to, label, exact }) => {
              const isActive = exact
                ? currentPath === to
                : currentPath === to || currentPath.startsWith(to + '/')

              return (
                <Link
                  key={to}
                  to={to}
                  data-active={isActive ? 'true' : 'false'}
                  className={cnm(
                    'pill-nav-link relative px-3 py-1.5 text-sm font-medium transition-colors duration-[120ms] ease-out curva-focus rounded-lg',
                    isActive
                      ? 'text-[rgba(255,255,255,0.95)]'
                      : 'text-[rgba(255,255,255,0.5)] hover:text-[rgba(255,255,255,0.9)]',
                  )}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {label}
                </Link>
              )
            })}
          </div>

          {/* Right side: GitHub + CTA */}
          <div className="flex items-center gap-2 ml-3">
            <a
              href="https://github.com/placeholder-curva-repo"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Curva on GitHub (placeholder)"
              className={cnm(
                'p-1.5 text-[rgba(255,255,255,0.5)] hover:text-[rgba(255,255,255,0.9)]',
                'transition-colors duration-[120ms] ease-out curva-focus rounded-lg',
              )}
            >
              <Github size={16} aria-hidden="true" />
            </a>

            <a
              href="https://dorahacks.io"
              target="_blank"
              rel="noopener noreferrer"
              className={cnm(
                'hidden sm:inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold',
                'bg-[#c8102e] text-white hover:bg-[#a80d26]',
                'transition-colors duration-[120ms] ease-out curva-focus',
              )}
            >
              DoraHacks
            </a>
          </div>
        </nav>
      </header>
    </>
  )
}
