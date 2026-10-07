import { useState, type FormEvent } from 'react'
import { Button } from '@/components/Button'
import { Meter, Notice } from '@/components/Display'
import { SelectField, TextField } from '@/components/Field'
import { Dialog, useToast } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { useDeleteAdminUser, useMe, useResetPassword, useUpdateUser } from '@/data/queries'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { AdminUsageOut, AdminUserOut } from '@/lib/types'
import { CopyField, Switch } from './bits'
import { atLimit, formatUsd, parseCount, userTags, type UserTag } from './logic'

const TAG_INK: Record<UserTag['tone'], string> = {
  cobalt: 'text-cobalt',
  warn: 'text-warn',
  danger: 'text-danger',
  quiet: 'text-ink-2',
}

function Tags({ user }: { user: AdminUserOut }) {
  return (
    <span className="text-[14px] font-semibold">
      {userTags(user).map((t, i) => (
        <span key={t.label} className={TAG_INK[t.tone]}>
          {i > 0 && <span className="text-ink-2"> · </span>}
          {t.label}
        </span>
      ))}
    </span>
  )
}

function Scans({ user }: { user: AdminUserOut }) {
  const limit = atLimit(user.pages_used_this_month, user.monthly_scan_quota)
  return (
    <span className="flex items-center gap-2.5">
      <span className="min-w-0 flex-1">
        <Meter
          value={user.pages_used_this_month}
          max={user.monthly_scan_quota}
          label={`${user.display_name}: scans used this month`}
          tone={limit ? 'warn' : 'cobalt'}
        />
      </span>
      <span className={cn('num w-[64px] text-right text-[15px] font-semibold', limit && 'text-warn')}>
        {user.pages_used_this_month} / {user.monthly_scan_quota}
      </span>
    </span>
  )
}

