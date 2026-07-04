import {
  BookOpen,
  Code2,
  ExternalLink,
  Moon,
  Sun,
  Terminal,
} from 'lucide-react'
import AnimateComponent from './elements/AnimateComponent'
import ModularGrid from './art/ModularGrid'
import { config } from '@/config'
import { cnm } from '@/utils/style'
import { useTheme } from '@/providers/ThemeProvider'

function HeroArt() {
  return (
    <div
      className={cnm(
        'relative w-full h-64 sm:h-80 lg:h-full lg:min-h-[380px]',
        'border border-neutral-200 dark:border-neutral-800',
        'bg-neutral-100/50 dark:bg-neutral-800/30',
        'overflow-hidden',
      )}
    >
      <ModularGrid columns={10} rows={8} gap={4} />
      <div className="absolute bottom-3 right-3 text-[10px] font-mono text-neutral-300 dark:text-neutral-700 tracking-wider">
        grid.01
      </div>
    </div>
  )
}

function Header() {
  const { theme, toggleTheme } = useTheme()

  return (
    <header className="fixed top-0 left-0 right-0 z-50 w-full border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-900/80 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 bg-amber-500" />
          <span className="text-sm font-mono tracking-tight text-neutral-900 dark:text-neutral-100">
            KWEK/STARTER
          </span>
        </div>
        <div className="flex items-center gap-6">
          <nav className="hidden sm:flex items-center gap-6">
            <a
              href="#start"
              className="text-xs font-mono uppercase tracking-wider text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
            >
              Start
            </a>
            <a
              href="#stack"
              className="text-xs font-mono uppercase tracking-wider text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
            >
              Stack
            </a>
            <a
              href={config.links.github || '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono uppercase tracking-wider text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
            >
              Source
            </a>
          </nav>
          <button
            onClick={toggleTheme}
            className={cnm(
              'p-2 border border-neutral-200 dark:border-neutral-700',
              'hover:bg-neutral-100 dark:hover:bg-neutral-800',
              'transition-colors duration-150',
            )}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? (
              <Sun className="w-4 h-4 text-neutral-400" />
            ) : (
              <Moon className="w-4 h-4 text-neutral-600" />
            )}
          </button>
        </div>
      </div>
    </header>
  )
}

function HeroSection() {
  return (
    <section className="relative w-full max-w-6xl mx-auto px-6 pt-16 pb-16">
      <div className="grid grid-cols-12 gap-8 lg:gap-12">
        <div className="col-span-12 lg:col-span-6 flex flex-col justify-center order-2 lg:order-1">
          <AnimateComponent entry="fadeInUp" duration={500}>
            <p className="text-xs font-mono uppercase tracking-widest text-amber-600 dark:text-amber-500 mb-4">
              Web Starter v2.0
            </p>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-light tracking-tight leading-[1.1] text-neutral-900 dark:text-neutral-100">
              Start with
              <br />
              <span className="font-normal">solid foundation</span>
            </h1>
            <p className="mt-6 text-base text-neutral-500 dark:text-neutral-400 leading-relaxed max-w-md">
              Production-ready React template. Modern tooling. No boilerplate
              fatigue.
            </p>
          </AnimateComponent>
        </div>

        <div className="col-span-12 lg:col-span-6 order-1 lg:order-2">
          <AnimateComponent delay={100} entry="fadeInUp">
            <HeroArt />
          </AnimateComponent>
        </div>
      </div>

      <AnimateComponent delay={200}>
        <div className="mt-16 pt-8 border-t border-neutral-200 dark:border-neutral-800">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-8">
            {[
              { label: 'React', version: '19' },
              { label: 'TanStack', version: 'Start' },
              { label: 'Tailwind', version: '4' },
              { label: 'TypeScript', version: '5.x' },
            ].map((item) => (
              <div key={item.label} className="space-y-1">
                <p className="text-2xl font-light text-neutral-900 dark:text-neutral-100">
                  {item.version}
                </p>
                <p className="text-xs font-mono uppercase tracking-wider text-neutral-400">
                  {item.label}
                </p>
              </div>
            ))}
          </div>
        </div>
      </AnimateComponent>
    </section>
  )
}

function LinksSection() {
  const links = [
    { label: 'Documentation', url: config.links.docs, icon: BookOpen },
    { label: 'GitHub', url: config.links.github, icon: Code2 },
    { label: 'Twitter', url: config.links.twitter, icon: ExternalLink },
    { label: 'Telegram', url: config.links.telegram, icon: ExternalLink },
  ]

  return (
    <AnimateComponent delay={300} onScroll threshold={0.1}>
      <div className="w-full max-w-6xl mx-auto px-6 py-12">
        <div className="flex flex-wrap gap-2">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.url || '#'}
              target="_blank"
              rel="noopener noreferrer"
              className={cnm(
                'inline-flex items-center gap-2 px-4 py-2',
                'border border-neutral-200 dark:border-neutral-800',
                'text-sm font-mono text-neutral-600 dark:text-neutral-400',
                'hover:border-neutral-400 dark:hover:border-neutral-600',
                'hover:text-neutral-900 dark:hover:text-neutral-100',
                'transition-colors duration-150',
                !link.url && 'opacity-30 pointer-events-none',
              )}
            >
              <link.icon className="w-3.5 h-3.5" />
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </AnimateComponent>
  )
}

function CodeSnippet({ children }: { children: string }) {
  return (
    <code className="px-1.5 py-0.5 text-sm font-mono bg-neutral-100 dark:bg-neutral-800 text-amber-700 dark:text-amber-400">
      {children}
    </code>
  )
}

