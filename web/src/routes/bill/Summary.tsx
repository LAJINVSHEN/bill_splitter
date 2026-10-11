import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { EqualsMark } from '@/components/Brand'
import { Button, ButtonLink } from '@/components/Button'
import { Avatar, EvenBadge, Money, Notice, PageTitle, SectionTitle } from '@/components/Display'
import { Dialog, useToast } from '@/components/Feedback'
import { SelectField } from '@/components/Field'
import { FullName } from '@/components/FullName'
import { Icon } from '@/components/Icon'
import { PaidToggle } from '@/components/PaidToggle'
import { useConfirmAll, useConfirmClaim, useDeleteBill, useMe, usePatchBill, useRejectClaim, useSettle, useUnsettle } from '@/data/queries'
import type { BillOut, ClaimOut, SplitPersonOut } from '@/lib/types'
import { ConvertDialog } from '@/features/bill/ConvertDialog'
import { billTitle, paidByMe, stepPath } from '@/features/bill/flow'
import { BillGate } from '@/features/bill/parts'
import { DeleteBillNote } from '@/features/bill/DeleteBillNote'
import { PersonSheet } from '@/features/bill/PersonSheet'
import { trimDecimal } from '@/features/bill/receiptDraft'
import { TotalsBlock } from '@/features/bill/TotalsBlock'
import { longDate, peopleCount } from '@/features/home/format'
import { BillBalance } from '@/features/settle/YourBalance'
import { formatAmount } from '@/lib/money'
import { ShareDialog } from '@/features/share/ShareDialog'

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
  const confirmClaim = useConfirmClaim(bill.id)
  const rejectClaim = useRejectClaim(bill.id)
  const confirmAll = useConfirmAll(bill.id)
  const del = useDeleteBill()
  const title = billTitle(bill)
  const [sheet, setSheet] = useState<string | null>(null)
  const [convertOpen, setConvertOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const claims = bill.claims ?? []

  const split = bill.split
  const converted = Boolean(split.settle_currency && split.fx_rate)
  const home = me.data?.default_currency ?? bill.currency
  const people = [...split.people].sort((a, b) => Number(b.is_payer) - Number(a.is_payer))
  const sheetPerson = split.people.find((p) => p.person_id === sheet) ?? null
  const unassigned = split.unassigned_item_ids.length
  const editSplit = bill.source === 'quick' ? `/bills/${bill.id}/quick` : `/bills/${bill.id}/assign`
  const editItems = `/bills/${bill.id}/review`
  const claimOf = (id: string) => claims.find((c) => c.person_id === id)
  const pending = (id: string) =>
    (settle.isPending && settle.variables?.personId === id) ||
    (unsettle.isPending && unsettle.variables === id) ||
    (confirmClaim.isPending && confirmClaim.variables?.claimId === claimOf(id)?.id) ||
    (rejectClaim.isPending && rejectClaim.variables === claimOf(id)?.id)
  const fail = (err: Error) => toast(err.message, 'danger')
  const itemsSum = bill.items.reduce((a, i) => a + i.total_price_cents, 0)
  const payer = split.people.find((p) => p.is_payer)
  const meta = [
    longDate(bill.bill_date),
    bill.merchant && bill.merchant !== title ? bill.merchant : null,
    peopleCount(split.people.length),
    payer ? (payer.is_self ? 'you paid' : `${payer.name} paid`) : null,
  ].filter(Boolean).join(' · ')

  const remove = () =>
    del.mutate(bill.id, {
      onSuccess: () => {
        toast('Bill deleted')
        navigate('/', { replace: true })
      },
    })

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
          <span className="text-[15px] font-semibold">Bill in {bill.currency}</span>
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
        <Button size="lg" icon={<Icon name="share" size={18} />} onClick={() => setShareOpen(true)}>
          Share
        </Button>
        <ButtonLink to={editSplit} variant="secondary" size="lg">
          Edit split
        </ButtonLink>
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
    <div className="flex flex-col gap-6 pb-6 lg:grid lg:grid-cols-[minmax(0,1fr)_var(--app-rail-w)] lg:gap-x-[var(--app-gutter)]">
      <div className="flex min-w-0 flex-col gap-5">
        {/* Name, a quiet meta line and the total; then the one line about you, which is what you came to check. */}
        <PageTitle
          compact
          back={{ to: '/bills', label: 'Bills' }}
          sub={meta}
          actions={
            <p className="flex items-baseline gap-1.5" aria-label={`Total ${bill.currency} ${formatAmount(split.grand_total_cents, bill.currency)}`}>
              <span className="text-[15px] font-semibold text-ink-2">Total</span>
              <span className="num text-[15px] font-semibold text-ink-2">{bill.currency}</span>
              <span className="num text-[26px] font-bold leading-none">{formatAmount(split.grand_total_cents, bill.currency)}</span>
            </p>
          }
        >
          {title}
        </PageTitle>
        <BillBalance bill={bill} />
        {showConversion && conversion}

        {claims.length > 1 && (
          <Notice
            tone="warn"
            action={
              <Button variant="quiet" className="-my-2.5 shrink-0" loading={confirmAll.isPending} onClick={() => confirmAll.mutate(undefined, { onError: fail })}>
                Confirm all
              </Button>
            }
          >
            {claims.length} people say they’ve paid.
          </Notice>
        )}

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
              claim={claimOf(p.person_id)}
              onConfirm={(c) => confirmClaim.mutate({ claimId: c.id }, { onError: fail })}
              onReject={(c) => rejectClaim.mutate(c.id, { onError: fail })}
              onOpen={() => setSheet(p.person_id)}
              onSettle={() => settle.mutate({ personId: p.person_id }, { onError: (err) => toast(err.message, 'danger') })}
              onUndo={() => unsettle.mutate(p.person_id, { onError: (err) => toast(err.message, 'danger') })}
            />
          ))}
        </ul>

        {bill.source !== 'quick' && (
          <section aria-labelledby="sm-items" className="mt-2">
            <SectionTitle id="sm-items">Items</SectionTitle>
            <ul className="border-t-[1.5px] border-ink">
              {bill.items.map((it) => {
                const qty = trimDecimal(it.quantity)
                return (
                  <li key={it.id} className="flex min-h-11 items-center justify-between gap-4 border-b border-rule py-1 text-[16px]">
                    <span className="min-w-0">
                      <FullName text={qty !== '1' ? `${it.name} ×${qty}` : it.name}>
                        {it.name}
                        {qty !== '1' && <span className="text-ink-2"> ×{qty}</span>}
                      </FullName>
                      {it.details && <span className="block truncate text-[14px] text-ink-2">with {it.details}</span>}
                    </span>
                    <Money minor={it.total_price_cents} currency={bill.currency} className="pr-[11px]" />
                  </li>
                )
              })}
            </ul>
            <div className="mt-4 md:ml-auto md:w-[min(100%,440px)]">
              <TotalsBlock
                currency={bill.currency}
                lines={[
                  { key: 'items', label: 'Subtotal', minor: itemsSum },
                  ...bill.charges.map((c) => ({
                    key: c.id,
                    label: (
                      <>
                        {c.name}
                        {c.percent && <span className="text-ink-2"> · {trimDecimal(c.percent)}%</span>}
                      </>
                    ),
                    minor: c.amount_cents,
                  })),
                ]}
                total={{ label: bill.tax_scenario === 'tax_inclusive' ? 'Total (tax incl.)' : 'Total', minor: split.grand_total_cents }}
              />
            </div>
          </section>
        )}
      </div>

      <aside aria-label="Bill actions" className="lg:sticky lg:top-0 lg:self-start lg:border-l lg:border-rule lg:pl-[var(--app-gutter)] lg:pt-10">
        {actions}
      </aside>

      <PersonSheet bill={bill} person={sheetPerson} onClose={() => setSheet(null)} />
      <ConvertDialog bill={bill} home={home} open={convertOpen} onClose={() => setConvertOpen(false)} />
      <ShareDialog bill={bill} open={shareOpen} onClose={() => setShareOpen(false)} />
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
    </div>
  )
}

