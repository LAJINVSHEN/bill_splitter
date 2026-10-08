import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/Button'
import { Money, SectionTitle } from '@/components/Display'
import { Icon } from '@/components/Icon'
import { cn } from '@/lib/cn'
import { minorToInput as formatInput } from '@/lib/money'
import type { ValidationOut } from '@/lib/types'
import { DecimalInput, MoneyInput } from './inputs'
import {
  chargeFromPercent,
  chargesTotal,
  editAmount,
  editEach,
  editQty,
  emptyCharge,
  emptyItem,
  grandTotal,
  isPercentText,
  isQtyText,
  itemsTotal,
  type ChargeRow,
  type ItemRow,
  type ReceiptDraft,
} from './receiptDraft'

/** Borderless cell input: the row's hairlines are the structure; focus shows a cobalt ring. */
const cell =
  'h-11 w-full min-w-0 rounded-[var(--radius-control)] border-0 bg-transparent px-1.5 text-[16px] font-medium text-ink outline-none placeholder:text-ink-2 focus:bg-mist focus:ring-2 focus:ring-cobalt disabled:text-ink-2'
const removeBtn = 'grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] text-ink-2 hover:bg-mist hover:text-danger'

type Update = (fn: (d: ReceiptDraft) => ReceiptDraft) => void

/** Focus a freshly added row's first input (so "+ Add item" and Enter keep typing flowing). */
function useFocusNew() {
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const refs = useRef(new Map<string, HTMLInputElement>())
  useEffect(() => {
    if (!focusKey) return
    refs.current.get(focusKey)?.focus()
    setFocusKey(null) // eslint-disable-line react-hooks/set-state-in-effect -- one-shot focus request
  }, [focusKey])
  const register = (key: string) => (el: HTMLInputElement | null) => {
    if (el) refs.current.set(key, el)
    else refs.current.delete(key)
  }
  return { focus: setFocusKey, register }
}

export function ItemsTable({
  draft,
  update,
  currency,
  warnings,
  disabled,
}: {
  draft: ReceiptDraft
  update: Update
  currency: string
  warnings: ValidationOut['warnings']
  disabled?: boolean
}) {
  const nav = useFocusNew()
  const setRow = (key: string, fn: (r: ItemRow) => ItemRow) => update((d) => ({ ...d, items: d.items.map((r) => (r.key === key ? fn(r) : r)) }))
  const add = (afterKey?: string) => {
    const row = emptyItem()
    update((d) => {
      const at = afterKey ? d.items.findIndex((r) => r.key === afterKey) + 1 : d.items.length
      return { ...d, items: [...d.items.slice(0, at), row, ...d.items.slice(at)] }
    })
    nav.focus(row.key)
  }
  // Enter moves down a row (adding one at the end), like a receipt being typed out
  const onEnter = (key: string) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const i = draft.items.findIndex((r) => r.key === key)
    const next = draft.items[i + 1]
    if (next) nav.focus(next.key)
    else add(key)
  }

  return (
    <div>
      <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr)_72px_120px_120px_44px] gap-x-2 border-b border-rule border-t-[1.5px] border-t-ink py-2.5 text-[14px] font-semibold text-ink-2 md:grid">
        <span className="px-1.5">Item</span>
        <span className="px-1.5 text-right">Qty</span>
        <span className="px-1.5 text-right">Each</span>
        <span className="px-1.5 text-right">Amount</span>
        <span className="sr-only">Remove</span>
      </div>
      <ul aria-label="Items" className="border-t-[1.5px] border-ink md:border-t-0">
        {draft.items.map((r, i) => {
          const warn = warnings.find((w) => (w.item_id ? w.item_id === r.id : w.item_index === i))
          return (
            <li key={r.key} className={cn('border-b border-rule py-1', warn && 'bg-warn-soft')}>
              <div className="grid grid-cols-[minmax(0,1fr)_44px] items-center gap-x-1 md:grid-cols-[minmax(0,1fr)_72px_120px_120px_44px] md:gap-x-2">
                <input
                  ref={nav.register(r.key)}
                  aria-label={`Item ${i + 1} name`}
                  value={r.name}
                  placeholder="Item name"
                  maxLength={200}
                  disabled={disabled}
                  enterKeyHint="next"
                  onKeyDown={onEnter(r.key)}
                  onChange={(e) => setRow(r.key, (x) => ({ ...x, name: e.target.value }))}
                  className={cn(cell, 'font-semibold md:col-auto')}
                />
                <button type="button" aria-label={`Remove ${r.name || `item ${i + 1}`}`} disabled={disabled} className={cn(removeBtn, 'md:order-last')} onClick={() => update((d) => ({ ...d, items: d.items.filter((x) => x.key !== r.key) }))}>
                  <Icon name="close" size={18} />
                </button>
                <div className="col-span-2 grid grid-cols-[52px_auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-1 md:col-span-3 md:col-start-2 md:row-start-1 md:grid-cols-[72px_120px_120px] md:gap-x-2">
                  <DecimalInput
                    aria-label={`Item ${i + 1} quantity`}
                    allow={isQtyText}
                    value={r.qty}
                    disabled={disabled}
                    onKeyDown={onEnter(r.key)}
                    onChange={(v) => setRow(r.key, (x) => editQty(x, v, currency))}
                    onBlur={() => r.qty.trim() === '' && setRow(r.key, (x) => editQty(x, '1', currency))}
                    className={cn(cell, 'text-right')}
                  />
                  <span aria-hidden="true" className="text-ink-2 md:hidden">
                    ×
                  </span>
                  <MoneyInput
                    aria-label={`Item ${i + 1} price each`}
                    currency={currency}
                    value={r.each}
                    placeholder="Each"
                    disabled={disabled}
                    onKeyDown={onEnter(r.key)}
                    onChange={(v) => setRow(r.key, (x) => editEach(x, v, currency))}
                    className={cn(cell, 'text-right')}
                  />
                  <span aria-hidden="true" className="text-ink-2 md:hidden">
                    =
                  </span>
                  <MoneyInput
                    aria-label={`Item ${i + 1} amount`}
                    aria-invalid={warn ? true : undefined}
                    currency={currency}
                    value={r.amount}
                    placeholder="Amount"
                    disabled={disabled}
                    onKeyDown={onEnter(r.key)}
                    onChange={(v) => setRow(r.key, (x) => editAmount(x, v, currency))}
                    className={cn(cell, 'text-right font-semibold', warn && 'text-warn')}
                  />
                </div>
              </div>
              {r.details && <p className="px-1.5 pb-1 text-[14px] text-ink-2">with {r.details}</p>}
              {warn && (
                <p className="px-1.5 pb-1 text-[14px] font-semibold text-warn-ink">
                  Qty × each comes to <Money minor={warn.expected_cents} currency={currency} />
                </p>
              )}
            </li>
          )
        })}
      </ul>
      <Button variant="quiet" icon={<Icon name="plus" size={18} />} onClick={() => add()} disabled={disabled}>
        Add item
      </Button>
    </div>
  )
}

