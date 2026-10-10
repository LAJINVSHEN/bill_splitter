import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { FlowShell } from '@/app/FlowShell'
import { Button } from '@/components/Button'
import { FullPageLoader, Notice } from '@/components/Display'
import { SelectField, TextField } from '@/components/Field'
import { useBill, useCreateBill, useMe, usePatchBill } from '@/data/queries'
import { cn } from '@/lib/cn'
import type { BillOut, UUID } from '@/lib/types'
import { billTitle, isUUID, STEPS, stepLinks, todayLocal } from '@/features/bill/flow'
import { CurrencyOptions } from '@/features/bill/inputs'
import { StepTitle, FooterBar } from '@/features/bill/parts'
import { QuickForm } from '@/features/bill/QuickForm'
import { ScanStart } from '@/features/bill/ScanStart'

type Mode = 'scan' | 'manual' | 'quick'
const MODES: Array<{ mode: Mode; label: string; title: string }> = [
  { mode: 'scan', label: 'Scan', title: 'Scan a receipt' },
  { mode: 'manual', label: 'Type items', title: 'Type the items' },
  { mode: 'quick', label: 'Split a total', title: 'Split a total' },
]

const parseMode = (v: string | null): Mode => (v === 'manual' || v === 'quick' ? v : 'scan')

/** Three ways in, one place to switch between them. */
function ModeTabs({ mode }: { mode: Mode }) {
  return (
    <nav aria-label="How to start" className="-mt-1 flex gap-5 border-b border-rule">
      {MODES.map((m) => (
        <Link
          key={m.mode}
          to={`/bills/new?mode=${m.mode}`}
          replace
          aria-current={m.mode === mode ? 'page' : undefined}
          className={cn(
            'flex h-11 items-center whitespace-nowrap text-[15px] font-semibold',
            m.mode === mode ? 'text-ink shadow-[inset_0_-3px_0_var(--color-cobalt)]' : 'text-ink-2 hover:text-ink',
          )}
        >
          {m.label}
        </Link>
      ))}
    </nav>
  )
}

export default function NewBillPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const mode = parseMode(params.get('mode'))
  const title = MODES.find((m) => m.mode === mode)?.title ?? ''
  const top = (
    <>
      <StepTitle>{title}</StepTitle>
      <ModeTabs mode={mode} />
    </>
  )

  if (mode === 'quick') return <QuickForm key="quick" top={top} />
  if (mode === 'manual') {
    const billId = params.get('bill')
    return isUUID(billId ?? undefined) ? <ManualStartFor billId={billId as UUID} top={<StepTitle>Type the items</StepTitle>} /> : <ManualStart top={top} />
  }
  return (
    <ScanStart
      key="scan"
      top={top}
      onManual={(billId) => (billId ? navigate(`/bills/${billId}/people`) : navigate('/bills/new?mode=manual', { replace: true }))}
    />
  )
}

/** Coming back to Start on a typed bill: wait for it, then edit it in place. */
function ManualStartFor({ billId, top }: { billId: UUID; top: React.ReactNode }) {
  const bill = useBill(billId)
  if (bill.data) return <ManualStart key={bill.data.id} top={top} bill={bill.data} />
  if (bill.isPending) return <FullPageLoader label="Loading bill" />
  return <ManualStart top={top} />
}

/**
 * Typing items: what it was, when, and in what currency, then pick people. A new bill is created
 * on Next; coming back here from a later step edits the same bill.
 */
function ManualStart({ top, bill }: { top: React.ReactNode; bill?: BillOut }) {
  const navigate = useNavigate()
  const me = useMe()
  const create = useCreateBill()
  const patch = usePatchBill(bill?.id ?? '')
  const [merchant, setMerchant] = useState(bill ? billTitle(bill) : '')
  const [date, setDate] = useState(bill ? (bill.bill_date ?? '') : todayLocal())
  const [currency, setCurrency] = useState<string | null>(bill?.currency ?? null)
  const cur = currency ?? me.data?.default_currency ?? 'SGD'
  const error = create.error ?? patch.error

  const next = () => {
    const fields = { merchant: merchant.trim() || undefined, bill_date: date || undefined }
    if (!bill) {
      create.mutate({ source: 'manual', ...fields, currency: cur }, { onSuccess: (b) => navigate(`/bills/${b.id}/people`, { replace: true }) })
      return
    }
    patch.mutate(
      { merchant: fields.merchant ?? null, bill_date: fields.bill_date ?? null, ...(cur !== bill.currency && !bill.currency_locked ? { currency: cur } : {}) },
      { onSuccess: (b) => navigate(`/bills/${b.id}/people`) },
    )
  }

  return (
    <FlowShell
      billId={bill?.id}
      steps={STEPS.manual}
      current={0}
      links={bill ? stepLinks(bill) : undefined}
      footer={
        <FooterBar>
          <span className="flex-1" />
          <Button size="lg" loading={create.isPending || patch.isPending} onClick={next}>
            Next: who’s splitting
          </Button>
        </FooterBar>
      }
    >
      <form
        className="flex max-w-[640px] flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          next()
        }}
      >
        {top}
        <TextField label="What was it?" value={merchant} onChange={(e) => setMerchant(e.target.value)} maxLength={120} autoComplete="off" enterKeyHint="next" />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <SelectField
            label="Currency"
            value={cur}
            disabled={bill?.currency_locked}
            hint={bill?.currency_locked ? 'Locked after the first payment' : undefined}
            onChange={(e) => setCurrency(e.target.value)}
          >
            <CurrencyOptions />
          </SelectField>
        </div>
        {error && <Notice tone="danger">{error.message}</Notice>}
        <button type="submit" className="sr-only" tabIndex={-1}>
          Next
        </button>
      </form>
    </FlowShell>
  )
}
