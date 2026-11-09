import { useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'
import { useToast } from '@/components/Feedback'
import { isBillChanged, qk, usePutAssignments, type AssignmentIn } from '@/data/queries'
import { ApiError } from '@/lib/api'
import type { BillOut, UUID } from '@/lib/types'
import { applyAssignments } from './assignment'
import { useAutosave } from './useAutosave'

const BURST_MS = 400

/**
 * Optimistic painting: each tap updates the cached bill at once (the screen previews with the TS
 * split mirror), taps in a burst are coalesced into one PUT /assignments, and the server's bill
 * replaces the preview. Failed edits remain visible and queued for retry. On a shared bill, taps
 * that clash with someone else's change to the same items are dropped and the latest is shown.
 */
export function useAssignments(billId: UUID) {
  const qc = useQueryClient()
  const put = usePutAssignments(billId)
  const toast = useToast()
  const pending = useRef(new Map<UUID, AssignmentIn>())
  const send = async (list: AssignmentIn[]) => {
    try {
      return await put.mutateAsync(list)
    } catch (err) {
      if (!isBillChanged(err)) throw err
      pending.current.clear()
      await qc.refetchQueries({ queryKey: qk.bill(billId), exact: true })
      toast((err as ApiError).message, 'danger')
      return qc.getQueryData<BillOut>(qk.bill(billId)) as BillOut
    }
  }
  const save = useAutosave(send, {
    delay: BURST_MS,
    onSaved: (saved, sent) => {
      sent.forEach((assignment) => {
        if (pending.current.get(assignment.item_id) === assignment) pending.current.delete(assignment.item_id)
      })
      if (pending.current.size) qc.setQueryData(qk.bill(billId), applyAssignments(saved, [...pending.current.values()]))
    },
  })

  const assign = (list: AssignmentIn[]) => {
    const current = qc.getQueryData<BillOut>(qk.bill(billId))
    if (!current || list.length === 0) return
    void qc.cancelQueries({ queryKey: qk.bill(billId), exact: true })
    qc.setQueryData(qk.bill(billId), applyAssignments(current, list))
    list.forEach((a) => pending.current.set(a.item_id, a))
    save.schedule([...pending.current.values()])
  }

  return { ...save, assign, settle: save.flush, busy: save.dirty || save.saving }
}
