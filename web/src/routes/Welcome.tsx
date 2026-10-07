import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { Wordmark } from '@/components/Brand'
import { Button } from '@/components/Button'
import { FullPageLoader } from '@/components/Display'
import { TextField } from '@/components/Field'
import { useMe, usePasswordChanged } from '@/data/queries'
import { AuthError, authClient } from '@/lib/auth'

/** First sign-in with a temporary password: pick your own before anything else. */
export default function Welcome() {
  const me = useMe()
  const done = usePasswordChanged()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (me.isPending) return <FullPageLoader />
  if (me.data && !me.data.must_change_password) return <Navigate to="/" replace />

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (password.length < 8) return setError('Use at least 8 characters.')
    if (password !== confirm) return setError('The two passwords don’t match.')
    setBusy(true)
    setError(null)
    try {
      await authClient.updatePassword(password)
      await done.mutateAsync()
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Couldn’t save the password. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col px-6 pb-8 pt-[min(12vh,96px)]">
      <Wordmark />
      <h1 className="display mt-10 text-[34px]">Welcome, {me.data?.display_name ?? 'friend'}</h1>
      <p className="mt-2 text-[17px] text-ink-2">Pick your own password to replace the temporary one.</p>
      <form onSubmit={submit} noValidate className="mt-8 flex flex-col gap-[18px]">
        <TextField label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 8 characters." />
        <TextField label="Type it again" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={error} />
        <Button type="submit" size="lg" block loading={busy} className="mt-1.5">
          Save and continue
        </Button>
      </form>
    </main>
  )
}
