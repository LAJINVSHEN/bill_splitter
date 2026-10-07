import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { useSessionStatus } from '@/app/session'
import { Wordmark } from '@/components/Brand'
import { Button } from '@/components/Button'
import { Notice } from '@/components/Display'
import { TextField } from '@/components/Field'
import { AuthError, authClient } from '@/lib/auth'

const PROBLEMS: Record<string, string> = {
  not_provisioned: 'This account isn’t set up yet. Ask the admin to finish it.',
  account_disabled: 'This account has been turned off. Ask the admin.',
  invalid_audience: 'That sign-in can’t be used here.',
}

function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'
}

export default function Login() {
  const status = useSessionStatus()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const problem = params.get('problem')

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'password' | 'google' | null>(null)

  if (status === 'signedIn' && !problem) return <Navigate to={next} replace />

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!username.trim() || !password) {
      setError('Enter your username and password.')
      return
    }
    setBusy('password')
    setError(null)
    try {
      await authClient.signInWithPassword(username, password)
      navigate(next, { replace: true })
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Couldn’t sign in. Try again.')
    } finally {
      setBusy(null)
    }
  }

  async function google() {
    setBusy('google')
    setError(null)
    try {
      await authClient.signInWithGoogle()
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Google sign-in failed.')
      setBusy(null)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col px-6 pb-8 pt-[min(14vh,112px)]">
      <Wordmark size="lg" />
      <p className="mt-3.5 text-[17px] text-ink-2">Scan it, split it, call it even.</p>

      {problem && PROBLEMS[problem] && (
        <div className="mt-8">
          <Notice tone="danger">{PROBLEMS[problem]}</Notice>
        </div>
      )}

      <form onSubmit={submit} noValidate className="mt-10 flex flex-col gap-[18px]">
        <TextField
          label="Username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <TextField
          label="Password"
          name="password"
          type={show ? 'text' : 'password'}
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
          labelAction={
            <button type="button" onClick={() => setShow((s) => !s)} className="text-[15px] font-semibold text-cobalt" aria-pressed={show}>
              {show ? 'Hide' : 'Show'}
            </button>
          }
        />
        <Button type="submit" size="lg" block loading={busy === 'password'} className="mt-1.5">
          Sign in
        </Button>
      </form>

      {authClient.supportsGoogle && (
        <>
          <div aria-hidden="true" className="my-5 flex items-center gap-3 text-[14px] font-semibold text-ink-2">
            <span className="h-px flex-1 bg-rule" />
            or
            <span className="h-px flex-1 bg-rule" />
          </div>
          <Button variant="secondary" size="lg" block onClick={google} loading={busy === 'google'}>
            Continue with Google
          </Button>
        </>
      )}

      <p className="mt-auto pt-10 text-[15px] leading-relaxed text-ink-2">No account? Accounts are set up by the admin — ask them for a username.</p>
    </main>
  )
}
