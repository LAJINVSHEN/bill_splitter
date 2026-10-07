import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Button } from '@/components/Button'
import { Meter, PageTitle, SectionTitle } from '@/components/Display'
import { controlClass } from '@/components/Field'
import { useToast } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { useFxRates, useMe, useUpdateMe, useUsage } from '@/data/queries'
import { PasswordDialog, RateDialog, TextDialog, type RateDraft } from '@/features/account/AccountDialogs'
import { rateRows } from '@/features/account/rates'
import { LoadError } from '@/features/home/BillList'
import { dayOf } from '@/features/home/format'
import { scanPauseText } from '@/features/home/scanPause'
import { ApiError } from '@/lib/api'
import { authClient } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { CURRENCIES } from '@/lib/money'

type Open = null | 'name' | 'note' | 'password' | { rate: RateDraft }

function Row({ label, children, htmlFor }: { label: ReactNode; children?: ReactNode; htmlFor?: string }) {
  return (
    <li className="flex min-h-[52px] items-center justify-between gap-3 border-b border-rule py-1">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="shrink-0 text-base font-medium">
          {label}
        </label>
      ) : (
        <span className="shrink-0 text-base font-medium">{label}</span>
      )}
      {children}
    </li>
  )
}

function Section({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <SectionTitle id={id} action={action}>
        {title}
      </SectionTitle>
      <ul className="border-t-[1.5px] border-ink">{children}</ul>
    </section>
  )
}

