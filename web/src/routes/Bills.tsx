import { useSearchParams } from 'react-router'
import { Button, ButtonLink } from '@/components/Button'
import { EmptyState, PageTitle } from '@/components/Display'
import { SelectField } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { useBills, useMe, useSummary } from '@/data/queries'
import { BillList, LoadError, SectionLoader } from '@/features/home/BillList'
import { BILL_FILTERS, filterStatuses, matchesFilter, owingCount, owingIndex, parseFilter, type BillFilter } from '@/features/home/billState'
import { cn } from '@/lib/cn'

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
  const q = useBills(filterStatuses(filter))
  const owing = owingIndex(summary.data)
  const homeCurrency = me.data?.default_currency ?? 'SGD'

  const loaded = q.data?.pages.flatMap((p) => p.items) ?? []
  const bills = loaded.filter((b) => matchesFilter(filter, b, owingCount(b, owing)))
  const setFilter = (f: BillFilter) => setParams(f === 'all' ? {} : { show: f }, { replace: true })

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <PageTitle>Bills</PageTitle>
        <FilterControl value={filter} onChange={setFilter} />
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
          {bills.length > 0 ? (
            <BillList bills={bills} owing={owing} homeCurrency={homeCurrency} label="Bills" />
          ) : (
            <p className="border-t-[1.5px] border-ink py-4 text-[15px] text-ink-2">None in the latest {loaded.length} bills.</p>
          )}
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
    </div>
  )
}
