import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { EqualsMark } from '@/components/Brand'
import { Button, ButtonLink } from '@/components/Button'
import { Avatar, EvenBadge, HeroAmount, Money, Notice, PageTitle } from '@/components/Display'
import { Dialog, useToast } from '@/components/Feedback'
import { SelectField } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { useDeleteBill, useMe, usePatchBill, useRevokeShareLink, useSettle, useShareLinks, useUnsettle } from '@/data/queries'
import { cn } from '@/lib/cn'
import type { BillOut, ShareLinkOut, SplitPersonOut, UUID } from '@/lib/types'
import { ConvertDialog } from '@/features/bill/ConvertDialog'
import { billTitle, shortDate, stepPath } from '@/features/bill/flow'
import { BillGate } from '@/features/bill/parts'
import { DeleteBillNote } from '@/features/bill/DeleteBillNote'
import { PersonSheet } from '@/features/bill/PersonSheet'
import { trimDecimal } from '@/features/bill/receiptDraft'
import { isShareLinkActive, SHARE_LINK_LIMIT, useSendLink } from '@/features/bill/useSendLink'

export default function SummaryPage() {
  return <BillGate>{(bill) => (bill.status !== 'complete' ? <Navigate to={stepPath(bill)} replace /> : <Summary bill={bill} />)}</BillGate>
}

