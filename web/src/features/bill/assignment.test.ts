import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qk, type AssignmentIn } from '@/data/queries'
import type { BillOut, ItemOut } from '@/lib/types'
import { useAssignments } from './useAssignments'
import {
  applyToItem,
  applyAssignments,
  dialogToAssign,
  evenPercents,
  initialDialog,
  itemCounts,
  percentLeft,
  quantityMismatch,
  shareWithEveryone,
  soFar,
  switchMode,
  toggleItem,
  type Assign,
} from './assignment'

const { saveAssignments } = vi.hoisted(() => ({ saveAssignments: vi.fn<(list: AssignmentIn[]) => Promise<BillOut>>() }))
vi.mock('@/data/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/queries')>()
  return {
    ...actual,
    usePutAssignments: (billId: string) => {
      const qc = useQueryClient()
      return { mutateAsync: async (list: AssignmentIn[]) => {
        const saved = await saveAssignments(list)
        qc.setQueryData(actual.qk.bill(billId), saved)
        return saved
      } }
    },
  }
})

const item = (mode: ItemOut['split_mode'], ids: string[], extra: Partial<ItemOut> = {}): ItemOut => ({
  id: 'i1',
  position: 0,
  name: 'Gyoza',
  quantity: '1',
  unit_price_cents: 1400,
  total_price_cents: 1400,
  split_mode: mode,
  shares: ids.map((person_id) => ({ person_id, weight: '1', amount_cents: null })),
  ...extra,
})

const ids = (a: Assign | 'dialog') => (a === 'dialog' ? 'dialog' : { mode: a.mode, who: a.shares.map((s) => s.person_id) })

describe('toggleItem (person-first painting)', () => {
  it('nobody → single', () => {
    expect(ids(toggleItem(item(null, []), 'p'))).toEqual({ mode: 'single', who: ['p'] })
  })
  it('single(q) → equal[q, p]', () => {
    expect(ids(toggleItem(item('single', ['q']), 'p'))).toEqual({ mode: 'equal', who: ['q', 'p'] })
  })
  it('single(p) → nobody', () => {
    expect(ids(toggleItem(item('single', ['p']), 'p'))).toEqual({ mode: null, who: [] })
  })
  it('equal with p drops p; one left becomes single', () => {
    expect(ids(toggleItem(item('equal', ['q', 'p', 'r']), 'p'))).toEqual({ mode: 'equal', who: ['q', 'r'] })
    expect(ids(toggleItem(item('equal', ['q', 'p']), 'p'))).toEqual({ mode: 'single', who: ['q'] })
  })
  it('equal without p adds p', () => {
    expect(ids(toggleItem(item('equal', ['q', 'r']), 'p'))).toEqual({ mode: 'equal', who: ['q', 'r', 'p'] })
  })
  it('weighted and custom open the dialog', () => {
    expect(toggleItem(item('weighted', ['q']), 'p')).toBe('dialog')
    expect(toggleItem(item('custom', ['q']), 'q')).toBe('dialog')
  })
  it('a mode with no shares counts as unassigned', () => {
    expect(ids(toggleItem(item('equal', []), 'p'))).toEqual({ mode: 'single', who: ['p'] })
  })
})

describe('shareWithEveryone', () => {
  it('is equal over everyone, or single for one person', () => {
    expect(ids(shareWithEveryone(['a', 'b', 'c']))).toEqual({ mode: 'equal', who: ['a', 'b', 'c'] })
    expect(ids(shareWithEveryone(['a']))).toEqual({ mode: 'single', who: ['a'] })
  })
})

describe('applyToItem', () => {
  it('mirrors the server shape', () => {
    const custom = applyToItem(item(null, []), { mode: 'custom', shares: [{ person_id: 'a', amount_cents: 400 }, { person_id: 'b', amount_cents: 1000 }] })
    expect(custom.shares).toEqual([
      { person_id: 'a', weight: null, amount_cents: 400 },
      { person_id: 'b', weight: null, amount_cents: 1000 },
    ])
    expect(applyToItem(item(null, []), { mode: 'equal', shares: [{ person_id: 'a' }] }).shares[0]?.weight).toBe('1')
  })
})

describe('counts and running totals', () => {
  it('counts items per person', () => {
    const counts = itemCounts([item('equal', ['a', 'b']), item('single', ['a']), item(null, [])])
    expect(counts.get('a')).toBe(2)
    expect(counts.get('b')).toBe(1)
  })
  it('so far scales against the whole receipt, not just what is assigned', () => {
    // items 100.00 of 200.00 on a 220.00 bill → 110.00, not 220.00
    expect(soFar(10000, 20000, 22000)).toBe(11000)
    expect(soFar(0, 20000, 22000)).toBe(0)
    expect(soFar(20000, 20000, 22000)).toBe(22000)
    expect(soFar(5, 0, 100)).toBe(0)
  })
})

