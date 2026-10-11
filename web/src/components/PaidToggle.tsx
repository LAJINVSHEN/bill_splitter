import { cn } from '@/lib/cn'
import { EqualsMark } from './Brand'
import { Icon } from './Icon'

/**
 * The one paid control: off = outlined, on = filled with a tick. Tapping again takes it back,
 * so a mis-tap is one tap to undo. Say "Received" when the money comes to you, "Paid" otherwise
 * (``received``). ``label`` names what's being settled for screen readers; the pressed state
 * says whether it is. The button is always a 44px target; the pill inside stays compact.
 */
export function PaidToggle({ paid, busy, onToggle, label, received = false, text }: {
  paid: boolean
  busy?: boolean
  onToggle: () => void
  label?: string
  received?: boolean
  text?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={paid}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={onToggle}
      className="group inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center focus-visible:outline-none"
    >
      <span
        className={cn(
          'inline-flex h-9 min-w-[4.75rem] items-center justify-center gap-1.5 rounded-[var(--radius-control)] border-[1.5px] border-cobalt px-3 text-[15px] font-bold transition-colors',
          'group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-cobalt',
          paid ? 'bg-cobalt text-white group-hover:border-cobalt-ink group-hover:bg-cobalt-ink' : 'bg-paper text-cobalt group-hover:bg-cobalt-soft',
        )}
      >
        {busy ? <EqualsMark size="xs" moving tone={paid ? 'white' : 'cobalt'} /> : paid && <Icon name="check" size={16} />}
        {text ?? (received ? 'Received' : 'Paid')}
      </span>
    </button>
  )
}
