import type { BillStatus, BillSummaryOut, SummaryOut, UUID } from '@/lib/types'

/** Statuses that mean "not finished yet": listed under In progress and the Drafts filter. */
export const IN_PROGRESS: BillStatus[] = ['draft', 'scanning', 'review', 'assigning']

export interface ProgressState {
  label: string
  /** warn = waiting on the user; quiet = nothing to do yet */
  tone: 'warn' | 'quiet'
  action: 'Resume' | 'Open'
}

export function progressState(b: Pick<BillSummaryOut, 'status' | 'source' | 'unassigned_item_count' | 'price_issue_count' | 'validation_issue_count'>): ProgressState {
  if (b.status !== 'scanning' && b.status !== 'complete') {
    const labels: string[] = []
    if (b.price_issue_count) labels.push(`${b.price_issue_count} ${b.price_issue_count === 1 ? 'price' : 'prices'} to check`)
    if (b.validation_issue_count) labels.push(`${b.validation_issue_count} receipt ${b.validation_issue_count === 1 ? 'issue' : 'issues'}`)
    if (b.unassigned_item_count) labels.push(`${b.unassigned_item_count} ${b.unassigned_item_count === 1 ? 'item' : 'items'} unassigned`)
    if (labels.length) return { label: labels.join(' · '), tone: 'warn', action: 'Resume' }
  }
  switch (b.status) {
    case 'scanning':
      return { label: 'Reading receipt…', tone: 'quiet', action: 'Open' }
    case 'review':
      return b.price_issue_count === undefined && b.validation_issue_count === undefined
        ? { label: 'Prices to check', tone: 'warn', action: 'Resume' }
        : { label: 'Review receipt', tone: 'quiet', action: 'Resume' }
    case 'assigning':
      return b.unassigned_item_count === undefined
        ? { label: 'Items to assign', tone: 'warn', action: 'Resume' }
        : { label: 'Ready to finish', tone: 'quiet', action: 'Resume' }
    case 'draft':
      if (b.source === 'quick') return { label: 'Add the total', tone: 'quiet', action: 'Resume' }
      if (b.source === 'scan') return { label: 'Add a receipt', tone: 'quiet', action: 'Resume' }
      return { label: 'Add items', tone: 'quiet', action: 'Resume' }
    default:
      return { label: '', tone: 'quiet', action: 'Open' }
  }
}

/**
 * Both summary and list counts derive from outstanding money, including partial payments.
 */
export function owingIndex(summary: SummaryOut | undefined): Map<UUID, number> {
  return new Map((summary?.bills ?? []).map((b) => [b.bill_id, b.unsettled_people]))
}

export function owingCount(b: Pick<BillSummaryOut, 'id' | 'unsettled_count'>, index: Map<UUID, number>): number {
  return b.unsettled_count ?? index.get(b.id) ?? 0
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

export function filterStatuses(filter: BillFilter): BillStatus[] | undefined {
  if (filter === 'drafts') return IN_PROGRESS
  if (filter === 'open' || filter === 'even') return ['complete']
  return undefined
}

export function filterSettled(filter: BillFilter): boolean | undefined {
  if (filter === 'open') return false
  if (filter === 'even') return true
  return undefined
}
