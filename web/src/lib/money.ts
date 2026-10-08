import data from '@shared/currencies.json'

/**
 * Every *_cents value in the API is an integer in MINOR units of its currency
 * (SGD 2 decimals, JPY 0, KWD 3). Shared table: shared/currencies.json.
 */
export interface CurrencyInfo {
  code: string
  exponent: number
  name: string
  symbol?: string
}

const TABLE = new Map<string, CurrencyInfo>(
  (data.currencies as CurrencyInfo[]).map((c) => [c.code, c]),
)

export const CURRENCIES: readonly CurrencyInfo[] = [...TABLE.values()].sort((a, b) =>
  a.code.localeCompare(b.code),
)

export function currencyInfo(code: string): CurrencyInfo {
  return TABLE.get(code.toUpperCase()) ?? { code: code.toUpperCase(), exponent: 2, name: code.toUpperCase() }
}

export function exponentOf(code: string): number {
  return currencyInfo(code).exponent
}

const groupFmt = new Intl.NumberFormat('en-SG', { maximumFractionDigits: 0 })

/** 123456 SGD → "1,234.56"; 14820 JPY → "14,820"; -500 → "-5.00". No currency code. */
export function formatAmount(minor: number, currency: string): string {
  const exp = exponentOf(currency)
  const negative = minor < 0
  const abs = Math.abs(Math.trunc(minor))
  const scale = 10 ** exp
  const major = Math.floor(abs / scale)
  const frac = abs % scale
  const text = exp > 0 ? `${groupFmt.format(major)}.${String(frac).padStart(exp, '0')}` : groupFmt.format(major)
  return negative ? `-${text}` : text
}

/** "SGD 1,234.56" */
export function formatMoney(minor: number, currency: string): string {
  return `${currency.toUpperCase()} ${formatAmount(minor, currency)}`
}

/** Plain value for an input field: 1234 SGD → "12.34" (no grouping). */
export function minorToInput(minor: number, currency: string): string {
  const exp = exponentOf(currency)
  if (exp === 0) return String(minor)
  const negative = minor < 0
  const abs = Math.abs(minor)
  const s = `${Math.floor(abs / 10 ** exp)}.${String(abs % 10 ** exp).padStart(exp, '0')}`
  return negative ? `-${s}` : s
}

/**
 * Parse what a person typed into minor units, half-up like the backend ("12.345" SGD → 1235).
 * Accepts thousands separators and a leading currency symbol/code. Returns null when it isn't a number.
 */
export function parseToMinor(text: string, currency: string): number | null {
  const cleaned = text.replace(/[\s,]/g, '').replace(/^[A-Za-z$€£¥₹₩₫฿]+/, '')
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(cleaned)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null
  const exp = exponentOf(currency)
  const whole = BigInt(m[2] || '0')
  const fracDigits = m[3] ?? ''
  const scale = 10n ** BigInt(exp)
  let minor = whole * scale
  if (fracDigits.length <= exp) {
    minor += BigInt(fracDigits.padEnd(exp, '0') || '0')
  } else {
    const kept = BigInt(fracDigits.slice(0, exp) || '0')
    const rest = fracDigits.slice(exp)
    const roundUp = Number(rest[0]) >= 5
    minor += kept + (roundUp ? 1n : 0n)
  }
  const value = Number(minor)
  if (!Number.isSafeInteger(value)) return null
  return m[1] === '-' ? -value : value
}
