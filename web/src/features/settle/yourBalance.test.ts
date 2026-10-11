import { describe, expect, it } from 'vitest'
import type { BillOut, SplitPersonOut } from '@/lib/types'
import { billPosition } from './YourBalance'

const person = (name: string, o: Partial<SplitPersonOut> = {}): SplitPersonOut => ({
  person_id: name, name, color_seed: 200, is_self: false, is_payer: false, items_cents: 0, adjustment_cents: 0,
  total_cents: 1000, settle_total_cents: null, effective_total_cents: 1000, items: [], settled_at: null,
  settled_amount_cents: null, outstanding_cents: 1000, ...o,
})
const bill = (people: SplitPersonOut[]) => ({ split: { people, effective_currency: 'SGD' } }) as unknown as Pick<BillOut, 'split'>
const me = (o: Partial<SplitPersonOut> = {}) => person('Maya Lim', { is_self: true, ...o })

describe('what a bill means for you', () => {
  it('you paid: what is still owed to you, and by how many', () => {
    const pos = billPosition(bill([me({ is_payer: true, outstanding_cents: 0 }), person('Ben'), person('Dev', { outstanding_cents: 0 })]))
    expect(pos).toEqual({ kind: 'owed', label: 'You’re owed', amount: 1000, currency: 'SGD', note: '1 of 2 still owe' })
    expect(billPosition(bill([me({ is_payer: true, outstanding_cents: 0 }), person('Ben', { outstanding_cents: 0 })]))?.label).toBe('Everyone’s paid you back')
  })

  it('someone else paid: what you owe them, by first name', () => {
    const payer = person('Ben Tan', { is_payer: true, outstanding_cents: 0 })
    expect(billPosition(bill([payer, me({ outstanding_cents: 400 })]))).toEqual({ kind: 'owe', label: 'You owe Ben', amount: 400, currency: 'SGD', note: null })
    expect(billPosition(bill([payer, me({ outstanding_cents: 0 })]))?.label).toBe('You’re even with Ben')
  })

  it('says nothing when you are not on the bill', () => {
    expect(billPosition(bill([person('Ben', { is_payer: true }), person('Dev')]))).toBeNull()
  })
})
