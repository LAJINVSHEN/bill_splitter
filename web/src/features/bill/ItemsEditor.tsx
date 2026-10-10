import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from 'react'
import { Button } from '@/components/Button'
import { Money, SectionTitle } from '@/components/Display'
import { Icon } from '@/components/Icon'
import { cn } from '@/lib/cn'
import { minorToInput as formatInput } from '@/lib/money'
import type { ValidationOut } from '@/lib/types'
import { DecimalInput, MoneyInput } from './inputs'
import {
  chargeFromPercent,
  chargeMinor,
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
import { TotalsBlock, totalsInput } from './TotalsBlock'

/** A clearly drawn entry box: text keyboard for names, number pad for qty and money (inputMode on the inputs). */
const box =
  'h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-ink-2 bg-paper px-2.5 text-[16px] font-medium text-ink outline-none placeholder:text-ink-2 focus:border-cobalt focus:ring-2 focus:ring-cobalt-soft disabled:bg-mist disabled:text-ink-2'
/**
 * The name reads as the row's title, not another box: plain bold text that edits in place. A soft
 * mist on hover and a cobalt ring while typing say it's editable; the negative margin keeps the text
 * lined up with the edge of the boxes below it.
 */
const nameText =
  '-mx-2 w-[calc(100%+1rem)] min-w-0 rounded-[var(--radius-control)] border-0 bg-transparent px-2 text-[17px] font-semibold text-ink outline-none placeholder:font-medium placeholder:text-ink-2 hover:bg-mist focus:bg-paper focus:ring-2 focus:ring-cobalt disabled:text-ink-2 disabled:hover:bg-transparent'
const removeBtn = 'grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] text-ink-2 hover:bg-mist hover:text-danger'

type Update = (fn: (d: ReceiptDraft) => ReceiptDraft) => void
type Focusable = HTMLInputElement | HTMLTextAreaElement

/** Focus a freshly added row's first field (so "+ Add item" and Enter keep typing flowing). */
function useFocusNew() {
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const refs = useRef(new Map<string, Focusable>())
  useEffect(() => {
    if (!focusKey) return
    refs.current.get(focusKey)?.focus()
    setFocusKey(null) // eslint-disable-line react-hooks/set-state-in-effect -- one-shot focus request
  }, [focusKey])
  const register = (key: string) => (el: Focusable | null) => {
    if (el) refs.current.set(key, el)
    else refs.current.delete(key)
  }
  return { focus: setFocusKey, register }
}

/**
 * A name box that stays one line, and opens up to show the whole name while it's being edited
 * (tap a long, cut-off name to read it). Enter never adds a line break; it moves on.
 */
export const NameBox = forwardRef<HTMLTextAreaElement, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onChange: (v: string) => void }>(
  function NameBox({ value, onChange, className, onFocus, onBlur, ...rest }, ref) {
    const [open, setOpen] = useState(false)
    const own = useRef<HTMLTextAreaElement | null>(null)
    // measure after the wrap style has applied, so the box fits every line of the name
    useLayoutEffect(() => {
      const el = own.current
      if (!el) return
      if (!open) {
        el.style.height = ''
        el.scrollTop = 0
        return
      }
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight + 2}px`
    }, [open, value])
    return (
      <textarea
        ref={(el) => {
          own.current = el
          if (typeof ref === 'function') ref(el)
          else if (ref) ref.current = el
        }}
        rows={1}
        value={value}
        autoCapitalize="sentences"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value.replace(/\s*\n\s*/g, ' '))}
        onFocus={(e) => {
          setOpen(true)
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setOpen(false)
          onBlur?.(e)
        }}
        className={cn(nameText, 'block min-h-11 resize-none py-[10px] leading-[1.4]', open ? 'whitespace-pre-wrap' : 'overflow-hidden whitespace-nowrap', className)}
        {...rest}
      />
    )
  },
)

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
  const onEnter = (key: string) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const i = draft.items.findIndex((r) => r.key === key)
    const next = draft.items[i + 1]
    if (next) nav.focus(next.key)
    else add(key)
  }

  return (
    <div>
      <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr)_76px_124px_124px_44px] gap-x-2 border-b border-rule border-t-[1.5px] border-t-ink py-2.5 text-[14px] font-semibold text-ink-2 md:grid">
        <span>Item</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Each</span>
        <span className="text-right">Amount</span>
        <span className="sr-only">Remove</span>
      </div>
      <ul aria-label="Items" className="border-t-[1.5px] border-ink md:border-t-0">
        {draft.items.map((r, i) => {
          const warn = warnings.find((w) => (w.item_id ? w.item_id === r.id : w.item_index === i))
          return (
            <li key={r.key} className={cn('border-b border-rule pb-3 pt-2 md:py-2', warn && '-mx-2 rounded-[var(--radius-control)] border-b-0 bg-warn-soft px-2')}>
              <div className="grid grid-cols-[minmax(0,1fr)_44px] items-start gap-x-1.5 gap-y-1 md:grid-cols-[minmax(0,1fr)_76px_124px_124px_44px] md:gap-x-2">
                <NameBox
                  ref={nav.register(r.key)}
                  aria-label={`Item ${i + 1} name`}
                  value={r.name}
                  placeholder="Item name"
                  maxLength={200}
                  disabled={disabled}
                  enterKeyHint="next"
                  onKeyDown={onEnter(r.key)}
                  onChange={(v) => setRow(r.key, (x) => ({ ...x, name: v }))}
                  className="font-semibold"
                />
                <button type="button" aria-label={`Remove ${r.name || `item ${i + 1}`}`} disabled={disabled} className={cn(removeBtn, 'md:order-last')} onClick={() => update((d) => ({ ...d, items: d.items.filter((x) => x.key !== r.key) }))}>
                  <Icon name="close" size={18} />
                </button>
                <div className="col-span-2 grid grid-cols-[64px_auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-1.5 md:col-span-3 md:col-start-2 md:row-start-1 md:grid-cols-[76px_124px_124px] md:gap-x-2">
                  <DecimalInput
                    aria-label={`Item ${i + 1} quantity`}
                    allow={isQtyText}
                    value={r.qty}
                    placeholder="Qty"
                    disabled={disabled}
                    enterKeyHint="next"
                    onKeyDown={onEnter(r.key)}
                    onChange={(v) => setRow(r.key, (x) => editQty(x, v, currency))}
                    onBlur={() => r.qty.trim() === '' && setRow(r.key, (x) => editQty(x, '1', currency))}
                    className={cn(box, 'text-right')}
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
                    enterKeyHint="next"
                    onKeyDown={onEnter(r.key)}
                    onChange={(v) => setRow(r.key, (x) => editEach(x, v, currency))}
                    className={cn(box, 'text-right')}
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
                    enterKeyHint="next"
                    onKeyDown={onEnter(r.key)}
                    onChange={(v) => setRow(r.key, (x) => editAmount(x, v, currency))}
                    className={cn(box, 'text-right font-semibold', warn && 'border-warn text-warn')}
                  />
                </div>
              </div>
              {r.details && <p className="pt-1.5 text-[14px] text-ink-2">with {r.details}</p>}
              {warn && (
                <p className="pt-1.5 text-[15px] font-semibold text-warn-ink">
                  Qty × each comes to <Money minor={warn.expected_cents} currency={currency} />. Check this line against the receipt.
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
      <SectionTitle>Charges &amp; discounts</SectionTitle>
      <ul aria-label="Charges and discounts" className="border-t-[1.5px] border-ink">
        {draft.charges.map((ch, i) => (
          <li key={ch.key} className="grid grid-cols-[minmax(0,1fr)_44px] items-center gap-x-1.5 gap-y-1 border-b border-rule pb-3 pt-2 md:grid-cols-[minmax(0,1fr)_88px_44px_124px_44px] md:gap-x-2 md:py-2">
            <NameBox
              ref={nav.register(ch.key)}
              aria-label={`Charge ${i + 1} name`}
              value={ch.name}
              placeholder={ch.negative ? 'Discount' : 'Service, GST…'}
              maxLength={120}
              disabled={disabled}
              onChange={(v) => setRow(ch.key, (x) => ({ ...x, name: v }))}
              onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
              className="font-semibold"
            />
            <button type="button" aria-label={`Remove ${ch.name || `charge ${i + 1}`}`} disabled={disabled} className={cn(removeBtn, 'md:order-last')} onClick={() => update((d) => ({ ...d, charges: d.charges.filter((x) => x.key !== ch.key) }))}>
              <Icon name="close" size={18} />
            </button>
            <div className="col-span-2 grid grid-cols-[88px_44px_minmax(0,1fr)] items-center gap-x-1.5 md:col-span-3 md:col-start-2 md:row-start-1 md:grid-cols-[88px_44px_124px] md:gap-x-2">
              <span className="relative">
                <DecimalInput
                  aria-label={`Charge ${i + 1} percent`}
                  allow={isPercentText}
                  value={ch.percent}
                  placeholder="0"
                  disabled={disabled}
                  onChange={(v) => setRow(ch.key, (x) => chargeFromPercent(x, v, base, currency))}
                  className={cn(box, 'pr-7 text-right')}
                />
                <span aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[15px] text-ink-2">
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
                  'grid h-11 w-11 place-items-center rounded-[var(--radius-control)] border text-[20px] font-bold leading-none',
                  ch.negative ? 'border-cobalt bg-cobalt-soft text-cobalt-ink' : 'border-ink-2 text-ink hover:bg-mist',
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
                className={cn(box, 'text-right font-semibold')}
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

/** The closing section: items, each charge, the printed subtotal (scans), and the total. */
export function TotalsList({
  draft,
  update,
  currency,
  validation,
  disabled,
  showSubtotal,
}: {
  draft: ReceiptDraft
  update: Update
  currency: string
  validation: ValidationOut | null
  disabled?: boolean
  /** the receipt's printed subtotal is only worth asking about for a photographed receipt */
  showSubtotal?: boolean
}) {
  const items = itemsTotal(draft.items, currency)
  const charges = chargesTotal(draft.charges, currency)
  const total = grandTotal(draft, currency)
  const codes = new Set(validation?.errors.map((e) => e.code))
  const itemsWarn = codes.has('items_subtotal_mismatch')
  const totalWarn = codes.has('grand_total_mismatch') || codes.has('items_grand_mismatch') || codes.has('no_scenario_matches')
  const sum = items + charges
  const shownCharges = draft.charges.filter((ch) => ch.name.trim() || chargeMinor(ch, currency) !== 0)

  return (
    <TotalsBlock
      currency={currency}
      lines={[
        { key: 'items', label: 'Items', minor: items, tone: itemsWarn ? 'warn' : undefined },
        ...(showSubtotal || draft.subtotal
          ? [
              {
                key: 'subtotal',
                label: <label htmlFor="rv-subtotal">Subtotal on receipt</label>,
                value: (
                  <MoneyInput id="rv-subtotal" currency={currency} value={draft.subtotal} placeholder="Not shown" disabled={disabled} onChange={(v) => update((d) => ({ ...d, subtotal: v }))} className={totalsInput} />
                ),
              },
            ]
          : []),
        ...shownCharges.map((ch) => ({
          key: ch.key,
          label: (
            <>
              {ch.name.trim() || (ch.negative ? 'Discount' : 'Charge')}
              {ch.percent && <span className="text-ink-2"> · {ch.percent}%</span>}
            </>
          ),
          minor: chargeMinor(ch, currency),
        })),
      ]}
      total={{
        label: <label htmlFor="rv-total">Total</label>,
        tone: totalWarn ? 'warn' : undefined,
        note:
          totalWarn && !draft.totalAuto && total !== sum ? (
            <Button variant="quiet" className="h-auto py-1 text-[15px]" disabled={disabled} onClick={() => update((d) => ({ ...d, totalAuto: true }))}>
              Use <Money minor={Math.max(0, sum)} currency={currency} />
            </Button>
          ) : undefined,
        value: (
          <MoneyInput
            id="rv-total"
            currency={currency}
            value={draft.totalAuto ? (sum > 0 ? formatInput(sum, currency) : '') : draft.total}
            placeholder="0"
            disabled={disabled}
            aria-invalid={totalWarn || undefined}
            onChange={(v) => update((d) => ({ ...d, total: v, totalAuto: false }))}
            className={cn(totalsInput, 'hero-num h-12 border-ink text-[24px]', totalWarn && 'border-warn text-warn')}
          />
        ),
      }}
    />
  )
}
