import type { BillStatus, BillSummaryOut, SummaryOut, UUID } from '@/lib/types'

/** Statuses that mean "not finished yet": listed under In progress and the Drafts filter. */
export const IN_PROGRESS: BillStatus[] = ['draft', 'scanning', 'review', 'assigning']

export interface ProgressState {
  label: string
  /** warn = waiting on the user; quiet = nothing to do yet */
  tone: 'warn' | 'quiet'
  action: 'Resume' | 'Open'
}

/**
 * What an unfinished bill is waiting on, from what the list endpoint gives us (status + source).
 * Counts like "2 prices to check" need fields BillSummaryOut doesn't carry yet (see handover).
 */
export function progressState(b: Pick<BillSummaryOut, 'status' | 'source'>): ProgressState {
  switch (b.status) {
    case 'scanning':
      return { label: 'Reading receipt…', tone: 'quiet', action: 'Open' }
    case 'review':
      return { label: 'Prices to check', tone: 'warn', action: 'Resume' }
    case 'assigning':
      return { label: 'Items to assign', tone: 'warn', action: 'Resume' }
    case 'draft':
      if (b.source === 'quick') return { label: 'Add the total', tone: 'quiet', action: 'Resume' }
      if (b.source === 'scan') return { label: 'Add a receipt', tone: 'quiet', action: 'Resume' }
      return { label: 'Add items', tone: 'quiet', action: 'Resume' }
    default:
      return { label: '', tone: 'quiet', action: 'Open' }
  }
}

/**
 * People still owing on each outstanding bill. /me/summary counts anyone with money outstanding
 * (a partial payment still owes); BillSummaryOut.unsettled_count only counts people never marked,
 * so the summary wins when it knows the bill.
 */
export function owingIndex(summary: SummaryOut | undefined): Map<UUID, number> {
  return new Map((summary?.bills ?? []).map((b) => [b.bill_id, b.unsettled_people]))
}

export function owingCount(b: Pick<BillSummaryOut, 'id' | 'unsettled_count'>, index: Map<UUID, number>): number {
  return index.get(b.id) ?? b.unsettled_count
}

export type BillFilter = 'all' | 'open' | 'even' | 'drafts'

export const BILL_FILTERS: Array<{ value: BillFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'even', label: 'Even' },
  { value: 'drafts', label: 'Drafts' },
]

export function parseFilter(value: string | null): BillFilter {
  return BILL_FILTERS.some((f) => f.value === value) ? (value as BillFilter) : 'all'
}

/** Server-side status filter. Open vs Even both fetch complete bills and split on who still owes. */
export function filterStatuses(filter: BillFilter): BillStatus[] | undefined {
  if (filter === 'drafts') return IN_PROGRESS
  if (filter === 'open' || filter === 'even') return ['complete']
  return undefined
}

export function matchesFilter(filter: BillFilter, b: Pick<BillSummaryOut, 'status'>, owing: number): boolean {
  if (filter === 'open') return b.status === 'complete' && owing > 0
  if (filter === 'even') return b.status === 'complete' && owing === 0
  if (filter === 'drafts') return IN_PROGRESS.includes(b.status)
  return true
}
