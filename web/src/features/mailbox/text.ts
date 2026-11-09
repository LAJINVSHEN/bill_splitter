import type { MailRequest, MailUpdate } from '@/lib/types'

/** First names in sentences, like the rest of the app ("Maya", not "Maya Lim"). */
export const first = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] || 'Someone'

/** The one line that says what a request wants from you. */
export function requestText(r: MailRequest): string {
  const who = first(r.actor?.name ?? r.person_name)
  switch (r.kind) {
    case 'friend_request':
      return `${who} wants to be friends`
    case 'link_invite':
      return `${who} says “${r.person_name ?? ''}” on their bills is you`
    case 'payment_claim':
      return `${first(r.person_name)} says they’ve paid`
  }
}

/** What happened, in one line. Repeated edits to one bill arrive as one update with a count. */
export function updateText(u: MailUpdate): string {
  const who = first(u.actor?.name)
  const bill = u.bill_title ?? 'a bill'
  switch (u.kind) {
    case 'friend_accepted':
      return `${who} accepted your friend request`
    case 'friend_declined':
      return `${who} said no to your friend request`
    case 'link_accepted':
      return `${who} is now “${u.data.person_name ?? ''}” on your bills`
    case 'link_declined':
      return `${who} isn’t “${u.data.person_name ?? ''}”`
    case 'bill_added':
      return `${who} added you to ${bill}`
    case 'bill_edited':
      return u.count > 1 ? `${who} edited ${bill} · ${u.count} changes` : `${who} edited ${bill}`
    case 'claim_confirmed':
      return `${who} confirmed your payment for ${bill}`
    case 'claim_rejected':
      return `${who} hasn’t received your payment for ${bill} yet`
    case 'plan_sent':
      return `${who} sent the ${u.data.group ?? 'group'} plan`
  }
}

/** Where tapping an update takes you. */
export function updateLink(u: MailUpdate): string | null {
  if (u.bill_id) return `/bills/${u.bill_id}`
  if (u.kind === 'plan_sent') return null
  return '/people'
}

/** "just now", "12 min ago", "3 h ago", "Yesterday", "3 Nov". */
export function ago(iso: string, now: Date = new Date()): string {
  const t = new Date(iso)
  const s = Math.max(0, (now.getTime() - t.getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (t.getTime() >= startOfToday) return `${Math.floor(s / 3600)} h ago`
  if (t.getTime() >= startOfToday - 86_400_000) return 'Yesterday'
  const base = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(t)
  return t.getFullYear() === now.getFullYear() ? base : `${base} ${t.getFullYear()}`
}

/** Home's one line into the Mailbox: the newest request, and how many more. */
export function waitingLine(requests: MailRequest[]): string | null {
  const [top, ...rest] = requests
  if (!top) return null
  return rest.length ? `${requestText(top)} · ${rest.length} more` : requestText(top)
}
