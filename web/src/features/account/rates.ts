import type { FxRateOut } from '@/lib/types'

/**
 * Saved conversion rates: "1 BASE = rate QUOTE", typed by the user (never fetched).
 * Mirrors the API's checks (backend/app/schemas/common.py `_rate`) so mistakes show inline.
 */
export const MAX_RATE_DIGITS = 15

const RATE_RE = /^(\d*)(?:\.(\d*))?$/

/** What the API gets: the trimmed text without grouping commas (a decimal string, never a float). */
export function normaliseRate(input: string): string {
  return input.trim().replace(/,/g, '')
}

/** Returns an error message, or null when the rate is acceptable. */
export function rateError(input: string): string | null {
  const text = normaliseRate(input)
  if (!text) return 'Enter a rate.'
  const m = RATE_RE.exec(text)
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return 'Use digits and one decimal point, like 0.0091.'
  const all = `${m[1]}${m[2] ?? ''}`
  if (!/[1-9]/.test(all)) return 'The rate must be more than 0.'
  const significant = all.replace(/^0+/, '').replace(/0+$/, '')
  if (significant.length > MAX_RATE_DIGITS) return `Use at most ${MAX_RATE_DIGITS} significant digits.`
  const value = Number(text)
  if (value < 1e-12 || value > 1e12) return 'That rate is out of range.'
  return null
}

export interface RateRow {
  base: string
  quote: string
  rate: string
  derived: boolean
  updated_at: string
}

/** Saved rates (editable), each followed by its inverse (read-only, as the API derives it). */
export function rateRows(saved: FxRateOut[]): RateRow[] {
  const rows: RateRow[] = []
  const sorted = [...saved].sort((a, b) => a.base.localeCompare(b.base) || a.quote.localeCompare(b.quote))
  for (const r of sorted) {
    rows.push({ base: r.base, quote: r.quote, rate: r.rate, derived: false, updated_at: r.updated_at })
    const inverse = invertRate(r.rate)
    if (inverse) rows.push({ base: r.quote, quote: r.base, rate: inverse, derived: true, updated_at: r.updated_at })
  }
  return rows
}

/** 1 / rate to 12 significant digits, half-up, trailing zeros trimmed (matches services/fx.py `invert`). */
export function invertRate(rate: string): string {
  const m = RATE_RE.exec(rate.trim())
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return ''
  const frac = m[2] ?? ''
  const num = BigInt(`${m[1] || '0'}${frac}`)
  if (num === 0n) return ''
  // 1/rate = 10^len(frac) / num. Scale by 10^40 so the quotient always has more than 12 digits.
  const scaled = 10n ** BigInt(frac.length + 40)
  let q = scaled / num
  const rem = scaled % num
  let exp = 40 // value = q / 10^exp
  const cut = q.toString().length - 12
  if (cut > 0) {
    const d = 10n ** BigInt(cut)
    const dropped = q % d
    q /= d
    // half-up on the exact remainder: dropped + rem/num >= d/2
    if (2n * (dropped * num + rem) >= d * num) q += 1n
    exp -= cut
  }
  const digits = q.toString()
  let out: string
  if (exp <= 0) out = digits + '0'.repeat(-exp)
  else if (digits.length > exp) out = `${digits.slice(0, digits.length - exp)}.${digits.slice(digits.length - exp)}`
  else out = `0.${'0'.repeat(exp - digits.length)}${digits}`
  return out.includes('.') ? out.replace(/0+$/, '').replace(/\.$/, '') : out
}
