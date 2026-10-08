import { Navigate } from 'react-router'
import { stepPath } from '@/features/bill/flow'
import { BillGate, StepTitle } from '@/features/bill/parts'
import { QuickForm } from '@/features/bill/QuickForm'

/** Edit a quick split (total, who, equally or by shares). Itemised bills are sent to their own step. */
export default function QuickPage() {
  return (
    <BillGate>
      {(bill) =>
        bill.source !== 'quick' && bill.items.length > 0 ? (
          <Navigate to={stepPath(bill)} replace />
        ) : (
          <QuickForm key={bill.id} bill={bill} top={<StepTitle>Split a total</StepTitle>} />
        )
      }
    </BillGate>
  )
}
