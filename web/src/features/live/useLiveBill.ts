import { useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { applyBill, qk } from '@/data/queries'
import { api } from '@/lib/api'
import type { BillOut, LiveOut, UUID } from '@/lib/types'

/**
 * Shared bills stay live without a socket: while one is open and the tab is visible, poll a
 * cheap endpoint every few seconds (who's here, the version, and the bill only when it moved on).
 *
 * A newer bill is applied only when you have nothing unsaved, so a draft is never swapped out
 * under you and its saves keep the version they were based on (the server then catches a real
 * clash). Editors register their unsaved state with `useDraftGuard`.
 */
const POLL_MS = 4000
const drafts = new Map<UUID, number>()

export function useDraftGuard(billId: UUID, unsaved: boolean) {
  useEffect(() => {
    if (!unsaved) return
    drafts.set(billId, (drafts.get(billId) ?? 0) + 1)
    return () => {
      const n = (drafts.get(billId) ?? 1) - 1
      if (n > 0) drafts.set(billId, n)
      else drafts.delete(billId)
    }
  }, [billId, unsaved])
}

export interface LiveState {
  /** others with the bill open now */
  others: LiveOut['viewers']
  /** the last change someone else made that just landed on your screen */
  landed: { by: string; at: number } | null
}

export function useLiveBill(bill: Pick<BillOut, 'id' | 'shared'> | undefined): LiveState {
  const qc = useQueryClient()
  const id = bill?.id ?? ''
  const mutating = useIsMutating({ mutationKey: ['bill', id] }) > 0
  const [landed, setLanded] = useState<LiveState['landed']>(null)
  const live = useQuery({
    queryKey: ['live', id] as const,
    enabled: Boolean(bill?.shared),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
    queryFn: () => {
      const version = qc.getQueryData<BillOut>(qk.bill(id))?.version
      return api<LiveOut>(`/bills/${id}/live${version ? `?version=${version}` : ''}`, { timeoutMs: 15_000 })
    },
  })

  const next = live.data?.bill
  useEffect(() => {
    if (!next || mutating || drafts.has(id)) return
    const current = qc.getQueryData<BillOut>(qk.bill(id))
    if (current?.version && next.version && next.version <= current.version) return
    applyBill(qc, next)
    if (live.data?.updated_by) setLanded({ by: live.data.updated_by, at: Date.now() }) // eslint-disable-line react-hooks/set-state-in-effect -- reflects the poll
  // dataUpdatedAt: re-check on every poll (structural sharing keeps `next` the same object)
  }, [next, mutating, id, qc, live.data?.updated_by, live.dataUpdatedAt])

  useEffect(() => {
    if (!landed) return
    const t = window.setTimeout(() => setLanded(null), 8000)
    return () => window.clearTimeout(t)
  }, [landed])

  return { others: (live.data?.viewers ?? []).filter((v) => !v.is_self), landed }
}
