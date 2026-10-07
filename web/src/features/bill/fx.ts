import { parseDecimal } from '@/lib/decimal'
import type { FxRateOut } from '@/lib/types'

/** Rates are typed by people: digits and one dot, nothing else. */
export const isRateText = (t: string) => /^\d*(\.\d*)?$/.test(t.trim())

/** A rate the API will take: > 0 and at most 15 significant digits. */
export function validRate(t: string): boolean {
  const s = t.trim()
  if (!s || !isRateText(s) || s === '.') return false
  try {
    if (parseDecimal(s).num <= 0n) return false
  } catch {
    return false
  }
  const digits = s.replace('.', '').replace(/^0+/, '').replace(/0+$/, '')
  return digits.length > 0 && digits.length <= 15
}

/** 1 / rate to 12 significant digits, like the backend's derived inverse. Display only. */
export function invertRate(rate: string): string {
  const n = Number(rate)
  if (!(n > 0)) return ''
  const inv = Number((1 / n).toPrecision(12))
  const s = String(inv)
  return /e/i.test(s) ? inv.toFixed(20).replace(/0+$/, '').replace(/\.$/, '') : s
}

/** The saved rate for base→quote: typed directly, or the inverse of quote→base. */
export function savedRate(rates: FxRateOut[] | undefined, base: string, quote: string): { rate: string; derived: boolean } | null {
  if (!rates) return null
  const direct = rates.find((r) => r.base === base && r.quote === quote)
  if (direct) return { rate: trim(direct.rate), derived: false }
  const inverse = rates.find((r) => r.base === quote && r.quote === base)
  return inverse ? { rate: invertRate(inverse.rate), derived: true } : null
}

const trim = (d: string) => (d.includes('.') ? d.replace(/0+$/, '').replace(/\.$/, '') : d)
