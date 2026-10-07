import { useState } from 'react'
import { Button } from '@/components/Button'
import { EvenBadge, Money, Notice } from '@/components/Display'
import { Dialog } from '@/components/Feedback'
import { controlClass } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { useSettle, useUnsettle } from '@/data/queries'
import { cn } from '@/lib/cn'
import { minorToInput, parseToMinor } from '@/lib/money'
import type { BillOut, SplitPersonOut } from '@/lib/types'
import { MoneyInput } from './inputs'

/**
 * One person on the bill: what they had, their cut of charges, and their payment.
 * Partial payments live here; "Mark paid" on the row covers the usual full amount.
 */
export function PersonSheet({
  bill,
  person,
  onClose,
  onSendLink,
  sending,
  sendDisabled,
}: {
  bill: BillOut
  person: SplitPersonOut | null
  onClose: () => void
  onSendLink: (p: SplitPersonOut) => void
  sending: boolean
  sendDisabled: boolean
}) {
  return (
    <Dialog open={Boolean(person)} onClose={onClose} title={person ? (person.is_self ? 'You' : person.name) : ''}>
      {person && <Body key={person.person_id} bill={bill} person={person} onSendLink={onSendLink} sending={sending} sendDisabled={sendDisabled} />}
    </Dialog>
  )
}

function Body({ bill, person, onSendLink, sending, sendDisabled }: { bill: BillOut; person: SplitPersonOut; onSendLink: (p: SplitPersonOut) => void; sending: boolean; sendDisabled: boolean }) {
  const settle = useSettle(bill.id)
  const unsettle = useUnsettle(bill.id)
  const eff = bill.split.effective_currency
  const converted = Boolean(bill.split.settle_currency)
  const paid = person.settled_amount_cents ?? 0
  const [amount, setAmount] = useState(minorToInput(person.outstanding_cents || person.effective_total_cents, eff))
  const minor = parseToMinor(amount, eff)
  const error = settle.error ?? unsettle.error

  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="What they had" className="border-t-[1.5px] border-ink">
        {person.items.map((it) => (
          <li key={it.item_id} className="flex min-h-11 items-center justify-between gap-3 border-b border-rule text-[16px]">
            <span className="min-w-0 truncate">{it.name}</span>
            <Money minor={it.share_cents} currency={bill.currency} className="font-semibold" />
          </li>
        ))}
        {person.adjustment_cents !== 0 && (
          <li className="flex min-h-11 items-center justify-between gap-3 border-b border-rule text-[16px]">
            <span>{person.adjustment_cents < 0 ? 'Discounts' : 'Tax, service & charges'}</span>
            <Money minor={person.adjustment_cents} currency={bill.currency} className="font-semibold" />
          </li>
        )}
        <li className="flex min-h-12 items-center justify-between gap-3 text-[17px] font-bold">
          <span>Total</span>
          <span className="text-right">
            <Money minor={person.effective_total_cents} currency={eff} code />
            {converted && (
              <span className="block text-[14px] font-semibold text-ink-2">
                <Money minor={person.total_cents} currency={bill.currency} code />
              </span>
            )}
          </span>
        </li>
      </ul>

      {person.is_payer ? (
        <p className="text-[16px] font-semibold">{person.is_self ? 'You paid the bill.' : `${person.name} paid the bill.`}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {person.settled_at && (
            <div className="flex min-h-11 items-center justify-between gap-3">
              {person.outstanding_cents === 0 ? (
                <EvenBadge />
              ) : (
                <span className="text-[16px] font-semibold">
                  Paid <Money minor={paid} currency={eff} /> · <span className="text-warn"><Money minor={person.outstanding_cents} currency={eff} /> left</span>
                </span>
              )}
              <Button variant="quiet" loading={unsettle.isPending} onClick={() => unsettle.mutate(person.person_id)}>
                Undo payment
              </Button>
            </div>
          )}
          {person.outstanding_cents > 0 && (
            <>
              <form
                className="flex items-end gap-2.5"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (minor !== null && minor > 0) settle.mutate({ personId: person.person_id, amount_cents: paid + minor })
                }}
              >
                <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="text-[15px] font-semibold">{person.settled_at ? 'Paid more' : 'Paid'} ({eff})</span>
                  <MoneyInput currency={eff} value={amount} onChange={setAmount} className={cn(controlClass, 'text-right')} />
                </label>
                <Button type="submit" variant="secondary" loading={settle.isPending && settle.variables?.amount_cents !== undefined} disabled={minor === null || minor <= 0}>
                  Save
                </Button>
              </form>
              <Button block loading={settle.isPending && settle.variables?.amount_cents === undefined} onClick={() => settle.mutate({ personId: person.person_id })}>
                Mark paid in full
              </Button>
            </>
          )}
          {!person.is_self && (
            <Button variant="secondary" block icon={<Icon name="link" size={18} />} loading={sending} disabled={sendDisabled} onClick={() => onSendLink(person)}>
              Send link
            </Button>
          )}
        </div>
      )}
      {error && <Notice tone="danger">{error.message}</Notice>}
    </div>
  )
}
