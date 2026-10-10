import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * A one-line name that may be cut off. Tapping a cut-off name shows the whole of it in a small
 * bubble; a name that fits lets the tap through (so a row it sits in still works as usual).
 * Hover shows it too (title). Screen readers always get the full text.
 */
export function FullName({ text, children, className }: { text: string; children?: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e.type === 'pointerdown' && ref.current?.parentElement?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    window.addEventListener('scroll', close, { passive: true, capture: true })
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
      window.removeEventListener('scroll', close, { capture: true })
    }
  }, [open])

  return (
    <span className="relative block min-w-0">
      <span
        ref={ref}
        title={text}
        className={cn('block truncate', className)}
        onClick={(e) => {
          const el = ref.current
          if (!open && !(el && el.scrollWidth > el.clientWidth + 1)) return
          e.preventDefault()
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        {children ?? text}
      </span>
      {open && (
        <span
          role="tooltip"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
          }}
          className="absolute left-0 top-full z-30 mt-1 block w-max max-w-[min(24rem,calc(100vw-2.5rem))] whitespace-normal break-words rounded-[var(--radius-control)] bg-ink px-3 py-2 text-left text-[15px] font-medium leading-snug text-paper shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  )
}
