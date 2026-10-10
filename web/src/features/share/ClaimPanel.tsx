import { EqualsMark } from '@/components/Brand'
import { Button } from '@/components/Button'
import { EvenBadge, Money, Notice } from '@/components/Display'
import { useToast } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import type { PublicPerson, PublicShareOut } from '@/lib/types'
import { myClaimKey, type useClaims } from './claims'
import { firstName } from './logic'
import { amountText } from './message'

const when = (iso: string) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return new Intl.DateTimeFormat('en-GB', today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' }).format(d)
}

/**
 * Under a person's share: "I've paid" and what happens next. A claim goes to the host to confirm;
 * nothing here changes the bill by itself.
 */
export function ClaimPanel({
  token,
  share,
  person,
  claims,
  personKey,
}: {
  token: string
  share: PublicShareOut
  person: PublicPerson
  claims: ReturnType<typeof useClaims>
  /** group links claim for the picked name; personal links don't need one */
  personKey: string | null
}) {
  const toast = useToast()
  const host = firstName(share.host_name || 'the host')
  const eff = share.effective_currency
  const owed = person.outstanding_cents
  const c = person.claim
  const title = share.title?.trim() || share.merchant?.trim() || 'the bill'

  const letKnow = async () => {
    const text = `Paid ${amountText(c?.amount_cents ?? owed, eff)} for ${title} (marked in even)`
    try {
      if (typeof navigator.share === 'function') await navigator.share({ text })
      else {
        await navigator.clipboard.writeText(text)
        toast('Copied: paste it in your chat')
      }
    } catch {
      /* closed the share sheet */
    }
  }

  let body
  if (person.is_payer) {
    body = <p className="text-[16px] font-semibold">You paid this bill.</p>
  } else if (claims.isSending(personKey)) {
    body = (
      <p role="status" className="flex items-start gap-2.5 text-[16px] font-semibold">
        <EqualsMark size="sm" moving />
        <span>
          Telling {host}…
          <span className="block text-[15px] font-medium text-ink-2">Saved on this phone, so it’s safe to close.</span>
        </span>
      </p>
    )
  } else if (person.settled) {
    body = <EvenBadge label={`You’re even with ${host}`} />
  } else if (c?.status === 'claimed') {
    const mine = Boolean(myClaimKey(token, personKey))
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-[16px] font-semibold">
          You told {host} you paid <Money minor={c.amount_cents} currency={eff} code /> · {when(c.created_at)}.
          <span className="block font-medium text-ink-2">Waiting for {host} to confirm.</span>
        </p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Button variant="secondary" icon={<Icon name="share" size={18} />} onClick={() => void letKnow()}>
            Let {host} know
          </Button>
          {mine && (
            <Button variant="quiet" loading={claims.undoing} onClick={() => void claims.undo(personKey)}>
              Undo
            </Button>
          )}
        </div>
      </div>
    )
  } else if (!share.claims_open) {
    body = <p className="text-[16px] font-semibold">{host} is still finishing this bill. Check back soon.</p>
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {c?.status === 'rejected' && <Notice tone="warn">{host} hasn’t seen your payment yet. Tell {host} again once it’s gone through.</Notice>}
        {c?.status === 'confirmed' && owed > 0 && (
          <Notice tone="warn">
            {host} updated the bill: <Money minor={owed} currency={eff} code /> more to pay.
          </Notice>
        )}
        <Button size="lg" block onClick={() => claims.claim(personKey)}>
          I’ve paid <Money minor={owed} currency={eff} code />
        </Button>
      </div>
    )
  }

  return (
    <section aria-label="Payment" className="flex flex-col gap-3 px-1">
      {body}
      {claims.error && <Notice tone="danger">{claims.error}</Notice>}
    </section>
  )
}
