import { Link } from 'react-router'
import { Avatar } from '@/components/Display'
import { Icon } from '@/components/Icon'
import { useMailbox } from '@/data/queries'
import { waitingLine } from './text'

/** Home's one line into the Mailbox when something needs an answer. Hidden otherwise. */
export function WaitingOnYou() {
  const mail = useMailbox()
  const requests = mail.data?.requests ?? []
  const line = waitingLine(requests)
  if (!line) return null
  const faces = requests.slice(0, 3)
  return (
    <Link
      to="/mailbox"
      className="group flex min-h-[60px] items-center gap-3 border-y-[1.5px] border-ink py-2 text-ink"
    >
      <span className="flex shrink-0 -space-x-2" aria-hidden="true">
        {faces.map((r) => (
          <span key={`${r.kind}-${r.id}`} className="rounded-full ring-2 ring-paper">
            <Avatar name={r.actor?.name ?? r.person_name ?? '?'} seed={r.actor?.color_seed ?? r.color_seed ?? 0} size={30} />
          </span>
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate text-[16px] font-semibold">{line}</span>
      <span className="flex shrink-0 items-center gap-1 text-[15px] font-bold text-cobalt group-hover:text-cobalt-ink">
        Open
        <Icon name="next" size={16} />
      </span>
    </Link>
  )
}
