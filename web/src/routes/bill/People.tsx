import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { FlowShell } from '@/app/FlowShell'
import { EqualsMark } from '@/components/Brand'
import { Button } from '@/components/Button'
import { Notice } from '@/components/Display'
import { isJobActive, useMe, usePatchBill, usePutParticipants } from '@/data/queries'
import type { BillOut, UUID } from '@/lib/types'
import { STEPS } from '@/features/bill/flow'
import { BillGate, SaveError, StepTitle, FooterBar } from '@/features/bill/parts'
import { PeoplePicker } from '@/features/bill/PeoplePicker'
import { ScanStrip } from '@/features/bill/ScanStrip'
import { useAutosave } from '@/features/bill/useAutosave'

export default function PeopleStep() {
  return <BillGate>{(bill) => (bill.source === 'quick' ? <Navigate to={`/bills/${bill.id}/quick`} replace /> : <PeopleScreen bill={bill} />)}</BillGate>
}

function PeopleScreen({ bill }: { bill: BillOut }) {
  const navigate = useNavigate()
  const me = useMe()
  const put = usePutParticipants(bill.id)
  const patch = usePatchBill(bill.id)
  const [selected, setSelected] = useState<UUID[]>(() => bill.participants.map((p) => p.person_id))
  const save = useAutosave((ids: UUID[]) => put.mutateAsync(ids), { delay: 600 })
  const selfId = me.data?.self_person_id ?? bill.participants.find((p) => p.is_self)?.person_id
  const scanning = bill.status === 'scanning' || isJobActive(bill.latest_job?.status)
  const [leaving, setLeaving] = useState(false)

  const change = (ids: UUID[]) => {
    const ordered = selfId && ids.includes(selfId) ? [selfId, ...ids.filter((id) => id !== selfId)] : ids
    setSelected(ordered)
    save.schedule(ordered)
  }

  const next = async () => {
    setLeaving(true)
    try {
      if (!(await save.flush())) return
      if (bill.status === 'draft') await patch.mutateAsync({ status: 'review' })
      navigate(`/bills/${bill.id}/review`)
    } catch {
      /* patch.error is shown */
    } finally {
      setLeaving(false)
    }
  }

  const n = selected.length
  return (
    <FlowShell
      billId={bill.id}
      steps={STEPS[bill.source]}
      current={1}
      save={save}
      footer={
        <FooterBar>
          <span className="flex-1 text-[16px] font-semibold" aria-live="polite">
            <span className="hero-num mr-1 text-[24px]">{n}</span>
            {n === 1 ? 'person' : 'people'}
          </span>
          <Button size="lg" onClick={() => void next()} disabled={scanning} loading={leaving} icon={scanning ? <EqualsMark size="sm" moving /> : undefined}>
            {scanning ? 'Waiting for receipt' : bill.items.length ? 'Review items' : 'Add items'}
          </Button>
        </FooterBar>
      }
    >
      <div className="flex max-w-[640px] flex-col gap-4">
        <StepTitle>Who’s splitting?</StepTitle>
        <ScanStrip bill={bill} onManual={() => void next()} manualBusy={leaving} />
        {save.error != null && <SaveError error={save.error} onRetry={save.retry} />}
        {patch.error && <Notice tone="danger">{patch.error.message}</Notice>}
        <PeoplePicker
          selected={selected}
          onChange={change}
          known={bill.participants.map((p) => ({ id: p.person_id, name: p.name, color_seed: p.color_seed, is_self: p.is_self }))}
          locked={selfId ? [selfId] : []}
          note={(id) => (id === bill.payer_person_id ? 'paid' : null)}
        />
      </div>
    </FlowShell>
  )
}
