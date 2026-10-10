import { useState } from 'react'
import { Button, ButtonLink } from '@/components/Button'
import { Notice } from '@/components/Display'
import { Dialog, useToast } from '@/components/Feedback'
import { SelectField } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { useBillLinks, useMe, useResetLink } from '@/data/queries'
import type { BillOut, EnsuredLink, UUID } from '@/lib/types'
import { amountText, buildShareMessage, linkWithFragment, type MessageScope } from './message'

const GROUP = 'group'

/**
 * Share a finished bill: pick the group chat or one person, see the exact message, then Share
 * (the phone's share sheet) or Copy. The links inside are the same every time.
 */
export function ShareDialog({ bill, open, onClose, personId }: { bill: BillOut; open: boolean; onClose: () => void; personId?: UUID | null }) {
  return (
    <Dialog open={open} onClose={onClose} title="Share">
      {open && <Body key={personId ?? GROUP} bill={bill} initial={personId ?? GROUP} />}
    </Dialog>
  )
}

function Body({ bill, initial }: { bill: BillOut; initial: string }) {
  const me = useMe()
  const toast = useToast()
  const others = bill.split.people.filter((p) => !p.is_payer)
  const ids: Array<UUID | null> = [null, ...others.map((p) => p.person_id)]
  const links = useBillLinks(bill.id, ids)
  const reset = useResetLink(bill.id)
  const [scope, setScope] = useState(initial)
  const [fresh, setFresh] = useState<Record<string, EnsuredLink>>({})
  const [confirmReset, setConfirmReset] = useState(false)

  const link = fresh[scope] ?? links.data?.find((l) => (l.person_id ?? GROUP) === scope)
  const which: MessageScope = scope === GROUP ? { kind: 'group' } : { kind: 'person', personId: scope }
  const url = link ? linkWithFragment(link.url ?? `${window.location.origin}${link.path}`, which, bill) : null
  const text =
    url && me.data ? buildShareMessage({ bill, hostName: me.data.display_name, paymentNote: me.data.payment_note, scope: which, url }) : null
  const payer = bill.split.people.find((p) => p.is_payer)
  const missingNote = Boolean(payer?.is_self && !me.data?.payment_note?.trim())
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  const eff = bill.split.effective_currency

  const copy = async () => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast('Message copied')
    } catch {
      toast('Couldn’t copy: press and hold the message to copy it', 'danger')
    }
  }
  const share = async () => {
    if (!text) return
    try {
      // the link goes inside `text`: some apps drop `text` or `url` when both are given
      await navigator.share({ text })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      await copy()
    }
  }
  const doReset = () => {
    if (!link) return
    reset.mutate(link.link_id, {
      onSuccess: (next) => {
        setFresh((f) => ({ ...f, [scope]: next }))
        setConfirmReset(false)
        toast('New link ready. The old one no longer opens.')
      },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <SelectField
        label="Send to"
        value={scope}
        onChange={(e) => {
          setScope(e.target.value)
          setConfirmReset(false)
        }}
      >
        <option value={GROUP}>Group chat (everyone)</option>
        {others.map((p) => (
          <option key={p.person_id} value={p.person_id}>
            {p.is_self ? me.data?.display_name ?? 'Me' : p.name} · {p.outstanding_cents > 0 ? amountText(p.outstanding_cents, eff) : 'paid'}
          </option>
        ))}
      </SelectField>

      {missingNote && (
        <Notice
          tone="warn"
          action={
            <ButtonLink to="/account" variant="quiet" className="-my-2.5 shrink-0">
              Add
            </ButtonLink>
          }
        >
          Add how friends pay you, so the message says where to send it.
        </Notice>
      )}

      {links.isError ? (
        <Notice tone="danger" action={<Button variant="quiet" className="-my-2.5" loading={links.isFetching} onClick={() => void links.refetch()}>Retry</Button>}>
          {links.error.message}
        </Notice>
      ) : (
        <pre
          aria-label="Message"
          aria-busy={!text}
          className="max-h-[42dvh] min-h-[8rem] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-control)] border border-rule bg-mist px-3.5 py-3 font-sans text-[15px] leading-relaxed text-ink"
        >
          {text ?? 'Getting the link…'}
        </pre>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {confirmReset ? (
          <span className="flex flex-wrap items-center gap-x-3 text-[15px] font-semibold">
            The old link stops opening.
            <Button variant="danger" className="h-11 px-0" loading={reset.isPending} onClick={doReset}>
              Make a new link
            </Button>
          </span>
        ) : (
          <Button variant="quiet" className="text-[15px]" disabled={!link} onClick={() => setConfirmReset(true)}>
            New link
          </Button>
        )}
        <span className="ml-auto flex gap-2.5">
          <Button variant={canShare ? 'secondary' : 'primary'} disabled={!text} onClick={() => void copy()}>
            Copy
          </Button>
          {canShare && (
            <Button disabled={!text} icon={<Icon name="share" size={18} />} onClick={() => void share()}>
              Share…
            </Button>
          )}
        </span>
      </div>
      {reset.error && <Notice tone="danger">{reset.error.message}</Notice>}
    </div>
  )
}
