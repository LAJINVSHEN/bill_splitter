/**
 * The text the owner pastes into a chat: plain text that reads the same in WhatsApp, Telegram,
 * iMessage, SMS and Line (no *bold*, no emoji, no column padding), with the link last on its own
 * line so every app turns it into a link. See .skills/DESIGN_SHARING.md §2.
 */
import { billTitle, shortDate } from '@/features/bill/flow'
import { formatAmount } from '@/lib/money'
import type { BillOut, SplitPersonOut, UUID } from '@/lib/types'
import { firstName, fractionLabel } from './logic'

export type MessageScope = { kind: 'group' } | { kind: 'person'; personId: UUID }

const MAX_ITEM_LINES = 6

export const amountText = (minor: number, currency: string) => `${currency} ${formatAmount(minor, currency)}`

/**
 * The link with a fragment the page can draw before the server answers: "#g" for the group, or
 * "#p.{minor}.{currency}" with what this person owed when it was sent. Never sent to any server.
 */
export function linkWithFragment(url: string, scope: MessageScope, bill: BillOut): string {
  if (scope.kind === 'group') return `${url}#g`
  const p = bill.split.people.find((x) => x.person_id === scope.personId)
  return p ? `${url}#p.${p.outstanding_cents}.${bill.split.effective_currency}` : url
}

/** "(paid)", "(SGD 18.60 left)", "(says paid)" or nothing when they owe it all. */
function status(p: SplitPersonOut, eff: string, claimed: Set<UUID>): string {
  if (p.outstanding_cents === 0) return ' (paid)'
  if (claimed.has(p.person_id)) return ' (says paid)'
  if (p.outstanding_cents < p.effective_total_cents) return ` (${amountText(p.outstanding_cents, eff)} left)`
  return ''
}

function payLine(payer: SplitPersonOut | undefined, hostName: string, note: string | null | undefined): string | null {
  if (!payer) return null
  const who = firstName(payer.is_self ? hostName : payer.name)
  if (payer.is_self) return note?.trim() ? `Pay ${who}: ${note.trim()}` : null
  return `Pay ${who} back directly.`
}

function conversionLine(bill: BillOut): string | null {
  const s = bill.split
  if (!s.settle_currency || !s.fx_rate) return null
  const rate = s.fx_rate.includes('.') ? s.fx_rate.replace(/0+$/, '').replace(/\.$/, '') : s.fx_rate
  return `Amounts in ${s.settle_currency}. 1 ${s.currency} = ${rate} ${s.settle_currency}.`
}

/** Item share labels from the bill itself: "½" for an item split equally between two, and so on. */
function itemFraction(bill: BillOut, itemId: UUID): string {
  const item = bill.items.find((i) => i.id === itemId)
  if (!item || item.split_mode !== 'equal' || item.shares.length < 2) return ''
  return fractionLabel(1, item.shares.length)
}

export function buildShareMessage({
  bill,
  hostName,
  paymentNote,
  scope,
  url,
}: {
  bill: BillOut
  /** the owner's display name (the bill's "Me"), never "Me" or "You": others read this */
  hostName: string
  paymentNote?: string | null
  scope: MessageScope
  /** the link, fragment included */
  url: string
}): string {
  const s = bill.split
  const eff = s.effective_currency
  const title = billTitle(bill)
  const date = shortDate(bill.bill_date)
  const payer = s.people.find((p) => p.is_payer)
  const name = (p: SplitPersonOut) => (p.is_self ? hostName : p.name)
  const host = firstName(hostName)
  const claimed = new Set((bill.claims ?? []).map((c) => c.person_id))
  const pay = payLine(payer, hostName, paymentNote)
  const conv = conversionLine(bill)

  if (scope.kind === 'group') {
    const total = s.settle_grand_total_cents ?? s.grand_total_cents
    const others = s.people.filter((p) => !p.is_payer)
    const owing = [...others.filter((p) => p.outstanding_cents > 0), ...others.filter((p) => p.outstanding_cents === 0)]
    const lines = [
      date ? `${title} · ${date}` : title,
      `Total ${amountText(total, eff)}${payer ? `, paid by ${name(payer)}` : ''}`,
      '',
      ...owing.map((p) => `${name(p)}  ${amountText(p.effective_total_cents, eff)}${status(p, eff, claimed)}`),
      ...(payer ? [`${name(payer)}  ${amountText(payer.effective_total_cents, eff)} (paid the bill)`] : []),
      '',
      ...(conv ? [conv] : []),
      ...(pay ? [pay] : []),
      'Find your name to see your items and tap "I’ve paid":',
      url,
    ]
    return lines.join('\n')
  }

  const p = s.people.find((x) => x.person_id === scope.personId)
  if (!p) return url
  const converted = Boolean(s.settle_currency && s.fx_rate)
  const left = p.outstanding_cents > 0 && p.outstanding_cents < p.effective_total_cents ? ` (${amountText(p.outstanding_cents, eff)} left)` : ''
  const original = converted ? ` (${amountText(p.total_cents, s.currency)})` : ''
  const when = date ? ` (${date})` : ''
  // a quick split is one made-up "Total" item: listing it adds nothing
  const listed = bill.source === 'quick' ? [] : p.items
  const items = listed.slice(0, MAX_ITEM_LINES).map((it) => {
    const frac = itemFraction(bill, it.item_id)
    return `- ${it.name}${frac ? ` ${frac}` : ''} ${amountText(it.share_cents, s.currency)}`
  })
  const more = listed.length - MAX_ITEM_LINES
  const adj = p.adjustment_cents
  const lines = [
    `Hi ${firstName(p.name)}, your share of ${title}${when} is ${amountText(p.effective_total_cents, eff)}${original}${left}`,
    '',
    ...items,
    ...(more > 0 ? [`- and ${more} more`] : []),
    ...(adj !== 0 ? [`- ${adj > 0 ? 'Tax and service' : 'Discounts'} ${amountText(adj, s.currency)}`] : []),
    ...(items.length || adj !== 0 ? [''] : []),
    ...(pay && !p.is_payer ? [pay] : []),
    p.outstanding_cents > 0 ? `When you’ve paid, tap here so ${host} knows:` : 'Your share, item by item:',
    url,
  ]
  return lines.join('\n')
}