export default function AccountPage() {
  const me = useMe()
  const usage = useUsage()
  const rates = useFxRates()
  const update = useUpdateMe()
  const toast = useToast()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const user = me.data
  const home = user?.default_currency ?? 'SGD'
  // "Add JPY rate" on Home lands here with ?rate=JPY: start with that dialog open (me is cached by the guard).
  const [open, setOpen] = useState<Open>(() => {
    const asked = params.get('rate')?.toUpperCase()
    return asked ? { rate: { base: asked, quote: asked === home ? 'USD' : home, rate: '', existing: false } } : null
  })
  const [signingOut, setSigningOut] = useState(false)
  const close = () => {
    setOpen(null)
    if (params.has('rate')) setParams({}, { replace: true })
  }

  if (!user) return null
  const paused = scanPauseText(usage.data)
  const hasNote = user.payment_note !== undefined

  async function setCurrency(code: string) {
    try {
      await update.mutateAsync({ default_currency: code })
      toast(`Home currency is now ${code}`)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t change the currency. Try again.', 'danger')
    }
  }

  async function signOut() {
    setSigningOut(true)
    try {
      await authClient.signOut()
    } finally {
      navigate('/login', { replace: true })
    }
  }

  return (
    <div className="flex flex-col gap-7 md:max-w-[720px] md:gap-9">
      <PageTitle sub={`@${user.username}${user.role === 'admin' ? ' · admin' : ''}`}>{user.display_name}</PageTitle>

      {usage.data && (
        <section aria-labelledby="scans-title" className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="scans-title" className="text-[15px] font-semibold">
              Scans this month
            </h2>
            <span className="num text-[15px] font-semibold">
              {usage.data.pages_used} of {usage.data.pages_quota}
            </span>
          </div>
          <Meter
            value={usage.data.pages_used}
            max={usage.data.pages_quota}
            label="Scans used this month"
            tone={usage.data.scans_paused || usage.data.pages_used >= usage.data.pages_quota ? 'warn' : 'cobalt'}
          />
          {paused && <p className="text-[15px] font-semibold text-warn">{paused}</p>}
        </section>
      )}

      <Section id="money-title" title="Money">
        <Row label="Home currency" htmlFor="home-currency">
          <select
            id="home-currency"
            value={home}
            disabled={update.isPending}
            onChange={(e) => void setCurrency(e.target.value)}
            className={cn(controlClass, 'h-11 w-auto min-w-0 max-w-[58%] truncate px-2.5 text-[15px] font-semibold md:max-w-[320px]')}
          >
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </Row>
        {hasNote && (
          <Row label="How friends pay you">
            <Button variant="quiet" className="min-w-0 max-w-[55%] justify-end" onClick={() => setOpen('note')}>
              <span className="truncate">{user.payment_note || 'Add'}</span>
            </Button>
          </Row>
        )}
      </Section>

      <section aria-labelledby="rates-title">
        <SectionTitle
          id="rates-title"
          action={
            <Button
              variant="quiet"
              onClick={() => setOpen({ rate: { base: home === 'USD' ? 'EUR' : 'USD', quote: home, rate: '', existing: false } })}
            >
              Add rate
            </Button>
          }
        >
          Saved rates
        </SectionTitle>
        {rates.isError ? (
          <LoadError what="your rates" onRetry={() => void rates.refetch()} retrying={rates.isFetching} />
        ) : (
          <ul className="border-t-[1.5px] border-ink">
            {rates.data && rates.data.length === 0 && <li className="flex min-h-[52px] items-center border-b border-rule text-base text-ink-2">No saved rates</li>}
            {rateRows(rates.data ?? []).map((r) => (
              <li key={`${r.base}-${r.quote}`} className="grid min-h-[52px] grid-cols-[minmax(0,1fr)_auto_44px] items-center gap-3 border-b border-rule">
                <span className={cn('num truncate text-base', r.derived ? 'font-medium text-ink-2' : 'font-semibold')}>
                  1 {r.base} = {r.rate} {r.quote}
                </span>
                <span className="text-[14px] text-ink-2">{r.derived ? 'Inverse' : dayOf(r.updated_at)}</span>
                {r.derived ? (
                  <span />
                ) : (
                  <button
                    type="button"
                    aria-label={`Edit ${r.base} to ${r.quote} rate`}
                    onClick={() => setOpen({ rate: { base: r.base, quote: r.quote, rate: r.rate, existing: true } })}
                    className="grid h-11 w-11 place-items-center text-cobalt hover:text-cobalt-ink"
                  >
                    <Icon name="type" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Section id="signin-title" title="Profile and sign-in">
        <Row label="Name">
          <Button variant="quiet" className="min-w-0 max-w-[60%] justify-end" onClick={() => setOpen('name')}>
            <span className="truncate">{user.display_name}</span>
          </Button>
        </Row>
        <Row label="Password">
          <Button variant="quiet" onClick={() => setOpen('password')}>
            Change
          </Button>
        </Row>
        {user.role === 'admin' && (
          <li className="flex min-h-[52px] items-center justify-between gap-3 border-b border-rule md:hidden">
            <span className="text-base font-medium">Accounts and limits</span>
            <Link to="/admin" className="inline-flex h-11 items-center text-[15px] font-bold text-cobalt">
              Admin
            </Link>
          </li>
        )}
        <Row label="This device">
          <Button variant="danger" loading={signingOut} onClick={() => void signOut()}>
            Sign out
          </Button>
        </Row>
      </Section>

      {me.isError && <LoadError what="your account" onRetry={() => void me.refetch()} retrying={me.isFetching} />}

      {open === 'name' && (
        <TextDialog
          title="Your name"
          label="Name"
          initial={user.display_name}
          maxLength={60}
          onSave={(display_name) => update.mutateAsync({ display_name })}
          onClose={close}
        />
      )}
      {open === 'note' && (
        <TextDialog
          title="How friends pay you"
          label="Shown on your share links"
          placeholder="PayNow 9123 4567"
          initial={user.payment_note ?? ''}
          maxLength={200}
          optional
          onSave={(note) => update.mutateAsync({ payment_note: note || null })}
          onClose={close}
        />
      )}
      {open === 'password' && <PasswordDialog onClose={close} />}
      {open !== null && typeof open === 'object' && <RateDialog draft={open.rate} onClose={close} />}
    </div>
  )
}