/** Accounts: a table on desktop, a ruled list on phones (both from the same rows). */
export function AccountsList({ users, usage, onEdit }: { users: AdminUserOut[]; usage: AdminUsageOut | undefined; onEdit: (u: AdminUserOut) => void }) {
  const spend = new Map((usage?.by_user ?? []).map((u) => [u.user_id, u.cost_micros]))
  return (
    <>
      <ul aria-label="Accounts" className="border-t-[1.5px] border-ink md:hidden">
        {users.map((u) => (
          <li key={u.id} className="flex flex-col gap-1.5 border-b border-rule py-2.5">
            <div className="flex items-start justify-between gap-3">
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-semibold">
                  {u.display_name} <span className="font-medium text-ink-2">@{u.username}</span>
                </span>
                <Tags user={u} />
              </span>
              <Button variant="quiet" className="-my-1.5 shrink-0" aria-label={`Edit ${u.display_name}`} onClick={() => onEdit(u)}>
                Edit
              </Button>
            </div>
            <Scans user={u} />
          </li>
        ))}
      </ul>
      <div className="relative hidden overflow-x-auto md:block">
        <table aria-label="Accounts" className="w-full min-w-[620px] border-collapse text-base">
          <thead>
            <tr className="border-t-[1.5px] border-b border-ink border-b-rule text-left text-[14px] text-ink-2">
              <th scope="col" className="py-2.5 font-semibold">
                Account
              </th>
              <th scope="col" className="w-[220px] py-2.5 font-semibold">
                Scans this month
              </th>
              <th scope="col" className="w-[90px] py-2.5 text-right font-semibold">
                Spend
              </th>
              <th scope="col" className="w-[80px] py-2.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-rule">
                <td className="py-3 pr-4">
                  <span className="flex flex-col">
                    <span className="font-semibold">
                      {u.display_name} <span className="font-medium text-ink-2">@{u.username}</span>
                    </span>
                    <Tags user={u} />
                  </span>
                </td>
                <td className="py-3 pr-4">
                  <Scans user={u} />
                </td>
                <td className="num py-3 text-right font-semibold">{formatUsd(spend.get(u.id) ?? 0)}</td>
                <td className="py-3 text-right">
                  <Button variant="quiet" aria-label={`Edit ${u.display_name}`} onClick={() => onEdit(u)}>
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

const SELF_ERRORS: Record<string, string> = {
  cannot_disable_self: 'You can’t disable your own account.',
  cannot_demote_self: 'You can’t remove your own admin role.',
}

export function EditUserDialog({ user, onClose }: { user: AdminUserOut; onClose: () => void }) {
  const update = useUpdateUser()
  const reset = useResetPassword()
  const deletion = useDeleteAdminUser()
  const { data: me } = useMe()
  const toast = useToast()
  const [name, setName] = useState(user.display_name)
  const [role, setRole] = useState(user.role)
  const [quota, setQuota] = useState(String(user.monthly_scan_quota))
  const [disabled, setDisabled] = useState(Boolean(user.disabled_at))
  const [errors, setErrors] = useState<{ name?: string; quota?: string; form?: string }>({})
  const [confirmReset, setConfirmReset] = useState(false)
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const isSelf = me?.id === user.id
  const busy = update.isPending || reset.isPending || deletion.isPending

  async function doDelete() {
    if (confirmation !== user.username || !me || isSelf || busy) return
    setDeleteError(null)
    try {
      await deletion.mutateAsync(user.id)
      toast(`@${user.username} deleted`)
      onClose()
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Could not delete the account. Try again.')
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const clean = name.trim().replace(/\s+/g, ' ')
    const q = parseCount(quota, 0, 10_000)
    const next: typeof errors = {}
    if (!clean || clean.length > 60) next.name = 'Enter a name up to 60 characters.'
    if (q === null) next.quota = 'A whole number from 0 to 10,000.'
    setErrors(next)
    if (next.name || next.quota || q === null) return
    const body: Parameters<typeof update.mutateAsync>[0] = { id: user.id }
    if (clean !== user.display_name) body.display_name = clean
    if (role !== user.role) body.role = role
    if (q !== user.monthly_scan_quota) body.monthly_scan_quota = q
    if (disabled !== Boolean(user.disabled_at)) body.disabled = disabled
    if (Object.keys(body).length === 1) return onClose()
    try {
      await update.mutateAsync(body)
      toast(`${clean} saved`)
      onClose()
    } catch (err) {
      const code = err instanceof ApiError ? err.code : ''
      setErrors({ form: SELF_ERRORS[code] ?? (err instanceof ApiError ? err.message : 'Couldn’t save. Try again.') })
    }
  }

  async function doReset() {
    if (busy) return
    try {
      const res = await reset.mutateAsync(user.id)
      setTempPassword(res.temp_password)
      setConfirmReset(false)
    } catch (err) {
      setErrors({ form: err instanceof ApiError ? err.message : 'Couldn’t reset the password. Try again.' })
    }
  }

  if (confirmDelete) {
    return (
      <Dialog
        open
        onClose={() => { if (!deletion.isPending) setConfirmDelete(false) }}
        title={`Delete @${user.username}?`}
        footer={
          <>
            <Button variant="secondary" disabled={deletion.isPending} onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              icon={<Icon name={deleteError ? 'retry' : 'trash'} />}
              disabled={confirmation !== user.username || !me || isSelf}
              loading={deletion.isPending}
              onClick={() => void doDelete()}
            >
              {deleteError ? 'Retry delete account' : 'Delete account'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-base">Permanently deletes their bills and saved people, revokes share links, removes receipt photos and removes their login.</p>
          <p className="text-[15px] text-ink-2">Usage quota history remains anonymous and still counts toward the global Azure and OpenAI limits.</p>
          {deleteError && <Notice tone="danger">{deleteError}</Notice>}
          <TextField label="Confirm username" value={confirmation} disabled={deletion.isPending} autoComplete="off" onChange={(e) => setConfirmation(e.target.value)} />
          <p className="text-[15px] font-semibold">@{user.username}</p>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose() }}
      title={`Edit ${user.display_name}`}
      footer={
        <Button type="submit" form="edit-user" disabled={busy} loading={update.isPending}>
          Save
        </Button>
      }
    >
      <form id="edit-user" onSubmit={(e) => void save(e)} noValidate className="flex flex-col gap-4">
        {errors.form && <Notice tone="danger">{errors.form}</Notice>}
        <TextField label="Name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} error={errors.name} autoComplete="off" />
        <div className="grid grid-cols-2 gap-2.5">
          <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as AdminUserOut['role'])}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </SelectField>
          <TextField label="Scans / month" inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value)} error={errors.quota} />
        </div>
        <div className="flex min-h-[52px] items-center justify-between gap-3 border-y border-rule">
          <span className="text-base font-medium">{disabled ? 'Disabled: can’t sign in' : 'Can sign in'}</span>
          <Switch checked={!disabled} onChange={(on) => setDisabled(!on)} label="Account enabled" />
        </div>
      </form>

      <div className="mt-5 flex flex-col gap-3">
        {tempPassword ? (
          <>
            <CopyField id="reset-temp-password" label="New temporary password" value={tempPassword} />
            <p className="text-[15px] font-semibold text-warn">Shown once. {user.display_name} picks a new one when they sign in.</p>
          </>
        ) : confirmReset ? (
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="flex-1 text-[15px] font-semibold">Their current password stops working.</span>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button variant="danger" className="px-3" disabled={busy} loading={reset.isPending} onClick={() => void doReset()}>
              Reset
            </Button>
          </div>
        ) : (
          <Button variant="secondary" className="self-start" disabled={busy} onClick={() => setConfirmReset(true)}>
            Reset password
          </Button>
        )}
      </div>
      <div className="mt-5 border-t border-rule pt-3">
        {isSelf ? (
          <p className="text-[15px] text-ink-2">You cannot delete your own account.</p>
        ) : (
          <Button variant="danger" icon={<Icon name="trash" />} disabled={!me || busy} onClick={() => setConfirmDelete(true)}>
            Delete account
          </Button>
        )}
      </div>
    </Dialog>
  )
}
