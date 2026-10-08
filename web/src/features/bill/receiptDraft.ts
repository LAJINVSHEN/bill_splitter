/**
 * The Review editor's draft: what the person is typing, as strings, so "12.50" keeps its zero and
 * "12." survives a keystroke. Pure functions; the page keeps one draft and autosaves it.
 */
import type { ReceiptIn } from '@/data/queries'
import { parseDecimal, roundHalfUp } from '@/lib/decimal'
import { exponentOf, minorToInput, parseToMinor } from '@/lib/money'
import type { BillOut, UUID } from '@/lib/types'

export interface ItemRow {
  key: string
  id?: UUID
  name: string
  /** folded component lines, shown read-only; the server keeps them while the item exists */
  details?: string
  qty: string
  each: string
  amount: string
}

export interface ChargeRow {
  key: string
  name: string
  /** magnitude as typed; the sign lives in `negative` (phone keypads have no minus key) */
  amount: string
  negative: boolean
  percent: string
  /** the person typed the percentage, so the amount follows it */
  percentTyped: boolean
}

export interface ReceiptDraft {
  merchant: string
  date: string
  items: ItemRow[]
  charges: ChargeRow[]
  subtotal: string
  total: string
  /** the total follows items + charges until someone types one */
  totalAuto: boolean
}

let seq = 0
export const newKey = (prefix = 'r') => `${prefix}${++seq}-${Math.random().toString(36).slice(2, 7)}`

export const trimDecimal = (d: string | null | undefined) => {
  if (!d) return ''
  return d.includes('.') ? d.replace(/0+$/, '').replace(/\.$/, '') : d
}

export function draftFromBill(bill: BillOut): ReceiptDraft {
  const c = bill.currency
  const items: ItemRow[] = bill.items.map((it) => ({
    key: it.id,
    id: it.id,
    name: it.name,
    details: it.details ?? undefined,
    qty: trimDecimal(it.quantity) || '1',
    each: minorToInput(it.unit_price_cents, c),
    amount: minorToInput(it.total_price_cents, c),
  }))
  const charges: ChargeRow[] = bill.charges.map((ch) => ({
    key: newKey('c'),
    name: ch.name,
    amount: minorToInput(Math.abs(ch.amount_cents), c),
    negative: ch.amount_cents < 0,
    percent: trimDecimal(ch.percent),
    percentTyped: false,
  }))
  const sum = bill.items.reduce((a, i) => a + i.total_price_cents, 0) + bill.charges.reduce((a, ch) => a + ch.amount_cents, 0)
  const totalAuto = bill.grand_total_cents === null || (bill.source !== 'scan' && bill.grand_total_cents === sum)
  return {
    merchant: bill.merchant ?? '',
    date: bill.bill_date ?? '',
    items,
    charges,
    subtotal: bill.subtotal_cents ? minorToInput(bill.subtotal_cents, c) : '',
    total: bill.grand_total_cents === null ? '' : minorToInput(bill.grand_total_cents, c),
    totalAuto,
  }
}

export const emptyItem = (): ItemRow => ({ key: newKey('i'), name: '', qty: '1', each: '', amount: '' })
export const emptyCharge = (negative = false): ChargeRow => ({ key: newKey('c'), name: '', amount: '', negative, percent: '', percentTyped: false })

// ---- what may be typed ----------------------------------------------------------------------------

/** Money while typing: digits, grouping commas, one dot. Empty is fine. */
export const isMoneyText = (t: string) => /^[\d,]*(\.\d*)?$/.test(t.trim())
/** Quantity while typing: up to 3 decimals (the API's limit). */
export const isQtyText = (t: string) => /^\d*(\.\d{0,3})?$/.test(t.trim())
export const isPercentText = (t: string) => /^\d*(\.\d{0,2})?$/.test(t.trim())

/** "12.5" → "12.50" on blur; junk or empty stays as typed. */
export function normalizeMoney(text: string, currency: string): string {
  if (text.trim() === '') return ''
  const minor = parseToMinor(text, currency)
  return minor === null ? text : minorToInput(minor, currency)
}

const minorOf = (text: string, currency: string) => (text.trim() === '' ? 0 : parseToMinor(text, currency))

function qtyRational(qty: string) {
  try {
    const r = parseDecimal(qty.trim() === '' ? '1' : qty)
    return r.num > 0n ? r : null
  } catch {
    return null
  }
}

// ---- qty × each = amount, kept consistent the way the old editor did ----------------------------

export function editQty(row: ItemRow, qty: string, currency: string): ItemRow {
  const q = qtyRational(qty)
  const each = minorOf(row.each, currency)
  if (!q || each === null || row.each.trim() === '') return { ...row, qty }
  return { ...row, qty, amount: minorToInput(roundHalfUp(q.num * BigInt(each), q.den), currency) }
}