function PersonRow({
  p,
  bill,
  converted,
  busy,
  claim,
  onConfirm,
  onReject,
  onOpen,
  onSettle,
  onUndo,
}: {
  p: SplitPersonOut
  bill: BillOut
  converted: boolean
  busy: boolean
  claim?: ClaimOut
  onConfirm: (c: ClaimOut) => void
  onReject: (c: ClaimOut) => void
  onOpen: () => void
  onSettle: () => void
  onUndo: () => void
}) {
  const eff = bill.split.effective_currency
  const received = paidByMe(bill)
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
        ) : claim ? (
          <span className="font-semibold text-warn">
            Says paid <Money minor={claim.amount_cents} currency={claim.currency} />
            {claim.amount_cents !== p.outstanding_cents && (
              <>
                {' '}· now <Money minor={p.outstanding_cents} currency={eff} />
              </>
            )}
          </span>
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
          // paid → the toggle is on; tap again to take it back
          p.settled_at ? <PaidToggle paid received={received} busy={busy} onToggle={onUndo} /> : <EvenBadge />
        ) : claim ? (
          <>
            <button type="button" onClick={() => onReject(claim)} disabled={busy} className="min-h-11 min-w-11 font-bold text-ink hover:text-cobalt disabled:text-ink-2">
              Not yet
            </button>
            <button type="button" onClick={() => onConfirm(claim)} disabled={busy} className="flex min-h-11 min-w-11 items-center gap-1.5 font-bold text-cobalt hover:text-cobalt-ink disabled:text-ink-2">
              {busy && <EqualsMark size="xs" moving />}
              Confirm
            </button>
          </>
        ) : (
          <PaidToggle paid={false} received={received} busy={busy} onToggle={onSettle} />
        )}
      </span>
    </li>
  )
}
