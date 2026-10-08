import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { FlowShell } from '@/app/FlowShell'
import { Button } from '@/components/Button'
import { Notice } from '@/components/Display'
import { SelectField, TextField } from '@/components/Field'
import { useCreateBill, useMe } from '@/data/queries'
import { cn } from '@/lib/cn'
import { STEPS, todayLocal } from '@/features/bill/flow'
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
  if (mode === 'manual') return <ManualStart top={top} />
  return (
    <ScanStart
      key="scan"
      top={top}
      onManual={(billId) => (billId ? navigate(`/bills/${billId}/people`) : navigate('/bills/new?mode=manual', { replace: true }))}
    />
  )
}

/** Typing items: say where and in what currency, then pick people. The bill is created on Next. */
function ManualStart({ top }: { top: React.ReactNode }) {
  const navigate = useNavigate()
  const me = useMe()
  const create = useCreateBill()
  const [merchant, setMerchant] = useState('')
  const [date, setDate] = useState(todayLocal())
  const [currency, setCurrency] = useState<string | null>(null)
  const cur = currency ?? me.data?.default_currency ?? 'SGD'

  const next = () =>
    create.mutate(
      { source: 'manual', merchant: merchant.trim() || undefined, bill_date: date || undefined, currency: cur },
      { onSuccess: (b) => navigate(`/bills/${b.id}/people`, { replace: true }) },
    )

  return (
    <FlowShell
      steps={STEPS.manual}
      current={0}
      footer={
        <FooterBar>
          <span className="flex-1" />
          <Button size="lg" loading={create.isPending} onClick={next}>
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
        <TextField label="Where was it?" value={merchant} onChange={(e) => setMerchant(e.target.value)} maxLength={120} autoComplete="off" enterKeyHint="next" />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <SelectField label="Currency" value={cur} onChange={(e) => setCurrency(e.target.value)}>
            <CurrencyOptions />
          </SelectField>
        </div>
        {create.error && <Notice tone="danger">{create.error.message}</Notice>}
        <button type="submit" className="sr-only" tabIndex={-1}>
          Next
        </button>
      </form>
    </FlowShell>
  )
}
