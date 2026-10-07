import { Navigate, Outlet, useLocation } from 'react-router'
import { FullPageLoader } from '@/components/Display'
import { useMe } from '@/data/queries'
import { ApiError } from '@/lib/api'
import { useSessionStatus } from './session'

/** Signed in + provisioned + temp password changed. Everything private sits under this. */
export function RequireAuth() {
  const status = useSessionStatus()
  const location = useLocation()
  const me = useMe(status === 'signedIn')

  if (status === 'loading' || (status === 'signedIn' && me.isPending)) return <FullPageLoader />
  if (status === 'signedOut') {
    const next = location.pathname + location.search
    return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />
  }
  if (me.error) {
    const code = me.error instanceof ApiError ? me.error.code : ''
    return <Navigate to={`/login?problem=${encodeURIComponent(code || 'unavailable')}`} replace />
  }
  if (me.data?.must_change_password && location.pathname !== '/welcome') return <Navigate to="/welcome" replace />
  return <Outlet />
}

export function RequireAdmin() {
  const me = useMe()
  if (me.isPending) return <FullPageLoader />
  if (me.data?.role !== 'admin') return <Navigate to="/" replace />
  return <Outlet />
}
