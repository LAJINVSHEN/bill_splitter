/**
 * Pure assignment logic for the Assign step: person-first painting, the split dialog's maths,
 * and the optimistic preview. No React, no I/O; the server stays the source of truth.
 */
import type { AssignmentIn } from '@/data/queries'
import { parseDecimal } from '@/lib/decimal'
import { allocate, computeSplit, type SplitResult } from '@/lib/split'
import type { BillOut, ItemOut, ParticipantOut, ShareOut, SplitMode, UUID } from '@/lib/types'

export interface Assign {
  mode: SplitMode | null
  shares: AssignmentIn['shares']
}

const NONE: Assign = { mode: null, shares: [] }

export const sharerIds = (item: Pick<ItemOut, 'shares'>): UUID[] => item.shares.map((s) => s.person_id)

const single = (personId: UUID): Assign => ({ mode: 'single', shares: [{ person_id: personId }] })
const equal = (ids: UUID[]): Assign =>
  ids.length === 0 ? NONE : ids.length === 1 ? single(ids[0] as UUID) : { mode: 'equal', shares: ids.map((person_id) => ({ person_id })) }

/**
 * Tap an item while painting for `personId`:
 * nobody → single(p); single(q) → equal[q, p]; single(p) → nobody;
 * equal with p → drop p (one left → single, none → nobody); equal without p → add p;
 * weighted/custom → 'dialog' (a tap can't safely edit amounts or shares).
 */
export function toggleItem(item: Pick<ItemOut, 'split_mode' | 'shares'>, personId: UUID): Assign | 'dialog' {
  const ids = sharerIds(item)
  const mode = ids.length === 0 ? null : item.split_mode
  switch (mode) {
    case null:
      return single(personId)
    case 'single':
      return ids.includes(personId) ? NONE : equal([...ids, personId])
    case 'equal':
      return ids.includes(personId) ? equal(ids.filter((id) => id !== personId)) : equal([...ids, personId])
    default:
      return 'dialog'
  }
}

/** "Share with everyone": equal over all participants, in bill order. */
export const shareWithEveryone = (participantIds: UUID[]): Assign => equal(participantIds)

export const toInput = (itemId: UUID, a: Assign): AssignmentIn => ({ item_id: itemId, mode: a.mode, shares: a.shares })

/** The item as the server would return it after this assignment. */
export function applyToItem(item: ItemOut, a: Assign): ItemOut {
  const shares: ShareOut[] = a.shares.map((s) => ({
    person_id: s.person_id,
    weight: a.mode === 'equal' || a.mode === 'single' ? '1' : a.mode === 'weighted' ? String(s.weight ?? '0') : null,
    amount_cents: a.mode === 'custom' ? (s.amount_cents ?? 0) : null,
  }))
  return { ...item, split_mode: a.mode, shares }
}

/** Optimistic bill: assignments applied to the items; `split` is left for the server to replace. */
export function applyAssignments(bill: BillOut, list: AssignmentIn[]): BillOut {
  if (list.length === 0) return bill
  const byItem = new Map(list.map((a) => [a.item_id, a]))
  return {
    ...bill,
    items: bill.items.map((it) => {
      const a = byItem.get(it.id)
      return a ? applyToItem(it, { mode: a.mode, shares: a.shares }) : it
    }),
  }
}

/** Instant preview with the TS mirror of the backend split. */
export function previewSplit(bill: Pick<BillOut, 'items' | 'participants' | 'grand_total_cents'>): SplitResult {
  return computeSplit({
    participants: bill.participants.map((p) => p.person_id),
    grand_total_cents: bill.grand_total_cents ?? bill.items.reduce((a, i) => a + i.total_price_cents, 0),
    items: bill.items.map((it) => ({
      id: it.id,
      total_cents: it.total_price_cents,
      mode: it.shares.length ? it.split_mode : null,
      shares: it.shares.map((s) => ({ person_id: s.person_id, weight: s.weight, amount_cents: s.amount_cents })),
    })),
  })
}

/** How many items each person is on (for the person tabs). */
export function itemCounts(items: Pick<ItemOut, 'shares'>[]): Map<UUID, number> {
  const out = new Map<UUID, number>()
  for (const it of items) for (const s of it.shares) out.set(s.person_id, (out.get(s.person_id) ?? 0) + 1)
  return out
}

/**
 * What someone owes "so far": their items, plus their proportional cut of charges, measured against
 * the whole receipt so it doesn't balloon while most items are still unassigned. Exact once complete.
 */