describe('quantityMismatch', () => {
  it('flags ×2 shared by three', () => {
    expect(quantityMismatch(item('equal', ['a', 'b', 'c'], { quantity: '2' }))).toEqual({ ordered: 2, sharing: 3 })
  })
  it('is quiet when it lines up, nobody is on it, or the quantity is fractional', () => {
    expect(quantityMismatch(item('equal', ['a', 'b'], { quantity: '2.000' }))).toBeNull()
    expect(quantityMismatch(item(null, [], { quantity: '3' }))).toBeNull()
    expect(quantityMismatch(item('single', ['a'], { quantity: '1.5' }))).toBeNull()
  })
})

describe('split dialog', () => {
  const all = ['a', 'b', 'c']

  it('even percentages add up to exactly 100', () => {
    expect(evenPercents(3)).toEqual(['33.34', '33.33', '33.33'])
    expect(evenPercents(2)).toEqual(['50', '50'])
    expect(evenPercents(6)).toEqual(['16.67', '16.67', '16.67', '16.67', '16.66', '16.66'])
  })

  it('percentLeft is exact and rejects junk', () => {
    expect(percentLeft(['33.34', '33.33', '33.33'])).toBe(0)
    expect(percentLeft(['50', ''])).toBe(5000)
    expect(percentLeft(['60', '50'])).toBe(-1000)
    expect(percentLeft(['1.234'])).toBeNull()
    expect(percentLeft(['abc'])).toBeNull()
  })

  it('opens on the item’s current mode', () => {
    expect(initialDialog(item(null, []), all).mode).toBe('equal')
    expect(initialDialog(item(null, []), all).included).toEqual(all)
    const custom = initialDialog(
      { split_mode: 'custom', total_price_cents: 1400, shares: [{ person_id: 'a', weight: null, amount_cents: 400 }, { person_id: 'b', weight: null, amount_cents: 1000 }] },
      all,
    )
    expect(custom.mode).toBe('exact')
    expect(custom.exact).toEqual({ a: 400, b: 1000, c: 0 })
    const pct = initialDialog(
      { split_mode: 'weighted', total_price_cents: 1400, shares: [{ person_id: 'a', weight: '70.0000', amount_cents: null }, { person_id: 'b', weight: '30.0000', amount_cents: null }] },
      all,
    )
    expect(pct.mode).toBe('percent')
    expect(pct.percent).toEqual({ a: '70', b: '30', c: '' })
    const shares = initialDialog(
      { split_mode: 'weighted', total_price_cents: 1400, shares: [{ person_id: 'a', weight: '2', amount_cents: null }, { person_id: 'b', weight: '1', amount_cents: null }] },
      all,
    )
    expect(shares.mode).toBe('shares')
    expect(shares.shares).toEqual({ a: 2, b: 1, c: 0 })
  })

  it('switching modes keeps who is in and seeds sensible values', () => {
    const start = initialDialog(item('equal', ['a', 'b']), all)
    const exact = switchMode(start, 'exact', 1401, all)
    // same cents as an equal split would give (backend allocate: remainder to the first largest)
    expect(exact.exact).toEqual({ a: 700, b: 701, c: 0 })
    const pct = switchMode(exact, 'percent', 1401, all)
    expect(pct.percent).toEqual({ a: '50', b: '50', c: '' })
  })

  it('turns each mode into the right assignment', () => {
    const s = initialDialog(item(null, []), all)
    expect(ids((dialogToAssign({ ...s, included: ['b'] }, 1400, all) as { ok: true; assign: Assign }).assign)).toEqual({ mode: 'single', who: ['b'] })
    const shares = dialogToAssign({ ...s, mode: 'shares', shares: { a: 2, b: 0, c: 1 } }, 1400, all)
    expect(shares).toEqual({ ok: true, assign: { mode: 'weighted', shares: [{ person_id: 'a', weight: '2' }, { person_id: 'c', weight: '1' }] } })
    expect(dialogToAssign({ ...s, mode: 'percent', percent: { a: '60', b: '30', c: '' } }, 1400, all)).toEqual({ ok: false, reason: '10% left to give' })
    expect(dialogToAssign({ ...s, mode: 'exact', exact: { a: 400, b: 900, c: 0 } }, 1400, all)).toEqual({ ok: false, reason: 'difference' })
    expect(dialogToAssign({ ...s, mode: 'exact', exact: { a: 400, b: 1000, c: 0 } }, 1400, all)).toEqual({
      ok: true,
      assign: { mode: 'custom', shares: [{ person_id: 'a', amount_cents: 400 }, { person_id: 'b', amount_cents: 1000 }] },
    })
    expect(dialogToAssign({ ...s, included: [] }, 1400, all).ok).toBe(false)
  })
})

