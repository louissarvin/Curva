import { ExternalLink, Github } from 'lucide-react'

export default function Footer() {
  return (
    <footer
      role="contentinfo"
      className="border-t border-[rgba(255,255,255,0.07)] py-6 px-6 md:px-12"
    >
      <div className="max-w-[1100px] mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-[#8a8a8a]">
          <span>MIT License</span>
          <span>Nation: Italy</span>
          <span>Tether Developers Cup 2026</span>
          <span>Pears Track</span>
        </div>

        <div className="flex items-center gap-4">
          <a
            href="https://github.com/placeholder-curva-repo"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Curva on GitHub (placeholder)"
            className="inline-flex items-center gap-1.5 text-xs text-[#8a8a8a] hover:text-[#f5f5f0] transition-colors curva-focus rounded"
          >
            <Github size={13} aria-hidden="true" />
            GitHub
          </a>
          <a
            href="https://dorahacks.io"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-[#8a8a8a] hover:text-[#f5f5f0] transition-colors curva-focus rounded"
          >
            <ExternalLink size={11} aria-hidden="true" />
            DoraHacks
          </a>
        </div>
      </div>
    </footer>
  )
}
