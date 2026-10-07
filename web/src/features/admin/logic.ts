import type { AdminUserOut } from '@/lib/types'

/** Usernames: 3–32 of [a-z0-9_.-], starting with a letter or digit (backend/app/schemas/admin.py). */
export const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]*$/

/** Lower-cased as typed, spaces dropped: "Mei Ling" → "meiling". */
export function normaliseUsername(input: string): string {
  return input.toLowerCase().replace(/\s+/g, '')
}

export function usernameError(username: string): string | null {
  if (username.length < 3) return 'At least 3 characters.'
  if (username.length > 32) return 'At most 32 characters.'
  if (!USERNAME_RE.test(username)) return 'Letters, digits, dot, dash or underscore; start with a letter or digit.'
  return null
}

export function emailError(email: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? null : 'Enter their Google email address.'
}

/** Whole number within [min, max]; null when it isn't one. */
export function parseCount(input: string, min: number, max: number): number | null {
  const text = input.trim()
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return n >= min && n <= max ? n : null
}

/** Dollars from cost micros: 1_820_000 → "$1.82"; tiny non-zero spend shows as "< $0.01". */
export function formatUsd(micros: number): string {
  if (micros > 0 && micros < 5_000) return '< $0.01'
  const cents = Math.round(micros / 10_000)
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** "8" or "8.50" → micros (8_500_000). Cent precision; null when it isn't a non-negative amount. */
export function parseUsdToMicros(input: string): number | null {
  const m = /^\$?\s*(\d{1,7})(?:\.(\d{0,2}))?$/.exec(input.trim().replace(/,/g, ''))
  if (!m) return null
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
  return cents * 10_000
}

/** "8.00" for the budget input. */
export function microsToUsdInput(micros: number): string {
  return (Math.round(micros / 10_000) / 100).toFixed(2)
}

export interface UserTag {
  label: string
  tone: 'cobalt' | 'warn' | 'danger' | 'quiet'
}

/** The one line under a name: the most important state first, colour only when it needs attention. */
export function userTags(u: AdminUserOut): UserTag[] {
  const tags: UserTag[] = []
  if (u.disabled_at) tags.push({ label: 'Disabled', tone: 'danger' })
  if (u.role === 'admin') tags.push({ label: 'Admin', tone: 'cobalt' })
  if (u.must_change_password) tags.push({ label: 'Must change password', tone: 'warn' })
  if (!u.disabled_at && u.monthly_scan_quota > 0 && u.pages_used_this_month >= u.monthly_scan_quota)
    tags.push({ label: 'At limit', tone: 'warn' })
  if (tags.length === 0) tags.push({ label: 'Member', tone: 'quiet' })
  return tags
}

export function atLimit(used: number, limit: number): boolean {
  return limit > 0 ? used >= limit : used > 0
}