export function editEach(row: ItemRow, each: string, currency: string): ItemRow {
  const q = qtyRational(row.qty)
  const e = minorOf(each, currency)
  if (!q || e === null) return { ...row, each }
  if (each.trim() === '') return { ...row, each, amount: '' }
  return { ...row, each, amount: minorToInput(roundHalfUp(q.num * BigInt(e), q.den), currency) }
}

/** Typing the line amount works out the price each (rounded), so the row stays consistent. */
export function editAmount(row: ItemRow, amount: string, currency: string): ItemRow {
  const q = qtyRational(row.qty)
  const a = minorOf(amount, currency)
  if (!q || a === null) return { ...row, amount }
  if (amount.trim() === '') return { ...row, amount, each: '' }
  return { ...row, amount, each: minorToInput(roundHalfUp(BigInt(a) * q.den, q.num), currency) }
}

// ---- totals ----------------------------------------------------------------------------------------

export const itemsTotal = (items: ItemRow[], currency: string) => items.reduce((a, r) => a + (minorOf(r.amount, currency) ?? 0), 0)

export const chargeMinor = (ch: ChargeRow, currency: string) => (minorOf(ch.amount, currency) ?? 0) * (ch.negative ? -1 : 1)

export const chargesTotal = (charges: ChargeRow[], currency: string) => charges.reduce((a, ch) => a + chargeMinor(ch, currency), 0)

export function grandTotal(d: ReceiptDraft, currency: string): number {
  if (d.totalAuto) return Math.max(0, itemsTotal(d.items, currency) + chargesTotal(d.charges, currency))
  return minorOf(d.total, currency) ?? 0
}

/** A charge typed as a percentage of the items: amount = items × pct / 100, half-up. */
export function chargeFromPercent(row: ChargeRow, percent: string, base: number, currency: string): ChargeRow {
  if (percent.trim() === '') return { ...row, percent, percentTyped: false }
  let amount = row.amount
  try {
    const p = parseDecimal(percent)
    amount = minorToInput(Math.abs(roundHalfUp(BigInt(base) * p.num, p.den * 100n)), currency)
  } catch {
    /* half-typed ("."): leave the amount */
  }
  return { ...row, percent, percentTyped: true, amount }
}

/** Re-apply typed percentages when the items change (e.g. service 10% follows the subtotal). */
export function refreshPercents(charges: ChargeRow[], base: number, currency: string): ChargeRow[] {
  return charges.map((ch) => (ch.percentTyped ? chargeFromPercent(ch, ch.percent, base, currency) : ch))
}

// ---- to the API ------------------------------------------------------------------------------------

export interface DraftPayload {
  body: ReceiptIn
  /** item row keys in the order sent, to map new server ids back onto rows */
  itemKeys: string[]
  chargeKeys: string[]
}

export function draftToReceipt(d: ReceiptDraft, currency: string): DraftPayload {
  const rows = d.items.filter((r) => r.name.trim() !== '')
  const charges = d.charges.filter((ch) => ch.name.trim() !== '' || (minorOf(ch.amount, currency) ?? 0) !== 0)
  const subtotal = minorOf(d.subtotal, currency)
  return {
    itemKeys: rows.map((r) => r.key),
    chargeKeys: charges.map((ch) => ch.key),
    body: {
      items: rows.map((r) => {
        const q = qtyRational(r.qty)
        return {
          ...(r.id ? { id: r.id } : {}),
          name: r.name.trim(),
          quantity: q && isQtyText(r.qty) && r.qty.trim() !== '' ? r.qty.trim() : '1',
          unit_price_cents: minorOf(r.each, currency) ?? 0,
          total_price_cents: minorOf(r.amount, currency) ?? 0,
        }
      }),
      charges: charges.map((ch) => ({ name: ch.name.trim() || (ch.negative ? 'Discount' : 'Charge'), amount_cents: chargeMinor(ch, currency) })),
      subtotal_cents: subtotal ? subtotal : null,
      grand_total_cents: grandTotal(d, currency),
      merchant: d.merchant.trim() || null,
      bill_date: d.date || null,
    },
  }
}

/**
 * Merge a save response into the draft without touching what the person is typing:
 * new item ids by sent position, and server-derived percentages for charges nobody typed a % into.
 */
export function mergeSaved(d: ReceiptDraft, sent: DraftPayload, bill: Pick<BillOut, 'items' | 'charges'>): ReceiptDraft {
  const idByKey = new Map(sent.itemKeys.map((k, i) => [k, bill.items[i]?.id]))
  const pctByKey = new Map(sent.chargeKeys.map((k, i) => [k, bill.charges[i]?.percent ?? null]))
  return {
    ...d,
    items: d.items.map((r) => (!r.id && idByKey.get(r.key) ? { ...r, id: idByKey.get(r.key) } : r)),
    charges: d.charges.map((ch) => (!ch.percentTyped && pctByKey.has(ch.key) ? { ...ch, percent: trimDecimal(pctByKey.get(ch.key)) } : ch)),
  }
}

export const isZeroDecimals = (currency: string) => exponentOf(currency) === 0
