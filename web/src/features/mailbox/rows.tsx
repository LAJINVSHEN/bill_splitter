import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { EqualsMark } from '@/components/Brand'
import { Button } from '@/components/Button'
import { Avatar, Money } from '@/components/Display'
import { Dialog, useToast } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { useAnswerLink, useConfirmClaim, useFriendAction, useLinkPerson, useRejectClaim } from '@/data/queries'
import { cn } from '@/lib/cn'
import type { MailboxOut, MailRequest, MailUpdate } from '@/lib/types'
import { ago, first, requestText, updateLink, updateText } from './text'

/** Two text answers on the right, like a ledger's actions: the "yes" in cobalt. */
function Answers({ no, yes, busy, onNo, onYes }: { no: string; yes: string; busy: 'no' | 'yes' | null; onNo: () => void; onYes: () => void }) {
  return (
    <span className="col-span-2 flex shrink-0 items-center justify-end gap-4 text-[15px]">
      <button type="button" disabled={busy !== null} onClick={onNo} className="flex min-h-11 min-w-11 items-center gap-1.5 font-bold text-ink hover:text-cobalt disabled:text-ink-2">
        {busy === 'no' && <EqualsMark size="xs" moving tone="ink" />}
        {no}
      </button>
      <button type="button" disabled={busy !== null} onClick={onYes} className="flex min-h-11 min-w-11 items-center gap-1.5 font-bold text-cobalt hover:text-cobalt-ink disabled:text-ink-2">
        {busy === 'yes' && <EqualsMark size="xs" moving />}
        {yes}
      </button>
    </span>
  )
}

function Row({ avatar, title, meta, children, to }: { avatar: ReactNode; title: string; meta: ReactNode; children?: ReactNode; to?: string | null }) {
  const text = (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="break-words text-[16px] font-semibold leading-snug">{title}</span>
      <span className="truncate text-[14px] text-ink-2">{meta}</span>
    </span>
  )
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 border-b border-rule py-2.5 sm:flex sm:min-h-[64px]">
      {avatar}
      {to ? <Link to={to} className="flex min-w-0 flex-1 hover:text-cobalt">{text}</Link> : text}
      {children}
    </li>
  )
}

// ---- requests ------------------------------------------------------------------------------------
export function RequestRow({ r }: { r: MailRequest }) {
  if (r.kind === 'payment_claim') return <ClaimRow r={r} />
  if (r.kind === 'link_invite') return <LinkInviteRow r={r} />
  return <FriendRequestRow r={r} />
}

function FriendRequestRow({ r }: { r: MailRequest }) {
  const act = useFriendAction()
  const toast = useToast()
  const [asking, setAsking] = useState(false)
  const name = first(r.actor?.name)
  const run = (action: 'accept' | 'decline' | 'block', then: string) =>
    act.mutate(
      { action, id: action === 'block' ? (r.actor?.id ?? '') : r.id },
      { onSuccess: () => { setAsking(false); toast(then) }, onError: (e) => toast(e.message, 'danger') },
    )
  const busy = act.isPending ? (act.variables?.action === 'accept' ? 'yes' : 'no') : null
  return (
    <>
      <Row avatar={<Avatar name={r.actor?.name ?? '?'} seed={r.actor?.color_seed ?? 0} size={32} />} title={requestText(r)} meta={`@${r.actor?.username} · ${ago(r.created_at)}`}>
        <Answers no="Decline" yes="Accept" busy={busy} onNo={() => setAsking(true)} onYes={() => run('accept', `You and ${name} are friends`)} />
      </Row>
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title={`Say no to ${name}?`}
        footer={
          <>
            <Button variant="danger" className="mr-auto px-3" loading={act.isPending && act.variables?.action === 'block'} onClick={() => run('block', `${name} is blocked`)}>
              Block
            </Button>
            <Button variant="secondary" loading={act.isPending && act.variables?.action === 'decline'} onClick={() => run('decline', 'Request declined')}>
              Say no
            </Button>
          </>
        }
      >
        <p className="text-[16px]">{name} will see that you said no, and can ask again in 30 days. Block them to stop requests for good.</p>
      </Dialog>
    </>
  )
}

function LinkInviteRow({ r }: { r: MailRequest }) {
  const answer = useAnswerLink()
  const toast = useToast()
  const n = r.bill_count ?? 0
  const bills = n === 1 ? '1 bill' : `${n} bills`
  const busy = answer.isPending ? (answer.variables?.accept ? 'yes' : 'no') : null
  const go = (accept: boolean) =>
    answer.mutate(
      { id: r.id, accept },
      {
        onSuccess: () => toast(accept ? `${bills} shared with you` : `${first(r.actor?.name)} will know it isn’t you`),
        onError: (e) => toast(e.message, 'danger'),
      },
    )
  return (
    <Row avatar={<Avatar name={r.actor?.name ?? '?'} seed={r.actor?.color_seed ?? 0} size={32} />} title={requestText(r)} meta={`${bills} come with it · ${ago(r.created_at)}`}>
      <Answers no="Not me" yes="That’s me" busy={busy} onNo={() => go(false)} onYes={() => go(true)} />
    </Row>
  )
}