export function ChargesList({ draft, update, currency, disabled }: { draft: ReceiptDraft; update: Update; currency: string; disabled?: boolean }) {
  const nav = useFocusNew()
  const base = itemsTotal(draft.items, currency)
  const setRow = (key: string, fn: (r: ChargeRow) => ChargeRow) => update((d) => ({ ...d, charges: d.charges.map((r) => (r.key === key ? fn(r) : r)) }))
  const add = () => {
    const row = emptyCharge()
    update((d) => ({ ...d, charges: [...d.charges, row] }))
    nav.focus(row.key)
  }
  return (
    <div className="min-w-0">
      <SectionTitle>Charges</SectionTitle>
      <ul aria-label="Charges and discounts" className="border-t-[1.5px] border-ink">
        {draft.charges.map((ch, i) => (
          <li key={ch.key} className="grid grid-cols-[minmax(0,1fr)_44px] items-center gap-x-1 border-b border-rule py-1 sm:grid-cols-[minmax(0,1fr)_76px_44px_112px_44px]">
            <input
              ref={nav.register(ch.key)}
              aria-label={`Charge ${i + 1} name`}
              value={ch.name}
              placeholder={ch.negative ? 'Discount' : 'Service, GST…'}
              maxLength={120}
              disabled={disabled}
              onChange={(e) => setRow(ch.key, (x) => ({ ...x, name: e.target.value }))}
              className={cn(cell, 'font-semibold')}
            />
            <button type="button" aria-label={`Remove ${ch.name || `charge ${i + 1}`}`} disabled={disabled} className={cn(removeBtn, 'sm:order-last')} onClick={() => update((d) => ({ ...d, charges: d.charges.filter((x) => x.key !== ch.key) }))}>
              <Icon name="close" size={18} />
            </button>
            <div className="col-span-2 grid grid-cols-[76px_44px_minmax(0,1fr)] items-center gap-x-1 sm:col-span-3 sm:col-start-2 sm:row-start-1 sm:grid-cols-[76px_44px_112px]">
              <span className="relative">
                <DecimalInput
                  aria-label={`Charge ${i + 1} percent`}
                  allow={isPercentText}
                  value={ch.percent}
                  disabled={disabled}
                  onChange={(v) => setRow(ch.key, (x) => chargeFromPercent(x, v, base, currency))}
                  className={cn(cell, 'pr-6 text-right')}
                />
                <span aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[15px] text-ink-2">
                  %
                </span>
              </span>
              <button
                type="button"
                aria-pressed={ch.negative}
                aria-label={ch.negative ? 'Discount: tap to make it a charge' : 'Charge: tap to make it a discount'}
                disabled={disabled}
                onClick={() => setRow(ch.key, (x) => ({ ...x, negative: !x.negative }))}
                className={cn(
                  'grid h-11 w-11 place-items-center rounded-[var(--radius-control)] text-[20px] font-bold leading-none',
                  ch.negative ? 'bg-cobalt-soft text-cobalt-ink' : 'text-ink hover:bg-mist',
                )}
              >
                {ch.negative ? '−' : '+'}
              </button>
              <MoneyInput
                aria-label={`Charge ${i + 1} amount`}
                currency={currency}
                value={ch.amount}
                placeholder="0"
                disabled={disabled}
                onChange={(v) => setRow(ch.key, (x) => ({ ...x, amount: v, percentTyped: false, percent: x.percentTyped ? '' : x.percent }))}
                className={cn(cell, 'text-right font-semibold')}
              />
            </div>
          </li>
        ))}
      </ul>
      <Button variant="quiet" icon={<Icon name="plus" size={18} />} onClick={add} disabled={disabled}>
        Add charge or discount
      </Button>
    </div>
  )
}

