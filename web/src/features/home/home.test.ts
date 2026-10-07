import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBills, useDeleteBill } from '@/data/queries'
import { api, ApiError } from '@/lib/api'
import type { BillSummaryOut, PersonOut, SummaryOut } from '@/lib/types'
import BillsPage from '@/routes/Bills'
import PeoplePage from '@/routes/People'
import { BillRows, BillTable } from './BillList'
import { OwedHero } from './HomeSections'
import { filterSettled, filterStatuses, owingCount, owingIndex, parseFilter, progressState } from './billState'
import { billName, dayOf, longDate, monthName, parseCalendarDate, participantNames, peopleCount, shortDate } from './format'

const today = new Date(2026, 9, 7)

vi.mock('@/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api')>(), api: vi.fn(), newIdempotencyKey: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

const listedBill: BillSummaryOut = {
  id: 'bill', title: 'Dinner', merchant: null, bill_date: '2026-10-03', currency: 'SGD',
  status: 'review', source: 'manual', grand_total_cents: 3000, participant_count: 4,
  participant_names: ['You', 'Maya', 'Arjun', 'Lena'], unsettled_count: 1,
  unassigned_item_count: 2, price_issue_count: 1, validation_issue_count: 0,
  created_at: '2026-10-03T08:00:00Z', updated_at: '2026-10-03T08:00:00Z',
}

function queryWrapper(entry = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client, children: createElement(MemoryRouter, { initialEntries: [entry] }, children) })
  }
}

describe('dates', () => {
  it('reads calendar dates as local parts', () => {
    expect(parseCalendarDate('2026-10-03')).toEqual({ y: 2026, m: 10, d: 3 })
    expect(parseCalendarDate('nope')).toBeNull()
    expect(parseCalendarDate(null)).toBeNull()
    expect(parseCalendarDate('2026-13-01')).toBeNull()
  })
  it('formats short and long dates, adding the year only when it differs', () => {
    expect(shortDate('2026-10-03', today)).toBe('03 Oct')
    expect(shortDate('2025-12-31', today)).toBe('31 Dec 2025')
    expect(shortDate(null, today)).toBe('')
    expect(longDate('2026-10-03', today)).toBe('Sat 3 Oct')
    expect(longDate('2025-01-01', today)).toBe('Wed 1 Jan 2025')
  })
  it('formats timestamps and months', () => {
    expect(dayOf('2026-10-07T08:12:55Z', today)).toMatch(/^\d{1,2} Oct$/)
    expect(dayOf('garbage', today)).toBe('')
    expect(monthName('2026-10')).toBe('October')
    expect(monthName('bad')).toBe('bad')
  })
  it('names bills and counts people', () => {
    expect(billName({ title: ' ', merchant: 'Kopi & Co.' })).toBe('Kopi & Co.')
    expect(billName({ title: null, merchant: null })).toBe('Untitled bill')
    expect(peopleCount(1)).toBe('1 person')
    expect(peopleCount(4)).toBe('4 people')
  })
  it('shows participant names with compact overflow and a legacy count fallback', () => {
    expect(participantNames({ participant_count: 1, participant_names: ['You'] })).toBe('You')
    expect(participantNames({ participant_count: 2, participant_names: ['You', 'Maya'] })).toBe('You, Maya')
    expect(participantNames({ participant_count: 4, participant_names: ['You', 'Maya', 'Arjun', 'Lena'] })).toBe('You, Maya +2')
    expect(participantNames({ participant_count: 3 })).toBe('3 people')
    expect(participantNames({ participant_count: 0, participant_names: [] })).toBe('0 people')
  })
})

describe('other-currency bill actions', () => {
  const yenBill: SummaryOut['bills'][number] = { bill_id: 'yen-bill', title: 'Dinner', bill_date: null,
    currency: 'JPY', owed_to_me_cents: 500, i_owe_cents: 0, unsettled_people: 1 }
  const summary: SummaryOut = {
    home: { currency: 'SGD', owed_to_me_cents: 0, i_owe_cents: 0 },
    currencies: [{ currency: 'JPY', owed_to_me_cents: 500, i_owe_cents: 0 }],
    people: [],
    bills: [yenBill],
  }

  it('opens the existing bill rather than saving an unrelated account rate', () => {
    render(createElement(OwedHero, { summary }), { wrapper: queryWrapper() })
    expect(screen.getByRole('link', { name: 'Open JPY bill' })).toHaveAttribute('href', '/bills/yen-bill')
    expect(screen.queryByRole('link', { name: 'Add JPY rate' })).not.toBeInTheDocument()
  })

  it('opens outstanding bills when more than one bill needs attention', () => {
    render(createElement(OwedHero, { summary: { ...summary, bills: [...summary.bills,
      { ...yenBill, bill_id: 'second-yen-bill' }] } }), { wrapper: queryWrapper() })
    expect(screen.getByRole('link', { name: 'Open JPY bills' })).toHaveAttribute('href', '/bills?show=open')
  })
})

