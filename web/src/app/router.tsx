import { createBrowserRouter, type RouteObject } from 'react-router'
import { FullPageLoader } from '@/components/Display'
import { AppShell } from './AppShell'
import { RequireAdmin, RequireAuth } from './guards'
import { RouteError } from './RouteError'

type Loader = () => Promise<{ default: React.ComponentType }>
const page = (load: Loader): Pick<RouteObject, 'lazy'> => ({
  lazy: async () => ({ Component: (await load()).default }),
})

/**
 * Route map. Bill flow screens render their own FlowShell (focus mode, no tabs);
 * everything else sits inside AppShell (sidebar on desktop, bottom tabs on phones).
 */
export const router = createBrowserRouter([
  { hydrateFallbackElement: <FullPageLoader />, errorElement: <RouteError />, children: routes() },
])

function routes(): RouteObject[] {
  return [
  { path: '/login', ...page(() => import('@/routes/Login')), errorElement: <RouteError /> },
  { path: '/s/:token', ...page(() => import('@/routes/Share')), errorElement: <RouteError /> },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      { path: '/welcome', ...page(() => import('@/routes/Welcome')) },
      // bill flow (focus mode)
      { path: '/bills/new', ...page(() => import('@/routes/bill/NewBill')) },
      { path: '/bills/:billId/scan', ...page(() => import('@/routes/bill/Scan')) },
      { path: '/bills/:billId/people', ...page(() => import('@/routes/bill/People')) },
      { path: '/bills/:billId/review', ...page(() => import('@/routes/bill/Review')) },
      { path: '/bills/:billId/assign', ...page(() => import('@/routes/bill/Assign')) },
      { path: '/bills/:billId/quick', ...page(() => import('@/routes/bill/Quick')) },
      {
        element: <AppShell />,
        children: [
          { index: true, ...page(() => import('@/routes/Home')) },
          { path: '/bills', ...page(() => import('@/routes/Bills')) },
          { path: '/bills/:billId', ...page(() => import('@/routes/bill/Summary')) },
          { path: '/people', ...page(() => import('@/routes/People')) },
          { path: '/account', ...page(() => import('@/routes/Account')) },
          { element: <RequireAdmin />, children: [{ path: '/admin', ...page(() => import('@/routes/Admin')) }] },
          { path: '*', ...page(() => import('@/routes/NotFound')) },
        ],
      },
    ],
  },
  ]
}
