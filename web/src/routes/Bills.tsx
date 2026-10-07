import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Button, ButtonLink } from '@/components/Button'
import { EmptyState, Notice, PageTitle } from '@/components/Display'
import { SelectField, TextField } from '@/components/Field'
import { Dialog, useToast } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { useBills, useClearBills, useDeleteBill, useMe, useSummary } from '@/data/queries'
import { BillList, LoadError, SectionLoader } from '@/features/home/BillList'
import { BILL_FILTERS, filterSettled, filterStatuses, owingIndex, parseFilter, type BillFilter } from '@/features/home/billState'
import { cn } from '@/lib/cn'
import { ApiError } from '@/lib/api'
import type { BillSummaryOut } from '@/lib/types'
import { billName } from '@/features/home/format'

const EMPTY: Record<BillFilter, string> = {
  all: 'No bills yet',
  open: 'Nobody owes you',
  even: 'Nothing settled yet',
  drafts: 'No drafts',
}

/** Filter: a segmented control on desktop (never wraps), the native select on phones. */
function FilterControl({ value, onChange }: { value: BillFilter; onChange: (f: BillFilter) => void }) {
  return (
    <>
      <div className="w-full md:hidden">
        <SelectField label="Show" hideLabel value={value} onChange={(e) => onChange(e.target.value as BillFilter)}>
          {BILL_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </SelectField>
      </div>
      <div role="group" aria-label="Show" className="hidden shrink-0 whitespace-nowrap rounded-[var(--radius-control)] border-[1.5px] border-ink p-0.5 md:inline-flex">
        {BILL_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={value === f.value}
            onClick={() => onChange(f.value)}
            className={cn(
              'h-10 rounded-[4px] px-4 text-[15px] font-semibold transition-colors',
              value === f.value ? 'bg-ink text-white' : 'text-ink hover:bg-mist',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
    </>
  )
}

export default function BillsPage() {
  const [params, setParams] = useSearchParams()
  const filter = parseFilter(params.get('show'))
  const me = useMe()
  const summary = useSummary()
  const q = useBills(filterStatuses(filter), 20, filterSettled(filter))
  const owing = owingIndex(summary.data)
  const homeCurrency = me.data?.default_currency ?? 'SGD'
  const remove = useDeleteBill()
  const clear = useClearBills()
  const toast = useToast()
  const [deleting, setDeleting] = useState<BillSummaryOut | 'all' | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const busy = remove.isPending || clear.isPending

  function openDelete(target: BillSummaryOut | 'all') {
    setDeleting(target)
    setConfirmation('')
    setDeleteError(null)
  }

  async function confirmDelete() {
    if (!deleting || busy || (deleting === 'all' && confirmation !== 'DELETE ALL BILLS')) return
    try {
      if (deleting === 'all') await clear.mutateAsync({ permanent: true })
      else await remove.mutateAsync({ id: deleting.id, permanent: true })
      toast(deleting === 'all' ? 'Bill history cleared' : 'Bill deleted')
      setDeleting(null)
    } catch (error) {
      setDeleteError(error instanceof ApiError ? error.message : 'Could not delete. Try again.')
    }
  }

  const loaded = q.data?.pages.flatMap((p) => p.items) ?? []
  const bills = loaded
  const setFilter = (f: BillFilter) => setParams(f === 'all' ? {} : { show: f }, { replace: true })

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <PageTitle>Bills</PageTitle>
        <FilterControl value={filter} onChange={setFilter} />
      </div>
      <div className="flex justify-end">
        <Button variant="quiet" className="text-danger" icon={<Icon name="trash" size={20} />} disabled={busy} onClick={() => openDelete('all')}>
          Clear bill history
        </Button>
      </div>

      {q.isPending ? (
        <SectionLoader label="Loading bills" />
      ) : q.isError && loaded.length === 0 ? (
        <LoadError what="your bills" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : bills.length === 0 && !q.hasNextPage ? (
        <EmptyState
          title={EMPTY[filter]}
          action={
            filter === 'all' || filter === 'drafts' ? (
              <ButtonLink to="/bills/new" icon={<Icon name="plus" size={18} />}>
                New bill
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <div className={cn('transition-opacity', q.isPlaceholderData && 'opacity-60')}>
          <BillList bills={bills} owing={owing} homeCurrency={homeCurrency} label="Bills" onDelete={openDelete}
            deletingId={remove.isPending && deleting && deleting !== 'all' ? deleting.id : undefined} />
          {q.hasNextPage && (
            <div className="mt-4 flex flex-col items-start gap-2">
              {q.isFetchNextPageError && <LoadError what="more bills" onRetry={() => void q.fetchNextPage()} retrying={q.isFetchingNextPage} />}
              <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
      {deleting && (
        <Dialog open onClose={() => { if (!busy) setDeleting(null) }} title={deleting === 'all' ? 'Clear bill history?' : 'Delete bill?'}
          footer={<>
            <Button variant="secondary" disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" icon={<Icon name="trash" size={20} />} loading={busy}
              disabled={deleting === 'all' && confirmation !== 'DELETE ALL BILLS'} onClick={() => void confirmDelete()}>
              {deleting === 'all' ? 'Delete all bills' : 'Delete bill'}
            </Button>
          </>}>
          <div className="flex flex-col gap-4" aria-busy={busy}>
            {deleting !== 'all' && <p className="break-words font-semibold">{billName(deleting)}</p>}
            <p>{deleting === 'all' ? 'All bills, drafts and previously deleted history, across every page and filter, will be permanently erased.' : 'This bill’s items, splits and payment history will be permanently erased.'}</p>
            <p>Share links stop working, scans are cancelled, and photos are queued for deletion. Scan usage still counts toward your quota. This cannot be undone.</p>
            {deleting === 'all' && <TextField label="Type DELETE ALL BILLS to confirm" value={confirmation} autoComplete="off" disabled={busy} onChange={(event) => setConfirmation(event.target.value)} />}
            {deleteError && <Notice tone="danger">{deleteError}</Notice>}
          </div>
        </Dialog>
      )}
    </div>
  )
}
