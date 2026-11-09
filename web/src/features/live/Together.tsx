import { EqualsMark } from '@/components/Brand'
import { Avatar } from '@/components/Display'
import { useBill } from '@/data/queries'
import { cn } from '@/lib/cn'
import type { UUID } from '@/lib/types'
import { useLiveBill } from './useLiveBill'

function names(list: string[]): string {
  if (list.length <= 2) return list.join(' and ')
  return `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`
}

/**
 * Who else has this shared bill open, and a quiet line when their change lands on your screen.
 * Renders nothing for a bill only you can see. Polling lives here, so mounting it keeps the bill live.
 */
export function Together({ billId, className }: { billId: UUID; className?: string }) {
  const bill = useBill(billId).data
  const { others, landed } = useLiveBill(bill)
  if (!bill?.shared || (!others.length && !landed)) return null
  return (
    <p aria-live="polite" className={cn('flex min-h-8 min-w-0 items-center gap-2 text-[14px] font-semibold', className)}>
      {landed ? (
        <>
          <EqualsMark size="xs" />
          <span className="truncate text-cobalt-ink">{landed.by} just made a change</span>
        </>
      ) : (
        <>
          <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
            {others.slice(0, 3).map((v) => (
              <span key={v.name} className="rounded-full ring-2 ring-paper">
                <Avatar name={v.name} seed={v.color_seed} size={24} />
              </span>
            ))}
          </span>
          <span className="truncate text-ink-2">
            {names(others.map((v) => v.name.split(' ')[0] ?? v.name))} {others.length === 1 ? 'is' : 'are'} here
          </span>
        </>
      )}
    </p>
  )
}
