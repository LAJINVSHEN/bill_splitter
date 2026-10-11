import type { SettleDebt, SettlePayment, SettlePerson, SettleUpOut, SettleView, UUID } from '@/lib/types'

/** One person's part of the plan, for their row on People. */
export interface PersonSettle {
  person: SettlePerson
  pays: Array<{ payment: SettlePayment; currency: string }> // they send these (the actions live here)
  gets: Array<{ currency: string; amount: number; from: SettlePerson[] }> // incoming, summed per currency
  cancelOut: string[] // currencies where their debts cancel in a loop (nothing to pay)
}

/** The plan, keyed by person: each payment sits on its payer's row; payees see a total. */
export function byPerson(data: SettleUpOut | undefined, view: SettleView): Map<UUID, PersonSettle> {
  const out = new Map<UUID, PersonSettle>()
  const entry = (person: SettlePerson) => {
    let e = out.get(person.person_id)
    if (!e) out.set(person.person_id, (e = { person, pays: [], gets: [], cancelOut: [] }))
    return e
  }
  for (const g of data?.groups ?? []) {
    for (const payment of view === 'original' ? g.original : g.simplified) {
      entry(payment.from_person).pays.push({ payment, currency: g.currency })
      const gets = entry(payment.to_person).gets
      const same = gets.find((x) => x.currency === g.currency)
      if (same) {
        same.amount += payment.amount_cents
        same.from.push(payment.from_person)
      } else gets.push({ currency: g.currency, amount: payment.amount_cents, from: [payment.from_person] })
    }
    if (view === 'simplified') for (const p of g.cancel_out) entry(p).cancelOut.push(g.currency)
  }
  return out
}

/** Short names for lines inside a row: first names, unless two people share one. */
export function shortNames(data: SettleUpOut | undefined): Map<UUID, string> {
  const people = new Map<UUID, SettlePerson>()
  for (const g of data?.groups ?? [])
    for (const p of [...g.original, ...g.simplified]) for (const x of [p.from_person, p.to_person]) people.set(x.person_id, x)
  const first = (p: SettlePerson) => p.name.trim().split(/\s+/)[0] ?? p.name
  const count = new Map<string, number>()
  for (const p of people.values()) count.set(first(p), (count.get(first(p)) ?? 0) + 1)
  return new Map([...people.values()].map((p) => [p.person_id, (count.get(first(p)) ?? 0) > 1 ? p.name : first(p)]))
}

/** Every payment one person is part of, in the plan's current view: what they send and receive. */
export function paymentsOf(data: SettleUpOut | undefined, view: SettleView, personId: UUID) {
  const out: Array<{ payment: SettlePayment; currency: string; incoming: boolean }> = []
  for (const g of data?.groups ?? [])
    for (const payment of view === 'original' ? g.original : g.simplified) {
      if (payment.from_person.person_id === personId) out.push({ payment, currency: g.currency, incoming: false })
      else if (payment.to_person.person_id === personId) out.push({ payment, currency: g.currency, incoming: true })
    }
  return out
}

/** A counterparty inside someone's row: "you" or their short name. */
export const who = (p: SettlePerson, names?: Map<UUID, string>) => (p.is_self ? 'you' : (names?.get(p.person_id) ?? p.name))

/** For screen readers and toasts, where the row isn't there: "Bob pays you". */
export function payLine(p: Pick<SettlePayment, 'from_person' | 'to_person'>): string {
  if (p.from_person.is_self) return `You pay ${p.to_person.name}`
  if (p.to_person.is_self) return `${p.from_person.name} pays you`
  return `${p.from_person.name} pays ${p.to_person.name}`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Under the page title: what simplifying saves. Null when there's nothing to settle. */
export function planNote(data: SettleUpOut | undefined, view: SettleView): string | null {
  const groups = data?.groups ?? []
  const debts = groups.reduce((n, g) => n + g.original.length, 0)
  const payments = groups.reduce((n, g) => n + g.simplified.length, 0)
  if (debts === 0) return null
  if (view === 'original') return `${plural(debts, 'debt')}, as the bills say`
  return payments < debts ? `${plural(debts, 'debt')} simplified to ${plural(payments, 'payment')}` : `${plural(payments, 'payment')} to settle`
}

/** One person's breakdown, per currency: the bills behind their balance and where it nets to. */
export interface Breakdown {
  currency: string
  net: number // > 0: they get money back; < 0: they owe
  lines: Array<{ debt: SettleDebt; incoming: boolean }>
}

export function breakdown(data: SettleUpOut | undefined, personId: UUID): Breakdown[] {
  const out: Breakdown[] = []
  for (const g of data?.groups ?? []) {
    const lines = g.debts
      .filter((d) => d.from_person.person_id === personId || d.to_person.person_id === personId)
      .map((debt) => ({ debt, incoming: debt.to_person.person_id === personId }))
    if (lines.length === 0) continue
    out.push({ currency: g.currency, net: lines.reduce((n, l) => n + (l.incoming ? 1 : -1) * l.debt.amount_cents, 0), lines })
  }
  return out
}
