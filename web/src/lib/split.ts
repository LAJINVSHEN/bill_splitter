/**
 * PURE mirror of backend/app/core/split.py + money.allocate/convert_allocation.
 * Used for instant previews while a mutation is in flight; the server's `split` stays the source of truth.
 * Parity is enforced by shared/split-vectors.json (split.test.ts).
 */
import { parseDecimal, roundHalfUp, type Rational } from './decimal'

export type SplitMode = 'single' | 'equal' | 'weighted' | 'custom'

export interface ShareIn {
  person_id: string
  weight?: string | number | null
  amount_cents?: number | null
}

export interface ItemIn {
  id: string
  total_cents: number
  mode: SplitMode | null
  shares: ShareIn[]
}

export interface SplitIn {
  participants: string[]
  items: ItemIn[]
  grand_total_cents: number
}

export interface SplitIssue {
  code: string
  item_id?: string
  person_id?: string
  expected_cents?: number
  actual_cents?: number
}

export interface PersonSplit {
  person_id: string
  items_cents: number
  total_cents: number
  item_shares: Array<[itemId: string, cents: number]>
}

export interface SplitResult {
  grand_total_cents: number
  all_items_cents: number
  assigned_items_cents: number
  people: PersonSplit[]
  item_allocations: Record<string, Record<string, number>>
  unassigned_item_ids: string[]
  issues: SplitIssue[]
  is_complete: boolean
}

/** Proportional split of `total` by `weights`; always sums exactly to `total`. */
export function allocate(total: number, weights: ReadonlyArray<string | number | Rational>): number[] {
  const n = weights.length
  if (n === 0) return []
  const rationals = weights.map((w) => (typeof w === 'object' ? w : parseDecimal(w)))
  // bring every weight onto a common denominator so they can be summed exactly
  const den = rationals.reduce((acc, r) => (acc % r.den === 0n ? acc : acc * r.den), 1n)
  const scaled = rationals.map((r) => (r.num * den) / r.den)
  const sum = scaled.reduce((a, b) => a + b, 0n)
  const shares = sum === 0n ? new Array<number>(n).fill(0) : scaled.map((w) => roundHalfUp(BigInt(total) * w, sum))
  const remainder = total - shares.reduce((a, b) => a + b, 0)
  if (remainder !== 0) {
    let largest = 0
    for (let i = 1; i < n; i++) if ((shares[i] as number) > (shares[largest] as number)) largest = i
    shares[largest] = (shares[largest] as number) + remainder
  }
  return shares
}

function positiveWeight(w: ShareIn['weight']): Rational {
  if (w === null || w === undefined || w === '') return { num: 0n, den: 1n }
  const r = parseDecimal(w)
  return r.num > 0n ? r : { num: 0n, den: 1n }
}

function allocateItem(item: ItemIn, participants: Set<string>, issues: SplitIssue[]): Record<string, number> | null {
  const shares = item.shares.filter((s) => participants.has(s.person_id))
  for (const s of item.shares) {
    if (!participants.has(s.person_id)) issues.push({ code: 'share_not_participant', item_id: item.id, person_id: s.person_id })
  }
  if (!item.mode || shares.length === 0) return null

  const out: Record<string, number> = {}
  switch (item.mode) {
    case 'single': {
      if (shares.length > 1) issues.push({ code: 'single_has_many_shares', item_id: item.id })
      out[(shares[0] as ShareIn).person_id] = item.total_cents
      return out
    }
    case 'equal': {
      const amounts = allocate(item.total_cents, shares.map(() => 1))
      shares.forEach((s, i) => (out[s.person_id] = amounts[i] as number))
      return out
    }
    case 'weighted': {
      const weights = shares.map((s) => positiveWeight(s.weight))
      if (weights.every((w) => w.num === 0n)) {
        issues.push({ code: 'zero_weights', item_id: item.id })
        return null
      }
      const amounts = allocate(item.total_cents, weights)
      shares.forEach((s, i) => (out[s.person_id] = amounts[i] as number))
      return out
    }
    case 'custom': {
      let actual = 0
      for (const s of shares) {
        const cents = Math.trunc(s.amount_cents ?? 0)
        out[s.person_id] = cents
        actual += cents
      }
      if (actual !== item.total_cents) {
        issues.push({ code: 'custom_amounts_mismatch', item_id: item.id, expected_cents: item.total_cents, actual_cents: actual })
      }
      return out
    }
    default:
      issues.push({ code: 'unknown_mode', item_id: item.id })
      return null
  }
}

export function computeSplit(input: SplitIn): SplitResult {
  const participants = [...new Set(input.participants)]
  const pset = new Set(participants)
  const issues: SplitIssue[] = []
  const itemsCents = new Map(participants.map((p) => [p, 0]))
  const perPerson = new Map<string, Array<[string, number]>>(participants.map((p) => [p, []]))
  const allocations: Record<string, Record<string, number>> = {}
  const unassigned: string[] = []

  for (const item of input.items) {
    const alloc = allocateItem(item, pset, issues)
    if (!alloc) {
      unassigned.push(item.id)
      continue
    }
    allocations[item.id] = alloc
    for (const [pid, cents] of Object.entries(alloc)) {
      itemsCents.set(pid, (itemsCents.get(pid) ?? 0) + cents)
      perPerson.get(pid)?.push([item.id, cents])
    }
  }

  if (participants.length === 0) issues.push({ code: 'no_participants' })
  const subtotals = participants.map((p) => itemsCents.get(p) ?? 0)
  const assigned = subtotals.reduce((a, b) => a + b, 0)
  if (participants.length > 0 && assigned === 0 && input.grand_total_cents !== 0) {
    issues.push({ code: 'zero_items_subtotal' })
  }
  const totals = allocate(input.grand_total_cents, subtotals)
  for (const id of unassigned) issues.push({ code: 'unassigned_item', item_id: id })

  const people = participants.map((p, i) => ({
    person_id: p,
    items_cents: itemsCents.get(p) ?? 0,
    total_cents: totals[i] as number,
    item_shares: perPerson.get(p) ?? [],
  }))

  return {
    grand_total_cents: input.grand_total_cents,
    all_items_cents: input.items.reduce((a, i) => a + i.total_cents, 0),
    assigned_items_cents: assigned,
    people,
    item_allocations: allocations,
    unassigned_item_ids: unassigned,
    issues,
    is_complete: people.length > 0 && unassigned.length === 0 && issues.length === 0,
  }
}

/** ROUND_HALF_UP(amount × rate × 10^(toExp − fromExp)); rate = units of TO per 1 unit of FROM. */
export function convertMinor(amount: number, rate: string, fromExp: number, toExp: number): number {
  const r = parseDecimal(rate)
  const shift = toExp - fromExp
  const num = BigInt(amount) * r.num * (shift > 0 ? 10n ** BigInt(shift) : 1n)
  const den = r.den * (shift < 0 ? 10n ** BigInt(-shift) : 1n)
  return roundHalfUp(num, den)
}

/** Converted grand total, then allocated over the bill-currency shares so it sums exactly. */
export function convertAllocation(
  grandTotal: number,
  shares: number[],
  rate: string,
  fromExp: number,
  toExp: number,
): { total: number; shares: number[] } {
  const total = convertMinor(grandTotal, rate, fromExp, toExp)
  return { total, shares: allocate(total, shares) }
}
