import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { FlowShell } from '@/app/FlowShell'
import { Button, ButtonLink } from '@/components/Button'
import { Money, Notice } from '@/components/Display'
import { Dialog, useToast } from '@/components/Feedback'
import { SelectField, TextField } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { qk, usePatchBill, usePutReceipt } from '@/data/queries'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { BillOut } from '@/lib/types'
import { scanRunning, STEPS } from '@/features/bill/flow'
import { CurrencyOptions } from '@/features/bill/inputs'
import { ChargesList, ItemsTable, TotalsList } from '@/features/bill/ItemsEditor'
import { BillGate, SaveError, StepTitle, FooterBar } from '@/features/bill/parts'
import { PhotoViewer } from '@/features/bill/PhotoViewer'
import {
  draftFromBill,
  draftToReceipt,
  emptyItem,
  grandTotal,
  itemsTotal,
  mergeSaved,
  refreshPercents,
  type DraftPayload,
  type ReceiptDraft,
} from '@/features/bill/receiptDraft'
import { useAutosave } from '@/features/bill/useAutosave'
import { validationText } from '@/features/bill/validationText'

export default function ReviewStep() {
  return (
    <BillGate>
      {(bill) =>
        scanRunning(bill) ? (
          <Navigate to={`/bills/${bill.id}/people`} replace />
        ) : bill.source === 'quick' ? (
          <Navigate to={`/bills/${bill.id}/quick`} replace />
        ) : (
          <ReviewScreen key={bill.id} bill={bill} />
        )
      }
    </BillGate>
  )
}

