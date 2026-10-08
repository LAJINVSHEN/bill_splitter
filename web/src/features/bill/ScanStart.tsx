import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { FlowShell } from '@/app/FlowShell'
import { Button } from '@/components/Button'
import { Notice } from '@/components/Display'
import { useUsage } from '@/data/queries'
import type { UUID } from '@/lib/types'
import { STEPS } from './flow'
import { QuotaNotice, FooterBar } from './parts'
import { ReceiptPicker } from './ReceiptPicker'
import { useScanStart } from './useScanStart'

/**
 * Pick the receipt, then Start: compress, create the bill (only now), upload, and go straight
 * to "Who's splitting?" while it reads. With `billId`, adds a receipt to an existing bill.
 */
export function ScanStart({
  billId,
  top,
  onManual,
  manualBusy,
}: {
  billId?: UUID
  top: ReactNode
  /** "Type items instead": gets the bill id when one exists already */
  onManual: (billId: UUID | null) => void
  manualBusy?: boolean
}) {
  const navigate = useNavigate()
  const usage = useUsage()
  const [files, setFiles] = useState<File[]>([])
  const scan = useScanStart(billId)
  const paused = usage.data?.scans_paused
    ? { reason: usage.data.pause_reason ?? 'scans_disabled', pagesUsed: usage.data.pages_used, pagesQuota: usage.data.pages_quota, month: usage.data.month }
    : null
  const quota = scan.error?.quota ?? paused

  const start = async () => {
    const id = await scan.start(files)
    if (id) navigate(`/bills/${id}/people`, { replace: true })
  }

  return (
    <FlowShell
      billId={billId}
      steps={STEPS.scan}
      current={0}
      footer={
        <FooterBar>
          <span className="flex-1 text-[16px] font-semibold">
            {files.length > 0 && (
              <>
                <span className="hero-num mr-1 text-[24px]">{files.length}</span>
                {files.length === 1 ? 'page' : 'pages'}
              </>
            )}
          </span>
          <Button size="lg" disabled={files.length === 0 || Boolean(quota)} loading={scan.busy} onClick={() => void start()}>
            {scan.phase === 'preparing' ? 'Preparing' : scan.phase === 'uploading' ? 'Uploading' : scan.error ? 'Try again' : 'Read receipt'}
          </Button>
        </FooterBar>
      }
    >
      <div className="flex flex-col gap-5">
        {top}
        {quota ? (
          <QuotaNotice quota={quota} onManual={() => onManual(scan.error?.billId ?? billId ?? null)} busy={manualBusy} />
        ) : (
          scan.error && <Notice tone="danger">{scan.error.message}</Notice>
        )}
        <ReceiptPicker
          files={files}
          disabled={scan.busy || Boolean(quota)}
          onChange={(f) => {
            scan.clearError()
            setFiles(f)
          }}
        />
      </div>
    </FlowShell>
  )
}
