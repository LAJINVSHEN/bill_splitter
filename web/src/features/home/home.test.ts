import { describe, expect, it } from 'vitest'
import type { SummaryOut } from '@/lib/types'
import { filterStatuses, matchesFilter, owingCount, owingIndex, parseFilter, progressState } from './billState'
import { billName, dayOf, longDate, monthName, parseCalendarDate, peopleCount, shortDate } from './format'

const today = new Date(2026, 9, 7)

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
})

describe('owing and filters', () => {
  const summary = { bills: [{ bill_id: 'a', unsettled_people: 2 }] } as unknown as SummaryOut
  const index = owingIndex(summary)
  it('prefers the summary count (partial payers still owe)', () => {
    expect(owingCount({ id: 'a', unsettled_count: 1 }, index)).toBe(2)
    expect(owingCount({ id: 'b', unsettled_count: 3 }, index)).toBe(3)
    expect(owingIndex(undefined).size).toBe(0)
  })
  it('maps filters to statuses and client checks', () => {
    expect(parseFilter('open')).toBe('open')
    expect(parseFilter('weird')).toBe('all')
    expect(filterStatuses('all')).toBeUndefined()
    expect(filterStatuses('even')).toEqual(['complete'])
    expect(filterStatuses('drafts')).toEqual(['draft', 'scanning', 'review', 'assigning'])
    expect(matchesFilter('open', { status: 'complete' }, 1)).toBe(true)
    expect(matchesFilter('open', { status: 'complete' }, 0)).toBe(false)
    expect(matchesFilter('even', { status: 'complete' }, 0)).toBe(true)
    expect(matchesFilter('even', { status: 'review' }, 0)).toBe(false)
    expect(matchesFilter('drafts', { status: 'scanning' }, 0)).toBe(true)
    expect(matchesFilter('all', { status: 'draft' }, 0)).toBe(true)
  })
})
