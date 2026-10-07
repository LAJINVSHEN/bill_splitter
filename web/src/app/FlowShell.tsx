import { useIsMutating } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { SlowNetworkBar } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { cn } from '@/lib/cn'

/**
 * Focus mode for the bill flow: no sidebar or tabs, just the steps and a way out.
 * Work saves as you go, so "Save & exit" is always safe.
 */
export function FlowShell({
  billId,
  steps,
  current,
  children,
  footer,
}: {
  billId?: string
  steps: string[]
  current: number
  children: ReactNode
  /** Sticky action bar (primary CTA). Rendered fixed at the bottom on phones. */
  footer?: ReactNode
}) {
  const saving = useIsMutating({ mutationKey: ['bill', billId ?? '__none__'] }) > 0
  return (
    <div className="min-h-dvh">
      <SlowNetworkBar />
      <header className="flex items-center gap-4 border-rule px-2 pt-2 md:border-b md:px-[var(--app-gutter)] md:py-3.5">
        <Link to="/" className="inline-flex h-11 items-center gap-1 px-2 text-[15px] font-semibold text-ink md:px-0">
          <Icon name="back" />
          Save &amp; exit
        </Link>
        <ol aria-label="Steps" className="hidden flex-1 justify-center gap-6 text-[15px] font-semibold md:flex">
          {steps.map((s, i) => (
            <li
              key={s}
              aria-current={i === current ? 'step' : undefined}
              className={cn(i === current ? 'pb-1 text-ink shadow-[inset_0_-3px_0_var(--color-cobalt)]' : 'text-ink-2')}
            >
              {s}
            </li>
          ))}
        </ol>
        <span className="ml-auto text-[14px] font-semibold text-ink-2 md:ml-0 md:w-[110px] md:text-right" aria-live="polite">
          <span className="md:hidden">
            Step {current + 1} of {steps.length}
            {billId && (saving ? ' · Saving…' : '')}
          </span>
          <span className="hidden md:inline">{billId ? (saving ? 'Saving…' : 'Saved') : ''}</span>
        </span>
      </header>
      <main className={cn('px-5 md:px-[var(--app-gutter)]', footer ? 'pb-36 md:pb-14' : 'pb-14')}>{children}</main>
      {footer && (
        <div className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t-[1.5px] border-ink bg-paper md:static md:border-t-0 md:bg-transparent">
          <div className="flex items-center gap-3.5 px-5 py-3 md:px-[var(--app-gutter)] md:pb-10">{footer}</div>
        </div>
      )}
    </div>
  )
}
