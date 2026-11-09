import { describe, expect, it } from 'vitest'
import type { MailRequest, MailUpdate } from '@/lib/types'
import { ago, requestText, updateLink, updateText, waitingLine } from './text'

const actor = { id: 'a', name: 'Maya Lim', username: 'maya', color_seed: 10 }
const req = (over: Partial<MailRequest>): MailRequest => ({
  kind: 'friend_request', id: 'r', created_at: '2026-11-09T10:00:00Z', actor, person_id: null, person_name: null,
  color_seed: null, bill_id: null, bill_title: null, bill_date: null, bill_count: null, amount_cents: null,
  currency: null, expected_total_cents: null, ...over,
})
const upd = (over: Partial<MailUpdate>): MailUpdate => ({
  id: 'u', kind: 'bill_edited', actor, bill_id: 'b', bill_title: 'Dinner', count: 1, data: {}, unread: true,
  at: '2026-11-09T10:00:00Z', ...over,
})

describe('mailbox text', () => {
  it('says what each request wants, with first names', () => {
    expect(requestText(req({}))).toBe('Maya wants to be friends')
    expect(requestText(req({ kind: 'link_invite', person_name: 'Maya (old)' }))).toBe('Maya says “Maya (old)” on their bills is you')
    expect(requestText(req({ kind: 'payment_claim', actor: null, person_name: 'Ben Ong' }))).toBe('Ben says they’ve paid')
  })

  it('folds repeated edits into one line', () => {
    expect(updateText(upd({}))).toBe('Maya edited Dinner')
    expect(updateText(upd({ count: 3 }))).toBe('Maya edited Dinner · 3 changes')
    expect(updateText(upd({ kind: 'link_declined', bill_id: null, data: { person_name: 'Jeff' } }))).toBe('Maya isn’t “Jeff”')
  })

  it('links updates to their bill, friend news to People', () => {
    expect(updateLink(upd({}))).toBe('/bills/b')
    expect(updateLink(upd({ kind: 'friend_accepted', bill_id: null }))).toBe('/people')
    expect(updateLink(upd({ kind: 'plan_sent', bill_id: null }))).toBeNull()
  })

  it('reads times like a person would', () => {
    const now = new Date('2026-11-09T12:00:00')
    expect(ago('2026-11-09T11:59:30', now)).toBe('just now')
    expect(ago('2026-11-09T11:15:00', now)).toBe('45 min ago')
    expect(ago('2026-11-09T08:00:00', now)).toBe('4 h ago')
    expect(ago('2026-11-08T20:00:00', now)).toBe('Yesterday')
    expect(ago('2026-11-03T20:00:00', now)).toBe('3 Nov')
  })

  it('sums up what is waiting for Home', () => {
    expect(waitingLine([])).toBeNull()
    expect(waitingLine([req({}), req({ id: 'x' }), req({ id: 'y' })])).toBe('Maya wants to be friends · 2 more')
  })
})
