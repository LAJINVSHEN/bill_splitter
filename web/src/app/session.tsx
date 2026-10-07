import { useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { authClient } from '@/lib/auth'

type Status = 'loading' | 'signedIn' | 'signedOut'

const SessionContext = createContext<Status>('loading')

/** Tracks whether a session exists; who the user is comes from GET /me (useMe). */
export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [status, setStatus] = useState<Status>('loading')

  useEffect(() => {
    let alive = true
    authClient.hasSession().then((has) => alive && setStatus(has ? 'signedIn' : 'signedOut'))
    const off = authClient.onChange((signedIn) => {
      setStatus(signedIn ? 'signedIn' : 'signedOut')
      if (!signedIn) qc.clear()
    })
    return () => {
      alive = false
      off()
    }
  }, [qc])

  const value = useMemo(() => status, [status])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export const useSessionStatus = () => useContext(SessionContext)
