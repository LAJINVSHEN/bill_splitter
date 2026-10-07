import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { slowNetwork } from '@/lib/api'
import { cn } from '@/lib/cn'
import { EqualsMark } from './Brand'
import { Icon } from './Icon'

// ---- Toasts: short confirmations ("Link copied") and errors that aren't tied to a field --------------
type Tone = 'neutral' | 'danger'
interface ToastItem {
  id: number
  message: string
  tone: Tone
}
const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => undefined)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)
  const push = useCallback((message: string, tone: Tone = 'neutral') => {
    const id = ++seq.current
    setItems((list) => [...list.slice(-2), { id, message, tone }])
    window.setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), tone === 'danger' ? 6000 : 3000)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--app-bottom-gap)-1rem)] z-50 flex flex-col items-center gap-2 px-4 md:bottom-6">
        {items.map((t) => (
          <p
            key={t.id}
            className={cn(
              'pointer-events-auto rounded-[var(--radius-control)] px-4 py-3 text-[15px] font-semibold shadow-[0_8px_24px_rgb(11_15_25/0.18)]',
              t.tone === 'danger' ? 'bg-danger text-white' : 'bg-ink text-white',
            )}
          >
            {t.message}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

// ---- Cold-start signal: a free-tier server sleeps; say so instead of looking broken ---------------
export function SlowNetworkBar() {
  const slow = useSyncExternalStore(slowNetwork.subscribe, slowNetwork.get, () => false)
  if (!slow) return null
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2.5 bg-cobalt-soft px-4 py-2 text-[14px] font-semibold text-cobalt-ink">
      <EqualsMark size="xs" moving />
      Waking the server — the first load after a quiet spell can take up to a minute.
    </div>
  )
}

// ---- Dialog: native <dialog>; a bottom sheet on phones, centred panel on desktop ---------------
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      aria-labelledby="dialog-title"
      className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[88dvh] w-full max-w-none overflow-auto rounded-t-[14px] bg-paper p-0 text-ink backdrop:bg-ink/40 md:inset-0 md:m-auto md:h-fit md:w-[min(520px,calc(100%-2rem))] md:rounded-[var(--radius-panel)]"
    >
      <div className="flex items-center justify-between gap-3 px-5 pt-4">
        <h2 id="dialog-title" className="display-sm text-xl">
          {title}
        </h2>
        <button type="button" aria-label="Close" onClick={onClose} className="-mr-2 grid h-11 w-11 place-items-center text-ink">
          <Icon name="close" />
        </button>
      </div>
      <div className="px-5 pb-5 pt-2">{children}</div>
      {footer && <div className="pb-safe sticky bottom-0 flex justify-end gap-2.5 border-t border-rule bg-paper px-5 py-3">{footer}</div>}
    </dialog>
  )
}
