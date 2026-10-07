import { Link } from 'react-router'
import { EqualsMark } from '@/components/Brand'
import { Avatar, HeroAmount, Money, SectionTitle } from '@/components/Display'
import { Icon, type IconName } from '@/components/Icon'
import { useBills, usePeople } from '@/data/queries'
import { cn } from '@/lib/cn'
import type { SummaryOut, UsageOut } from '@/lib/types'
import { BillList, BillStatusLabel, LoadError } from './BillList'
import { IN_PROGRESS, owingIndex, progressState } from './billState'
import { billName } from './format'
import { scanPauseText } from './scanPause'

// ---- Owed hero -----------------------------------------------------------------------------------
/**
 * What friends owe me in my home currency, never summed across currencies. Other currencies
 * are listed after it as they are; what I owe others follows when there's any.
 */
export function OwedHero({ summary }: { summary: SummaryOut }) {
  const home = summary.home
  const others = summary.currencies.filter((c) => c.currency !== home.currency && c.owed_to_me_cents !== 0)
  const firstOther = others[0]?.currency
  const iOwe = summary.currencies.filter((c) => c.i_owe_cents !== 0)
  const allEven = home.owed_to_me_cents === 0 && others.length === 0 && iOwe.length === 0

  if (allEven) {
    return (
      <section aria-labelledby="owed-title">
        <h2 id="owed-title" className="text-[15px] font-semibold text-ink-2 md:text-base">
          Owed to you
        </h2>
        <p className="display mt-2 flex items-center gap-3.5 text-[40px] md:text-[56px]">
          <EqualsMark size="lg" />
          You’re all even
        </p>
      </section>
    )
  }

  return (
    <section aria-labelledby="owed-title">
      <HeroAmount minor={home.owed_to_me_cents} currency={home.currency} label={<span id="owed-title">Owed to you</span>} />
      {firstOther && (
        <p className="mt-1 text-[15px] text-ink-2">
          Plus{' '}
          {others.map((c, i) => (
            <span key={c.currency}>
              {i > 0 && ', '}
              <Money minor={c.owed_to_me_cents} currency={c.currency} code className="font-bold text-warn" />
            </span>
          ))}{' '}
          without a rate ·{' '}
          <Link to={`/account?rate=${firstOther}`} className="font-semibold text-cobalt hover:text-cobalt-ink">
            Add {firstOther} rate
          </Link>
        </p>
      )}
      {iOwe.length > 0 && (
        <p className="mt-1 text-[15px] font-semibold">
          You owe{' '}
          {iOwe.map((c, i) => (
            <span key={c.currency}>
              {i > 0 && ', '}
              <Money minor={c.i_owe_cents} currency={c.currency} code />
            </span>
          ))}
        </p>
      )}
    </section>
  )
}

// ---- Debtors -------------------------------------------------------------------------------------
export function Debtors({ summary }: { summary: SummaryOut }) {
  const people = usePeople()
  const seeds = new Map((people.data ?? []).map((p) => [p.id, p.color_seed]))
  const debtors = summary.people.filter((p) => p.they_owe_me_cents > 0)
  if (debtors.length === 0) return null
  return (
    <ul aria-label="Who owes you" className="mt-4 border-t-[1.5px] border-ink md:mt-5">
      {debtors.map((d) => (
        <li
          key={`${d.person_id}-${d.currency}`}
          className="grid min-h-[48px] grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-3 border-b border-rule py-1.5 md:grid-cols-[30px_minmax(120px,180px)_minmax(0,1fr)_auto]"
        >
          <Avatar name={d.name} seed={seeds.get(d.person_id) ?? 210} size={28} />
          <span className="truncate text-base font-semibold">{d.name}</span>
          <span className="hidden truncate text-[15px] text-ink-2 md:block">{d.bill_count === 1 ? '1 bill' : `${d.bill_count} bills`}</span>
          <Money minor={d.they_owe_me_cents} currency={d.currency} code={d.currency !== summary.home.currency} className="text-[17px] font-semibold" />
        </li>
      ))}
    </ul>
  )
}

// ---- Start a bill --------------------------------------------------------------------------------
interface StartAction {
  mode: 'scan' | 'manual' | 'quick'
  label: string
  icon: IconName
}
const ACTIONS: StartAction[] = [
  { mode: 'scan', label: 'Scan a receipt', icon: 'scan' },
  { mode: 'manual', label: 'Type items', icon: 'type' },
  { mode: 'quick', label: 'Split a total', icon: 'divide' },
]

