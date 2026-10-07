import { NavLink, Outlet } from 'react-router'
import { EqualsMark, Wordmark } from '@/components/Brand'
import { ButtonLink } from '@/components/Button'
import { Meter } from '@/components/Display'
import { SlowNetworkBar } from '@/components/Feedback'
import { Icon } from '@/components/Icon'
import { useMe, useUsage } from '@/data/queries'
import { cn } from '@/lib/cn'

interface NavItem {
  to: string
  label: string
  mobileLabel?: string
  end?: boolean
}

function useNav(): NavItem[] {
  const me = useMe()
  const items: NavItem[] = [
    { to: '/', label: 'Home', end: true },
    { to: '/bills', label: 'Bills' },
    { to: '/people', label: 'People' },
    { to: '/account', label: 'Account', mobileLabel: 'Me' },
  ]
  if (me.data?.role === 'admin') items.push({ to: '/admin', label: 'Admin' })
  return items
}

function Sidebar() {
  const nav = useNav()
  const usage = useUsage()
  return (
    <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-rule px-5 py-6 md:flex">
      <NavLink to="/" aria-label="even, home" className="px-2.5">
        <Wordmark />
      </NavLink>
      <ButtonLink to="/bills/new" icon={<Icon name="plus" size={18} />}>
        New bill
      </ButtonLink>
      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              cn('flex h-11 items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-base', isActive ? 'bg-mist font-bold text-ink' : 'font-semibold text-ink-2 hover:text-ink')
            }
          >
            {({ isActive }) => (
              <>
                <EqualsMark size="xs" className={isActive ? '' : 'invisible'} />
                {n.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      {usage.data && (
        <div className="mt-auto flex flex-col gap-2 px-2.5">
          <div className="flex justify-between text-[14px] font-semibold">
            <span>Scans this month</span>
            <span className="num">
              {usage.data.pages_used} / {usage.data.pages_quota}
            </span>
          </div>
          <Meter
            value={usage.data.pages_used}
            max={usage.data.pages_quota}
            label="Scans used this month"
            tone={usage.data.scans_paused ? 'warn' : 'cobalt'}
          />
        </div>
      )}
    </aside>
  )
}

function BottomNav() {
  const nav = useNav().filter((n) => n.to !== '/admin')
  return (
    <nav aria-label="Main" className="pb-safe fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-rule bg-paper md:hidden">
      {nav.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          className={({ isActive }) =>
            cn('flex h-16 items-center justify-center text-[15px]', isActive ? 'font-bold text-ink shadow-[inset_0_3px_0_var(--color-cobalt)]' : 'font-semibold text-ink-2')
          }
        >
          {n.mobileLabel ?? n.label}
        </NavLink>
      ))}
    </nav>
  )
}

/** Threshold-free shell (playbook §1.6): sidebar welded to the left edge, no max-width, no mx-auto. */
export function AppShell() {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[var(--app-sidebar-w)_minmax(0,1fr)]">
      <SlowNetworkBar />
      <Sidebar />
      <main className="min-w-0 px-[var(--app-gutter)] pb-[var(--app-bottom-gap)]">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  )
}
