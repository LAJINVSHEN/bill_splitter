import type { ReactNode } from 'react'
import { Money } from '@/components/Display'
import { cn } from '@/lib/cn'

export interface TotalsLine {
  key: string
  label: ReactNode
  /** a plain amount, or `value` for an editable control in the amount column */
  minor?: number
  value?: ReactNode
  tone?: 'warn'
}

/** Amount column width: static amounts and inputs share it, so every figure lines up on the right. */
export const TOTALS_COL = 'w-[9.5rem]'
/** Inputs in the column: right-aligned text with the same right inset as the static figures. */
export const totalsInput =
  'h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-ink-2 bg-paper px-2.5 text-right text-[16px] font-semibold text-ink outline-none placeholder:text-ink-2 focus:border-cobalt focus:ring-2 focus:ring-cobalt-soft disabled:bg-mist'

/**
 * The bill's closing section, receipt-style: subtotal and charges on hairlines, then the total
 * under a heavy rule. One design for the item editor and the finished bill.
 */
export function TotalsBlock({
  lines,
  total,
  currency,
  className,
}: {
  lines: TotalsLine[]
  total: { label?: ReactNode; minor?: number; value?: ReactNode; tone?: 'warn'; note?: ReactNode }
  currency: string
  className?: string
}) {
  return (
    <dl aria-label="Totals" className={cn('w-full text-[16px]', className)}>
      {lines.map((l) => (
        <div key={l.key} className="flex min-h-11 items-center justify-between gap-4 border-b border-rule">
          <dt className={cn('min-w-0 font-medium', l.tone === 'warn' && 'font-semibold text-warn-ink')}>{l.label}</dt>
          <dd className={cn(TOTALS_COL, 'shrink-0 text-right', l.value === undefined && 'pr-[11px]')}>
            {l.value ?? <Money minor={l.minor ?? 0} currency={currency} className={cn('font-semibold', l.tone === 'warn' && 'text-warn')} />}
          </dd>
        </div>
      ))}
      <div className="mt-1 flex items-start justify-between gap-4 border-t-[1.5px] border-ink pt-3">
        <dt className={cn('min-w-0 pt-1.5', total.tone === 'warn' && 'text-warn-ink')}>
          <span className="display-sm text-lg">{total.label ?? 'Total'}</span>
          {total.note && <span className="block">{total.note}</span>}
        </dt>
        <dd className={cn('shrink-0 text-right', total.value === undefined ? 'pr-[11px]' : TOTALS_COL)}>
          {total.value ?? (
            <span className={cn('hero-num text-[28px]', total.tone === 'warn' && 'text-warn')}>
              <Money minor={total.minor ?? 0} currency={currency} code />
            </span>
          )}
        </dd>
      </div>
    </dl>
  )
}
