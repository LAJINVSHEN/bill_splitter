import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Icon } from './Icon'

/**
 * A row that scrolls sideways when it's wider than its box (tabs, chips). Smooth scrolling, an
 * arrow at whichever edge has more to see, and a vertical mouse wheel scrolls it sideways on desktop.
 * No visible scrollbar; touch swipes as usual.
 */
export function ScrollStrip({ children, label, className, innerClassName }: { children: ReactNode; label: string; className?: string; innerClassName?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })

  const measure = () => {
    const el = ref.current
    if (!el) return
    const left = el.scrollLeft > 2
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }))
  }
  // content changes (people added or removed) can change the overflow: re-measure after each render
  useLayoutEffect(measure)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
      e.preventDefault()
      el.scrollBy({ left: e.deltaY })
    }
    el.addEventListener('scroll', measure, { passive: true })
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', measure)
      el.removeEventListener('wheel', wheel)
    }
  }, [])

  const by = (dir: 1 | -1) => {
    const el = ref.current
    if (el) el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: 'smooth' })
  }
  const arrow = 'absolute inset-y-0 z-10 flex w-12 items-center text-ink hover:text-cobalt'

  return (
    <div className={cn('relative min-w-0', className)}>
      <div
        ref={ref}
        role="group"
        aria-label={label}
        className={cn('flex min-w-0 overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', innerClassName)}
      >
        {children}
      </div>
      {edges.left && (
        <button type="button" tabIndex={-1} aria-label="Scroll left" onClick={() => by(-1)} className={cn(arrow, 'left-0 justify-start bg-linear-to-r from-paper from-55% to-transparent')}>
          <Icon name="back" size={20} />
        </button>
      )}
      {edges.right && (
        <button type="button" tabIndex={-1} aria-label="Scroll right" onClick={() => by(1)} className={cn(arrow, 'right-0 justify-end bg-linear-to-l from-paper from-55% to-transparent')}>
          <Icon name="next" size={20} />
        </button>
      )}
    </div>
  )
}