describe('progressState', () => {
  it('labels each unfinished status', () => {
    expect(progressState({ status: 'scanning', source: 'scan' })).toEqual({ label: 'Reading receipt…', tone: 'quiet', action: 'Open' })
    expect(progressState({ status: 'review', source: 'scan' }).tone).toBe('warn')
    expect(progressState({ status: 'assigning', source: 'manual' }).label).toBe('Items to assign')
    expect(progressState({ status: 'draft', source: 'quick' }).label).toBe('Add the total')
    expect(progressState({ status: 'draft', source: 'scan' }).label).toBe('Add a receipt')
    expect(progressState({ status: 'draft', source: 'manual' }).action).toBe('Resume')
  })
  it('uses concrete counts without reporting zero issues as problems', () => {
    expect(progressState({ status: 'review', source: 'scan', price_issue_count: 2, unassigned_item_count: 3 }).label)
      .toBe('2 prices to check · 3 items unassigned')
    expect(progressState({ status: 'assigning', source: 'manual', unassigned_item_count: 1 }).label).toBe('1 item unassigned')
    expect(progressState({ status: 'review', source: 'manual', price_issue_count: 1, validation_issue_count: 1 }).label)
      .toBe('1 price to check · 1 receipt issue')
    expect(progressState({ status: 'review', source: 'manual', price_issue_count: 0, validation_issue_count: 0 }).label).toBe('Review receipt')
    expect(progressState({ status: 'assigning', source: 'manual', unassigned_item_count: 0 }).label).toBe('Ready to finish')
    expect(progressState({ status: 'scanning', source: 'scan', unassigned_item_count: 4 }).tone).toBe('quiet')
  })
})

describe('owing and filters', () => {
  const summary = { bills: [{ bill_id: 'a', unsettled_people: 2 }] } as unknown as SummaryOut
  const index = owingIndex(summary)
  it('uses the derived list count rather than a stale summary count', () => {
    expect(owingCount({ id: 'a', unsettled_count: 1 }, index)).toBe(1)
    expect(owingCount({ id: 'a', unsettled_count: 0 }, index)).toBe(0)
    expect(owingCount({ id: 'b', unsettled_count: 3 }, index)).toBe(3)
    expect(owingIndex(undefined).size).toBe(0)
  })
  it('maps filters to server statuses and settled flags', () => {
    expect(parseFilter('open')).toBe('open')
    expect(parseFilter('weird')).toBe('all')
    expect(filterStatuses('all')).toBeUndefined()
    expect(filterStatuses('even')).toEqual(['complete'])
    expect(filterStatuses('drafts')).toEqual(['draft', 'scanning', 'review', 'assigning'])
    expect(filterSettled('open')).toBe(false)
    expect(filterSettled('even')).toBe(true)
    expect(filterSettled('drafts')).toBeUndefined()
    expect(filterSettled('all')).toBeUndefined()
  })
})

describe('bill list rows', () => {
  it.each([BillRows, BillTable])('renders names, overflow, and concrete progress in each layout', (Component) => {
    render(createElement(Component, { bills: [listedBill], owing: new Map(), homeCurrency: 'SGD', label: 'Bills' }),
      { wrapper: queryWrapper() })
    expect(screen.getByRole('link', { name: /Dinner/ })).toHaveAttribute('href', '/bills/bill')
    expect(screen.getByText('You, Maya +2')).toHaveAttribute('title', 'You, Maya, Arjun, Lena')
    expect(screen.getByText('1 price to check · 2 items unassigned')).toBeInTheDocument()
  })
  it.each([BillRows, BillTable])('keeps the trash action outside the bill link in each layout', (Component) => {
    const onDelete = vi.fn()
    render(createElement(Component, { bills: [listedBill], owing: new Map(), homeCurrency: 'SGD', label: 'Bills', onDelete }),
      { wrapper: queryWrapper() })
    const button = screen.getByRole('button', { name: 'Delete Dinner' })
    expect(button.closest('a')).toBeNull()
    fireEvent.click(button)
    expect(onDelete).toHaveBeenCalledWith(listedBill)
  })
})

