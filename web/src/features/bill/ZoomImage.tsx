import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'

const MIN = 1
const MAX = 5

interface View {
  s: number
  x: number
  y: number
}

/**
 * A receipt photo you can pinch, drag and double-tap (phones), or pinch / ctrl-scroll to zoom and
 * scroll to move (desktop). The image fits the width at 1×; moves are written straight to the
 * element's transform (no re-render per frame), so it stays smooth on long receipts.
 */
export function ZoomImage({ src, alt, onError, className }: { src: string; alt: string; onError?: () => void; className?: string }) {
  const stage = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const view = useRef<View>({ s: 1, x: 0, y: 0 })
  const zoomer = useRef<(factor: number) => void>(() => {})
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const el = stage.current
    const pic = img.current
    if (!el || !pic) return
    const pointers = new Map<number, { x: number; y: number }>()
    let pinch: { dist: number; s: number; mx: number; my: number } | null = null
    let lastTap = 0
    let frame = 0

    const clamp = (v: View): View => {
      const w = el.clientWidth
      const h = el.clientHeight
      const ratio = pic.naturalWidth ? pic.naturalHeight / pic.naturalWidth : 1
      const cw = w * v.s
      const ch = w * ratio * v.s
      const x = Math.min(0, Math.max(w - cw, v.x))
      const y = ch > h ? Math.min(0, Math.max(h - ch, v.y)) : 0
      return { s: v.s, x, y }
    }
    const paint = () => {
      frame = 0
      const { s, x, y } = view.current
      pic.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s})`
    }
    const set = (v: View) => {
      view.current = clamp(v)
      if (!frame) frame = requestAnimationFrame(paint)
      setScale((old) => (Math.abs(old - view.current.s) > 0.01 ? view.current.s : old))
    }
    /** zoom to `s`, keeping the point under (px, py) where it is */
    const zoomAt = (s: number, px: number, py: number) => {
      const v = view.current
      const next = Math.min(MAX, Math.max(MIN, s))
      set({ s: next, x: px - ((px - v.x) * next) / v.s, y: py - ((py - v.y) * next) / v.s })
    }
    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId)
      pointers.set(e.pointerId, local(e))
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: view.current.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
      }
    }
    const move = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId)
      if (!prev) return
      const now = local(e)
      pointers.set(e.pointerId, now)
      if (pointers.size >= 2 && pinch) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const v = view.current
        set({ ...v, x: v.x + mx - pinch.mx, y: v.y + my - pinch.my }) // two-finger drag moves too
        zoomAt((pinch.s * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.dist, mx, my)
        pinch.mx = mx
        pinch.my = my
      } else if (pointers.size === 1) {
        const v = view.current
        set({ ...v, x: v.x + now.x - prev.x, y: v.y + now.y - prev.y })
      }
    }
    const up = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId)
      pointers.delete(e.pointerId)
      if (pointers.size < 2) pinch = null
      // double-tap (touch) toggles between fit and a closer look
      if (e.pointerType === 'touch' && p && pointers.size === 0) {
        const t = Date.now()
        if (t - lastTap < 300) {
          zoomAt(view.current.s > 1.2 ? 1 : 2.5, p.x, p.y)
          lastTap = 0
        } else lastTap = t
      }
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = local(e)
      if (e.ctrlKey) zoomAt(view.current.s * Math.exp(-e.deltaY * 0.01), p.x, p.y) // trackpad pinch / ctrl+wheel
      else {
        const v = view.current
        set({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })
      }
    }
    const dbl = (e: MouseEvent) => {
      const p = local(e)
      zoomAt(view.current.s > 1.2 ? 1 : 2.5, p.x, p.y)
    }
    const resize = new ResizeObserver(() => set(view.current))
    resize.observe(el)

    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('dblclick', dbl)
    zoomer.current = (f: number) => zoomAt(view.current.s * f, el.clientWidth / 2, el.clientHeight / 2)
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('dblclick', dbl)
    }
  }, [])

  const zoomBy = (f: number) => zoomer.current(f)
  const btn =
    'grid h-11 w-11 place-items-center rounded-[var(--radius-control)] border border-ink-2 bg-paper text-[20px] font-bold leading-none text-ink shadow-sm hover:bg-mist disabled:text-ink-2'

  return (
    <div className={cn('relative h-full min-h-[320px] overflow-hidden', className)}>
      <div ref={stage} className="absolute inset-0 cursor-grab touch-none select-none overflow-hidden active:cursor-grabbing">
        <img
          ref={img}
          src={src}
          alt={alt}
          draggable={false}
          onError={onError}
          onLoad={() => zoomBy(1)}
          className="block w-full max-w-none origin-top-left will-change-transform"
        />
      </div>
      <div className="absolute right-3 top-3 flex gap-1.5">
        <button type="button" aria-label="Zoom out" className={btn} disabled={scale <= MIN + 0.01} onClick={() => zoomBy(1 / 1.5)}>
          −
        </button>
        <button type="button" aria-label="Zoom in" className={btn} disabled={scale >= MAX - 0.01} onClick={() => zoomBy(1.5)}>
          +
        </button>
      </div>
    </div>
  )
}
