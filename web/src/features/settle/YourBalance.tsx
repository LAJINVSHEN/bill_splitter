import { Link } from 'react-router'
import { EvenBadge } from '@/components/Display'
import { Icon } from '@/components/Icon'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/money'
import type { BillOut, SummaryOut } from '@/lib/types'

/**
 * "Where do I stand?": the signed-in person's own balance, on Home (every currency) and on a
 * bill (that bill). Same language everywhere: a soft yellow band, the sentence on the left,
 * code and amount in ledger columns; money coming to you is blue, money you owe is ink.
 */

function Figure({ minor, currency, incoming, className }: { minor: number; currency: string; incoming: boolean; className?: string }) {
  return (
    <>
      <span className="num text-[15px] font-semibold text-ink-2">{currency}</span>
      <span className={cn('num pl-1.5 text-right font-bold', incoming ? 'text-cobalt-ink' : 'text-ink', className)}>{formatAmount(minor, currency)}</span>
    </>
  )
}

/** Home, above "In progress": one line per currency, never converted into each other. */
export function HomeBalance({ summary, homeCurrency }: { summary: SummaryOut | undefined; homeCurrency: string }) {
  const lines = (summary?.currencies ?? [])
    .map((c) => ({ currency: c.currency, net: c.owed_to_me_cents - c.i_owe_cents }))
    .filter((l) => l.net !== 0)
    .sort((a, b) => Number(b.currency === homeCurrency) - Number(a.currency === homeCurrency) || a.currency.localeCompare(b.currency))
  if (lines.length === 0) return null
  return (
    <section aria-labelledby="balance-title" className="rounded-[var(--radius-panel)] bg-warn-soft px-4 pb-2 pt-1 md:px-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="balance-title" className="text-[15px] font-bold text-warn-ink">Your balance</h2>
        <Link to="/people" className="-mr-1 inline-flex h-11 items-center gap-0.5 px-1 text-[15px] font-semibold text-ink hover:text-cobalt">
          Settle up
          <Icon name="next" size={16} />
        </Link>
      </div>
      <div className="grid w-fit grid-cols-[auto_auto_auto] items-baseline gap-x-3">
        {lines.map((l) => (
          <p key={l.currency} className="col-span-3 grid min-h-10 grid-cols-subgrid items-baseline">
            <span className="text-base font-semibold">{l.net > 0 ? 'You’re owed' : 'You owe'}</span>
            <span className="flex items-baseline">
              <Figure minor={Math.abs(l.net)} currency={l.currency} incoming={l.net > 0} className="text-[22px] leading-none" />
            </span>
          </p>
        ))}
      </div>
    </section>
  )
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name

/** What this bill means for you, in one line: owed, owing, or even. */
export function billPosition(bill: Pick<BillOut, 'split'>) {
  const { people, effective_currency: currency } = bill.split
  const me = people.find((p) => p.is_self)
  const payer = people.find((p) => p.is_payer)
  if (!me || !payer) return null
  if (me.is_payer) {
    const others = people.filter((p) => !p.is_payer)
    const owing = others.filter((p) => p.outstanding_cents > 0)
    const owed = owing.reduce((n, p) => n + p.outstanding_cents, 0)
    if (owed > 0) return { kind: 'owed' as const, label: 'You’re owed', amount: owed, currency, note: `${owing.length} of ${others.length} still owe` }
    return { kind: 'even' as const, label: others.length ? 'Everyone’s paid you back' : 'Just you on this bill' }
  }
  if (me.outstanding_cents > 0) return { kind: 'owe' as const, label: `You owe ${firstName(payer.name)}`, amount: me.outstanding_cents, currency, note: null }
  return { kind: 'even' as const, label: `You’re even with ${firstName(payer.name)}` }
}

/** The bill page's one line about you, under the title: the thing you came to check. */
export function BillBalance({ bill }: { bill: BillOut }) {
  const pos = billPosition(bill)
  if (!pos) return null
  if (pos.kind === 'even') {
    return (
      <p className="flex min-h-12 items-center rounded-[var(--radius-control)] bg-mist px-4">
        <EvenBadge label={pos.label} />
      </p>
    )
  }
  return (
    <p className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 rounded-[var(--radius-control)] bg-warn-soft px-4 py-1.5">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-base font-semibold">{pos.label}</span>
        {pos.note && <span className="text-[15px] text-ink-2">{pos.note}</span>}
      </span>
      <span className="flex items-baseline">
        <Figure minor={pos.amount} currency={pos.currency} incoming={pos.kind === 'owed'} className="text-[22px] leading-none" />
      </span>
    </p>
  )
}
