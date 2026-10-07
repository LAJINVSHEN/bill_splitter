import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/money'
import { EqualsMark } from './Brand'
import { Icon } from './Icon'

/** Amount in minor units. `code` prefixes the currency ("SGD 12.34"). Always tabular. */
export function Money({ minor, currency, code = false, className }: { minor: number; currency: string; code?: boolean; className?: string }) {
  return (
    <span className={cn('num whitespace-nowrap', className)}>
      {code && <span className="mr-1">{currency}</span>}
      {formatAmount(minor, currency)}
    </span>
  )
}

/** The big number: owed amounts, totals. Currency code sits small and high, like a ledger. */
export function HeroAmount({ minor, currency, size = 'lg', label }: { minor: number; currency: string; size?: 'md' | 'lg' | 'xl'; label?: ReactNode }) {
  const text = size === 'xl' ? 'text-[84px]' : size === 'lg' ? 'text-[56px] md:text-[68px]' : 'text-[40px]'
  const code = size === 'md' ? 'text-base mt-1.5' : 'text-lg md:text-[22px] mt-2.5 md:mt-3.5'
  return (
    <div>
      {label && <p className="text-[15px] font-semibold text-ink-2 md:text-base">{label}</p>}
      <p className="flex items-start gap-1.5">
        <span className={cn('hero-num font-semibold', code)} style={{ letterSpacing: 0 }}>
          {currency}
        </span>
        <span className={cn('hero-num', text)}>{formatAmount(minor, currency)}</span>
      </p>
    </div>
  )
}

/** Person initial on their colour (hue from color_seed). Colour annotates identity, consistently everywhere. */
export function Avatar({ name, seed, size = 30 }: { name: string; seed: number; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-grid shrink-0 place-items-center rounded-full font-bold text-ink"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.43), background: `hsl(${seed} 78% 88%)` }}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

export function Meter({ value, max, label, tone = 'cobalt' }: { value: number; max: number; label: string; tone?: 'cobalt' | 'warn' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-1.5 overflow-hidden rounded-full bg-rule">
      <span className={cn('block h-full', tone === 'warn' ? 'bg-warn' : 'bg-cobalt')} style={{ width: `${pct}%` }} />
    </div>
  )
}

/** A ruled list: heavy top rule, hairline rows. The house alternative to cards. */
export function Ledger({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <ul aria-label={label} className={cn('border-t-[1.5px] border-ink', className)}>
      {children}
    </ul>
  )
}

export function LedgerRow({ children, className }: { children: ReactNode; className?: string }) {
  return <li className={cn('flex min-h-[52px] items-center gap-3 border-b border-rule', className)}>{children}</li>
}

export function SectionTitle({ children, action, id }: { children: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <h2 id={id} className="display-sm text-lg md:text-xl">
        {children}
      </h2>
      {action}
    </div>
  )
}

/** Settled state: the "=" plus the word. */
export function EvenBadge({ label = 'Even' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[15px] font-bold text-cobalt">
      <EqualsMark size="xs" />
      {label}
    </span>
  )
}

export function Notice({ tone = 'warn', children, action }: { tone?: 'warn' | 'danger' | 'info'; children: ReactNode; action?: ReactNode }) {
  const styles =
    tone === 'danger' ? 'bg-danger-soft text-danger' : tone === 'info' ? 'bg-cobalt-soft text-cobalt-ink' : 'bg-warn-soft text-warn-ink'
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-start gap-2.5 rounded-[var(--radius-control)] px-3.5 py-3 text-[15px] leading-snug', styles)}>
      <Icon name={tone === 'info' ? 'check' : 'alert'} className="mt-px shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  )
}

export function PageTitle({ children, sub, back }: { children: ReactNode; sub?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <header className="pt-3 md:pt-10">
      {back && (
        <Link to={back.to} className="-ml-1 mb-1 inline-flex h-11 items-center gap-1 text-[15px] font-semibold text-ink">
          <Icon name="back" />
          {back.label}
        </Link>
      )}
      <h1 className="display text-[34px] md:text-[40px]">{children}</h1>
      {sub && <p className="mt-1.5 text-[15px] text-ink-2">{sub}</p>}
    </header>
  )
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 border-t-[1.5px] border-ink py-8">
      <EqualsMark size="lg" />
      <p className="display-sm text-xl">{title}</p>
      {children && <p className="max-w-[46ch] text-[15px] text-ink-2">{children}</p>}
      {action}
    </div>
  )
}

export function FullPageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="grid min-h-[60vh] place-items-center">
      <EqualsMark size="lg" moving />
    </div>
  )
}
