import { useSyncExternalStore } from 'react'
import { Button } from '@/components/Button'
import { controlClass } from '@/components/Field'
import { useToast } from '@/components/Feedback'
import { cn } from '@/lib/cn'

/** Track a media query (e.g. desktop vs phone containers that can't both be mounted). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

export const useIsDesktop = () => useMediaQuery('(min-width: 48rem)')

/** On/off with role="switch": one tap, the label says what it controls. */
export function Switch({
  checked,
  onChange,
  label,
  busy,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  busy?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className="group grid h-11 w-[60px] shrink-0 place-items-center disabled:opacity-60"
    >
      <span className={cn('relative block h-7 w-12 rounded-full transition-colors', checked ? 'bg-cobalt' : 'bg-rule-2')}>
        <span
          className={cn('absolute top-1 block h-5 w-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-6' : 'translate-x-1')}
        />
      </span>
    </button>
  )
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** A value shown once (temporary password): read-only field + Copy. Selecting it is the fallback. */
export function CopyField({ label, value, id }: { label: string; value: string; id: string }) {
  const toast = useToast()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[15px] font-semibold">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className={cn(controlClass, 'min-w-0 flex-1 font-semibold')}
        />
        <Button
          variant="secondary"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={async () => {
            const ok = await copyText(value)
            if (ok) toast('Copied')
            else {
              const el = document.getElementById(id) as HTMLInputElement | null
              el?.focus()
              el?.select()
              toast('Selected: copy it with your keyboard')
            }
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  )
}