function renderPainter() {
  const bill: BillOut = {
    id: 'bill', title: null, merchant: null, bill_date: null, currency: 'SGD',
    settle_currency: null, fx_rate: null, effective_currency: 'SGD', currency_locked: false,
    status: 'assigning', source: 'manual', payer_person_id: null, subtotal_cents: 1400,
    grand_total_cents: 1400, tax_scenario: null, receipt_meta: {}, created_at: '', updated_at: '',
    items: [item(null, [])], charges: [], participants: [], validation: null, latest_job: null, files: [],
    split: {
      currency: 'SGD', settle_currency: null, fx_rate: null, effective_currency: 'SGD',
      grand_total_cents: 1400, settle_grand_total_cents: null, all_items_cents: 1400,
      assigned_items_cents: 0, payer_person_id: null, people: [], unassigned_item_ids: ['i1'],
      issues: [], is_complete: false, outstanding_total_cents: 0,
    },
  }
  const qc = new QueryClient()
  qc.setQueryData(qk.bill(bill.id), bill)
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
  const hook = renderHook(() => useAssignments(bill.id), { wrapper })
  return { ...hook, qc, bill }
}

const paint = (personId: string): AssignmentIn[] => [{ item_id: 'i1', mode: 'single', shares: [{ person_id: personId }] }]

describe('useAssignments persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    saveAssignments.mockReset()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('waits past six seconds and drains newer taps serially', async () => {
    let release!: () => void
    const { result, bill, qc } = renderPainter()
    saveAssignments.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(applyAssignments(bill, paint('a')))
    })).mockResolvedValue(applyAssignments(bill, paint('b')))
    act(() => result.current.assign(paint('a')))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    act(() => result.current.assign(paint('b')))
    let settled: boolean | undefined
    await act(async () => {
      void result.current.settle().then((ok) => { settled = ok })
      await vi.advanceTimersByTimeAsync(7000)
    })
    expect(settled).toBeUndefined()
    expect(result.current.busy).toBe(true)
    expect(saveAssignments).toHaveBeenCalledTimes(1)
    await act(async () => { release() })
    expect(settled).toBe(true)
    expect(saveAssignments).toHaveBeenCalledTimes(2)
    expect(saveAssignments).toHaveBeenLastCalledWith(paint('b'))
    expect(result.current.busy).toBe(false)
    expect(qc.getQueryData<BillOut>(qk.bill(bill.id))?.items[0]?.shares[0]?.person_id).toBe('b')
  })

  it('reports failure, keeps the optimistic changes, and retries the newest taps', async () => {
    let reject!: (error: Error) => void
    const { result, qc, bill } = renderPainter()
    saveAssignments.mockImplementationOnce(() => new Promise((_, rejectSave) => { reject = rejectSave }))
      .mockResolvedValue(applyAssignments(bill, paint('b')))
    act(() => result.current.assign(paint('a')))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    act(() => result.current.assign(paint('b')))
    let settled: boolean | undefined
    await act(async () => {
      void result.current.settle().then((ok) => { settled = ok })
      reject(new Error('offline'))
    })
    expect(settled).toBe(false)
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.dirty).toBe(true)
    expect(qc.getQueryData<BillOut>(qk.bill(bill.id))?.items[0]?.shares[0]?.person_id).toBe('b')
    await act(async () => { expect(await result.current.settle()).toBe(true) })
    expect(saveAssignments).toHaveBeenLastCalledWith(paint('b'))
    expect(result.current.error).toBeNull()
  })

  it('tracks an unmount save instead of bypassing error handling', async () => {
    let reject!: (error: Error) => void
    const { result, unmount, bill } = renderPainter()
    saveAssignments.mockImplementationOnce(() => new Promise((_, rejectSave) => { reject = rejectSave }))
      .mockResolvedValue(applyAssignments(bill, paint('a')))
    act(() => result.current.assign(paint('a')))
    const painter = result.current
    unmount()
    expect(saveAssignments).toHaveBeenCalledWith(paint('a'))
    const settled = painter.settle()
    reject(new Error('offline'))
    expect(await settled).toBe(false)
    expect(await painter.settle()).toBe(true)
    expect(saveAssignments).toHaveBeenCalledTimes(2)
  })

  it('drains queued taps after unmount while a save is already in flight', async () => {
    let release!: () => void
    const { result, unmount, bill } = renderPainter()
    saveAssignments.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(applyAssignments(bill, paint('a')))
    })).mockResolvedValue(applyAssignments(bill, paint('b')))
    act(() => result.current.assign(paint('a')))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    act(() => result.current.assign(paint('b')))
    const painter = result.current
    unmount()
    expect(saveAssignments).toHaveBeenCalledTimes(1)
    const settled = painter.settle()
    release()
    expect(await settled).toBe(true)
    expect(saveAssignments).toHaveBeenLastCalledWith(paint('b'))
  })
})
