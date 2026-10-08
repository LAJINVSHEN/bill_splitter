import { Navigate, useNavigate } from 'react-router'
import { usePatchBill } from '@/data/queries'
import type { BillOut } from '@/lib/types'
import { scanRunning } from '@/features/bill/flow'
import { BillGate, StepTitle } from '@/features/bill/parts'
import { ScanStart } from '@/features/bill/ScanStart'

/** Add a receipt to a bill that exists already (after a failed scan, or to a typed draft). */
export default function ScanRoute() {
  return <BillGate>{(bill) => (scanRunning(bill) ? <Navigate to={`/bills/${bill.id}/people`} replace /> : <AddReceipt bill={bill} />)}</BillGate>
}

function AddReceipt({ bill }: { bill: BillOut }) {
  const navigate = useNavigate()
  const patch = usePatchBill(bill.id)
  const toManual = async () => {
    if (bill.status === 'draft') await patch.mutateAsync({ status: 'review' }).catch(() => undefined)
    navigate(`/bills/${bill.id}/review`)
  }
  return (
    <ScanStart
      billId={bill.id}
      top={<StepTitle>{bill.items.length ? 'Scan it again' : 'Scan the receipt'}</StepTitle>}
      onManual={() => void toManual()}
      manualBusy={patch.isPending}
    />
  )
}
