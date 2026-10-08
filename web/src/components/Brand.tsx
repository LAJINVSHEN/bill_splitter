import { cn } from '@/lib/cn'

type MarkSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const BAR: Record<MarkSize, { w: number; h: number; gap: number }> = {
  xs: { w: 12, h: 2.5, gap: 3 },
  sm: { w: 14, h: 3, gap: 3.5 },
  md: { w: 16, h: 3.5, gap: 4 },
  lg: { w: 26, h: 6, gap: 6 },
  xl: { w: 40, h: 9, gap: 10 },
}

/**
 * The "=" — even's one recurring gesture: wordmark, settled state, active nav, loaders.
 * `moving` offsets the lower bar (not even yet) and slides it: our only loading animation.
 */
export function EqualsMark({
  size = 'md',
  tone = 'cobalt',
  moving = false,
  className,
}: {
  size?: MarkSize
  tone?: 'cobalt' | 'white' | 'ink'
  moving?: boolean
  className?: string
}) {
  const b = BAR[size]
  const color = tone === 'white' ? 'bg-white' : tone === 'ink' ? 'bg-ink' : 'bg-cobalt'
  return (
    <span aria-hidden="true" className={cn('inline-flex flex-col', className)} style={{ gap: b.gap }}>
      <span className={cn('block rounded-[2px]', color)} style={{ width: b.w, height: b.h }} />
      <span
        className={cn('block rounded-[2px]', color, moving && 'animate-even')}
        style={{ width: moving ? b.w * 0.65 : b.w, height: b.h, marginLeft: moving ? b.w * 0.35 : 0 }}
      />
    </span>
  )
}

const WORD: Record<'sm' | 'md' | 'lg', { text: string; mark: MarkSize; gap: string }> = {
  sm: { text: 'text-[22px]', mark: 'sm', gap: 'gap-[5px]' },
  md: { text: 'text-[28px]', mark: 'md', gap: 'gap-1.5' },
  lg: { text: 'text-[52px]', mark: 'lg', gap: 'gap-2.5' },
}

/** The only way the product name is rendered. */
export function Wordmark({ size = 'md', tone = 'ink', className }: { size?: 'sm' | 'md' | 'lg'; tone?: 'ink' | 'white'; className?: string }) {
  const w = WORD[size]
  return (
    <span className={cn('inline-flex items-center', w.gap, tone === 'white' ? 'text-white' : 'text-ink', className)}>
      <span className={cn(w.text, 'leading-none font-bold tracking-[-0.045em]')} style={{ fontStretch: '118%' }}>
        even
      </span>
      <EqualsMark size={w.mark} tone={tone === 'white' ? 'white' : 'cobalt'} className="mt-[0.12em]" />
    </span>
  )
}