describe('owner deletion controls', () => {
  const me: PersonOut = { id: 'me', name: 'Owner', color_seed: 30, is_self: true, last_used_at: null, archived_at: null, created_at: '2026-10-07T00:00:00Z' }
  const friend: PersonOut = { ...me, id: 'maya', name: 'Maya', is_self: false }
  const deletions = () => vi.mocked(api).mock.calls.filter(([, opts]) => opts?.method === 'DELETE')

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
    vi.mocked(api).mockImplementation(async (path, opts) => {
      if (opts?.method === 'DELETE' || opts?.method === 'PATCH') return undefined
      if (path === '/people') return { items: [me, friend] }
      if (path === '/me') return { default_currency: 'SGD' }
      if (path === '/me/summary') return { bills: [] }
      if (path.startsWith('/bills?')) return { items: [listedBill], next_cursor: 'another-page' }
      throw new Error(`Unexpected request: ${path}`)
    })
  })

  it('does not delete a bill when confirmation is cancelled', async () => {
    render(createElement(BillsPage), { wrapper: queryWrapper('/bills') })
    fireEvent.click((await screen.findAllByRole('button', { name: 'Delete Dinner' }))[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(deletions()).toHaveLength(0)
  })

  it('requires exact typed confirmation and clears all pages, not the active filter', async () => {
    render(createElement(BillsPage), { wrapper: queryWrapper('/bills?show=open') })
    fireEvent.click(screen.getByRole('button', { name: 'Clear bill history' }))
    const confirm = screen.getByRole('button', { name: 'Delete all bills' })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type DELETE ALL BILLS to confirm'), { target: { value: 'delete all bills' } })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type DELETE ALL BILLS to confirm'), { target: { value: 'DELETE ALL BILLS' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(deletions()).toEqual([['/bills?permanent=true&confirmation=DELETE+ALL+BILLS', { method: 'DELETE' }]])
  })

  it('keeps a confirmed delete open while loading and supports retry after failure', async () => {
    let fail: ((error: Error) => void) | undefined
    const original = vi.mocked(api).getMockImplementation()!
    let failed = false
    vi.mocked(api).mockImplementation(async (path, opts) => {
      if (opts?.method === 'DELETE' && !failed) {
        failed = true
        return new Promise((_resolve, reject) => { fail = reject })
      }
      return original(path, opts)
    })
    render(createElement(BillsPage), { wrapper: queryWrapper('/bills') })
    fireEvent.click((await screen.findAllByRole('button', { name: 'Delete Dinner' }))[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Delete bill' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete bill' })).toHaveAttribute('aria-busy', 'true'))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await act(async () => { fail?.(new ApiError(503, 'offline', 'Retry this deletion.')) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Retry this deletion.')
    fireEvent.click(screen.getByRole('button', { name: 'Delete bill' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(deletions()).toHaveLength(2)
    expect(deletions()[1]?.[0]).toBe('/bills/bill?permanent=true')
  })

  it('preserves the soft-delete default for existing hook callers', async () => {
    const { result } = renderHook(() => useDeleteBill(), { wrapper: queryWrapper() })
    await act(async () => { await result.current.mutateAsync('bill') })
    expect(deletions()).toEqual([['/bills/bill?permanent=false', { method: 'DELETE' }]])
  })

  it('never offers deletion of Me and cancels person deletion without a write', async () => {
    render(createElement(PeoplePage), { wrapper: queryWrapper('/people') })
    expect(await screen.findByRole('button', { name: 'Delete Maya' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete Owner' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Maya' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(deletions()).toHaveLength(0)
  })

  it('requires typed confirmation for bulk permanent people deletion', async () => {
    render(createElement(PeoplePage), { wrapper: queryWrapper('/people') })
    fireEvent.click(screen.getByRole('button', { name: 'Clear saved people' }))
    const confirm = screen.getByRole('button', { name: 'Delete all people' })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type DELETE ALL PEOPLE to confirm'), { target: { value: 'DELETE ALL PEOPLE' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(deletions()).toEqual([['/people?permanent=true&confirmation=DELETE%20ALL%20PEOPLE', { method: 'DELETE' }]])
  })

  it('requires a second confirmation before purging referenced bills, then retries the person', async () => {
    const original = vi.mocked(api).getMockImplementation()!
    let referenced = true
    vi.mocked(api).mockImplementation(async (path, opts) => {
      if (opts?.method === 'DELETE' && path.startsWith('/bills?')) referenced = false
      if (opts?.method === 'DELETE' && path.startsWith('/people/') && referenced) {
        throw new ApiError(409, 'person_referenced', 'Still used by a bill. Archive or delete history first.')
      }
      return original(path, opts)
    })
    render(createElement(PeoplePage), { wrapper: queryWrapper('/people') })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Maya' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete person' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Still used by a bill.')
    expect(deletions()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Delete associated bills first' }))
    const confirm = screen.getByRole('button', { name: 'Delete bills & people' })
    expect(confirm).toBeDisabled()
    expect(screen.getByText(/permanently erased for all its participants/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Type DELETE ASSOCIATED BILLS to confirm'), { target: { value: 'DELETE ASSOCIATED BILLS' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(deletions().map(([path]) => path)).toEqual([
      '/people/maya?permanent=true', '/bills?permanent=true&confirmation=DELETE+ASSOCIATED+BILLS&person_id=maya', '/people/maya?permanent=true',
    ])
  })

  it('offers archive without changing any referenced bill', async () => {
    render(createElement(PeoplePage), { wrapper: queryWrapper('/people') })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Maya' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive instead' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api).toHaveBeenCalledWith('/people/maya', { method: 'PATCH', body: { archived: true } })
    expect(deletions()).toHaveLength(0)
  })
})

describe('useBills server filters', () => {
  it('separates settled and page-size caches and retains filters on the next cursor request', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      const params = new URLSearchParams(path.split('?')[1])
      const id = `${params.get('settled')}:${params.get('limit')}:${params.get('cursor') ?? 'first'}`
      return { items: [{ ...listedBill, id }], next_cursor: params.has('cursor') ? null : 'next' }
    })
    const { result, rerender } = renderHook(({ settled, limit }) => useBills(['complete'], limit, settled), {
      wrapper: queryWrapper(), initialProps: { settled: false, limit: 1 },
    })
    await waitFor(() => expect(result.current.data?.pages[0]?.items[0]?.id).toBe('false:1:first'))
    expect(api).toHaveBeenCalledWith('/bills?limit=1&status=complete&settled=false')
    await act(async () => { await result.current.fetchNextPage() })
    expect(api).toHaveBeenCalledWith('/bills?limit=1&status=complete&settled=false&cursor=next')
    await waitFor(() => expect(result.current.hasNextPage).toBe(false))
    rerender({ settled: true, limit: 1 })
    await waitFor(() => expect(result.current.data?.pages[0]?.items[0]?.id).toBe('true:1:first'))
    expect(result.current.data?.pages).toHaveLength(1)
    rerender({ settled: true, limit: 2 })
    await waitFor(() => expect(result.current.data?.pages[0]?.items[0]?.id).toBe('true:2:first'))
    expect(api).toHaveBeenCalledWith('/bills?limit=2&status=complete&settled=true')
  })

  it('omits the optional settled input for existing callers', async () => {
    vi.mocked(api).mockResolvedValue({ items: [], next_cursor: null })
    const { result } = renderHook(() => useBills(), { wrapper: queryWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(api).toHaveBeenCalledWith('/bills?limit=20')
  })
})

describe('Bills page server results', () => {
  it('keeps server-filtered results rather than removing rows using local balance counts', async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/me') return { default_currency: 'SGD' }
      if (path === '/me/summary') return { bills: [] }
      const params = new URLSearchParams(path.split('?')[1])
      const next = params.has('cursor')
      return {
        items: [{ ...listedBill, id: next ? 'older' : 'bill', title: next ? 'Older dinner' : 'Dinner',
          status: 'complete', unsettled_count: 0 }],
        next_cursor: next ? null : 'older-cursor',
      }
    })
    render(createElement(BillsPage), { wrapper: queryWrapper('/bills?show=open') })
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Dinner/ })).toHaveLength(2))
    expect(api).toHaveBeenCalledWith('/bills?limit=20&status=complete&settled=false')
    expect(screen.queryByText('Nobody owes you')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Older dinner/ })).toHaveLength(2))
    expect(api).toHaveBeenCalledWith('/bills?limit=20&status=complete&settled=false&cursor=older-cursor')
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })
})
