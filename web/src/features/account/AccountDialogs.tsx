import { useState, type FormEvent } from 'react'
import { Button } from '@/components/Button'
import { SelectField, TextField } from '@/components/Field'
import { Dialog, useToast } from '@/components/Feedback'
import { useDeleteFxRate, useSaveFxRate } from '@/data/queries'
import { ApiError } from '@/lib/api'
import { AuthError, authClient } from '@/lib/auth'
import { CURRENCIES } from '@/lib/money'
import { normaliseRate, rateError } from './rates'

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError || err instanceof AuthError ? err.message : fallback)

/** One text value (name, payment note): edit, save, close. Empty is allowed when `optional`. */
export function TextDialog({
  title,
  label,
  initial,
  maxLength,
  optional,
  placeholder,
  onSave,
  onClose,
}: {
  title: string
  label: string
  initial: string
  maxLength: number
  optional?: boolean
  placeholder?: string
  onSave: (value: string) => Promise<unknown>
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const clean = value.trim().replace(/\s+/g, ' ')
    if (!clean && !optional) return setError('This can’t be empty.')
    if (clean === initial.trim()) return onClose()
    setBusy(true)
    try {
      await onSave(clean)
      onClose()
    } catch (err) {
      setError(errorText(err, 'Couldn’t save. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <Button type="submit" form="text-dialog" loading={busy}>
          Save
        </Button>
      }
    >
      <form id="text-dialog" onSubmit={(e) => void submit(e)} noValidate>
        <TextField
          label={label}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          autoComplete="off"
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          error={error}
        />
      </form>
    </Dialog>
  )
}

export interface RateDraft {
  base: string
  quote: string
  rate: string
  /** editing a saved pair: the currencies are fixed, the rate can be changed or deleted */
  existing: boolean
}

export function RateDialog({ draft, onClose }: { draft: RateDraft; onClose: () => void }) {
  const save = useSaveFxRate()
  const remove = useDeleteFxRate()
  const toast = useToast()
  const [base, setBase] = useState(draft.base)
  const [quote, setQuote] = useState(draft.quote)
  const [rate, setRate] = useState(draft.rate)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (base === quote) return setError('Pick two different currencies.')
    const problem = rateError(rate)
    if (problem) return setError(problem)
    try {
      await save.mutateAsync({ base, quote, rate: normaliseRate(rate) })
      toast(`Saved 1 ${base} = ${normaliseRate(rate)} ${quote}`)
      onClose()
    } catch (err) {
      setError(errorText(err, 'Couldn’t save the rate. Try again.'))
    }
  }

  async function del() {
    try {
      await remove.mutateAsync({ base, quote })
      toast(`${base} → ${quote} rate deleted`)
      onClose()
    } catch (err) {
      setError(errorText(err, 'Couldn’t delete the rate. Try again.'))
    }
  }

  const options = CURRENCIES.map((c) => (
    <option key={c.code} value={c.code}>
      {c.code} — {c.name}
    </option>
  ))

  return (
    <Dialog
      open
      onClose={onClose}
      title={draft.existing ? `${draft.base} → ${draft.quote}` : 'Add rate'}
      footer={
        <>
          {draft.existing && (
            <Button variant="danger" className="mr-auto" loading={remove.isPending} onClick={() => void del()}>
              Delete
            </Button>
          )}
          <Button type="submit" form="rate-dialog" loading={save.isPending}>
            Save rate
          </Button>
        </>
      }
    >
      <form id="rate-dialog" onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        {!draft.existing && (
          <div className="grid grid-cols-2 gap-2.5">
            <SelectField label="From" value={base} onChange={(e) => (setBase(e.target.value), setError(null))}>
              {options}
            </SelectField>
            <SelectField label="To" value={quote} onChange={(e) => (setQuote(e.target.value), setError(null))}>
              {options}
            </SelectField>
          </div>
        )}
        <TextField
          label={`1 ${base} in ${quote}`}
          value={rate}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0091"
          onChange={(e) => {
            setRate(e.target.value)
            setError(null)
          }}
          error={error}
          className="num"
        />
      </form>
    </Dialog>
  )
}

export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (password.length < 8) return setError('Use at least 8 characters.')
    if (password !== confirm) return setError('The two passwords don’t match.')
    setBusy(true)
    try {
      await authClient.updatePassword(password)
      toast('Password changed')
      onClose()
    } catch (err) {
      setError(errorText(err, 'Couldn’t change the password. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Change password"
      footer={
        <Button type="submit" form="password-dialog" loading={busy}>
          Change password
        </Button>
      }
    >
      <form id="password-dialog" onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => (setPassword(e.target.value), setError(null))}
          hint="At least 8 characters."
        />
        <TextField
          label="Type it again"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => (setConfirm(e.target.value), setError(null))}
          error={error}
        />
      </form>
    </Dialog>
  )
}