function StartSection() {
  const steps = [
    {
      num: '01',
      title: 'Configure',
      desc: (
        <>
          Set up your links in <CodeSnippet>src/config.ts</CodeSnippet> — single
          source of truth for app config.
        </>
      ),
    },
    {
      num: '02',
      title: 'Animate',
      desc: (
        <>
          Use <CodeSnippet>AnimateComponent</CodeSnippet> for scroll-triggered
          animations. GSAP-powered, zero config.
        </>
      ),
    },
    {
      num: '03',
      title: 'Extend',
      desc: (
        <>
          Componentize sections: <CodeSnippet>{'<HeroSection />'}</CodeSnippet>,{' '}
          <CodeSnippet>{'<Features />'}</CodeSnippet>,{' '}
          <CodeSnippet>{'<Footer />'}</CodeSnippet>
        </>
      ),
    },
    {
      num: '04',
      title: 'Deploy',
      desc: (
        <>
          Update meta in <CodeSnippet>__root.tsx</CodeSnippet>, then push to
          Vercel. That's it.
        </>
      ),
    },
  ]

  const resources = [
    { name: 'Magic UI', url: 'https://magicui.design/' },
    { name: 'React Bits', url: 'https://www.reactbits.dev/' },
    { name: 'Aceternity', url: 'https://www.aceternity.com/' },
    { name: 'UIverse', url: 'https://uiverse.io/' },
    { name: '21st.dev', url: 'https://21st.dev/' },
  ]

  return (
    <AnimateComponent delay={100} onScroll threshold={0.1}>
      <section
        id="start"
        className="w-full bg-neutral-100/50 dark:bg-neutral-800/20 border-y border-neutral-200 dark:border-neutral-800"
      >
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="grid grid-cols-12 gap-12">
            <div className="col-span-12 lg:col-span-4">
              <div className="flex items-center gap-3 mb-4">
                <Terminal className="w-5 h-5 text-amber-600 dark:text-amber-500" />
                <h2 className="text-xs font-mono uppercase tracking-widest text-neutral-500">
                  Getting Started
                </h2>
              </div>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed">
                Four steps to production. No ceremony.
              </p>
            </div>

            <div className="col-span-12 lg:col-span-8">
              <div className="space-y-8">
                {steps.map((step) => (
                  <div key={step.num} className="grid grid-cols-12 gap-4 group">
                    <div className="col-span-2 sm:col-span-1">
                      <span className="text-xs font-mono text-neutral-300 dark:text-neutral-600 group-hover:text-amber-500 transition-colors">
                        {step.num}
                      </span>
                    </div>
                    <div className="col-span-10 sm:col-span-11 space-y-1">
                      <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                        {step.title}
                      </h3>
                      <p className="text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed">
                        {step.desc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-12 pt-8 border-t border-neutral-200 dark:border-neutral-700">
                <p className="text-xs font-mono uppercase tracking-wider text-neutral-400 mb-4">
                  Resources
                </p>
                <div className="flex flex-wrap gap-2">
                  {resources.map((resource) => (
                    <a
                      key={resource.name}
                      href={resource.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cnm(
                        'px-3 py-1.5 text-xs font-mono',
                        'border border-neutral-200 dark:border-neutral-700',
                        'text-neutral-500 dark:text-neutral-400',
                        'hover:border-amber-500/50 hover:text-amber-600 dark:hover:text-amber-500',
                        'transition-colors duration-150',
                      )}
                    >
                      {resource.name}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </AnimateComponent>
  )
}

function StackSection() {
  const stack = [
    'React 19',
    'TanStack Start',
    'TanStack Router',
    'TanStack Query',
    'Tailwind CSS 4',
    'HeroUI',
    'GSAP',
    'Lenis',
    'TypeScript',
    'Vite 7',
  ]

  return (
    <AnimateComponent delay={100} onScroll threshold={0.1}>
      <section id="stack" className="w-full max-w-6xl mx-auto px-6 py-20">
        <div className="grid grid-cols-12 gap-12">
          <div className="col-span-12 lg:col-span-4">
            <p className="text-xs font-mono uppercase tracking-widest text-neutral-400 mb-2">
              Technology
            </p>
            <h2 className="text-2xl font-light text-neutral-900 dark:text-neutral-100">
              Modern stack
            </h2>
          </div>

          <div className="col-span-12 lg:col-span-8">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {stack.map((name) => (
                <div
                  key={name}
                  className="px-4 py-3 border border-neutral-200 dark:border-neutral-800"
                >
                  <p className="text-sm text-neutral-900 dark:text-neutral-100">
                    {name}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </AnimateComponent>
  )
}

function Footer() {
  return (
    <footer className="w-full border-t border-neutral-200 dark:border-neutral-800">
      <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-xs font-mono text-neutral-400">
          Built by{' '}
          <a
            href="https://kweklabs.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-600 dark:text-neutral-300 hover:text-amber-600 dark:hover:text-amber-500 transition-colors"
          >
            Kwek Labs
          </a>
        </p>
        <p className="text-xs font-mono text-neutral-300 dark:text-neutral-700">
          {new Date().getFullYear()}
        </p>
      </div>
    </footer>
  )
}

export default function WebstarterOnboarding() {
  return (
    <div
      className={cnm(
        'relative min-h-screen w-full flex flex-col',
        'bg-neutral-50 dark:bg-neutral-900',
        'transition-colors duration-200',
      )}
    >
      <Header />
      <div className="flex flex-col min-h-screen pt-14">
        <main className="flex-1">
          <HeroSection />
          <LinksSection />
          <StartSection />
          <StackSection />
        </main>
        <Footer />
      </div>
    </div>
  )
}
