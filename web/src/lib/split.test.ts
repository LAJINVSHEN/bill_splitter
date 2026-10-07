import vectors from '@shared/split-vectors.json'
import { describe, expect, it } from 'vitest'
import { exponentOf, formatAmount, parseToMinor } from './money'
import { allocate, computeSplit, convertAllocation, type ItemIn, type SplitMode } from './split'

interface VectorShare {
  person: string
  weight?: string | number
  amount_cents?: number
}
interface VectorItem {
  id: string
  total_cents: number
  mode: SplitMode | null
  shares?: VectorShare[]
}
interface SplitCase {
  id: string
  input: { participants: string[]; items: VectorItem[]; grand_total_cents: number }
  expected: {
    items_cents: Record<string, number>
    totals_cents: Record<string, number>
    item_allocations: Record<string, Record<string, number>>
    unassigned_item_ids: string[]
    issue_codes: string[]
    is_complete: boolean
  }
}
interface ConversionCase {
  id: string
  input: { currency: string; settle_currency: string; fx_rate: string; grand_total_cents: number; totals_cents: number[] }
  expected: { settle_grand_total_cents: number; settle_totals_cents: number[] }
}
interface MinorUnitCase {
  amount: string
  currency: string
  exponent: number
  expected_cents: number
}

const splitCases = vectors.split_cases as unknown as SplitCase[]
const conversionCases = vectors.conversion_cases as unknown as ConversionCase[]
const minorCases = vectors.minor_unit_cases as unknown as MinorUnitCase[]

describe('split mirror matches shared/split-vectors.json', () => {
  it.each(splitCases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const items: ItemIn[] = c.input.items.map((i) => ({
      id: i.id,
      total_cents: i.total_cents,
      mode: i.mode,
      shares: (i.shares ?? []).map((s) => ({ person_id: s.person, weight: s.weight ?? null, amount_cents: s.amount_cents ?? null })),
    }))
    const r = computeSplit({ participants: c.input.participants, items, grand_total_cents: c.input.grand_total_cents })

    expect(Object.fromEntries(r.people.map((p) => [p.person_id, p.items_cents]))).toEqual(c.expected.items_cents)
    expect(Object.fromEntries(r.people.map((p) => [p.person_id, p.total_cents]))).toEqual(c.expected.totals_cents)
    expect(r.item_allocations).toEqual(c.expected.item_allocations)
    expect(r.unassigned_item_ids).toEqual(c.expected.unassigned_item_ids)
    expect(r.issues.map((i) => i.code).sort()).toEqual([...c.expected.issue_codes].sort())
    expect(r.is_complete).toBe(c.expected.is_complete)
    if (r.people.length) {
      expect(r.people.reduce((a, p) => a + p.total_cents, 0)).toBe(c.input.grand_total_cents)
    }
  })
})

describe('conversion matches shared vectors', () => {
  it.each(conversionCases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const out = convertAllocation(
      c.input.grand_total_cents,
      c.input.totals_cents,
      c.input.fx_rate,
      exponentOf(c.input.currency),
      exponentOf(c.input.settle_currency),
    )
    expect(out.total).toBe(c.expected.settle_grand_total_cents)
    expect(out.shares).toEqual(c.expected.settle_totals_cents)
  })
})

describe('minor units', () => {
  it.each(minorCases.map((c) => [`${c.amount} ${c.currency}`, c] as const))('%s', (_label, c) => {
    expect(exponentOf(c.currency)).toBe(c.exponent)
    expect(parseToMinor(c.amount, c.currency)).toBe(c.expected_cents)
  })

  it('formats per currency exponent', () => {
    expect(formatAmount(123456, 'SGD')).toBe('1,234.56')
    expect(formatAmount(14820, 'JPY')).toBe('14,820')
    expect(formatAmount(1234, 'KWD')).toBe('1.234')
    expect(formatAmount(-5, 'SGD')).toBe('-0.05')
  })

  it('allocate never drifts on many-way splits', () => {
    const shares = allocate(10000, [1, 1, 1, 1, 1, 1, 1])
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10000)
  })
})
