import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { router } from '@/app/router'
import { SessionProvider } from '@/app/session'
import { ToastProvider } from '@/components/Feedback'
import { ApiError, warmUpApi } from '@/lib/api'
import '@/styles/index.css'

// The free-tier API sleeps when idle; start waking it while the first screen renders.
warmUpApi()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // retry only what a retry can fix: network blips and 5xx
      retry: (count, err) => count < 2 && err instanceof ApiError && (err.isNetwork || err.status >= 500),
    },
    mutations: { retry: false },
  },
})

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
)
