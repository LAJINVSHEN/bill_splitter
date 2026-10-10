import type { ReactNode } from 'react'
import { Button } from '@/components/Button'
import { Avatar, EvenBadge, HeroAmount, Money } from '@/components/Display'
import { useToast } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { longDate, peopleCount } from '@/features/home/format'
import { cn } from '@/lib/cn'
import type { PublicPerson, PublicShareOut } from '@/lib/types'
import { effectiveTotal, firstName, isConverted } from './logic'

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

export function PersonShare({ share, person, footer, fractions }: { share: PublicShareOut; person: PublicPerson; footer?: ReactNode; fractions?: Map<string, string> }) {
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
        {share.itemised !== false && <ItemLines share={share} person={person} fractions={fractions} />}
        {!person.is_payer && <PayBlock share={share} />}
      </Stub>
      {footer}
    </>
  )
}

/** One short status per person, the same words the host sees. */
function statusOf(share: PublicShareOut, p: PublicPerson): { text: ReactNode; tone: 'warn' | 'even' | 'plain' } {
  if (p.is_payer) return { text: 'Paid the bill', tone: 'plain' }
  if (p.settled) return { text: 'Even', tone: 'even' }
  if (p.claim?.status === 'claimed') return { text: 'Says paid', tone: 'plain' }
  if (p.outstanding_cents < effectiveTotal(share, p))
    return { text: <><Money minor={p.outstanding_cents} currency={share.effective_currency} /> left</>, tone: 'warn' }
  return { text: 'Owes', tone: 'warn' }
}

/** Group link: everyone at the table, and "which one is you?" before anything else. */
export function PickName({ share, onPick }: { share: PublicShareOut; onPick: (key: string) => void }) {
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
      <section aria-labelledby="pick-title">
        <h2 id="pick-title" className="display-sm mb-1.5 text-lg">Which one is you?</h2>
        <ul className="border-t-[1.5px] border-ink">
          {share.people.map((p) => {
            const st = statusOf(share, p)
            return (
              <li key={p.key} className="border-b border-rule">
                <button type="button" onClick={() => onPick(p.key)} className="flex min-h-[56px] w-full items-center gap-3 py-1.5 text-left hover:text-cobalt">
                  <Avatar name={p.name} seed={p.color_seed} size={30} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-base font-semibold">{p.name}</span>
                    {st.tone === 'even' ? (
                      <EvenBadge />
                    ) : (
                      <span className={cn('text-[14px] font-semibold', st.tone === 'warn' ? 'text-warn' : 'text-ink-2')}>{st.text}</span>
                    )}
                  </span>
                  <Money minor={effectiveTotal(share, p)} currency={share.effective_currency} className="text-[17px] font-semibold" />
                  <Icon name="next" size={18} className="shrink-0 text-ink-2" />
                </button>
              </li>
            )
          })}
        </ul>
      </section>
      <PayBlock share={share} />
    </Stub>
  )
}
