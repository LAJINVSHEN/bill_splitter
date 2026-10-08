import { useState } from 'react'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'
import { useFileUrl } from '@/data/queries'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { BillOut } from '@/lib/types'

const ZOOMS = [1, 1.5, 2, 3]

/** The receipt beside the numbers: a tab per page, zoom, signed URLs that refresh themselves. */
export function PhotoViewer({ bill, className, hideLabel }: { bill: Pick<BillOut, 'id' | 'files'>; className?: string; hideLabel?: boolean }) {
  const files = [...bill.files].sort((a, b) => a.position - b.position)
  const [index, setIndex] = useState(0)
  const [zoom, setZoom] = useState(0)
  const file = files[Math.min(index, files.length - 1)]
  const url = useFileUrl(bill.id, file?.id, Boolean(file?.available))
  const isPdf = file?.mime === 'application/pdf'
  const expired = file && (!file.available || (url.error instanceof ApiError && url.error.code === 'file_expired'))

  if (!file) return null
  const zbtn =
    'grid h-11 w-11 place-items-center rounded-[var(--radius-control)] border border-rule-2 bg-paper text-[20px] font-bold leading-none text-ink hover:bg-mist disabled:text-ink-2'

  return (
    <div className={cn('flex min-h-0 flex-col gap-3', className)}>
      <div className="flex items-center justify-between gap-3">
        {files.length > 1 ? (
          <div role="tablist" aria-label="Receipt pages" className="flex min-w-0 gap-1.5 overflow-x-auto">
            {files.map((f, i) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={i === index}
                onClick={() => {
                  setIndex(i)
                  setZoom(0)
                }}
                className={cn(
                  'h-11 shrink-0 rounded-[var(--radius-control)] px-3 text-[14px]',
                  i === index ? 'border-[1.5px] border-ink bg-paper font-bold text-ink' : 'border border-rule-2 font-semibold text-ink-2 hover:text-ink',
                )}
              >
                {f.mime === 'application/pdf' ? 'PDF' : 'Photo'} {i + 1}
              </button>
            ))}
          </div>
        ) : (
          <span className={cn('text-[15px] font-semibold', hideLabel && 'sr-only')}>{isPdf ? 'Receipt PDF' : 'Receipt photo'}</span>
        )}
        {!isPdf && !expired && (
          <div className="flex shrink-0 gap-1.5">
            <button type="button" aria-label="Zoom out" className={zbtn} disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>
              −
            </button>
            <button type="button" aria-label="Zoom in" className={zbtn} disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}>
              +
            </button>
          </div>
        )}
      </div>

      <div role={files.length > 1 ? 'tabpanel' : undefined} className="relative min-h-[320px] flex-1 overflow-auto rounded-[8px] border border-rule bg-paper">
        {expired ? (
          <div className="grid h-full min-h-[320px] place-items-center p-6 text-center">
            <p className="flex max-w-[30ch] flex-col items-center gap-2 text-[15px] font-semibold text-ink-2">
              <Icon name="photo" size={28} />
              Receipt photos are deleted after 90 days. The items are all still here.
            </p>
          </div>
        ) : url.error ? (
          <div className="grid h-full min-h-[320px] place-items-center p-6">
            <div className="flex flex-col items-center gap-2 text-center">
              <p className="text-[15px] font-semibold text-danger">Couldn’t load the photo.</p>
              <Button variant="secondary" size="sm" icon={<Icon name="retry" size={18} />} onClick={() => void url.refetch()} loading={url.isFetching}>
                Try again
              </Button>
            </div>
          </div>
        ) : !url.data ? (
          <div className="h-full min-h-[320px] animate-pulse bg-mist" aria-label="Loading photo" />
        ) : isPdf ? (
          <div className="flex h-full min-h-[320px] flex-col">
            <iframe title="Receipt PDF" src={url.data.url} className="min-h-[320px] w-full flex-1 border-0" />
            <a href={url.data.url} target="_blank" rel="noreferrer" className="flex h-11 items-center gap-1.5 border-t border-rule px-3 text-[15px] font-semibold text-cobalt">
              Open the PDF
              <Icon name="next" size={18} />
            </a>
          </div>
        ) : (
          <img
            src={url.data.url}
            alt={`Receipt, page ${index + 1}`}
            className="block h-auto max-w-none"
            style={{ width: `${ZOOMS[zoom]! * 100}%` }}
            onError={() => void url.refetch()}
          />
        )}
      </div>
    </div>
  )
}
