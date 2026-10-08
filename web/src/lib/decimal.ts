/**
 * Exact decimal helpers on BigInt. Money never touches floating point:
 * the backend uses Decimal ROUND_HALF_UP and this mirror must agree to the minor unit.
 */

export interface Rational {
  num: bigint
  den: bigint
}

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?$/

/** "0.2950" → 2950/10000. Throws on anything that isn't a plain decimal. */
export function parseDecimal(value: string | number): Rational {
  const text = typeof value === 'number' ? numberToPlainString(value) : value.trim()
  const m = DECIMAL_RE.exec(text)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`not a decimal: ${String(value)}`)
  const frac = m[3] ?? ''
  const digits = `${m[2] || '0'}${frac}`
  const num = BigInt(digits) * (m[1] === '-' ? -1n : 1n)
  return { num, den: 10n ** BigInt(frac.length) }
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite number: ${n}`)
  if (Number.isInteger(n)) return n.toString()
  // toString gives the shortest round-tripping representation (e.g. 0.1 → "0.1"), like Python's str().
  const s = n.toString()
  if (!/e/i.test(s)) return s
  return n.toFixed(20).replace(/0+$/, '')
}

/** ROUND_HALF_UP (halves away from zero) of num/den, as a JS number. */
export function roundHalfUp(num: bigint, den: bigint): number {
  if (den === 0n) throw new Error('division by zero')
  const negative = num < 0n !== den < 0n && num !== 0n
  const a = num < 0n ? -num : num
  const b = den < 0n ? -den : den
  let q = a / b
  if ((a % b) * 2n >= b) q += 1n
  return Number(negative ? -q : q)
}

export function isPositiveDecimal(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false
  try {
    return parseDecimal(value).num > 0n
  } catch {
    return false
  }
}