function Summary({ bill }: { bill: BillOut }) {
  const navigate = useNavigate()
  const toast = useToast()
  const me = useMe()
  const patch = usePatchBill(bill.id)
  const settle = useSettle(bill.id)
  const unsettle = useUnsettle(bill.id)
  const revoke = useRevokeShareLink(bill.id)
  const del = useDeleteBill()
  const title = billTitle(bill)
  const links = useSendLink(bill.id, title)
  const [sheet, setSheet] = useState<string | null>(null)
  const [convertOpen, setConvertOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const split = bill.split
  const eff = split.effective_currency
  const converted = Boolean(split.settle_currency && split.fx_rate)
  const home = me.data?.default_currency ?? bill.currency
  const payer = split.people.find((p) => p.is_payer)
  const people = [...split.people].sort((a, b) => Number(b.is_payer) - Number(a.is_payer))
  const owing = people.filter((p) => !p.is_payer && p.outstanding_cents > 0)
  const sheetPerson = split.people.find((p) => p.person_id === sheet) ?? null
  const unassigned = split.unassigned_item_ids.length
  const editSplit = bill.source === 'quick' ? `/bills/${bill.id}/quick` : `/bills/${bill.id}/assign`
  const editItems = `/bills/${bill.id}/review`
  const pending = (id: string) =>
    (settle.isPending && settle.variables?.personId === id) || (unsettle.isPending && unsettle.variables === id)

  const remove = () =>
    del.mutate(bill.id, {
      onSuccess: () => {
        toast('Bill deleted')
        navigate('/', { replace: true })
      },
    })

  const sendAll = () => void links.sendAll(owing.map((p) => ({ id: p.person_id, name: p.name })))

  const conversion = (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 border-b border-t border-rule py-1">
      {converted ? (
        <>
          <span className="num text-[15px] font-semibold">
            1 {split.currency} = {trimDecimal(split.fx_rate)} {split.settle_currency}
          </span>
          {bill.currency_locked ? (
            <span className="flex items-center gap-1.5 text-[14px] font-semibold text-ink-2">
              <Icon name="lock" size={16} />
              Locked after the first payment
            </span>
          ) : (
            <Button variant="quiet" onClick={() => setConvertOpen(true)}>
              Change
            </Button>
          )}
        </>
      ) : (
        <>
          <span className="text-[15px] font-semibold">
            Bill in {bill.currency}
          </span>
          {bill.currency_locked ? (
            <span className="flex items-center gap-1.5 text-[14px] font-semibold text-ink-2">
              <Icon name="lock" size={16} />
              Locked after the first payment
            </span>
          ) : (
            <Button variant="quiet" icon={<Icon name="swap" size={18} />} onClick={() => setConvertOpen(true)}>
              Show in {bill.currency !== home ? home : 'another currency'}
            </Button>
          )}
        </>
      )}
    </div>
  )

  const showConversion = converted || bill.currency !== home

  const actions = (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-1">
        <ButtonLink to={editSplit} variant="secondary" size="lg">
          Edit split
        </ButtonLink>
        <Button size="lg" disabled={owing.length === 0 || links.busy !== null || revoke.isPending} loading={links.busy === 'all'} onClick={sendAll} icon={<Icon name="share" size={18} />}>
          Send all links
        </Button>
      </div>
      <SelectField
        label="Who paid?"
        value={split.payer_person_id ?? ''}
        disabled={patch.isPending}
        onChange={(e) => patch.mutate({ payer_person_id: e.target.value }, { onError: (err) => toast(err.message, 'danger') })}
      >
        {bill.participants.map((p) => (
          <option key={p.person_id} value={p.person_id}>
            {p.is_self ? 'Me' : p.name}
          </option>
        ))}
      </SelectField>
      <div className="flex flex-wrap gap-x-6">
        {bill.source !== 'quick' && (
          <ButtonLink to={editItems} variant="quiet" icon={<Icon name="type" size={18} />}>
            Edit items
          </ButtonLink>
        )}
        <Button variant="danger" icon={<Icon name="trash" size={18} />} onClick={() => setDeleteOpen(true)}>
          Delete bill
        </Button>
      </div>
    </div>
  )

  return (
    <div className="flex max-w-[1100px] flex-col gap-6 pb-6 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-x-14">
      <div className="flex min-w-0 flex-col gap-5">
        <PageTitle
          back={{ to: '/bills', label: 'Bills' }}
          sub={
            <>
              {[shortDate(bill.bill_date), payer ? (payer.is_self ? 'paid by you' : `paid by ${payer.name}`) : null].filter(Boolean).join(' · ')}
              {bill.bill_date || payer ? ' · ' : ''}
              <Money minor={split.grand_total_cents} currency={bill.currency} code />
            </>
          }
        >
          {title}
        </PageTitle>

        <section aria-labelledby="sm-owed">
          {split.outstanding_total_cents > 0 ? (
            <>
              <h2 id="sm-owed" className="text-[15px] font-semibold text-ink-2 md:text-base">
                {payer && !payer.is_self ? `Still owed to ${payer.name}` : 'Still owed to you'}
              </h2>
              <HeroAmount minor={split.outstanding_total_cents} currency={eff} />
            </>
          ) : (
            <div className="flex items-center gap-4 py-2">
              <EqualsMark size="xl" />
              <h2 id="sm-owed" className="display text-[40px] md:text-[52px]">
                Everyone’s even
              </h2>
            </div>
          )}
          {showConversion && <div className="mt-3">{conversion}</div>}
        </section>

        {unassigned > 0 && (
          <Notice
            tone="warn"
            action={
              <ButtonLink to={editSplit} variant="quiet" className="-my-2.5 shrink-0">
                Assign
              </ButtonLink>
            }
          >
            {unassigned === 1 ? '1 item has' : `${unassigned} items have`} nobody yet, so its cost is spread over everyone.
          </Notice>
        )}

        <ul aria-label="People" className="border-t-[1.5px] border-ink">
          {people.map((p) => (
            <PersonRow
              key={p.person_id}
              p={p}
              bill={bill}
              converted={converted}
              busy={pending(p.person_id)}
              sending={links.busy === p.person_id}
              sendDisabled={links.busy !== null || revoke.isPending}
              onOpen={() => setSheet(p.person_id)}
              onSettle={() => settle.mutate({ personId: p.person_id }, { onError: (err) => toast(err.message, 'danger') })}
              onUndo={() => unsettle.mutate(p.person_id, { onError: (err) => toast(err.message, 'danger') })}
              onSend={() => void links.send(p.person_id, p.name)}
            />
          ))}
        </ul>

        <ShareManagement bill={bill} revoke={revoke} sending={links.busy !== null} onRevoked={links.forget} />

        <details className="group border-b border-rule">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 text-[15px] [&::-webkit-details-marker]:hidden">
            <span className="font-semibold">Items &amp; charges</span>
            <span className="flex items-center gap-1.5 text-ink-2">
              {bill.items.length} {bill.items.length === 1 ? 'item' : 'items'}
              {bill.tax_scenario === 'tax_inclusive' ? ' · tax incl.' : ''}
              <Icon name="next" size={18} className="transition-transform group-open:rotate-90" />
            </span>
          </summary>
          <ul className="pb-3">
            {bill.items.map((it) => (
              <li key={it.id} className="flex min-h-10 items-center justify-between gap-3 text-[15px]">
                <span className="min-w-0">
                  <span className="block truncate">
                    {it.name}
                    {trimDecimal(it.quantity) !== '1' && <span className="text-ink-2"> ×{trimDecimal(it.quantity)}</span>}
                  </span>
                  {it.details && <span className="block truncate text-[14px] text-ink-2">with {it.details}</span>}
                </span>
                <Money minor={it.total_price_cents} currency={bill.currency} />
              </li>
            ))}
            {bill.charges.map((c) => (
              <li key={c.id} className="flex min-h-10 items-center justify-between gap-3 text-[15px] text-ink-2">
                <span className="min-w-0 truncate">{c.name}</span>
                <Money minor={c.amount_cents} currency={bill.currency} />
              </li>
            ))}
            <li className="flex min-h-10 items-center justify-between gap-3 border-t border-rule text-[15px] font-bold">
              <span>Total</span>
              <Money minor={split.grand_total_cents} currency={bill.currency} />
            </li>
          </ul>
        </details>
      </div>

      <aside aria-label="Bill actions" className="lg:sticky lg:top-6 lg:self-start lg:pt-10">
        {actions}
      </aside>

      <PersonSheet bill={bill} person={sheetPerson} onClose={() => setSheet(null)} onSendLink={(p) => void links.send(p.person_id, p.name)} sending={links.busy === sheet} sendDisabled={links.busy !== null || revoke.isPending} />
      <ConvertDialog bill={bill} home={home} open={convertOpen} onClose={() => setConvertOpen(false)} />
      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete this bill?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              Keep it
            </Button>
            <Button variant="danger" className="px-3" loading={del.isPending} onClick={remove}>
              Delete bill
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 text-[16px]">
          <p className="break-words font-semibold">{title}</p>
          <DeleteBillNote />
        </div>
        {del.error && (
          <div className="mt-3">
            <Notice tone="danger">{del.error.message}</Notice>
          </div>
        )}
      </Dialog>
      <Dialog open={Boolean(links.manual)} onClose={links.closeManual} title="Copy this">
        <textarea aria-label="Share message and link" readOnly value={links.manual ?? ''} rows={4} className="w-full rounded-[var(--radius-control)] border-[1.5px] border-ink p-3 text-[15px]" onFocus={(e) => e.target.select()} />
      </Dialog>
    </div>
  )
}

function ShareManagement({ bill, revoke, sending, onRevoked }: {
  bill: BillOut
  revoke: ReturnType<typeof useRevokeShareLink>
  sending: boolean
  onRevoked: (id?: UUID) => void
}) {
  const links = useShareLinks(bill.id)
  const toast = useToast()
  const [target, setTarget] = useState<ShareLinkOut | 'all' | null>(null)
  const now = new Date().getTime()
  const rows = links.data ?? []
  const active = rows.filter((link) => isShareLinkActive(link, now)).length
  const used = rows.filter((link) => !link.revoked_at).length
  const scope = (link: ShareLinkOut) => link.person_id === null
    ? 'Whole bill'
    : bill.participants.find((person) => person.person_id === link.person_id)?.name ?? 'Removed person'
  const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  const confirm = (next: ShareLinkOut | 'all') => {
    revoke.reset()
    setTarget(next)
  }
  const close = () => { if (!revoke.isPending) setTarget(null) }
  const remove = () => {
    if (!target) return
    const id = target === 'all' ? undefined : target.id
    revoke.mutate(id, {
      onSuccess: () => {
        onRevoked(id)
        toast(id ? 'Link revoked' : 'All links revoked')
        setTarget(null)
      },
    })
  }

  return (
    <section aria-label="Share links" className="border-t-[1.5px] border-ink">
      <details className="group border-b border-rule">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 text-[15px] [&::-webkit-details-marker]:hidden">
          <span className="font-semibold">Share links</span>
          <span className="flex items-center gap-1.5 text-ink-2">
            {links.data ? `${active} active` : links.isPending ? 'Loading' : 'Unavailable'}
            <Icon name="next" size={18} className="transition-transform group-open:rotate-90" />
          </span>
        </summary>
        <div className="flex flex-col gap-3 pb-3">
          {links.isPending && <p role="status" className="text-[15px]">Loading links...</p>}
          {links.isError && (
            <Notice tone="danger" action={<Button variant="quiet" loading={links.isFetching} onClick={() => void links.refetch()}>Retry</Button>}>
              {links.error.message}
            </Notice>
          )}
          {links.data && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-x-3">
                <span className="num text-[15px] text-ink-2">{used} of {SHARE_LINK_LIMIT} link slots used</span>
                <Button variant="danger" disabled={!used || sending || revoke.isPending} loading={revoke.isPending && revoke.variables === undefined} icon={<Icon name="trash" size={16} />} onClick={() => confirm('all')}>
                  Revoke all
                </Button>
              </div>
              {used >= SHARE_LINK_LIMIT && <Notice tone="warn">50-link limit reached. Revoke links before sending more.</Notice>}
              {used > active && <p className="text-[15px] text-warn-ink">Expired links still use a slot until revoked.</p>}
              {rows.length === 0 ? <p className="text-[15px] text-ink-2">No links yet</p> : (
                <ul aria-label="Share link history" className="border-t border-rule">
                  {rows.map((link) => (
                    <li key={link.id} className="flex items-center justify-between gap-3 border-b border-rule py-2">
                      <div className="min-w-0 text-[15px]">
                        <p className="break-words font-semibold">{scope(link)} <span className="font-normal text-ink-2">· {link.revoked_at ? 'Revoked' : isShareLinkActive(link, now) ? 'Active' : 'Expired'}</span></p>
                        <p className="text-[14px] text-ink-2">Created {date(link.created_at)}</p>
                        {link.expires_at && <p className="text-[14px] text-ink-2">Expires {date(link.expires_at)}</p>}
                        {link.last_viewed_at && <p className="text-[14px] text-ink-2">Viewed {date(link.last_viewed_at)}</p>}
                      </div>
                      {!link.revoked_at && (
                        <Button variant="danger" className="shrink-0" aria-label={`Revoke ${scope(link)} link created ${date(link.created_at)}`} disabled={sending || revoke.isPending} loading={revoke.isPending && revoke.variables === link.id} onClick={() => confirm(link)}>
                          Revoke
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </details>
      <Dialog open={target !== null} onClose={close} title={target === 'all' ? 'Revoke all links?' : 'Revoke this link?'} footer={
        <>
          <Button variant="secondary" disabled={revoke.isPending} onClick={close}>Keep {target === 'all' ? 'them' : 'it'}</Button>
          <Button variant="danger" className="px-3" loading={revoke.isPending} onClick={remove}>Revoke {target === 'all' ? 'all' : 'link'}</Button>
        </>
      }>
        <p className="text-[16px]">{target === 'all' ? 'All existing links' : 'This link'} will stop opening the bill. This cannot be undone.</p>
        {revoke.error && <div className="mt-3"><Notice tone="danger">{revoke.error.message}</Notice></div>}
      </Dialog>
    </section>
  )
}

function PersonRow({
  p,
  bill,
  converted,
  busy,
  sending,
  sendDisabled,
  onOpen,
  onSettle,
  onUndo,
  onSend,
}: {
  p: SplitPersonOut
  bill: BillOut
  converted: boolean
  busy: boolean
  sending: boolean
  sendDisabled: boolean
  onOpen: () => void
  onSettle: () => void
  onUndo: () => void
  onSend: () => void
}) {
  const eff = bill.split.effective_currency
  const partial = Boolean(p.settled_at) && p.outstanding_cents > 0
  const even = !p.is_payer && p.outstanding_cents === 0
  return (
    <li className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-rule py-2.5">
      <span className="row-span-2">
        <Avatar name={p.name} seed={p.color_seed} />
      </span>
      <button type="button" onClick={onOpen} className="flex min-h-11 min-w-11 items-center gap-1 text-left text-[16px] font-semibold hover:text-cobalt">
        <span className="truncate">{p.is_self ? 'You' : p.name}</span>
        <Icon name="next" size={16} className="shrink-0 text-ink-2" />
      </button>
      <span className="text-right text-[17px] font-semibold">
        <Money minor={p.effective_total_cents} currency={eff} />
      </span>
      <span className="min-w-0 truncate text-[14px] text-ink-2">
        {p.is_payer ? (
          <span className="font-semibold">paid the bill</span>
        ) : partial ? (
          <span className="font-semibold text-warn">
            <Money minor={p.outstanding_cents} currency={eff} /> left
          </span>
        ) : converted ? (
          <Money minor={p.total_cents} currency={bill.currency} code />
        ) : null}
      </span>
      <span className="flex items-center justify-end gap-4 text-[14px]">
        {p.is_payer ? (
          p.is_self ? <span className="font-semibold text-ink-2">your share</span> : null
        ) : even ? (
          <>
            <EvenBadge />
            {p.settled_at && (
            <button type="button" onClick={onUndo} disabled={busy} className={cn('min-h-11 min-w-11 font-bold text-cobalt hover:text-cobalt-ink', busy && 'text-ink-2')}>
              Undo
            </button>
            )}
          </>
        ) : (
          <>
            {!p.is_self && (
              <button type="button" onClick={onSend} disabled={sendDisabled} className="flex min-h-11 min-w-11 items-center gap-1.5 font-bold text-cobalt hover:text-cobalt-ink disabled:text-ink-2">
                {sending && <EqualsMark size="xs" moving />}
                Send link
              </button>
            )}
            <button type="button" onClick={onSettle} disabled={busy} className="flex min-h-11 min-w-11 items-center gap-1.5 font-bold text-cobalt hover:text-cobalt-ink disabled:text-ink-2">
              {busy && <EqualsMark size="xs" moving />}
              Mark paid
            </button>
          </>
        )}
      </span>
    </li>
  )
}
