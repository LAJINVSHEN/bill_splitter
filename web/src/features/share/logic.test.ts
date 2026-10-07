import { describe, expect, it } from 'vitest'
import type { PublicPerson } from '@/lib/types'
import { billFractions, effectiveTotal, firstName, fractionLabel, isConverted } from './logic'

const person = (name: string, items: Array<[string, number]>, extra: Partial<PublicPerson> = {}): PublicPerson => ({
  name,
  is_payer: false,
  items: items.map(([n, c]) => ({ name: n, share_cents: c })),
  items_cents: 0,
  adjustment_cents: 0,
  total_cents: 100,
  settle_total_cents: null,
  settled: false,
  outstanding_cents: 100,
  ...extra,
})

describe('fractionLabel', () => {
  it('uses glyphs where they exist', () => {
    expect(fractionLabel(1, 2)).toBe('½')
    expect(fractionLabel(2, 4)).toBe('½')
    expect(fractionLabel(1, 5)).toBe('⅕')
    expect(fractionLabel(2, 7)).toBe('2/7')
  })
  it('labels nothing for whole shares', () => {
    expect(fractionLabel(1, 1)).toBe('')
    expect(fractionLabel(0, 3)).toBe('')
  })
})

describe('billFractions', () => {
  it('labels near-equal splits and skips solo or unequal items', () => {
    const people = [
      person('A', [['Edamame', 334], ['Ramen', 1450], ['Beer', 900]]),
      person('B', [['Edamame', 333], ['Ramen', 1450], ['Beer', 300]]),
      person('C', [['Edamame', 333], ['Highball', 870]]),
    ]
    const f = billFractions(people)
    expect(f.get('Edamame')).toBe('⅓')
    expect(f.get('Ramen')).toBe('½')
    expect(f.has('Beer')).toBe(false)
    expect(f.has('Highball')).toBe(false)
  })
  it('skips names repeated for one person', () => {
    const f = billFractions([person('A', [['Tea', 100], ['Tea', 100]]), person('B', [['Tea', 100]])])
    expect(f.has('Tea')).toBe(false)
  })
})

describe('amounts', () => {
  it('uses the settle total when converted', () => {
    const p = person('A', [], { total_cents: 2880, settle_total_cents: 2575 })
    expect(effectiveTotal({ settle_currency: 'SGD' }, p)).toBe(2575)
    expect(effectiveTotal({ settle_currency: null }, p)).toBe(2880)
    expect(isConverted({ settle_currency: 'SGD', fx_rate: '0.00894' })).toBe(true)
    expect(isConverted({ settle_currency: null, fx_rate: null })).toBe(false)
    expect(firstName(' Lena Okafor ')).toBe('Lena')
  })
})