export function soFar(itemsCents: number, allItemsCents: number, grandTotalCents: number): number {
  if (allItemsCents === 0) return 0
  const [mine] = allocate(grandTotalCents, [itemsCents, allItemsCents - itemsCents].map((n) => Math.max(0, n)))
  return mine ?? 0
}

/** Quantity vs people sharing (the old app's nudge): "2 ordered · 3 sharing". Null when it lines up. */
export function quantityMismatch(item: Pick<ItemOut, 'quantity' | 'shares'>): { ordered: number; sharing: number } | null {
  let qty: number
  try {
    const r = parseDecimal(item.quantity)
    if (r.num % r.den !== 0n) return null
    qty = Number(r.num / r.den)
  } catch {
    return null
  }
  const sharing = item.shares.length
  return qty > 1 && sharing > 0 && sharing !== qty ? { ordered: qty, sharing } : null
}

// ---- split dialog --------------------------------------------------------------------------------

export type DialogMode = 'equal' | 'shares' | 'percent' | 'exact'

export interface DialogState {
  mode: DialogMode
  /** equal: who's in */
  included: UUID[]
  /** by shares: whole-number shares per person (0 = out) */
  shares: Record<UUID, number>
  /** percentages as typed */
  percent: Record<UUID, string>
  /** exact amounts in minor units */
  exact: Record<UUID, number>
}

const HUNDREDTHS = 10000 // 100.00 % in hundredths of a percent

/** Equal percentages that add up to exactly 100 (remainder to the largest, like the backend). */
export function evenPercents(n: number): string[] {
  if (n <= 0) return []
  const base = Math.floor(HUNDREDTHS / n)
  const extra = HUNDREDTHS - base * n
  return Array.from({ length: n }, (_, i) => formatHundredths(base + (i < extra ? 1 : 0)))
}

