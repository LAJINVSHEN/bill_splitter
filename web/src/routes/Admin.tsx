import { useState } from 'react'
import { Button } from '@/components/Button'
import { PageTitle, SectionTitle } from '@/components/Display'
import { Dialog } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { useAdminSettings, useAdminUsage, useAdminUsers } from '@/data/queries'
import { AccountsList, EditUserDialog } from '@/features/admin/Accounts'
import { useIsDesktop } from '@/features/admin/bits'
import { NewAccountForm } from '@/features/admin/NewAccount'
import { SettingsForm } from '@/features/admin/SettingsForm'
import { ThisMonth } from '@/features/admin/ThisMonth'
import { LoadError, SectionLoader } from '@/features/home/BillList'
import type { AdminUserOut } from '@/lib/types'

export default function AdminPage() {
  const users = useAdminUsers()
  const usage = useAdminUsage()
  const settings = useAdminSettings()
  const desktop = useIsDesktop()
  const [editing, setEditing] = useState<AdminUserOut | null>(null)
  const [creating, setCreating] = useState(false)
  const defaultQuota = settings.data?.default_user_quota ?? 30

  return (
    <div className="flex flex-col gap-9 pb-4">
      <PageTitle>Admin</PageTitle>

      {usage.isPending ? (
        <SectionLoader label="Loading usage" />
      ) : usage.isError ? (
        <LoadError what="this month’s usage" onRetry={() => void usage.refetch()} retrying={usage.isFetching} />
      ) : (
        <ThisMonth usage={usage.data} settings={settings.data} />
      )}

      <div className="flex flex-wrap items-start gap-10">
        <section aria-labelledby="accounts-title" className="min-w-0 flex-[999_1_560px]">
          <SectionTitle
            id="accounts-title"
            action={
              !desktop && (
                <Button size="sm" icon={<Icon name="plus" size={18} />} onClick={() => setCreating(true)}>
                  New account
                </Button>
              )
            }
          >
            Accounts
          </SectionTitle>
          {users.isPending ? (
            <SectionLoader label="Loading accounts" />
          ) : users.isError ? (
            <LoadError what="accounts" onRetry={() => void users.refetch()} retrying={users.isFetching} />
          ) : (
            <AccountsList users={users.data.items} usage={usage.data} onEdit={setEditing} />
          )}
        </section>

        {desktop && (
          <section aria-labelledby="new-account-title" className="flex min-w-0 flex-[1_1_300px] flex-col gap-3.5 rounded-[var(--radius-panel)] bg-mist p-5">
            <h2 id="new-account-title" className="display-sm text-xl">
              New account
            </h2>
            <NewAccountForm defaultQuota={defaultQuota} />
          </section>
        )}
      </div>

      {settings.isPending ? (
        <SectionLoader label="Loading settings" />
      ) : settings.isError ? (
        <LoadError what="settings" onRetry={() => void settings.refetch()} retrying={settings.isFetching} />
      ) : (
        <div className="md:max-w-[640px]">
          <SettingsForm key={settings.data.updated_at} settings={settings.data} />
        </div>
      )}

      {editing && <EditUserDialog key={editing.id} user={editing} onClose={() => setEditing(null)} />}
      {!desktop && (
        <Dialog open={creating} onClose={() => setCreating(false)} title="New account">
          {creating && <NewAccountForm defaultQuota={defaultQuota} formId="new-account-sheet" />}
        </Dialog>
      )}
    </div>
  )
}
