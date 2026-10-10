import { describe, expect, it } from 'vitest'
import type { BillOut, SplitPersonOut } from '@/lib/types'
import { buildShareMessage, linkWithFragment } from './message'

const person = (over: Partial<SplitPersonOut> & Pick<SplitPersonOut, 'person_id' | 'name'>): SplitPersonOut => ({
  color_seed: 100,
  is_self: false,
  is_payer: false,
  items_cents: 0,
  adjustment_cents: 0,
  total_cents: 0,
  settle_total_cents: null,
  effective_total_cents: 0,
  items: [],
  settled_at: null,
  settled_amount_cents: null,
  outstanding_cents: 0,
  ...over,
})

function bill(people: SplitPersonOut[], over: Partial<BillOut> = {}, split: Partial<BillOut['split']> = {}): BillOut {
  return {
    id: 'b1',
    title: 'Saturday hotpot',
    merchant: null,
    bill_date: '2026-10-04',
    currency: 'SGD',
    items: [
      { id: 'i1', name: 'Wagyu set', split_mode: 'single', shares: [{ person_id: 'maya' }] },
      { id: 'i2', name: 'Fish balls', split_mode: 'equal', shares: [{ person_id: 'maya' }, { person_id: 'lena' }] },
    ],
    claims: [],
    split: {
      currency: 'SGD',
      settle_currency: null,
      fx_rate: null,
      effective_currency: 'SGD',
      grand_total_cents: 18640,
      settle_grand_total_cents: null,
      people,
      ...split,
    },
    ...over,
  } as unknown as BillOut
}

const george = person({ person_id: 'me', name: 'George', is_self: true, is_payer: true, effective_total_cents: 2340, total_cents: 2340 })
const maya = person({
  person_id: 'maya',
  name: 'Maya Lim',
  effective_total_cents: 4210,
  total_cents: 4210,
  outstanding_cents: 4210,
  adjustment_cents: 410,
  items: [
    { item_id: 'i1', name: 'Wagyu set', share_cents: 3200 },
    { item_id: 'i2', name: 'Fish balls', share_cents: 600 },
  ],
})
const arjun = person({ person_id: 'arjun', name: 'Arjun', effective_total_cents: 3860, total_cents: 3860, outstanding_cents: 1860, settled_amount_cents: 2000 })
const tomas = person({ person_id: 'tomas', name: 'Tomas', effective_total_cents: 3100, total_cents: 3100, outstanding_cents: 0, settled_amount_cents: 3100 })
const lena = person({ person_id: 'lena', name: 'Lena', effective_total_cents: 5130, total_cents: 5130, outstanding_cents: 5130 })

describe('group message', () => {
  it('lists who owes first, then the paid, then the payer, with how to pay and the link last', () => {
    const b = bill([george, tomas, maya, arjun, lena], { claims: [{ person_id: 'lena' } as never] })
    const text = buildShareMessage({ bill: b, hostName: 'George', paymentNote: 'PayNow 9123 4567', scope: { kind: 'group' }, url: 'https://x.dev/s/T#g' })
    expect(text).toBe(
      [
        'Saturday hotpot · Sun 4 Oct',
        'Total SGD 186.40, paid by George',
        '',
        'Maya Lim  SGD 42.10',
        'Arjun  SGD 38.60 (SGD 18.60 left)',
        'Lena  SGD 51.30 (says paid)',
        'Tomas  SGD 31.00 (paid)',
        'George  SGD 23.40 (paid the bill)',
        '',
        'Pay George: PayNow 9123 4567',
        'Find your name to see your items and tap "I’ve paid":',
        'https://x.dev/s/T#g',
      ].join('\n'),
    )
    expect(text).not.toMatch(/[*_~]/) // no chat markup
  })

  it('says to pay a friend directly when they paid, and never calls the owner "Me"', () => {
    const payer = { ...arjun, is_payer: true, outstanding_cents: 0 }
    const me = { ...george, is_payer: false, outstanding_cents: 2340 }
    const text = buildShareMessage({ bill: bill([me, payer]), hostName: 'George Tan', paymentNote: 'PayNow 1', scope: { kind: 'group' }, url: 'u' })
    expect(text).toContain('paid by Arjun')
    expect(text).toContain('George Tan  SGD 23.40')
    expect(text).toContain('Pay Arjun back directly.')
    expect(text).not.toContain('PayNow')
  })
})

describe('one person', () => {
  it('greets by first name, lists items with fractions and the tax line', () => {
    const text = buildShareMessage({ bill: bill([george, maya]), hostName: 'George', paymentNote: 'PayNow 9123 4567', scope: { kind: 'person', personId: 'maya' }, url: 'https://x.dev/s/P#p.4210.SGD' })
    expect(text).toBe(
      [
        'Hi Maya, your share of Saturday hotpot (Sun 4 Oct) is SGD 42.10',
        '',
        '- Wagyu set SGD 32.00',
        '- Fish balls ½ SGD 6.00',
        '- Tax and service SGD 4.10',
        '',
        'Pay George: PayNow 9123 4567',
        'When you’ve paid, tap here so George knows:',
        'https://x.dev/s/P#p.4210.SGD',
      ].join('\n'),
    )
  })

  it('shows the original currency for a converted bill and caps the item lines', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ item_id: `x${i}`, name: `Dish ${i + 1}`, share_cents: 100 * (i + 1) }))
    const lena2 = { ...lena, total_cents: 2880, effective_total_cents: 2621, outstanding_cents: 2621, settle_total_cents: 2621, items }
    const b = bill([george, lena2], { currency: 'JPY' }, { currency: 'JPY', settle_currency: 'SGD', fx_rate: '0.00910000', effective_currency: 'SGD' })
    const text = buildShareMessage({ bill: b, hostName: 'George', scope: { kind: 'person', personId: 'lena' }, url: 'u' })
    expect(text.split('\n')[0]).toBe('Hi Lena, your share of Saturday hotpot (Sun 4 Oct) is SGD 26.21 (JPY 2,880)')
    expect(text).toContain('- Dish 6 JPY 600')
    expect(text).not.toContain('Dish 7')
    expect(text).toContain('- and 2 more')
    expect(text).not.toContain('Pay George') // no note set
  })

  it('skips the made-up item line for a quick split', () => {
    const b = bill([george, { ...maya, adjustment_cents: 0 }], { source: 'quick' })
    const text = buildShareMessage({ bill: b, hostName: 'George', scope: { kind: 'person', personId: 'maya' }, url: 'u' })
    expect(text).toBe(['Hi Maya, your share of Saturday hotpot (Sun 4 Oct) is SGD 42.10', '', 'When you’ve paid, tap here so George knows:', 'u'].join('\n'))
  })

  it('puts what they still owe in the link fragment', () => {
    expect(linkWithFragment('u', { kind: 'person', personId: 'arjun' }, bill([george, arjun]))).toBe('u#p.1860.SGD')
    expect(linkWithFragment('u', { kind: 'group' }, bill([george]))).toBe('u#g')
  })
})