function ClaimRow({ r }: { r: MailRequest }) {
  const billId = r.bill_id ?? ''
  const confirm = useConfirmClaim(billId)
  const reject = useRejectClaim(billId)
  const toast = useToast()
  const busy = confirm.isPending ? 'yes' : reject.isPending ? 'no' : null
  const fail = (e: Error) => toast(e.message, 'danger')
  return (
    <Row
      avatar={<Avatar name={r.person_name ?? '?'} seed={r.color_seed ?? 0} size={32} />}
      title={requestText(r)}
      to={`/bills/${billId}`}
      meta={
        <>
          <Money minor={r.amount_cents ?? 0} currency={r.currency ?? ''} code /> · {r.bill_title}
        </>
      }
    >
      <Answers
        no="Not yet"
        yes="Confirm"
        busy={busy}
        onNo={() => reject.mutate(r.id, { onError: fail })}
        onYes={() => confirm.mutate({ claimId: r.id }, { onSuccess: () => toast(`${first(r.person_name)} is even`), onError: fail })}
      />
    </Row>
  )
}

// ---- updates -------------------------------------------------------------------------------------
export function UpdateRow({ u, unread }: { u: MailUpdate; unread: boolean }) {
  const rows = u.kind === 'plan_sent' ? (u.data.rows ?? []) : []
  return (
    <li className={cn('border-b border-rule', unread && 'bg-cobalt-soft/40')}>
      <UpdateLine u={u} unread={unread} />
      {rows.length > 0 && (
        <ul className="mb-2.5 ml-[44px] flex flex-col gap-1 text-[15px]">
          {rows.map((p, i) => (
            <li key={i} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">
                {p.you_pay ? `You pay ${first(p.to)}` : p.you_get ? `${first(p.from)} pays you` : `${first(p.from)} pays ${first(p.to)}`}
              </span>
              <Money minor={p.amount_cents} currency={u.data.currency ?? ''} code className={cn('font-semibold', p.you_get && 'text-cobalt-ink')} />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function UpdateLine({ u, unread }: { u: MailUpdate; unread: boolean }) {
  const to = updateLink(u)
  const body = (
    <>
      {u.actor ? <Avatar name={u.actor.name} seed={u.actor.color_seed} size={32} /> : <span className="grid h-8 w-8 place-items-center"><Icon name="mail" /></span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('break-words text-[16px] leading-snug', unread ? 'font-bold' : 'font-medium')}>{updateText(u)}</span>
        <span className="text-[14px] text-ink-2">{ago(u.at)}</span>
      </span>
      {unread && <span aria-label="New" className="h-2.5 w-2.5 shrink-0 rounded-full bg-cobalt" />}
      {to && <Icon name="next" size={16} className="shrink-0 text-ink-2" />}
    </>
  )
  const cls = 'flex min-h-[60px] items-center gap-3 py-2'
  return to ? <Link to={to} className={cn(cls, 'hover:text-cobalt')}>{body}</Link> : <div className={cls}>{body}</div>
}

// ---- what you asked ------------------------------------------------------------------------------
export function SentRow({ s }: { s: MailboxOut['sent'][number] }) {
  const friend = useFriendAction()
  const link = useLinkPerson()
  const toast = useToast()
  const busy = friend.isPending || link.isPending
  const takeBack = () => {
    const done = { onSuccess: () => toast('Taken back'), onError: (e: Error) => toast(e.message, 'danger') }
    if (s.kind === 'friend_request') friend.mutate({ action: 'cancel', id: s.id }, done)
    else if (s.person_id) link.mutate({ personId: s.person_id, accountId: null }, done)
  }
  return (
    <li className="flex min-h-[56px] items-center gap-3 border-b border-rule py-1.5">
      <Icon name={s.kind === 'friend_request' ? 'person' : 'link'} className="shrink-0 text-ink-2" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[16px] font-semibold">{s.kind === 'friend_request' ? s.label : `“${s.person_name}” is ${first(s.label)}?`}</span>
        <span className="text-[14px] text-ink-2">Waiting · {ago(s.created_at)}</span>
      </span>
      <Button variant="quiet" className="shrink-0" loading={busy} onClick={takeBack}>
        Take back
      </Button>
    </li>
  )
}
