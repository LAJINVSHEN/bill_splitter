import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/Button'
import { EvenBadge, Notice } from '@/components/Display'
import { TextField } from '@/components/Field'
import { qk, useAskForAccess, useMyAccessRequest } from '@/data/queries'
import { dayOf } from '@/features/home/format'
import { ApiError } from '@/lib/api'
import { authClient } from '@/lib/auth'

/**
 * Signed in with Google, but there's no account for that email yet. Accounts stay with the
 * admin: you can ask for one here, and see the answer when you come back (nothing is emailed).
 */
export function AskForAccess() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const mine = useMyAccessRequest(true)
  const ask = useAskForAccess()
  const [note, setNote] = useState('')
  const [leaving, setLeaving] = useState(false)

  const signOut = async () => {
    setLeaving(true)
    await authClient.signOut()
    navigate('/login', { replace: true })
    setLeaving(false)
  }
  const other = (
    <Button variant="quiet" className="self-start" loading={leaving} onClick={() => void signOut()}>
      Use another account
    </Button>
  )

  const r = mine.data
  if (mine.isPending) return null
  if (r?.status === 'approved') {
    return (
      <div className="mt-8 flex flex-col items-start gap-4">
        <EvenBadge label="You’re in" />
        <Button
          size="lg"
          onClick={() => {
            void qc.invalidateQueries({ queryKey: qk.me })
            navigate('/', { replace: true })
          }}
        >
          Open even
        </Button>
      </div>
    )
  }
  if (r?.status === 'pending' || r?.status === 'rejected') {
    return (
      <div className="mt-8 flex flex-col gap-4">
        <Notice tone={r.status === 'rejected' ? 'danger' : 'info'}>
          {r.status === 'rejected'
            ? `The admin didn’t add ${r.email}.`
            : `Asked on ${dayOf(r.created_at)} for ${r.email}. Come back once the admin says yes.`}
        </Notice>
        {other}
      </div>
    )
  }

  const submit = () => ask.mutate(note.trim())
  return (
    <div className="mt-8 flex flex-col gap-4">
      <h2 className="display-sm text-xl">This Google account isn’t on even yet</h2>
      <TextField
        label={
          <>
            Note for the admin <span className="font-medium text-ink-2">· optional</span>
          </>
        }
        placeholder="Maya’s friend, joining the Kyoto trip"
        value={note}
        maxLength={300}
        onChange={(e) => setNote(e.target.value)}
      />
      {ask.error && <Notice tone="danger">{ask.error instanceof ApiError ? ask.error.message : 'Couldn’t send. Try again.'}</Notice>}
      <Button size="lg" block loading={ask.isPending} onClick={submit}>
        Ask for access
      </Button>
      {other}
    </div>
  )
}
