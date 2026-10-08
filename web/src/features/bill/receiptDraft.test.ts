import { describe, expect, it } from 'vitest'
import type { BillOut } from '@/lib/types'
import {
  chargeFromPercent,
  draftFromBill,
  draftToReceipt,
  editAmount,
  editEach,
  editQty,
  emptyCharge,
  emptyItem,
  grandTotal,
  isMoneyText,
  isQtyText,
  mergeSaved,
  normalizeMoney,
  refreshPercents,
  type ItemRow,
  type ReceiptDraft,
} from './receiptDraft'

const row = (over: Partial<ItemRow> = {}): ItemRow => ({ key: 'k', name: 'Laksa', qty: '1', each: '6.80', amount: '6.80', ...over })

describe('typing rules', () => {
  it('keeps half-typed money and quantities', () => {
    for (const ok of ['', '12', '12.', '12.50', '.5', '1,234.5']) expect(isMoneyText(ok)).toBe(true)
    for (const bad of ['12.5.0', 'abc', '-3', '1e5']) expect(isMoneyText(bad)).toBe(false)
    expect(isQtyText('0.125')).toBe(true)
    expect(isQtyText('0.1255')).toBe(false)
  })
  it('normalises on blur per currency', () => {
    expect(normalizeMoney('12.5', 'SGD')).toBe('12.50')
    expect(normalizeMoney('1,200', 'JPY')).toBe('1200')
    expect(normalizeMoney('3.1', 'KWD')).toBe('3.100')
    expect(normalizeMoney('', 'SGD')).toBe('')
  })
})

describe('qty × each = amount', () => {
  it('qty or each recompute the amount, leaving the typed field alone', () => {
    const r = editQty(row(), '3', 'SGD')
    expect(r).toMatchObject({ qty: '3', each: '6.80', amount: '20.40' })
    const e = editEach(row({ qty: '2' }), '5.5', 'SGD')
    expect(e).toMatchObject({ each: '5.5', amount: '11.00' })
  })
  it('fractional quantities round half-up', () => {
    expect(editQty(row({ each: '9.99' }), '0.5', 'SGD').amount).toBe('5.00') // 4.995 → 5.00
  })
  it('typing the amount works out each', () => {
    expect(editAmount(row({ qty: '3' }), '10', 'SGD')).toMatchObject({ amount: '10', each: '3.33' })
    expect(editAmount(row({ qty: '2' }), '1500', 'JPY').each).toBe('750')
  })
  it('a trailing dot or zero survives', () => {
    expect(editEach(row(), '6.', 'SGD').each).toBe('6.')
    expect(editEach(row(), '6.50', 'SGD').each).toBe('6.50')
  })
})

describe('charges', () => {
  it('a typed percentage drives the amount from the items', () => {
    const ch = chargeFromPercent(emptyCharge(), '10', 12140, 'SGD')
    expect(ch).toMatchObject({ amount: '12.14', percentTyped: true })
    const [again] = refreshPercents([ch], 20000, 'SGD')
    expect(again?.amount).toBe('20.00')
  })
  it('discounts are negative in the payload', () => {
    const d: ReceiptDraft = {
      merchant: '',
      date: '',
      items: [row({ amount: '10.00', each: '10.00' })],
      charges: [{ ...emptyCharge(true), name: 'Voucher', amount: '2' }],
      subtotal: '',
      total: '',
      totalAuto: true,
    }
    const { body } = draftToReceipt(d, 'SGD')
    expect(body.charges).toEqual([{ name: 'Voucher', amount_cents: -200 }])
    expect(body.grand_total_cents).toBe(800)
  })
})

describe('payload', () => {
  const draft: ReceiptDraft = {
    merchant: '  Ramen Kazu ',
    date: '2026-10-04',
    items: [row({ key: 'a', id: 'id-a' }), { ...emptyItem(), key: 'b', name: 'Gyoza', each: '14', amount: '14' }, { ...emptyItem(), key: 'c' }],
    charges: [],
    subtotal: '',
    total: '25.00',
    totalAuto: false,
  }

  it('skips unnamed rows, keeps ids and typed totals', () => {
    const p = draftToReceipt(draft, 'SGD')
    expect(p.itemKeys).toEqual(['a', 'b'])
    expect(p.body.items).toEqual([
      { id: 'id-a', name: 'Laksa', quantity: '1', unit_price_cents: 680, total_price_cents: 680 },
      { name: 'Gyoza', quantity: '1', unit_price_cents: 1400, total_price_cents: 1400 },
    ])
    expect(p.body.grand_total_cents).toBe(2500)
    expect(p.body.subtotal_cents).toBeNull()
    expect(p.body.merchant).toBe('Ramen Kazu')
    expect(grandTotal({ ...draft, totalAuto: true }, 'SGD')).toBe(2080)
  })

  it('maps new server ids back by sent position without touching typed values', () => {
    const sent = draftToReceipt(draft, 'SGD')
    const typedSince = { ...draft, items: draft.items.map((r) => (r.key === 'b' ? { ...r, name: 'Gyoza 6pc' } : r)) }
    const merged = mergeSaved(typedSince, sent, {
      items: [{ id: 'id-a' }, { id: 'id-b' }] as BillOut['items'],
      charges: [],
    })
    expect(merged.items.map((r) => r.id)).toEqual(['id-a', 'id-b', undefined])
    expect(merged.items[1]?.name).toBe('Gyoza 6pc')
  })
})

describe('draftFromBill', () => {
  it('reads minor units per currency and spots an auto total', () => {
    const bill = {
      currency: 'JPY',
      source: 'manual',
      merchant: null,
      bill_date: null,
      subtotal_cents: null,
      grand_total_cents: 1500,
      items: [{ id: 'x', name: 'Ramen', quantity: '1.000', unit_price_cents: 1500, total_price_cents: 1500 }],
      charges: [],
    } as unknown as BillOut
    const d = draftFromBill(bill)
    expect(d.items[0]).toMatchObject({ qty: '1', each: '1500', amount: '1500' })
    expect(d.totalAuto).toBe(true)
  })
})