/** Items · printed subtotal · charges · total, with the line that doesn't add up in warn. */
export function TotalsList({
  draft,
  update,
  currency,
  validation,
  disabled,
}: {
  draft: ReceiptDraft
  update: Update
  currency: string
  validation: ValidationOut | null
  disabled?: boolean
}) {
  const items = itemsTotal(draft.items, currency)
  const charges = chargesTotal(draft.charges, currency)
  const total = grandTotal(draft, currency)
  const codes = new Set(validation?.errors.map((e) => e.code))
  const itemsWarn = codes.has('items_subtotal_mismatch')
  const totalWarn = codes.has('grand_total_mismatch') || codes.has('items_grand_mismatch') || codes.has('no_scenario_matches')
  const sum = items + charges
  const input = 'h-11 w-[9.5rem] min-w-0 rounded-[var(--radius-control)] border-[1.5px] border-rule-2 bg-paper px-2.5 text-right text-[16px] font-semibold outline-none focus:border-cobalt focus:ring-2 focus:ring-cobalt-soft'

  return (
    <dl className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1.5 text-[16px] sm:max-w-[340px]">
      <dt className={cn('font-semibold', itemsWarn && 'text-warn-ink')}>Items</dt>
      <dd className={cn('num text-right font-bold', itemsWarn ? 'text-warn' : '')}>
        <Money minor={items} currency={currency} />
      </dd>
      <dt>
        <label htmlFor="rv-subtotal">Receipt subtotal</label>
      </dt>
      <dd className="text-right">
        <MoneyInput id="rv-subtotal" currency={currency} value={draft.subtotal} placeholder="Not shown" disabled={disabled} onChange={(v) => update((d) => ({ ...d, subtotal: v }))} className={input} />
      </dd>
      <dt>Charges</dt>
      <dd className="text-right font-semibold">
        <Money minor={charges} currency={currency} />
      </dd>
      <dt className={cn('border-t-[1.5px] border-ink pt-2.5 font-bold', totalWarn && 'text-warn-ink')}>
        <label htmlFor="rv-total">Total</label>
        {totalWarn && !draft.totalAuto && total !== sum && (
          <Button variant="quiet" className="block h-auto py-1 text-[14px]" disabled={disabled} onClick={() => update((d) => ({ ...d, totalAuto: true }))}>
            Use <Money minor={Math.max(0, sum)} currency={currency} />
          </Button>
        )}
      </dt>
      <dd className="border-t-[1.5px] border-ink pt-1.5 text-right">
        <MoneyInput
          id="rv-total"
          currency={currency}
          value={draft.totalAuto ? (sum > 0 ? formatInput(sum, currency) : '') : draft.total}
          placeholder="0"
          disabled={disabled}
          aria-invalid={totalWarn || undefined}
          onChange={(v) => update((d) => ({ ...d, total: v, totalAuto: false }))}
          className={cn(input, 'hero-num h-12 border-ink text-[26px]', totalWarn && 'border-warn text-warn')}
        />
      </dd>
    </dl>
  )
}
