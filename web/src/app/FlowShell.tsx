import { useIsMutating, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { Link, useBlocker, useNavigate } from 'react-router'
import { Button } from '@/components/Button'
import { Dialog, SlowNetworkBar } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { cn } from '@/lib/cn'

/** Thrown by a `save.flush` that can't save on its own (e.g. a form saved by its own button). */
export class NotSavedYet extends Error {}

/**
 * Focus mode for the bill flow: no sidebar or tabs, just the steps and a way out.
 * Editors provide their queued save state so navigation can wait for persistence; when a save
 * can't go through, leaving asks once and then lets the person go without it (never a trap).
 */
export function FlowShell({
  billId,
  steps,
  current,
  links,
  children,
  footer,
  save,
  exitLabel = 'Save & exit',
}: {
  billId?: string
  steps: string[]
  current: number
  /** where each step lives; a step with a path (other than the current one) links back to it */
  links?: Array<string | undefined>
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
  const [leaveTo, setLeaveTo] = useState('/')
  const exitLock = useRef(false)
  const forced = useRef(false)
  const saving = mutating || Boolean(save?.saving)
  const unsaved = Boolean(save?.dirty || save?.error != null)
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    !forced.current && currentLocation.pathname !== nextLocation.pathname && (unsaved || saving),
  )
  const exiting = blocker.state === 'blocked'
  const go = (to: string) => {
    setExitError(null)
    navigate(to)
  }
  const leaveAnyway = () => {
    forced.current = true
    go(leaveTo)
  }

  const finishNavigation = useEffectEvent(async () => {
    if (blocker.state !== 'blocked' || exitLock.current) return
    exitLock.current = true
    const target = blocker.location.pathname + blocker.location.search
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
      if (!saved || !mutationsSaved) throw new Error('Your last change didn’t save.')
      blocker.proceed()
    } catch (error) {
      setExitError(error)
      setLeaveTo(target)
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
        <button type="button" disabled={exiting} onClick={() => go('/')} className="inline-flex h-11 shrink-0 items-center gap-1 px-2 text-[15px] font-semibold text-ink disabled:opacity-60 md:px-0">
          <Icon name="back" />
          {exitLabel}
        </button>
        <div className="hidden min-w-0 flex-1 justify-center md:flex">
          <StepTrack steps={steps} current={current} links={links} labels />
        </div>
        <span className="ml-auto text-right text-[14px] font-semibold text-ink-2 md:ml-0 md:w-[130px]" aria-live="polite">
          <span className="md:hidden">{status && status !== 'Saved' ? status : `${steps[current]} · ${current + 1} of ${steps.length}`}</span>
          <span className="hidden md:inline">{status}</span>
        </span>
      </header>
      <div className="px-5 pb-1 pt-1 md:hidden">
        <StepTrack steps={steps} current={current} links={links} />
      </div>
      <main className={cn('px-5 md:px-[var(--app-gutter)]', footer ? 'pb-36 md:pb-10' : 'pb-14')}>
        <fieldset disabled={exiting} className="min-w-0">{children}</fieldset>
      </main>
      {footer && (
        // Phones: fixed to the bottom. Desktop: a sticky action bar across the window (summary left,
        // actions right), so the next step is always in reach however long the step is.
        <div className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t-[1.5px] border-ink bg-paper md:sticky md:border-t md:border-rule">
          <fieldset disabled={exiting} className="flex min-w-0 items-center gap-3.5 px-5 py-3 md:px-[var(--app-gutter)] md:py-4">{footer}</fieldset>
        </div>
      )}
      <Dialog
        open={exitError != null}
        onClose={() => setExitError(null)}
        title="Leave without saving?"
        footer={
          <>
            <Button variant="danger" className="px-3" onClick={leaveAnyway}>
              Leave without saving
            </Button>
            {exitError instanceof NotSavedYet ? (
              <Button variant="secondary" onClick={() => setExitError(null)}>
                Keep editing
              </Button>
            ) : (
              <Button variant="secondary" icon={<Icon name="retry" size={18} />} onClick={() => go(leaveTo)}>
                Try again
              </Button>
            )}
          </>
        }
      >
        <p className="text-[16px]">{exitError instanceof Error ? exitError.message : 'Your last change didn’t save.'}</p>
        {billId && !(exitError instanceof NotSavedYet) && <p className="mt-2 text-[16px]">If you leave now, that change is lost. Everything saved before it stays.</p>}
      </Dialog>
    </div>
  )
}

/**
 * The steps as a connected track: done steps are filled cobalt with a check, the current step is
 * solid ink, later ones are outlined, and the line fills in as you go. Any step with a path
 * (other than the current one) is a link back to it. Desktop shows names beside the dots; phones
 * show dots only (the header names the current step).
 */
function StepTrack({ steps, current, links, labels }: { steps: string[]; current: number; links?: Array<string | undefined>; labels?: boolean }) {
  return (
    <nav aria-label="Steps" className="w-full max-w-[720px]">
      <ol className="flex items-center">
        {steps.map((s, i) => {
          const to = i !== current ? links?.[i] : undefined
          const done = i < current
          const dot = (
            <span
              aria-hidden="true"
              className={cn(
                'grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-bold transition-colors',
                done
                  ? 'bg-cobalt text-white'
                  : i === current
                    ? 'bg-ink text-paper'
                    : to
                      ? 'border-[1.5px] border-cobalt text-cobalt'
                      : 'border-[1.5px] border-rule-2 text-ink-2',
              )}
            >
              {done ? <Icon name="check" size={15} strokeWidth={2.8} /> : i + 1}
            </span>
          )
          const name = (
            <span className={cn('whitespace-nowrap text-[15px] font-semibold', i === current ? 'text-ink' : done || to ? 'text-ink' : 'text-ink-2', !labels && 'sr-only')}>
              {s}
            </span>
          )
          return (
            <li key={s} aria-current={i === current ? 'step' : undefined} className={cn('flex min-w-0 items-center', i < steps.length - 1 && 'flex-1')}>
              {to ? (
                <Link
                  to={to}
                  aria-label={`Back to ${s}`}
                  className="group -m-2 flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-full p-2 hover:[&>span:last-child]:text-cobalt"
                >
                  {dot}
                  {name}
                </Link>
              ) : (
                <span className="flex shrink-0 items-center gap-2">
                  {dot}
                  {name}
                </span>
              )}
              {i < steps.length - 1 && (
                <span aria-hidden="true" className={cn('mx-2 h-[2px] min-w-3 flex-1 rounded-full', i < current ? 'bg-cobalt' : 'bg-rule-2')} />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
