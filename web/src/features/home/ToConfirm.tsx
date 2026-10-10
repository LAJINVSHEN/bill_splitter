import { Link } from 'react-router'
import { EqualsMark } from '@/components/Brand'
import { Avatar, Money, SectionTitle } from '@/components/Display'
import { useToast } from '@/components/Feedback'
import { useConfirmClaim, useInbox, useRejectClaim } from '@/data/queries'
import type { InboxClaim } from '@/lib/types'

/** Friends who said "I've paid" through a link: one tap to confirm, or "Not yet". Hidden when empty. */
export function ToConfirm() {
  const inbox = useInbox()
  const items = inbox.data ?? []
  if (!items.length) return null
  return (
    <section aria-labelledby="to-confirm">
      <SectionTitle id="to-confirm">To confirm</SectionTitle>
      <ul className="border-t-[1.5px] border-ink">
        {items.map((c) => (
          <Row key={c.id} c={c} />
        ))}
      </ul>
    </section>
  )
}

function Row({ c }: { c: InboxClaim }) {
  const toast = useToast()
  const confirm = useConfirmClaim(c.bill_id)
  const reject = useRejectClaim(c.bill_id)
  const busy = confirm.isPending || reject.isPending
  const fail = (err: Error) => toast(err.message, 'danger')
  return (
    <li className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-rule py-2 sm:flex sm:min-h-[60px]">
      <Avatar name={c.person_name} seed={c.color_seed} />
      <Link to={`/bills/${c.bill_id}`} className="flex min-w-0 flex-1 flex-col hover:text-cobalt">
        <span className="truncate text-[16px] font-semibold">{c.person_name}</span>
        <span className="truncate text-[14px] text-ink-2">Says paid · {c.bill_title}</span>
      </Link>
      <Money minor={c.amount_cents} currency={c.currency} className="text-[16px] font-semibold" />
      <span className="col-span-3 flex shrink-0 items-center justify-end gap-4 text-[14px] sm:col-span-1">
        <button type="button" disabled={busy} onClick={() => reject.mutate(c.id, { onError: fail })} className="min-h-11 min-w-11 font-bold text-ink hover:text-cobalt disabled:text-ink-2">
          Not yet
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => confirm.mutate({ claimId: c.id }, { onSuccess: () => toast(`${c.person_name} is even`), onError: fail })}
          className="flex min-h-11 min-w-11 items-center gap-1.5 font-bold text-cobalt hover:text-cobalt-ink disabled:text-ink-2"
        >
          {confirm.isPending && <EqualsMark size="xs" moving />}
          Confirm
        </button>
      </span>
    </li>
  )
}
