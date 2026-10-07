import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { FlowShell } from '@/app/FlowShell'
import { Button } from '@/components/Button'
import { Avatar, Money, SectionTitle } from '@/components/Display'
import { Dialog, useToast } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { usePatchBill } from '@/data/queries'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { BillOut, ItemOut, ParticipantOut, UUID } from '@/lib/types'
import { itemCounts, quantityMismatch, shareWithEveryone, soFar, toggleItem, toInput, whoIsOn, previewSplit } from '@/features/bill/assignment'
import { billTitle, scanRunning, STEPS } from '@/features/bill/flow'
import { BillGate, FooterBar, SaveError, StepTitle } from '@/features/bill/parts'
import { SplitDialog } from '@/features/bill/SplitDialog'
import { trimDecimal } from '@/features/bill/receiptDraft'
import { useAssignments } from '@/features/bill/useAssignments'

export default function AssignStep() {
  return (
    <BillGate>
      {(bill) =>
        scanRunning(bill) ? (
          <Navigate to={`/bills/${bill.id}/people`} replace />
        ) : bill.source === 'quick' ? (
          <Navigate to={`/bills/${bill.id}/quick`} replace />
        ) : (
          <AssignScreen bill={bill} />
        )
      }
    </BillGate>
  )
}

const personName = (p: ParticipantOut) => (p.is_self ? 'Me' : p.name)

const MODE_NOTE: Partial<Record<NonNullable<ItemOut['split_mode']>, string>> = { weighted: 'by shares', custom: 'exact amounts' }

function Who({ item, participants }: { item: ItemOut; participants: ParticipantOut[] }) {
  const who = whoIsOn(item, participants)
  if (who === 'none') return <span className="text-[13px] font-bold uppercase tracking-[0.06em] text-warn">Nobody</span>
  if (who === 'all') return <span className="text-[13px] font-bold uppercase tracking-[0.06em] text-ink-2">Everyone</span>
  const shown = who.slice(0, 3)
  return (
    <span className="flex items-center" aria-label={who.map(personName).join(', ')}>
      {shown.map((p, i) => (
        <span key={p.person_id} className={cn('rounded-full ring-2 ring-paper', i > 0 && '-ml-1.5')}>
          <Avatar name={p.name} seed={p.color_seed} size={24} />
        </span>
      ))}
      {who.length > 3 && <span className="ml-1 text-[13px] font-bold text-ink-2">+{who.length - 3}</span>}
    </span>
  )
}

