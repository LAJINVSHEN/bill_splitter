import { useState, type FormEvent } from 'react'
import { Button } from '@/components/Button'
import { Avatar, SectionTitle } from '@/components/Display'
import { Dialog, useToast } from '@/components/Feedback'
import { TextField } from '@/components/Field'
import { useAccessRequests, useAnswerAccess } from '@/data/queries'
import { ago } from '@/features/mailbox/text'
import { ApiError } from '@/lib/api'
import type { AccessRequestOut } from '@/lib/types'

/** A steady colour for someone with no people entry yet (a hue from their email). */
const colorFor = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)

/** A user id from an email: "Priya.Raman+x@gmail.com" → "priya.raman". */
export function suggestUsername(email: string): string {
  const local = email.split('@')[0]?.split('+')[0] ?? ''
  const clean = local.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 32)
  return clean.length >= 3 ? clean : `${clean}user`.slice(0, 32)
}

/**
 * People who signed in with Google but have no account yet. Approving makes the account for that
 * same Google sign-in (no password to hand over); rejecting just closes the request. Hidden when empty.
 */
export function AccessRequests() {
  const requests = useAccessRequests()
  const [approving, setApproving] = useState<AccessRequestOut | null>(null)
  const pending = (requests.data ?? []).filter((r) => r.status === 'pending')
  if (!pending.length) return null
  return (
    <section aria-labelledby="join-title">
      <SectionTitle id="join-title">Asking to join</SectionTitle>
      <ul className="border-t-[1.5px] border-ink">
        {pending.map((r) => (
          <RequestRow key={r.id} r={r} onApprove={() => setApproving(r)} />
        ))}
      </ul>
      {approving && <ApproveDialog r={approving} onClose={() => setApproving(null)} />}
    </section>
  )
}

function RequestRow({ r, onApprove }: { r: AccessRequestOut; onApprove: () => void }) {
  const answer = useAnswerAccess()
  const toast = useToast()
  const name = r.name || r.email
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-b border-rule py-2.5 sm:flex sm:min-h-[64px]">
      <Avatar name={name} seed={colorFor(r.email)} size={32} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[16px] font-semibold">{name}</span>
        <span className="truncate text-[14px] text-ink-2">
          {r.email} · {ago(r.created_at)}
        </span>
        {r.note && <span className="break-words text-[15px]">“{r.note}”</span>}
      </span>
      <span className="col-span-2 flex shrink-0 items-center justify-end gap-4 text-[15px]">
        <button
          type="button"
          disabled={answer.isPending}
          onClick={() => answer.mutate({ id: r.id, approve: false }, { onSuccess: () => toast('Request rejected'), onError: (e) => toast(e.message, 'danger') })}
          className="min-h-11 min-w-11 font-bold text-ink hover:text-cobalt disabled:text-ink-2"
        >
          Reject
        </button>
        <button type="button" onClick={onApprove} className="min-h-11 min-w-11 font-bold text-cobalt hover:text-cobalt-ink">
          Approve
        </button>
      </span>
    </li>
  )
}

function ApproveDialog({ r, onClose }: { r: AccessRequestOut; onClose: () => void }) {
  const answer = useAnswerAccess()
  const toast = useToast()
  const [username, setUsername] = useState(() => suggestUsername(r.email))
  const [display, setDisplay] = useState(r.name ?? '')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      await answer.mutateAsync({ id: r.id, approve: true, username: username.trim().toLowerCase(), display_name: display.trim() || undefined })
      toast(`${display || username} can sign in with Google now`)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t approve. Try again.')
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Approve"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="approve-form" loading={answer.isPending}>Make the account</Button>
        </>
      }
    >
      <form id="approve-form" onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <p className="break-words text-[16px] font-semibold">{r.email}</p>
        <TextField label="User id" value={username} maxLength={32} autoCapitalize="none" spellCheck={false} onChange={(e) => { setUsername(e.target.value); setError(null) }} error={error} />
        <TextField label="Name" value={display} maxLength={60} onChange={(e) => setDisplay(e.target.value)} />
      </form>
    </Dialog>
  )
}
