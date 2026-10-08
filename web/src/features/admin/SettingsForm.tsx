import { useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '@/components/Button'
import { Notice, SectionTitle } from '@/components/Display'
import { controlClass } from '@/components/Field'
import { useToast } from '@/components/Feedback'
import { useUpdateSettings } from '@/data/queries'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { AdminSettingsOut } from '@/lib/types'
import { Switch } from './bits'
import { microsToUsdInput, parseCount, parseUsdToMicros } from './logic'

type Field = 'cap' | 'budget' | 'quota'

function SettingRow({ id, label, note, error, children }: { id: string; label: string; note?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-1 border-b border-rule py-2">
      <div className="flex min-h-[44px] items-center justify-between gap-3">
        <label htmlFor={id} className="text-base font-medium">
          {label}
        </label>
        <span className="flex items-center gap-2.5">
          {note && <span className="hidden text-[14px] text-ink-2 sm:inline">{note}</span>}
          {children}
        </span>
      </div>
      {note && <span className="text-[14px] text-ink-2 sm:hidden">{note}</span>}
      {error && (
        <span id={`${id}-error`} className="text-[15px] font-semibold text-danger">
          {error}
        </span>
      )}
    </li>
  )
}

/** Global limits. Numbers save together; the scans switch saves on tap. */
export function SettingsForm({ settings }: { settings: AdminSettingsOut }) {
  const update = useUpdateSettings()
  const toggle = useUpdateSettings()
  const toast = useToast()
  const [cap, setCap] = useState(String(settings.global_monthly_page_cap))
  const [budget, setBudget] = useState(microsToUsdInput(settings.global_monthly_llm_budget_micros))
  const [quota, setQuota] = useState(String(settings.default_user_quota))
  const [errors, setErrors] = useState<Partial<Record<Field | 'form', string>>>({})
  const hardLimit = settings.provider?.azure_di_monthly_page_limit

  async function save(e: FormEvent) {
    e.preventDefault()
    const c = parseCount(cap, 0, 100_000)
    const b = parseUsdToMicros(budget)
    const q = parseCount(quota, 0, 10_000)
    const next: typeof errors = {}
    if (c === null) next.cap = 'A whole number of pages.'
    else if (hardLimit !== undefined && c > hardLimit) next.cap = `Azure allows at most ${hardLimit} pages a month.`
    if (b === null || b > 10_000_000_000) next.budget = 'A dollar amount, like 8 or 8.50.'
    if (q === null) next.quota = 'A whole number from 0 to 10,000.'
    setErrors(next)
    if (c === null || b === null || q === null || Object.keys(next).length > 0) return
    try {
      await update.mutateAsync({ global_monthly_page_cap: c, global_monthly_llm_budget_micros: b, default_user_quota: q })
      toast('Settings saved')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'page_cap_above_provider_limit') {
        const limit = typeof err.body.provider_limit === 'number' ? err.body.provider_limit : hardLimit
        setErrors({ cap: limit ? `Azure allows at most ${limit} pages a month.` : err.message })
      } else setErrors({ form: err instanceof ApiError ? err.message : 'Couldn’t save the settings. Try again.' })
    }
  }

  function setScans(on: boolean) {
    toggle.mutate(
      { scans_enabled: on },
      {
        onSuccess: () => toast(on ? 'Scanning is on' : 'Scanning is off for everyone'),
        onError: (err) => toast(err instanceof ApiError ? err.message : 'Couldn’t change it. Try again.', 'danger'),
      },
    )
  }

  const input = (field: Field) =>
    cn(controlClass, 'num h-11 max-w-[120px] text-right', errors[field] && 'border-danger')

  return (
    <section aria-labelledby="settings-title">
      <SectionTitle id="settings-title">Settings</SectionTitle>
      <form onSubmit={(e) => void save(e)} noValidate>
        <ul className="border-t-[1.5px] border-ink">
          <li className="flex min-h-[52px] items-center justify-between gap-3 border-b border-rule">
            <span id="scans-switch" className="text-base font-medium">
              Scanning {settings.scans_enabled ? 'on' : 'off'}
            </span>
            <Switch checked={settings.scans_enabled} onChange={setScans} busy={toggle.isPending} label="Scanning for everyone" />
          </li>
          <SettingRow
            id="set-cap"
            label="Pages a month"
            note={hardLimit !== undefined ? `Azure limit ${hardLimit}` : undefined}
            error={errors.cap}
          >
            <input
              id="set-cap"
              inputMode="numeric"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              aria-invalid={errors.cap ? true : undefined}
              aria-describedby={errors.cap ? 'set-cap-error' : undefined}
              className={input('cap')}
            />
          </SettingRow>
          <SettingRow id="set-budget" label="OpenAI budget a month" error={errors.budget}>
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="font-semibold">
                $
              </span>
              <input
                id="set-budget"
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                aria-invalid={errors.budget ? true : undefined}
                aria-describedby={errors.budget ? 'set-budget-error' : undefined}
                className={input('budget')}
              />
            </span>
          </SettingRow>
          <SettingRow id="set-quota" label="Scans for new accounts" error={errors.quota}>
            <input
              id="set-quota"
              inputMode="numeric"
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
              aria-invalid={errors.quota ? true : undefined}
              aria-describedby={errors.quota ? 'set-quota-error' : undefined}
              className={input('quota')}
            />
          </SettingRow>
        </ul>
        {errors.form && (
          <div className="mt-3">
            <Notice tone="danger">{errors.form}</Notice>
          </div>
        )}
        <Button type="submit" variant="secondary" className="mt-4" loading={update.isPending}>
          Save settings
        </Button>
      </form>
    </section>
  )
}