function AssignScreen({ bill }: { bill: BillOut }) {
  const navigate = useNavigate()
  const toast = useToast()
  const patch = usePatchBill(bill.id)
  const painter = useAssignments(bill.id)
  const participants = bill.participants
  const ids = participants.map((p) => p.person_id)
  const [activeId, setActiveId] = useState<UUID | undefined>(ids[0])
  const active = participants.find((p) => p.person_id === activeId) ?? participants[0]
  const [dialogItem, setDialogItem] = useState<UUID | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)

  const counts = itemCounts(bill.items)
  const unassigned = bill.items.filter((i) => i.shares.length === 0)
  const grand = bill.grand_total_cents ?? bill.split.grand_total_cents
  const allItems = bill.items.reduce((a, i) => a + i.total_price_cents, 0)
  // server numbers when settled; the TS mirror while a save is on its way
  const preview = painter.busy ? previewSplit(bill) : null
  const itemsOf = (id: UUID) =>
    preview ? (preview.people.find((p) => p.person_id === id)?.items_cents ?? 0) : (bill.split.people.find((p) => p.person_id === id)?.items_cents ?? 0)
  const owes = (id: UUID) => soFar(itemsOf(id), allItems, grand)

  const tap = (item: ItemOut) => {
    if (!active) return
    const next = toggleItem(item, active.person_id)
    if (next === 'dialog') setDialogItem(item.id)
    else painter.assign([toInput(item.id, next)])
  }

  const finish = async (anyway = false) => {
    setLeaving(true)
    try {
      if (!(await painter.settle())) return
      if (!anyway && unassigned.length) {
        setConfirmOpen(true)
        return
      }
      await patch.mutateAsync({ status: 'complete' })
      navigate(`/bills/${bill.id}`)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t finish. Try again.', 'danger')
    } finally {
      setLeaving(false)
    }
  }

  const dialog = bill.items.find((i) => i.id === dialogItem) ?? null

  return (
    <FlowShell
      billId={bill.id}
      steps={STEPS[bill.source]}
      current={3}
      save={painter}
      footer={
        <FooterBar width="max-w-[1100px]">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14px] font-semibold text-ink-2">
              {active ? `${personName(active)} so far` : 'So far'}
              {unassigned.length > 0 && <span className="font-bold text-warn"> · {unassigned.length} unassigned</span>}
            </span>
            <span className="hero-num text-[24px]" aria-live="polite">
              <Money minor={active ? owes(active.person_id) : 0} currency={bill.currency} code />
            </span>
          </div>
          <Button size="lg" loading={leaving && !confirmOpen} onClick={() => void finish()}>
            See totals
          </Button>
        </FooterBar>
      }
    >
      <div className="flex max-w-[1100px] flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-x-14">
        <div className="flex min-w-0 flex-col gap-4">
          {painter.error != null && <SaveError error={painter.error} onRetry={painter.retry} />}
          <StepTitle
            sub={
              <>
                {billTitle(bill)} · <Money minor={grand} currency={bill.currency} code />
              </>
            }
          >
            Who had what?
          </StepTitle>

          <div role="group" aria-label="Assigning for" className="-mx-5 flex gap-[18px] overflow-x-auto border-b border-rule px-5 md:mx-0 md:px-0">
            {participants.map((p) => {
              const on = p.person_id === active?.person_id
              return (
                <button
                  key={p.person_id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setActiveId(p.person_id)}
                  className={cn(
                    'flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap text-[16px] font-semibold',
                    on ? 'text-ink shadow-[inset_0_-3px_0_var(--color-cobalt)]' : 'text-ink-2 hover:text-ink',
                  )}
                >
                  {personName(p)}
                  <span className={cn('num text-[14px] font-bold', on ? 'text-cobalt' : 'text-ink-2')}>{counts.get(p.person_id) ?? 0}</span>
                </button>
              )
            })}
          </div>

          <ul aria-label={`Items — tap to add or remove ${active ? personName(active) : ''}`} className="-mt-4">
            {bill.items.map((item) => {
              const mine = Boolean(active && item.shares.some((s) => s.person_id === active.person_id))
              const qty = trimDecimal(item.quantity)
              const mismatch = quantityMismatch(item)
              const note = item.split_mode ? MODE_NOTE[item.split_mode] : undefined
              return (
                <li key={item.id} className="flex items-stretch border-b border-rule">
                  <button
                    type="button"
                    aria-pressed={mine}
                    onClick={() => tap(item)}
                    className="grid min-h-[56px] min-w-0 flex-1 grid-cols-[22px_minmax(0,1fr)_auto_auto] items-center gap-x-3 py-1.5 text-left"
                  >
                    <span aria-hidden="true" className={cn('grid h-[22px] w-[22px] place-items-center rounded-[4px]', mine ? 'bg-cobalt text-white' : 'border-[1.5px] border-ink')}>
                      {mine && <Icon name="check" size={16} strokeWidth={2.6} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[16px] font-medium">
                        {item.name}
                        {qty !== '1' && <span className="text-ink-2"> ×{qty}</span>}
                      </span>
                      {(mismatch || note) && (
                        <span className={cn('block text-[14px] font-semibold', mismatch ? 'text-warn' : 'text-ink-2')}>
                          {mismatch ? `${mismatch.ordered} ordered · ${mismatch.sharing} sharing` : note}
                        </span>
                      )}
                    </span>
                    <Who item={item} participants={participants} />
                    <span className="min-w-[4.5rem] text-right text-[16px] font-semibold">
                      <Money minor={item.total_price_cents} currency={bill.currency} />
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Split ${item.name} another way`}
                    onClick={() => setDialogItem(item.id)}
                    className="-mr-2 grid w-11 shrink-0 place-items-center text-ink-2 hover:text-cobalt"
                  >
                    <Icon name="sliders" />
                  </button>
                </li>
              )
            })}
          </ul>

          {unassigned.length > 0 && participants.length > 1 && (
            <Button
              variant="quiet"
              className="self-start"
              icon={<Icon name="people" size={18} />}
              onClick={() => painter.assign(unassigned.map((i) => toInput(i.id, shareWithEveryone(ids))))}
            >
              Everyone shares the {unassigned.length === 1 ? 'unassigned item' : `${unassigned.length} unassigned`}
            </Button>
          )}
        </div>

        <aside aria-labelledby="as-totals" className="hidden lg:sticky lg:top-6 lg:block lg:self-start lg:pt-8">
          <SectionTitle id="as-totals">So far</SectionTitle>
          <ul className="border-t-[1.5px] border-ink">
            {participants.map((p) => (
              <li key={p.person_id} className="border-b border-rule">
                <button
                  type="button"
                  onClick={() => setActiveId(p.person_id)}
                  aria-pressed={p.person_id === active?.person_id}
                  className={cn('flex min-h-[52px] w-full items-center gap-3 text-left', p.person_id === active?.person_id && 'font-bold')}
                >
                  <Avatar name={p.name} seed={p.color_seed} />
                  <span className="min-w-0 flex-1 truncate text-[16px] font-semibold">{personName(p)}</span>
                  <span className="text-[16px] font-semibold">
                    <Money minor={owes(p.person_id)} currency={bill.currency} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1 text-[15px]">
            <dt className={cn('font-semibold', unassigned.length ? 'text-warn' : 'text-ink-2')}>Unassigned</dt>
            <dd className={cn('text-right font-semibold', unassigned.length ? 'text-warn' : '')}>
              <Money minor={unassigned.reduce((a, i) => a + i.total_price_cents, 0)} currency={bill.currency} />
            </dd>
            <dt className="font-semibold">Total</dt>
            <dd className="text-right font-bold">
              <Money minor={grand} currency={bill.currency} />
            </dd>
          </dl>
        </aside>
      </div>

      <SplitDialog
        item={dialog}
        participants={participants}
        currency={bill.currency}
        onClose={() => setDialogItem(null)}
        onSave={(a) => {
          if (dialog) painter.assign([toInput(dialog.id, a)])
          setDialogItem(null)
        }}
      />

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={unassigned.length === 1 ? '1 item has nobody' : `${unassigned.length} items have nobody`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Keep assigning
            </Button>
            <Button loading={leaving} onClick={() => void finish(true)}>
              See totals anyway
            </Button>
          </>
        }
      >
        <p className="text-[16px]">
          {unassigned.map((i) => i.name).join(', ')}. Until someone has {unassigned.length === 1 ? 'it' : 'them'}, the cost is spread over everyone by what they had.
        </p>
      </Dialog>
    </FlowShell>
  )
}
