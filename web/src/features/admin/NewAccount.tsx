import { useState, type FormEvent } from 'react'
import { Button } from '@/components/Button'
import { Notice } from '@/components/Display'
import { SelectField, TextField } from '@/components/Field'
import { useCreateUser } from '@/data/queries'
import { ApiError } from '@/lib/api'
import { CopyField } from './bits'
import { emailError, normaliseUsername, parseCount, usernameError } from './logic'

type Login = 'password' | 'google'

interface Created {
  username: string
  name: string
  login: Login
  email: string
  tempPassword: string | null
}

/**
 * The New account form. Lives in a side panel on desktop and in a Dialog on phones (the caller decides).
 * The temporary password is shown once, right here, with Copy.
 */
export function NewAccountForm({ defaultQuota, formId = 'new-account' }: { defaultQuota: number; formId?: string }) {
  const create = useCreateUser()
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [login, setLogin] = useState<Login>('password')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [quota, setQuota] = useState(String(defaultQuota))
  const [errors, setErrors] = useState<Partial<Record<'username' | 'name' | 'email' | 'quota' | 'form', string>>>({})
  const [created, setCreated] = useState<Created | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const cleanName = name.trim().replace(/\s+/g, ' ')
    const q = parseCount(quota, 0, 10_000)
    const next: typeof errors = {}
    const u = usernameError(username)
    if (u) next.username = u
    if (cleanName.length > 60) next.name = 'Keep it under 60 characters.'
    if (login === 'google') {
      const em = emailError(email)
      if (em) next.email = em
    }
    if (q === null) next.quota = 'A whole number from 0 to 10,000.'
    setErrors(next)
    if (Object.keys(next).length > 0 || q === null) return
    try {
      const res = await create.mutateAsync({
        username,
        ...(cleanName ? { display_name: cleanName } : {}),
        login,
        ...(login === 'google' ? { email: email.trim() } : {}),
        role,
        monthly_scan_quota: q,
      })
      setCreated({ username: res.user.username, name: res.user.display_name, login, email: email.trim(), tempPassword: res.temp_password })
    } catch (err) {
      const code = err instanceof ApiError ? err.code : ''
      const message = err instanceof ApiError ? err.message : 'Couldn’t create the account. Try again.'
      if (code === 'username_taken') setErrors({ username: 'That username is taken.' })
      else if (code === 'email_taken') setErrors({ email: 'That email already has an account.' })
      else setErrors({ form: message })
    }
  }

  function again() {
    setCreated(null)
    setUsername('')
    setName('')
    setEmail('')
    setLogin('password')
    setRole('member')
    setQuota(String(defaultQuota))
  }

  if (created) {
    return (
      <div className="flex flex-col gap-4">
        <p className="display-sm text-lg">{created.name} is set up</p>
        {created.tempPassword ? (
          <>
            <CopyField id={`${formId}-username`} label="Username" value={created.username} />
            <CopyField id={`${formId}-password`} label="Temporary password" value={created.tempPassword} />
            <p className="text-[15px] font-semibold text-warn">Share these with them. The password is shown once; they pick their own at first sign-in.</p>
          </>
        ) : (
          <p className="text-[17px]">
            They can sign in with Google as <span className="font-semibold">{created.email}</span>.
          </p>
        )}
        <Button variant="secondary" className="self-start" onClick={again}>
          Create another
        </Button>
      </div>
    )
  }

  return (
    <form id={formId} onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-3.5">
      {errors.form && <Notice tone="danger">{errors.form}</Notice>}
      <TextField
        label="Username"
        value={username}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={32}
        onChange={(e) => {
          setUsername(normaliseUsername(e.target.value))
          setErrors((x) => ({ ...x, username: undefined }))
        }}
        error={errors.username}
      />
      <TextField label="Name" value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} error={errors.name} />
      <SelectField label="Signs in with" value={login} onChange={(e) => setLogin(e.target.value as Login)}>
        <option value="password">Username and password</option>
        <option value="google">Google</option>
      </SelectField>
      {login === 'google' && (
        <TextField
          label="Google email"
          type="email"
          inputMode="email"
          autoComplete="off"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setErrors((x) => ({ ...x, email: undefined }))
          }}
          error={errors.email}
        />
      )}
      <div className="grid grid-cols-2 gap-2.5">
        <TextField label="Scans / month" inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value)} error={errors.quota} />
        <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </SelectField>
      </div>
      <Button type="submit" size="lg" block loading={create.isPending} className="mt-1">
        Create account
      </Button>
    </form>
  )
}