function formatHundredths(h: number): string {
  const whole = Math.trunc(h / 100)
  const frac = Math.abs(h % 100)
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`.replace(/0$/, '')
}

/** A typed percentage in hundredths of a percent; null when it isn't a number with ≤ 2 decimals. */
export function percentToHundredths(text: string): number | null {
  const t = text.trim()
  if (t === '') return 0
  if (!/^\d*(\.\d{0,2})?$/.test(t) || t === '.') return null
  const r = parseDecimal(t)
  return Number((r.num * 100n) / r.den)
}

/** 100 % minus what's typed, in hundredths; null if anything typed isn't a valid percentage. */
export function percentLeft(values: string[]): number | null {
  let sum = 0
  for (const v of values) {
    const h = percentToHundredths(v)
    if (h === null) return null
    sum += h
  }
  return HUNDREDTHS - sum
}

export const formatPercent = (hundredths: number) => formatHundredths(hundredths)

/** Start the dialog from the item's current assignment. */
export function initialDialog(item: Pick<ItemOut, 'split_mode' | 'shares' | 'total_price_cents'>, participantIds: UUID[]): DialogState {
  const ids = sharerIds(item)
  const included = ids.length ? ids : participantIds
  const base: DialogState = {
    mode: 'equal',
    included,
    shares: Object.fromEntries(participantIds.map((id) => [id, included.includes(id) ? 1 : 0])),
    percent: seedPercent(included, participantIds),
    exact: seedExact(item.total_price_cents, included, participantIds),
  }
  if (!item.shares.length) return base
  if (item.split_mode === 'custom') {
    return { ...base, mode: 'exact', exact: Object.fromEntries(participantIds.map((id) => [id, item.shares.find((s) => s.person_id === id)?.amount_cents ?? 0])) }
  }
  if (item.split_mode === 'weighted') {
    const weights = item.shares.map((s) => s.weight ?? '0')
    const sum = weights.reduce((acc, w) => acc + weightHundredths(w), 0)
    const wholeShares = weights.every((w) => /^\d+(\.0+)?$/.test(w))
    if (sum === HUNDREDTHS && !(wholeShares && weights.length > 0 && weights.every((w) => parseFloat(w) <= 20))) {
      return { ...base, mode: 'percent', percent: Object.fromEntries(participantIds.map((id) => [id, trimZeros(item.shares.find((s) => s.person_id === id)?.weight ?? '')])) }
    }
    if (wholeShares) {
      return { ...base, mode: 'shares', shares: Object.fromEntries(participantIds.map((id) => [id, Math.round(parseFloat(item.shares.find((s) => s.person_id === id)?.weight ?? '0'))])) }
    }
    return { ...base, mode: 'percent', percent: seedPercent(ids, participantIds) }
  }
  return base
}

/** A stored weight ("33.3300") in hundredths; NaN when it has finer precision. */
function weightHundredths(w: string): number {
  try {
    const r = parseDecimal(w)
    return (r.num * 100n) % r.den === 0n ? Number((r.num * 100n) / r.den) : Number.NaN
  } catch {
    return Number.NaN
  }
}

const trimZeros = (w: string) => (w.includes('.') ? w.replace(/\.?0+$/, '') : w)

function seedPercent(included: UUID[], all: UUID[]): Record<UUID, string> {
  const even = evenPercents(included.length)
  return Object.fromEntries(all.map((id) => [id, included.includes(id) ? (even[included.indexOf(id)] ?? '') : '']))
}

function seedExact(total: number, included: UUID[], all: UUID[]): Record<UUID, number> {
  const parts = allocate(total, included.map(() => 1))
  return Object.fromEntries(all.map((id) => [id, included.includes(id) ? (parts[included.indexOf(id)] ?? 0) : 0]))
}

/** Switching tabs re-seeds the new mode from whoever is in the current one, so nothing is lost. */
export function switchMode(state: DialogState, mode: DialogMode, total: number, all: UUID[]): DialogState {
  const inNow = dialogIncluded(state, all)
  const included = inNow.length ? inNow : all
  return {
    ...state,
    mode,
    included,
    shares: mode === 'shares' && state.mode !== 'shares' ? Object.fromEntries(all.map((id) => [id, included.includes(id) ? 1 : 0])) : state.shares,
    percent: mode === 'percent' && state.mode !== 'percent' ? seedPercent(included, all) : state.percent,
    exact: mode === 'exact' && state.mode !== 'exact' ? seedExact(total, included, all) : state.exact,
  }
}

/** Who is on the item in the dialog's current mode. */
export function dialogIncluded(state: DialogState, all: UUID[]): UUID[] {
  switch (state.mode) {
    case 'equal':
      return all.filter((id) => state.included.includes(id))
    case 'shares':
      return all.filter((id) => (state.shares[id] ?? 0) > 0)
    case 'percent':
      return all.filter((id) => (percentToHundredths(state.percent[id] ?? '') ?? 0) > 0)
    case 'exact':
      return all.filter((id) => (state.exact[id] ?? 0) !== 0)
  }
}

export type DialogCheck = { ok: true; assign: Assign } | { ok: false; reason: string }

/** Validate the dialog and turn it into an assignment. */
export function dialogToAssign(state: DialogState, total: number, all: UUID[]): DialogCheck {
  const ids = dialogIncluded(state, all)
  switch (state.mode) {
    case 'equal':
      return ids.length ? { ok: true, assign: equal(ids) } : { ok: false, reason: 'Pick at least one person.' }
    case 'shares':
      if (!ids.length) return { ok: false, reason: 'Give someone at least one share.' }
      return { ok: true, assign: { mode: 'weighted', shares: ids.map((id) => ({ person_id: id, weight: String(state.shares[id]) })) } }
    case 'percent': {
      const left = percentLeft(all.map((id) => state.percent[id] ?? ''))
      if (left === null) return { ok: false, reason: 'Use numbers with up to 2 decimals.' }
      if (left !== 0) return { ok: false, reason: left > 0 ? `${formatPercent(left)}% left to give` : `${formatPercent(-left)}% too much` }
      return { ok: true, assign: { mode: 'weighted', shares: ids.map((id) => ({ person_id: id, weight: String(state.percent[id]).trim() })) } }
    }
    case 'exact': {
      const sum = all.reduce((acc, id) => acc + (state.exact[id] ?? 0), 0)
      if (!ids.length) return { ok: false, reason: 'Enter at least one amount.' }
      if (sum !== total) return { ok: false, reason: 'difference' }
      return { ok: true, assign: { mode: 'custom', shares: ids.map((id) => ({ person_id: id, amount_cents: state.exact[id] ?? 0 })) } }
    }
  }
}

/** Short who-label for an item row: everyone, nobody, or the people on it. */
export function whoIsOn(item: Pick<ItemOut, 'shares'>, participants: ParticipantOut[]): 'all' | 'none' | ParticipantOut[] {
  const ids = sharerIds(item)
  if (!ids.length) return 'none'
  if (participants.length > 1 && participants.every((p) => ids.includes(p.person_id))) return 'all'
  return participants.filter((p) => ids.includes(p.person_id))
}
