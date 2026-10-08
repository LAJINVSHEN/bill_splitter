import type { ReactNode } from 'react'
import { useParams } from 'react-router'
import { Button, ButtonLink } from '@/components/Button'
import { EmptyState, FullPageLoader, Notice } from '@/components/Display'
import { useBill } from '@/data/queries'
import { ApiError } from '@/lib/api'
import type { BillOut } from '@/lib/types'
import { quotaMessage, type QuotaInfo } from './flow'

/** Load the bill named in the URL; loading and "not here" states are handled once, here. */
export function BillGate({ children }: { children: (bill: BillOut) => ReactNode }) {
  const { billId } = useParams()
  const bill = useBill(billId)
  if (bill.data) return <>{children(bill.data)}</>
  if (bill.isPending) return <FullPageLoader label="Loading bill" />
  const notFound = bill.error instanceof ApiError && (bill.error.status === 404 || bill.error.status === 422)
  return (
    <div className="px-5 pt-10 md:px-[var(--app-gutter)]">
      <EmptyState
        title={notFound ? 'This bill isn’t here' : 'Couldn’t load this bill'}
        action={
          <div className="flex gap-2.5">
            {!notFound && (
              <Button onClick={() => void bill.refetch()} loading={bill.isFetching}>
                Try again
              </Button>
            )}
            <ButtonLink to="/" variant={notFound ? 'primary' : 'secondary'}>
              Home
            </ButtonLink>
          </div>
        }
      >
        {notFound ? 'It may have been deleted.' : bill.error?.message}
      </EmptyState>
    </div>
  )
}

/** Scanning is paused: say why and when it's back, and keep the way forward one tap away. */
export function QuotaNotice({ quota, onManual, busy }: { quota: QuotaInfo; onManual: () => void; busy?: boolean }) {
  return (
    <Notice
      tone="warn"
      action={
        <Button variant="quiet" className="-my-2.5 shrink-0" onClick={onManual} loading={busy}>
          Type items instead
        </Button>
      }
    >
      {quotaMessage(quota)}
    </Notice>
  )
}

/** Failed save with a way out: shown inline wherever autosave runs. */
export function SaveError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = error instanceof ApiError ? error.message : 'Your last change didn’t save.'
  return (
    <Notice
      tone="danger"
      action={
        <Button variant="quiet" className="-my-2.5 shrink-0" onClick={onRetry} icon={undefined}>
          Retry
        </Button>
      }
    >
      {message}
    </Notice>
  )
}

/** Title block for a flow step: one heading, an optional single fact line. */
export function StepTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="pt-2 md:pt-8">
      <h1 className="display text-[34px] md:text-[40px]">{children}</h1>
      {sub && <p className="mt-1.5 text-[15px] text-ink-2">{sub}</p>}
    </div>
  )
}

/** Action-bar content: a flex-1 summary first, then the actions (pushed right on desktop). */
export function FooterBar({ children }: { children: ReactNode }) {
  return <div className="flex w-full min-w-0 items-center gap-3.5">{children}</div>
}
