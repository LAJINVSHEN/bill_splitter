import { isJobActive } from '@/data/queries'
import { ApiError } from '@/lib/api'
import type { BillOut, BillSource, BillStatus, UUID } from '@/lib/types'

/** Step labels shown in FlowShell, per way of starting a bill. */
export const STEPS: Record<BillSource, string[]> = {
  scan: ['Scan', 'People', 'Review', 'Assign', 'Done'],
  manual: ['Start', 'People', 'Items', 'Assign', 'Done'],
  quick: ['Split', 'Done'],
}

/** Where an unfinished bill continues. Every "Resume" can point at /bills/:id and land here. */
export function stepPath(bill: Pick<BillOut, 'id' | 'status' | 'source'>): string {
  const base = `/bills/${bill.id}`
  const status: BillStatus = bill.status
  if (status === 'complete') return base
  if (bill.source === 'quick') return `${base}/quick`
  if (status === 'review') return `${base}/review`
  if (status === 'assigning') return `${base}/assign`
  return `${base}/people`
}

export const billTitle = (b: Pick<BillOut, 'title' | 'merchant'>) => b.title?.trim() || b.merchant?.trim() || 'Untitled bill'

/** Today as YYYY-MM-DD from local parts (never toISOString: it's UTC). */
export function todayLocal(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** "Sat 4 Oct" from YYYY-MM-DD, parsed as a local date. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d))
}

export const scanRunning = (bill: Pick<BillOut, 'status' | 'latest_job'>) => bill.status === 'scanning' || isJobActive(bill.latest_job?.status)

// ---- quota -----------------------------------------------------------------------------------------

export type PauseReason = 'scans_disabled' | 'user_quota' | 'global_page_cap' | 'llm_budget'

export interface QuotaInfo {
  reason: PauseReason
  pagesUsed?: number
  pagesQuota?: number
  month?: string
}

export function quotaFromError(err: unknown): QuotaInfo | null {
  if (!(err instanceof ApiError) || !err.code.startsWith('quota_')) return null
  const reason = err.code.slice('quota_'.length) as PauseReason
  const b = err.body
  return {
    reason,
    pagesUsed: typeof b.pages_used === 'number' ? b.pages_used : undefined,
    pagesQuota: typeof b.pages_quota === 'number' ? b.pages_quota : undefined,
    month: typeof b.month === 'string' ? b.month : undefined,
  }
}

/** "1 Nov": the first day of the month after `month` (YYYY-MM), when quotas reset. */
export function resetDay(month: string | undefined, now = new Date()): string {
  let y = now.getFullYear()
  let m = now.getMonth() + 1
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    y = Number(month.slice(0, 4))
    m = Number(month.slice(5, 7))
  }
  const next = new Date(y, m, 1)
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(next)
}

export function quotaMessage(q: QuotaInfo): string {
  const when = resetDay(q.month)
  switch (q.reason) {
    case 'user_quota':
      return q.pagesQuota !== undefined
        ? `You’ve used ${q.pagesUsed ?? q.pagesQuota} of ${q.pagesQuota} scans this month. Scanning comes back on ${when}.`
        : `You’ve used this month’s scans. Scanning comes back on ${when}.`
    case 'global_page_cap':
    case 'llm_budget':
      return `Scanning is paused for everyone until ${when}.`
    default:
      return 'Scanning is switched off for now.'
  }
}

export const isUUID = (s: string | undefined): s is UUID => Boolean(s && /^[0-9a-f-]{36}$/i.test(s))
