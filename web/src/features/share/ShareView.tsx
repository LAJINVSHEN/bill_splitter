import type { ReactNode } from 'react'
import { Button } from '@/components/Button'
import { Avatar, EvenBadge, HeroAmount, Money } from '@/components/Display'
import { useToast } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { longDate, peopleCount } from '@/features/home/format'
import { cn } from '@/lib/cn'
import type { PublicPerson, PublicShareOut } from '@/lib/types'
import { billFractions, effectiveTotal, firstName, isConverted } from './logic'

/** A stable hue per name: the public view has no ids or saved colours. */
function nameHue(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

function title(share: PublicShareOut): string {
  return share.title?.trim() || share.merchant?.trim() || 'A shared bill'
}

function Meta({ share, extra }: { share: PublicShareOut; extra?: string }) {
  const parts = [longDate(share.bill_date)]
  if (share.title && share.merchant && share.merchant !== share.title) parts.push(share.merchant)
  if (extra) parts.push(extra)
  const shown = parts.filter(Boolean)
  if (shown.length === 0) return null
  return (
    <p className="mt-1 text-[15px] text-ink-2">
      {shown.map((t, i) => (
        <span key={t}>
          {i > 0 && ' · '}
          <span className={t === share.merchant ? undefined : "whitespace-nowrap"}>{t}</span>
        </span>
      ))}
    </p>
  )
}

/** "JPY 2,880 at 1 JPY = 0.0091 SGD" under a converted amount. */
function ConversionLine({ share, minor }: { share: PublicShareOut; minor: number }) {
  if (!isConverted(share)) return null
  return (
    <p className="num mt-0.5 text-[15px] text-ink-2">
      <Money minor={minor} currency={share.currency} code /> at 1 {share.currency} = {share.fx_rate} {share.settle_currency}
    </p>
  )
}

function ItemLines({ share, person, fractions }: { share: PublicShareOut; person: PublicPerson; fractions?: Map<string, string> }) {
  const code = isConverted(share)
  return (
    <ul className="border-t border-rule">
      {person.items.map((it, i) => (
        <li key={`${it.name}-${i}`} className="flex min-h-[46px] items-center gap-2.5 border-b border-rule py-1.5">
          <span className="min-w-0 flex-1 text-base">{it.name}</span>
          {fractions?.get(it.name) && <span className="text-[15px] font-semibold text-ink-2">{fractions.get(it.name)}</span>}
          <Money minor={it.share_cents} currency={share.currency} code={code} className="text-base font-semibold" />
        </li>
      ))}
      {person.adjustment_cents !== 0 && (
        <li className="flex min-h-[46px] items-center gap-2.5 border-b border-rule py-1.5">
          <span className="min-w-0 flex-1 text-base">{person.adjustment_cents > 0 ? 'Tax and service' : 'Discounts'}</span>
          <Money minor={person.adjustment_cents} currency={share.currency} code={code} className="text-base font-semibold" />
        </li>
      )}
    </ul>
  )
}

function PayBlock({ share }: { share: PublicShareOut }) {
  const toast = useToast()
  const note = share.payer_payment_note?.trim()
  if (!note || !share.payer_name) return null
  return (
    <section aria-labelledby="pay-title" className="flex items-start gap-3 rounded-[var(--radius-control)] bg-cobalt-soft px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <h2 id="pay-title" className="text-[15px] font-bold text-cobalt-ink">
          Pay {firstName(share.payer_name)}
        </h2>
        <p className="mt-0.5 break-words text-base font-semibold">{note}</p>
      </div>
      <Button
        variant="quiet"
        className="-my-1.5 shrink-0"
        aria-label={`Copy how to pay ${firstName(share.payer_name)}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(note)
            toast('Copied')
          } catch {
            toast('Couldn’t copy: press and hold the text instead', 'danger')
          }
        }}
      >
        Copy
      </Button>
    </section>
  )
}

function Dot({ tone }: { tone: 'warn' | 'ink' }) {
  return <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', tone === 'warn' ? 'bg-warn' : 'bg-ink')} />
}

function PaidState({ share, person }: { share: PublicShareOut; person: PublicPerson }) {
  if (person.is_payer) return <p className="text-[15px] font-semibold">You paid this bill.</p>
  if (person.settled) return <EvenBadge label="Paid back: you’re even" />
  const total = effectiveTotal(share, person)
  const partial = person.outstanding_cents > 0 && person.outstanding_cents < total
  return (
    <p className="flex items-center gap-2 text-[15px] font-semibold text-ink-2">
      <Dot tone="warn" />
      {partial ? (
        <span>
          <Money minor={person.outstanding_cents} currency={share.effective_currency} code className="text-ink" /> still to pay
        </span>
      ) : (
        'Not marked as paid yet'
      )}
    </p>
  )
}

/** The stub: white on mist, heavy outline, the = across the top (mockup E-Share). */
function Stub({ children }: { children: ReactNode }) {
  return (
    <main className="overflow-hidden rounded-[var(--radius-panel)] border-[1.5px] border-ink bg-paper">
      <div aria-hidden="true" className="flex flex-col gap-1 px-5 pt-3.5">
        <span className="h-1 rounded-[2px] bg-cobalt" />
        <span className="h-1 rounded-[2px] bg-cobalt" />
      </div>
      <div className="flex flex-col gap-5 px-5 pb-5 pt-4">{children}</div>
    </main>
  )
}

export function PersonShare({ share, person }: { share: PublicShareOut; person: PublicPerson }) {
  return (
    <>
      <Stub>
        <div>
          <p className="text-base font-semibold">{firstName(person.name)}, your share of</p>
          <h1 className="display mt-0.5 text-[28px] leading-[1.1]">{title(share)}</h1>
          <Meta share={share} />
          <div className="mt-4">
            <HeroAmount minor={effectiveTotal(share, person)} currency={share.effective_currency} />
            <ConversionLine share={share} minor={person.total_cents} />
          </div>
        </div>
        <ItemLines share={share} person={person} />
        {!person.is_payer && <PayBlock share={share} />}
      </Stub>
      <div className="px-1">
        <PaidState share={share} person={person} />
      </div>
    </>
  )
}

export function BillShare({ share }: { share: PublicShareOut }) {
  const fractions = billFractions(share.people)
  const total = isConverted(share) && share.settle_grand_total_cents !== null ? share.settle_grand_total_cents : share.grand_total_cents
  return (
    <Stub>
      <div>
        <h1 className="display text-[28px] leading-[1.1]">{title(share)}</h1>
        <Meta share={share} extra={peopleCount(share.people.length)} />
        <div className="mt-4">
          <HeroAmount minor={total} currency={share.effective_currency} label="Total" />
          <ConversionLine share={share} minor={share.grand_total_cents} />
        </div>
      </div>
      <ul aria-label="Everyone’s share" className="border-t-[1.5px] border-ink">
        {share.people.map((p, i) => (
          <li key={`${p.name}-${i}`} className="border-b border-rule">
            <details className="group">
              <summary className="flex min-h-[56px] cursor-pointer list-none items-center gap-3 py-1.5 [&::-webkit-details-marker]:hidden">
                <Avatar name={p.name} seed={nameHue(p.name)} size={30} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-base font-semibold">{p.name}</span>
                  {p.is_payer ? (
                    <span className="text-[14px] font-semibold text-ink-2">Paid the bill</span>
                  ) : p.settled ? (
                    <span className="text-[14px] font-bold text-cobalt">Even</span>
                  ) : p.outstanding_cents < effectiveTotal(share, p) ? (
                    <span className="text-[14px] font-semibold text-warn">
                      <Money minor={p.outstanding_cents} currency={share.effective_currency} /> left to pay
                    </span>
                  ) : (
                    <span className="text-[14px] font-semibold text-warn">Owes {firstName(share.payer_name ?? 'the payer')}</span>
                  )}
                </span>
                <Money minor={effectiveTotal(share, p)} currency={share.effective_currency} className="text-[17px] font-semibold" />
                <Icon name="next" size={18} className="shrink-0 text-ink-2 transition-transform group-open:rotate-90" />
              </summary>
              <div className="pb-3 pl-[42px]">
                <ItemLines share={share} person={p} fractions={fractions} />
              </div>
            </details>
          </li>
        ))}
      </ul>
      <PayBlock share={share} />
    </Stub>
  )
}
