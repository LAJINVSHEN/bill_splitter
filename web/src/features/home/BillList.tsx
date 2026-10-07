import { Link } from 'react-router'
import { EqualsMark } from '@/components/Brand'
import { Button } from '@/components/Button'
import { EvenBadge, Money, Notice } from '@/components/Display'
import { cn } from '@/lib/cn'
import type { BillSummaryOut, UUID } from '@/lib/types'
import { owingCount, progressState } from './billState'
import { billName, peopleCount, shortDate } from './format'

/** "2 owe" in cobalt, "Even" with the =, or what an unfinished bill is waiting on. */
export function BillStatusLabel({ bill, owing }: { bill: BillSummaryOut; owing: number }) {
  if (bill.status === 'complete') {
    return owing > 0 ? <span className="text-[15px] font-bold text-cobalt">{owing} owe</span> : <EvenBadge />
  }
  const s = progressState(bill)
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[15px] font-semibold', s.tone === 'warn' ? 'text-warn' : 'text-ink-2')}>
      {bill.status === 'scanning' && <EqualsMark size="xs" moving />}
      {s.label}
    </span>
  )
}

function Total({ bill, homeCurrency, alwaysCode }: { bill: BillSummaryOut; homeCurrency: string; alwaysCode?: boolean }) {
  if (bill.grand_total_cents === null) return null
  return <Money minor={bill.grand_total_cents} currency={bill.currency} code={alwaysCode || bill.currency !== homeCurrency} />
}

interface ListProps {
  bills: BillSummaryOut[]
  owing: Map<UUID, number>
  homeCurrency: string
  label: string
}

/** Desktop: one table, shared columns. Scrolls inside its own box if the column gets narrow. */
export function BillTable({ bills, owing, homeCurrency, label }: ListProps) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full min-w-[640px] border-collapse text-base">
        <thead>
          <tr className="border-t-[1.5px] border-b border-ink border-b-rule text-left text-[14px] text-ink-2">
            <th scope="col" className="w-[110px] py-2.5 font-semibold">
              Date
            </th>
            <th scope="col" className="py-2.5 font-semibold">
              Bill
            </th>
            <th scope="col" className="w-[140px] py-2.5 font-semibold">
              People
            </th>
            <th scope="col" className="w-[160px] py-2.5 text-right font-semibold">
              Total
            </th>
            <th scope="col" className="w-[170px] py-2.5 text-right font-semibold">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {bills.map((b) => (
            <tr key={b.id} className="relative border-b border-rule hover:bg-mist">
              <td className="num py-3.5 font-semibold text-ink-2">{shortDate(b.bill_date ?? b.created_at)}</td>
              <td className="py-3.5 pr-4 font-semibold">
                <Link to={`/bills/${b.id}`} className="outline-offset-[-2px] after:absolute after:inset-0 after:content-['']">
                  {billName(b)}
                </Link>
              </td>
              <td className="py-3.5 text-ink-2">{peopleCount(b.participant_count)}</td>
              <td className="py-3.5 text-right font-semibold">
                <Total bill={b} homeCurrency={homeCurrency} alwaysCode />
              </td>
              <td className="py-3.5 text-right">
                <BillStatusLabel bill={b} owing={owingCount(b, owing)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Phone: a ruled list, one line per bill; the whole row is the link. */
export function BillRows({ bills, owing, homeCurrency, label }: ListProps) {
  return (
    <ul aria-label={label} className="border-t-[1.5px] border-ink">
      {bills.map((b) => (
        <li key={b.id} className="border-b border-rule">
          <Link to={`/bills/${b.id}`} className="grid min-h-[56px] grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-2.5 py-2 text-ink">
            <span className="num text-[14px] font-semibold text-ink-2">{shortDate(b.bill_date ?? b.created_at)}</span>
            <span className="truncate text-base font-semibold">{billName(b)}</span>
            <span className="flex flex-col items-end">
              <span className="text-base font-semibold">
                <Total bill={b} homeCurrency={homeCurrency} />
              </span>
              <BillStatusLabel bill={b} owing={owingCount(b, owing)} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** Both layouts; CSS picks one so there's no flash on resize. */
export function BillList(props: ListProps) {
  return (
    <>
      <div className="md:hidden">
        <BillRows {...props} />
      </div>
      <div className="hidden md:block">
        <BillTable {...props} />
      </div>
    </>
  )
}

export function LoadError({ what, onRetry, retrying }: { what: string; onRetry: () => void; retrying?: boolean }) {
  return (
    <Notice
      tone="danger"
      action={
        <Button variant="quiet" className="-my-3 text-danger" onClick={onRetry} loading={retrying}>
          Retry
        </Button>
      }
    >
      Couldn’t load {what}.
    </Notice>
  )
}

/** A section-sized loader (FullPageLoader is for whole pages). */
export function SectionLoader({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="py-10">
      <EqualsMark size="lg" moving />
    </div>
  )
}
