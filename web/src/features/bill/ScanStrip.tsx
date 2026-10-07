import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Button, ButtonLink } from '@/components/Button'
import { Money } from '@/components/Display'
import { Icon } from '@/components/Icon'
import { isJobActive, qk, useCancelJob, useJob, useRetryJob } from '@/data/queries'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { BillOut, JobStatus } from '@/lib/types'
import { quotaFromError } from './flow'
import { QuotaNotice } from './parts'

const STAGES = ['Upload', 'Read', 'Items', 'Totals'] as const

const PROGRESS: Record<JobStatus, number> = {
  queued: 1,
  ocr: 1.5,
  llm: 2.5,
  validating: 3.5,
  succeeded: 4,
  needs_review: 4,
  failed: 0,
  cancelled: 0,
}

const LABEL: Partial<Record<JobStatus, string>> = {
  queued: 'Reading your receipt',
  ocr: 'Reading your receipt',
  llm: 'Understanding the items',
  validating: 'Checking the totals',
}

function pagesLabel(bill: BillOut, jobId: string): string {
  const files = bill.files.filter((f) => f.job_id === jobId)
  const list = files.length ? files : bill.files
  if (list.length === 1 && list[0]?.mime === 'application/pdf') return '1 PDF'
  const n = Math.max(1, list.length)
  return `${n} ${n === 1 ? 'photo' : 'photos'}`
}

/**
 * The live scan on the People step: real stages from the job, cancel while it runs,
 * and every way forward when it fails (retry, another photo, or type the items).
 */
export function ScanStrip({ bill, onManual, manualBusy }: { bill: BillOut; onManual: () => void; manualBusy?: boolean }) {
  const qc = useQueryClient()
  const jobId = bill.latest_job?.id
  const job = useJob(jobId)
  const cancel = useCancelJob()
  const retry = useRetryJob()
  const [retryError, setRetryError] = useState<unknown>(null)
  const status: JobStatus | undefined = job.data?.status ?? bill.latest_job?.status
  const active = isJobActive(status)

  // when the job ends, the bill flips (items, status): fetch it now rather than on the next poll
  useEffect(() => {
    if (status && !isJobActive(status)) void qc.invalidateQueries({ queryKey: qk.bill(bill.id) })
  }, [status, bill.id, qc])

  if (!jobId || !status) return null
  const value = PROGRESS[status]
  const failed = status === 'failed' || status === 'cancelled'
  const retryable = job.data?.retryable ?? bill.latest_job?.retryable ?? false
  const quota = quotaFromError(retryError)

  return (
    <section aria-label="Receipt scan" className="border-b border-rule border-t-[1.5px] border-t-ink py-3.5">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="flex h-[52px] w-10 shrink-0 flex-col gap-1 rounded-[4px] border border-rule bg-mist px-[7px] py-2">
          <span className="h-0.5 bg-rule-2" />
          <span className="h-0.5 w-[70%] bg-rule-2" />
          <span className="h-0.5 bg-rule-2" />
          <span className="h-0.5 w-[55%] bg-rule-2" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5" aria-live="polite">
          <span className={cn('text-[16px] font-semibold', failed && 'text-danger')}>
            {active
              ? LABEL[status]
              : status === 'failed'
                ? 'Couldn’t read the receipt'
                : status === 'cancelled'
                  ? 'Scan cancelled'
                  : 'Receipt read'}
          </span>
          <span className={cn('text-[14px] text-ink-2', status === 'needs_review' && 'font-semibold text-warn')}>
            {active ? (
              `${pagesLabel(bill, jobId)} · you can keep going`
            ) : status === 'succeeded' || status === 'needs_review' ? (
              <>
                {bill.items.length} {bill.items.length === 1 ? 'item' : 'items'}
                {status === 'needs_review' ? ' · totals need a look' : bill.grand_total_cents !== null && <> · <Money minor={bill.grand_total_cents} currency={bill.currency} code /></>}
              </>
            ) : (
              status === 'cancelled' ? pagesLabel(bill, jobId) : (job.data?.error_message ?? 'Something went wrong reading it.')
            )}
          </span>
        </div>
        {active && (
          <Button variant="quiet" className="shrink-0" loading={cancel.isPending} onClick={() => cancel.mutate(jobId)}>
            Cancel
          </Button>
        )}
      </div>

      {!failed && (
        <>
          <div role="progressbar" aria-label="Scan progress" aria-valuemin={0} aria-valuemax={4} aria-valuenow={value} className="mt-3 grid grid-cols-4 gap-1">
            {STAGES.map((s, i) => (
              <span key={s} className="h-[3px] bg-rule">
                <span className="block h-full bg-cobalt transition-[width] duration-500" style={{ width: `${Math.max(0, Math.min(1, value - i)) * 100}%` }} />
              </span>
            ))}
          </div>
          <div className="mt-1.5 grid grid-cols-4 gap-1 text-[13px] font-semibold">
            {STAGES.map((s, i) => (
              <span key={s} className={value > i ? 'text-ink' : 'text-ink-2'}>
                {s}
              </span>
            ))}
          </div>
        </>
      )}

      {failed && (
        <div className="mt-3 flex flex-col gap-3">
          {quota ? (
            <QuotaNotice quota={quota} onManual={onManual} busy={manualBusy} />
          ) : (
            retryError instanceof ApiError && <p role="alert" className="text-[15px] font-semibold text-danger">{retryError.message}</p>
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {retryable && !quota && (
              <Button
                variant="quiet"
                icon={<Icon name="retry" size={18} />}
                loading={retry.isPending}
                onClick={() => {
                  setRetryError(null)
                  retry.mutate(jobId, { onError: setRetryError })
                }}
              >
                Try again
              </Button>
            )}
            <ButtonLink to={`/bills/${bill.id}/scan`} variant="quiet" icon={<Icon name="scan" size={18} />}>
              Take another photo
            </ButtonLink>
            {!quota && (
              <Button variant="quiet" icon={<Icon name="type" size={18} />} loading={manualBusy} onClick={onManual}>
                Type items instead
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
