import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { CURRENCIES, exponentOf } from '@/lib/money'
import { isMoneyText, normalizeMoney } from './receiptDraft'

type Bare = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>

/**
 * Amount as typed: "12." and "12.50" survive every keystroke; it tidies to the currency's
 * decimals on blur. Junk keystrokes are dropped rather than flagged, so focus never jumps.
 */
export const MoneyInput = forwardRef<HTMLInputElement, Bare & { value: string; onChange: (v: string) => void; currency: string }>(function MoneyInput(
  { value, onChange, currency, onBlur, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type="text"
      inputMode={exponentOf(currency) > 0 ? 'decimal' : 'numeric'}
      autoComplete="off"
      value={value}
      onChange={(e) => {
        if (isMoneyText(e.target.value)) onChange(e.target.value)
      }}
      onBlur={(e) => {
        const tidy = normalizeMoney(value, currency)
        if (tidy !== value) onChange(tidy)
        onBlur?.(e)
      }}
      className={cn('num', className)}
      {...rest}
    />
  )
})

/** Text input for a constrained decimal (quantity, percent, rate): rejects keystrokes that don't fit. */
export const DecimalInput = forwardRef<HTMLInputElement, Bare & { value: string; onChange: (v: string) => void; allow: (v: string) => boolean }>(function DecimalInput(
  { value, onChange, allow, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={value}
      onChange={(e) => {
        if (allow(e.target.value)) onChange(e.target.value)
      }}
      className={cn('num', className)}
      {...rest}
    />
  )
})

/** The one currency picker: a native select over every circulating currency. */
export function CurrencyOptions({ short }: { short?: boolean }) {
  return (
    <>
      {CURRENCIES.map((c) => (
        <option key={c.code} value={c.code}>
          {short ? c.code : `${c.code} · ${c.name}`}
        </option>
      ))}
    </>
  )
}

/** − n + for whole-number shares. 44 px targets. */
export function Stepper({ value, onChange, label, min = 0, max = 99 }: { value: number; onChange: (n: number) => void; label: string; min?: number; max?: number }) {
  const btn =
    'grid h-11 w-11 place-items-center rounded-[var(--radius-control)] border-[1.5px] border-ink text-[20px] font-bold leading-none text-ink hover:bg-mist disabled:border-rule-2 disabled:text-ink-2'
  return (
    <span role="group" aria-label={`Shares for ${label}`} className="inline-flex items-center gap-1">
      <button type="button" className={btn} aria-label={`Fewer shares for ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        −
      </button>
      <span className="num w-7 text-center text-[17px] font-bold" aria-live="polite">
        {value}
      </span>
      <button type="button" className={btn} aria-label={`More shares for ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        +
      </button>
    </span>
  )
}