/** Scan is the primary path; when scanning is paused it steps back and typing takes the lead. */
export function StartBill({ usage }: { usage: UsageOut | undefined }) {
  const paused = scanPauseText(usage)
  const primary: StartAction['mode'] = paused ? 'manual' : 'scan'
  return (
    <section aria-labelledby="start-title">
      <SectionTitle id="start-title">Start a bill</SectionTitle>
      <div className="mt-2.5 grid grid-cols-2 gap-2 md:grid-cols-3 md:gap-2.5">
        {ACTIONS.map((a) => {
          const isPrimary = a.mode === primary
          return (
            <Link
              key={a.mode}
              to={`/bills/new?mode=${a.mode}`}
              className={cn(
                'flex items-center justify-between gap-2 rounded-[var(--radius-control)] px-4 font-semibold transition-colors',
                'md:min-h-[96px] md:flex-col-reverse md:items-start md:justify-between md:p-3.5',
                isPrimary ? 'bg-cobalt font-bold text-white hover:bg-cobalt-ink' : 'border-[1.5px] border-ink bg-paper text-ink hover:bg-mist',
                a.mode === 'scan' && !paused ? 'col-span-2 h-14 text-[17px] md:col-span-1 md:h-auto md:text-base' : 'h-12 text-[15px] md:h-auto md:text-base',
                a.mode === 'scan' && paused && 'order-last col-span-2 md:order-none md:col-span-1',
              )}
            >
              <span>{a.label}</span>
              <Icon name={a.icon} size={22} />
            </Link>
          )
        })}
      </div>
      {paused && (
        <p className="mt-2.5 flex items-start gap-2 text-[15px] font-semibold text-warn">
          <Icon name="alert" className="mt-px shrink-0" />
          <span>{paused} Typing items still works.</span>
        </p>
      )}
    </section>
  )
}

// ---- In progress ---------------------------------------------------------------------------------
export function InProgress() {
  const q = useBills(IN_PROGRESS)
  const bills = q.data?.pages.flatMap((p) => p.items) ?? []
  if (q.isError) return <LoadError what="your drafts" onRetry={() => void q.refetch()} retrying={q.isFetching} />
  if (bills.length === 0) return null
  return (
    <section aria-labelledby="progress-title">
      <SectionTitle id="progress-title">In progress</SectionTitle>
      <ul className="border-t-[1.5px] border-ink">
        {bills.slice(0, 6).map((b) => {
          const s = progressState(b)
          return (
            <li key={b.id} className="border-b border-rule">
              <Link to={`/bills/${b.id}`} className="group flex min-h-[56px] items-center gap-3 py-1.5 text-ink">
                <span className="flex min-w-0 flex-1 flex-col md:flex-row md:items-center md:gap-3">
                  <span className="truncate text-base font-semibold md:flex-1">{billName(b)}</span>
                  <BillStatusLabel bill={b} owing={0} />
                </span>
                <span className="w-[72px] text-right text-[15px] font-bold text-cobalt group-hover:text-cobalt-ink">{s.action}</span>
              </Link>
            </li>
          )
        })}
      </ul>
      {bills.length > 6 && (
        <Link to="/bills?show=drafts" className="mt-1 inline-flex h-11 items-center text-[15px] font-semibold text-cobalt">
          All {bills.length}
          {q.hasNextPage ? '+' : ''} drafts
        </Link>
      )}
    </section>
  )
}

// ---- Recent bills --------------------------------------------------------------------------------
export function RecentBills({ summary, homeCurrency }: { summary: SummaryOut | undefined; homeCurrency: string }) {
  const q = useBills(['complete'])
  const bills = (q.data?.pages.flatMap((p) => p.items) ?? []).slice(0, 5)
  if (q.isError) return <LoadError what="recent bills" onRetry={() => void q.refetch()} retrying={q.isFetching} />
  if (!q.data || bills.length === 0) return null
  return (
    <section aria-labelledby="recent-title">
      <SectionTitle
        id="recent-title"
        action={
          <Link to="/bills" className="inline-flex h-11 items-center text-[15px] font-semibold text-cobalt hover:text-cobalt-ink">
            All bills
          </Link>
        }
      >
        <span className="md:hidden">Recent</span>
        <span className="hidden md:inline">Recent bills</span>
      </SectionTitle>
      <BillList bills={bills} owing={owingIndex(summary)} homeCurrency={homeCurrency} label="Recent bills" />
    </section>
  )
}
