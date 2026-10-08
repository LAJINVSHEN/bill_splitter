import type { PublicPerson, PublicShareOut } from '@/lib/types'

const VULGAR: Record<string, string> = {
  '1/2': '½',
  '1/3': '⅓',
  '2/3': '⅔',
  '1/4': '¼',
  '3/4': '¾',
  '1/5': '⅕',
  '2/5': '⅖',
  '3/5': '⅗',
  '4/5': '⅘',
  '1/6': '⅙',
  '5/6': '⅚',
  '1/8': '⅛',
}

/** "½", "⅓", or "2/7" for anything without a glyph. Whole shares get no label. */
export function fractionLabel(num: number, den: number): string {
  if (den <= 1 || num <= 0 || num >= den) return ''
  const g = gcd(num, den)
  const key = `${num / g}/${den / g}`
  return VULGAR[key] ?? key
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/**
 * Item fraction labels for a whole-bill link, where we can see every person's share of an item.
 * An item split n ways in near-equal parts (allocation leaves at most 1 minor unit of difference)
 * reads "½", "⅓"…; unequal splits get no label rather than a misleading one.
 * Keyed by item name: names repeated on a receipt are only labelled when unambiguous.
 */
export function billFractions(people: PublicPerson[]): Map<string, string> {
  const shares = new Map<string, number[]>()
  const perPersonCounts = new Map<string, number>()
  for (const p of people) {
    const seen = new Map<string, number>()
    for (const it of p.items) {
      seen.set(it.name, (seen.get(it.name) ?? 0) + 1)
      const list = shares.get(it.name) ?? []
      list.push(it.share_cents)
      shares.set(it.name, list)
    }
    for (const [name, n] of seen) perPersonCounts.set(name, Math.max(perPersonCounts.get(name) ?? 0, n))
  }
  const out = new Map<string, string>()
  for (const [name, list] of shares) {
    if ((perPersonCounts.get(name) ?? 0) > 1) continue // same name twice for one person: ambiguous
    if (list.length < 2) continue
    const max = Math.max(...list)
    const min = Math.min(...list)
    if (max - min <= 1) out.set(name, fractionLabel(1, list.length))
  }
  return out
}

/** The amount to show big: what they owe in the effective currency (settle currency when converted). */
export function effectiveTotal(share: Pick<PublicShareOut, 'settle_currency'>, p: PublicPerson): number {
  return share.settle_currency && p.settle_total_cents !== null ? p.settle_total_cents : p.total_cents
}

/** Who the link is about, and whether the bill was converted into another currency. */
export function isConverted(share: Pick<PublicShareOut, 'settle_currency' | 'fx_rate'>): boolean {
  return Boolean(share.settle_currency && share.fx_rate)
}

/** First name for friendly copy: "Lena Okafor" → "Lena". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}
