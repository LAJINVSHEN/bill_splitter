/**
 * Dates and names for bill lists. Calendar dates ("2026-10-03") are read as local parts,
 * never through Date's UTC parsing, so a bill never shifts a day across time zones.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface CalendarDate {
  y: number
  m: number // 1-12
  d: number
}

export function parseCalendarDate(iso: string | null | undefined): CalendarDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  if (!m) return null
  const date = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  return date.m >= 1 && date.m <= 12 && date.d >= 1 && date.d <= 31 ? date : null
}

/** List date: "03 Oct", plus the year when it isn't this year ("03 Oct 2025"). */
export function shortDate(iso: string | null | undefined, today: Date = new Date()): string {
  const c = parseCalendarDate(iso)
  if (!c) return ''
  const base = `${String(c.d).padStart(2, '0')} ${MONTHS[c.m - 1]}`
  return c.y === today.getFullYear() ? base : `${base} ${c.y}`
}

/** Heading date: "Sat 3 Oct" (+ year when it isn't this year). */
export function longDate(iso: string | null | undefined, today: Date = new Date()): string {
  const c = parseCalendarDate(iso)
  if (!c) return ''
  const weekday = DAYS[new Date(c.y, c.m - 1, c.d).getDay()]
  const base = `${weekday} ${c.d} ${MONTHS[c.m - 1]}`
  return c.y === today.getFullYear() ? base : `${base} ${c.y}`
}

/** A server timestamp shown as the local calendar day: "7 Oct". */
export function dayOf(timestamp: string | null | undefined, today: Date = new Date()): string {
  if (!timestamp) return ''
  const t = new Date(timestamp)
  if (Number.isNaN(t.getTime())) return ''
  const base = `${t.getDate()} ${MONTHS[t.getMonth()]}`
  return t.getFullYear() === today.getFullYear() ? base : `${base} ${t.getFullYear()}`
}

/** "October" from "2026-10". */
export function monthName(yyyyMm: string): string {
  const m = /^\d{4}-(\d{2})$/.exec(yyyyMm)
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return m ? (names[Number(m[1]) - 1] ?? yyyyMm) : yyyyMm
}

export function billName(b: { title: string | null; merchant: string | null }): string {
  return b.title?.trim() || b.merchant?.trim() || 'Untitled bill'
}

export function peopleCount(n: number): string {
  return n === 1 ? '1 person' : `${n} people`
}

export function participantNames(bill: { participant_count: number; participant_names?: string[] }): string {
  if (!bill.participant_names?.length) return peopleCount(bill.participant_count)
  const names = bill.participant_names.slice(0, 2).join(', ')
  const overflow = Math.max(bill.participant_count, bill.participant_names.length) - 2
  return overflow > 0 ? `${names} +${overflow}` : names
}
