import { describe, expect, it } from 'vitest'
import type { SettlePerson, SettleUpOut } from '@/lib/types'
import { breakdown, byPerson, payLine, paymentsOf, planNote, shortNames, who } from './logic'

const person = (name: string, is_self = false): SettlePerson => ({ person_id: name, name, color_seed: 200, is_self })
const pay = (from: SettlePerson, to: SettlePerson, amount_cents = 500) => ({ from_person: from, to_person: to, amount_cents, bill_count: 1 })
const debt = (bill: string, from: SettlePerson, to: SettlePerson, amount: number) => ({
  bill_id: bill, title: bill, bill_date: null, from_person: from, to_person: to, amount_cents: amount, currency: 'SGD', original_cents: amount,
})
const me = person('Alice', true)
const bob = person('Bob')
const cat = person('Cat')

// Bob owes me 5, Cat owes Bob 5 → simplified: Cat pays me 5.
const data: SettleUpOut = {
  combined_into: null,
  currencies: ['SGD'],
  missing_rates: [],
  groups: [{
    currency: 'SGD', original: [pay(bob, me), pay(cat, bob)], simplified: [pay(cat, me)], cancel_out: [],
    debts: [debt('b2', cat, bob, 500), debt('b1', bob, me, 500)],
  }],
}

describe('settle up per person', () => {
  it('puts each payment on the payer’s row and totals the payee', () => {
    const simple = byPerson(data, 'simplified')
    expect(simple.get('Cat')?.pays.map((x) => x.payment.to_person.name)).toEqual(['Alice'])
    expect(simple.get('Alice')?.gets).toEqual([{ currency: 'SGD', amount: 500, from: [cat] }])
    expect(simple.has('Bob')).toBe(false) // Bob ends up even

    const original = byPerson(data, 'original')
    expect(original.get('Bob')?.pays).toHaveLength(1)
    expect(original.get('Bob')?.gets).toEqual([{ currency: 'SGD', amount: 500, from: [cat] }])
  })

  it('marks loops that cancel out, in the simplified view only', () => {
    const loop: SettleUpOut = { ...data, groups: [{ currency: 'SGD', original: [pay(me, bob), pay(bob, me)], simplified: [], cancel_out: [me, bob], debts: [] }] }
    expect(byPerson(loop, 'simplified').get('Bob')?.cancelOut).toEqual(['SGD'])
    expect(byPerson(loop, 'original').get('Bob')?.cancelOut).toEqual([])
  })

  it('words a payment from the payer’s row and from anywhere', () => {
    expect(who(me)).toBe('you')
    expect(who(bob)).toBe('Bob')
    expect(payLine(pay(bob, me))).toBe('Bob pays you')
  })

  it('shortens names to first names unless two people share one', () => {
    const ben1 = person('Ben Tan')
    const ben2 = { ...person('Ben Lee'), person_id: 'Ben Lee' }
    const alex = person('Alexandra Wellington-Fairbanks')
    const names = shortNames({ ...data, groups: [{ currency: 'SGD', original: [pay(ben1, alex), pay(ben2, alex)], simplified: [], cancel_out: [], debts: [] }] })
    expect(who(alex, names)).toBe('Alexandra')
    expect([who(ben1, names), who(ben2, names)]).toEqual(['Ben Tan', 'Ben Lee'])
  })

  it('breaks a balance down into the bills behind it', () => {
    const [bobs] = breakdown(data, 'Bob')
    expect(bobs?.net).toBe(0) // owes Alice 5 on b1, Cat owes him 5 on b2
    expect(bobs?.lines.map((l) => [l.debt.bill_id, l.incoming])).toEqual([['b2', true], ['b1', false]])
    expect(breakdown(data, 'Cat')[0]?.net).toBe(-500)
    expect(breakdown(data, 'Nobody')).toEqual([])
  })

  it('lists every payment a person is part of, both ways', () => {
    expect(paymentsOf(data, 'original', 'Bob').map((x) => [x.payment.to_person.name, x.incoming])).toEqual([['Alice', false], ['Bob', true]])
    expect(paymentsOf(data, 'simplified', 'Bob')).toEqual([])
  })

  it('says what simplifying saves', () => {
    expect(planNote(data, 'simplified')).toBe('2 debts simplified to 1 payment')
    expect(planNote(data, 'original')).toBe('2 debts, as the bills say')
    expect(planNote({ ...data, groups: [] }, 'simplified')).toBeNull()
  })
})
