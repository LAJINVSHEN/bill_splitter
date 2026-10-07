import { useIsMutating, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { useBlocker, useNavigate } from 'react-router'
import { Button } from '@/components/Button'
import { Notice } from '@/components/Display'
import { SlowNetworkBar } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { cn } from '@/lib/cn'

/**
 * Focus mode for the bill flow: no sidebar or tabs, just the steps and a way out.
 * Editors provide their queued save state so navigation can wait for persistence.
 */
export function FlowShell({
  billId,
  steps,
  current,
  children,
  footer,
  save,
  exitLabel = 'Save & exit',
}: {
  billId?: string
  steps: string[]
  current: number
  children: ReactNode
  /** Sticky action bar (primary CTA). Rendered fixed at the bottom on phones. */
  footer?: ReactNode
  save?: { dirty: boolean; saving: boolean; error: unknown; flush: () => Promise<boolean> }
  exitLabel?: string
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const mutationKey = ['bill', billId ?? '__none__']
  const mutating = useIsMutating({ mutationKey }) > 0
  const [exitError, setExitError] = useState<unknown>(null)
  const exitLock = useRef(false)
  const saving = mutating || Boolean(save?.saving)
  const unsaved = Boolean(save?.dirty || save?.error != null)
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    currentLocation.pathname !== nextLocation.pathname && (unsaved || saving),
  )
  const exiting = blocker.state === 'blocked'
  const exit = () => {
    setExitError(null)
    navigate('/')
  }

  const finishNavigation = useEffectEvent(async () => {
    if (blocker.state !== 'blocked' || exitLock.current) return
    exitLock.current = true
    const cache = qc.getMutationCache()
    const tracked = new Set(cache.findAll({ mutationKey, status: 'pending' }))
    const mutationsDone = new Promise<boolean>((resolve) => {
      const check = () => {
        cache.findAll({ mutationKey, status: 'pending' }).forEach((mutation) => tracked.add(mutation))
        if ([...tracked].some((mutation) => mutation.state.status === 'pending')) return
        unsubscribe()
        resolve([...tracked].every((mutation) => mutation.state.status === 'success'))
      }
      const unsubscribe = cache.subscribe(check)
      check()
    })
    try {
      const [saved, mutationsSaved] = await Promise.all([save?.flush() ?? Promise.resolve(true), mutationsDone])
      if (!saved || !mutationsSaved) throw new Error('Could not save your changes. Retry before leaving.')
      blocker.proceed()
    } catch (error) {
      setExitError(error)
      blocker.reset()
    } finally {
      exitLock.current = false
    }
  })

  useEffect(() => {
    if (blocker.state === 'blocked') queueMicrotask(() => { void finishNavigation() })
  }, [blocker.state])

  useEffect(() => {
    if (!unsaved && !saving && !exiting) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved, saving, exiting])

  const status = exitError != null || save?.error != null ? 'Not saved' : saving || exiting ? 'Saving…' : unsaved ? 'Unsaved changes' : billId ? 'Saved' : ''
  return (
    <div className="min-h-dvh">
      <SlowNetworkBar />
      <header className="flex items-center gap-4 border-rule px-2 pt-2 md:border-b md:px-[var(--app-gutter)] md:py-3.5">
        <button type="button" disabled={exiting} onClick={exit} className="inline-flex h-11 shrink-0 items-center gap-1 px-2 text-[15px] font-semibold text-ink disabled:opacity-60 md:px-0">
          <Icon name="back" />
          {exitLabel}
        </button>
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
        <span className="ml-auto text-right text-[14px] font-semibold text-ink-2 md:ml-0 md:w-[130px]" aria-live="polite">
          <span className="md:hidden">
            Step {current + 1} of {steps.length}
            {status && status !== 'Saved' ? ` · ${status}` : ''}
          </span>
          <span className="hidden md:inline">{status}</span>
        </span>
      </header>
      <main className={cn('px-5 md:px-[var(--app-gutter)]', footer ? 'pb-36 md:pb-14' : 'pb-14')}>
        {exitError != null && (
          <div className="mt-4">
            <Notice tone="danger" action={<Button variant="quiet" onClick={exit} icon={<Icon name="retry" />}>Retry exit</Button>}>
              {exitError instanceof Error ? exitError.message : 'Could not save your changes. Retry before leaving.'}
            </Notice>
          </div>
        )}
        <fieldset disabled={exiting} className="min-w-0">{children}</fieldset>
      </main>
      {footer && (
        <div className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t-[1.5px] border-ink bg-paper md:static md:border-t-0 md:bg-transparent">
          <fieldset disabled={exiting} className="flex min-w-0 items-center gap-3.5 px-5 py-3 md:px-[var(--app-gutter)] md:pb-10">{footer}</fieldset>
        </div>
      )}
    </div>
  )
}
