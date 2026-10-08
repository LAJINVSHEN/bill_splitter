import { useCallback, useRef, useState } from 'react'
import { useCreateBill, useUploadScan } from '@/data/queries'
import { ApiError, newIdempotencyKey } from '@/lib/api'
import { prepareUpload, UploadError } from '@/lib/image'
import type { UUID } from '@/lib/types'
import { quotaFromError, type QuotaInfo } from './flow'

export type ScanPhase = 'idle' | 'preparing' | 'uploading'

export interface ScanStartError {
  message: string
  quota: QuotaInfo | null
  /** set when the bill exists already (so "Type items instead" continues it rather than starting over) */
  billId: UUID | null
}

const signature = (files: File[]) => files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('|')

/**
 * Start → compress → create the bill (only now: never an empty draft) → upload with an
 * Idempotency-Key that is reused when the same files are retried, so a flaky network never
 * double-charges a scan. Pass `billId` to add a receipt to an existing bill.
 */
export function useScanStart(existingBillId?: UUID) {
  const createBill = useCreateBill()
  const upload = useUploadScan()
  const [phase, setPhase] = useState<ScanPhase>('idle')
  const [error, setError] = useState<ScanStartError | null>(null)
  const billId = useRef<UUID | null>(existingBillId ?? null)
  const attempt = useRef<{ sig: string; key: string; prepared: File[] | null } | null>(null)

  const start = useCallback(
    async (files: File[]): Promise<UUID | null> => {
      setError(null)
      const sig = signature(files)
      if (attempt.current?.sig !== sig) attempt.current = { sig, key: newIdempotencyKey('scan'), prepared: null }
      const current = attempt.current
      try {
        setPhase('preparing')
        current.prepared ??= await Promise.all(files.map((f) => prepareUpload(f)))
        setPhase('uploading')
        if (!billId.current) billId.current = (await createBill.mutateAsync({ source: 'scan' })).id
        await upload.mutateAsync({ billId: billId.current, files: current.prepared, idempotencyKey: current.key })
        setPhase('idle')
        return billId.current
      } catch (err) {
        setPhase('idle')
        const message =
          err instanceof UploadError || err instanceof ApiError ? err.message : 'Something went wrong preparing the photos. Try again.'
        // the files were refused outright: a retry needs a fresh key
        if (err instanceof ApiError && [400, 413, 415].includes(err.status)) attempt.current = null
        setError({ message, quota: quotaFromError(err), billId: billId.current })
        return null
      }
    },
    [createBill, upload],
  )

  return { start, phase, busy: phase !== 'idle', error, clearError: () => setError(null) }
}