function ReviewScreen({ bill }: { bill: BillOut }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const toast = useToast()
  const put = usePutReceipt(bill.id)
  const patch = usePatchBill(bill.id)
  const currency = bill.currency
  // an empty receipt starts with one row ready to type into (not saved until it has a name)
  const [draft, setDraft] = useState<ReceiptDraft>(() => {
    const d = draftFromBill(bill)
    return d.items.length ? d : { ...d, items: [emptyItem()] }
  })
  const draftRef = useRef(draft)
  const [photoOpen, setPhotoOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [dismissedCurrency, setDismissedCurrency] = useState(false)
  const [switching, setSwitching] = useState(false)

  const commit = (next: ReceiptDraft) => {
    draftRef.current = next
    setDraft(next)
  }
  const save = useAutosave((p: DraftPayload) => put.mutateAsync(p.body), {
    delay: 700,
    onSaved: (saved, sent) => commit(mergeSaved(draftRef.current, sent, saved)),
  })
  const update = (fn: (d: ReceiptDraft) => ReceiptDraft) => {
    let next = fn(draftRef.current)
    if (next.charges.some((c) => c.percentTyped)) next = { ...next, charges: refreshPercents(next.charges, itemsTotal(next.items, currency), currency) }
    commit(next)
    save.schedule(draftToReceipt(next, currency))
  }

  const switchCurrency = async (code: string) => {
    if (code === currency) return
    setSwitching(true)
    try {
      if (!(await save.flush())) return
      const b = await patch.mutateAsync({ currency: code })
      commit(draftFromBill(b))
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t change the currency.', 'danger')
    } finally {
      setSwitching(false)
    }
  }

  const proceed = async (anyway = false) => {
    setLeaving(true)
    try {
      if (!(await save.flush())) return
      const latest = qc.getQueryData<BillOut>(qk.bill(bill.id)) ?? bill
      if (!anyway && latest.validation && !latest.validation.ok) {
        setConfirmOpen(true)
        return
      }
      await patch.mutateAsync({ status: 'assigning' })
      navigate(`/bills/${bill.id}/assign`)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t continue. Try again.', 'danger')
    } finally {
      setLeaving(false)
    }
  }

  const hasPhoto = bill.files.length > 0
  const detected = bill.latest_job?.detected_currency
  const named = draft.items.filter((r) => r.name.trim()).length
  const problem = validationText(bill.validation, currency, hasPhoto)
  const total = grandTotal(draft, currency)
  const busy = switching

  return (
    <FlowShell
      billId={bill.id}
      steps={STEPS[bill.source]}
      current={2}
      save={save}
      footer={
        <FooterBar>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className={cn('whitespace-nowrap text-[14px] font-semibold', bill.validation && !bill.validation.ok && named ? 'text-warn' : 'text-ink-2')}>
              {bill.validation && !bill.validation.ok && named ? 'Doesn’t add up' : 'Total'}
            </span>
            <span className="hero-num text-[24px]">
              <Money minor={total} currency={currency} code />
            </span>
          </div>
          <span className="hidden md:block">
            <ButtonLink to={`/bills/${bill.id}/people`} variant="secondary" size="lg">
              Back to people
            </ButtonLink>
          </span>
          <Button size="lg" onClick={() => void proceed()} loading={leaving && !confirmOpen} disabled={named === 0 || busy}>
            Looks right
          </Button>
        </FooterBar>
      }
    >
      <div className={cn(hasPhoto && 'lg:-mx-[var(--app-gutter)] lg:grid lg:grid-cols-[minmax(340px,5fr)_minmax(0,8fr)]')}>
        {hasPhoto && (
          <aside aria-label="Receipt" className="hidden min-h-0 border-r border-rule bg-mist px-[clamp(16px,2vw,32px)] pb-28 pt-6 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
            <PhotoViewer bill={bill} className="flex-1" />
          </aside>
        )}

        <div className={cn('flex min-w-0 flex-col gap-6', hasPhoto && 'lg:px-[clamp(16px,3vw,48px)]')}>
          <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
            <StepTitle>{bill.items.length || hasPhoto ? 'Check the items' : 'Add the items'}</StepTitle>
            {hasPhoto && (
              <Button variant="secondary" size="sm" className="shrink-0 lg:hidden" icon={<Icon name="photo" size={18} />} onClick={() => setPhotoOpen(true)}>
                View photo
              </Button>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
            <TextField label="Place" value={draft.merchant} maxLength={120} autoComplete="off" onChange={(e) => update((d) => ({ ...d, merchant: e.target.value }))} />
            <TextField label="Date" type="date" value={draft.date} onChange={(e) => update((d) => ({ ...d, date: e.target.value }))} />
            <SelectField
              label="Currency"
              value={currency}
              disabled={busy || bill.currency_locked}
              hint={bill.currency_locked ? 'Locked after the first payment' : undefined}
              onChange={(e) => void switchCurrency(e.target.value)}
            >
              <CurrencyOptions />
            </SelectField>
          </div>

          {detected && detected !== currency && !dismissedCurrency && !bill.currency_locked && (
            <Notice tone="warn">
              This receipt looks like it’s in {detected}.
              <span className="mt-1 flex flex-wrap gap-x-5">
                <Button variant="quiet" className="h-11" loading={switching} onClick={() => void switchCurrency(detected)}>
                  Switch to {detected}
                </Button>
                <Button variant="quiet" className="h-11" onClick={() => setDismissedCurrency(true)}>
                  Keep {currency}
                </Button>
              </span>
            </Notice>
          )}

          {save.error != null && <SaveError error={save.error} onRetry={save.retry} />}
          {problem && named > 0 && <Notice tone="warn">{problem}</Notice>}

          <ItemsTable draft={draft} update={update} currency={currency} warnings={bill.validation?.warnings ?? []} disabled={busy} />

          <div className="flex flex-wrap items-start gap-x-10 gap-y-6">
            <div className="min-w-0 flex-[1_1_300px]">
              <ChargesList draft={draft} update={update} currency={currency} disabled={busy} />
            </div>
            <div className="flex min-w-0 flex-[0_1_340px] sm:pt-9">
              <TotalsList draft={draft} update={update} currency={currency} validation={bill.validation} disabled={busy} />
            </div>
          </div>
        </div>
      </div>

      {hasPhoto && (
        <Dialog open={photoOpen} onClose={() => setPhotoOpen(false)} title="Receipt">
          <PhotoViewer bill={bill} className="h-[68dvh]" hideLabel />
        </Dialog>
      )}

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="The totals don’t add up"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Fix it
            </Button>
            <Button
              loading={leaving}
              onClick={() => {
                void proceed(true)
              }}
            >
              Continue anyway
            </Button>
          </>
        }
      >
        <p className="text-[16px]">{validationText(bill.validation, currency, false) ?? bill.validation?.message}</p>
        <p className="mt-2 text-[16px]">Everyone’s share is worked out from the total you entered.</p>
      </Dialog>
    </FlowShell>
  )
}
