import { useRouter } from '@tanstack/react-router'
import { AlertTriangle, Home, RefreshCw } from 'lucide-react'
import { cnm } from '@/utils/style'

interface ErrorPageProps {
  error?: Error
  reset?: () => void
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  const router = useRouter()

  const handleRetry = () => {
    if (reset) {
      reset()
    } else {
      router.invalidate()
    }
  }

  const handleHome = () => {
    router.navigate({ to: '/' })
  }

  return (
    <div
      className={cnm(
        'min-h-screen w-full flex items-center justify-center',
        'bg-neutral-50 dark:bg-neutral-900',
        'px-6 py-20',
      )}
    >
      <div className="max-w-lg w-full text-center">
        <div className="mb-8 flex justify-center">
          <div
            className={cnm(
              'w-16 h-16 flex items-center justify-center',
              'border border-neutral-200 dark:border-neutral-800',
              'bg-neutral-100 dark:bg-neutral-800',
            )}
          >
            <AlertTriangle className="w-7 h-7 text-amber-500" />
          </div>
        </div>

        <p className="text-xs font-mono uppercase tracking-widest text-neutral-400 mb-3">
          Error
        </p>

        <h1 className="text-2xl sm:text-3xl font-light text-neutral-900 dark:text-neutral-100 mb-4">
          Something went wrong
        </h1>

        <p className="text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed mb-8">
          An unexpected error occurred. Try refreshing the page. If this keeps
          happening, please contact us.
        </p>

        {error && (
          <div
            className={cnm(
              'mb-8 px-4 py-3 text-left',
              'border border-neutral-200 dark:border-neutral-800',
              'bg-neutral-100/50 dark:bg-neutral-800/30',
            )}
          >
            <p className="text-[10px] font-mono uppercase tracking-wider text-neutral-400 mb-1">
              Details
            </p>
            <p className="text-xs font-mono text-red-600 dark:text-red-400 break-all">
              {error.message || 'Unknown error'}
            </p>
          </div>
        )}

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            onClick={handleRetry}
            className={cnm(
              'inline-flex items-center gap-2 px-5 py-2.5',
              'text-sm font-mono',
              'bg-neutral-900 dark:bg-neutral-100',
              'text-neutral-100 dark:text-neutral-900',
              'hover:bg-neutral-800 dark:hover:bg-neutral-200',
              'transition-colors duration-150',
            )}
          >
            <RefreshCw className="w-4 h-4" />
            Try again
          </button>
          <button
            onClick={handleHome}
            className={cnm(
              'inline-flex items-center gap-2 px-5 py-2.5',
              'text-sm font-mono',
              'border border-neutral-300 dark:border-neutral-700',
              'text-neutral-700 dark:text-neutral-300',
              'hover:bg-neutral-100 dark:hover:bg-neutral-800',
              'transition-colors duration-150',
            )}
          >
            <Home className="w-4 h-4" />
            Go home
          </button>
        </div>
      </div>
    </div>
  )
}
