/**
 * The friend's "I've paid" on a share link. Tapping never waits on the server: the claim is kept on
 * this phone and sent (and resent while the API wakes up), so it survives a sleeping server and a
 * closed tab. The server ignores repeats of the same client key. Storage is optional (private
 * windows): everything still works while the page is open.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { qk } from '@/data/queries'
import { api, ApiError } from '@/lib/api'
import type { PublicShareOut } from '@/lib/types'

const PENDING = 'even.pendingClaims'
const MINE = 'even.myClaims'
const PICKED = 'even.pickedName'
const RETRY_MS = [5_000, 15_000, 30_000, 30_000, 60_000, 60_000, 90_000]

interface Pending {
  token: string
  personKey: string | null
  clientKey: string
  at: number
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage off: fine while the page is open */
  }
}

const slot = (token: string, personKey: string | null) => `${token}|${personKey ?? ''}`

export const pendingFor = (token: string) => read<Pending[]>(PENDING, []).filter((p) => p.token === token)
const dropPending = (clientKey: string) => write(PENDING, read<Pending[]>(PENDING, []).filter((p) => p.clientKey !== clientKey))
const addPending = (p: Pending) => write(PENDING, [...read<Pending[]>(PENDING, []).filter((x) => slot(x.token, x.personKey) !== slot(p.token, p.personKey)), p])

/** The client key of this phone's own claim, so it can be taken back. */
export const myClaimKey = (token: string, personKey: string | null) => read<Record<string, string>>(MINE, {})[slot(token, personKey)]
const rememberMine = (token: string, personKey: string | null, clientKey: string) =>
  write(MINE, { ...read<Record<string, string>>(MINE, {}), [slot(token, personKey)]: clientKey })

/** Group links: the name this phone picked, so the next visit opens straight to it. */
export const pickedName = (token: string): string | null => read<Record<string, string>>(PICKED, {})[token] ?? null
export function setPickedName(token: string, key: string | null) {
  const all = read<Record<string, string>>(PICKED, {})
  if (key) all[token] = key
  else delete all[token]
  write(PICKED, all)
}

/** "#g" → group; "#p.4210.SGD" → what this person owed when the link was sent. Untrusted: drawing only. */
export type Fragment = { kind: 'group' } | { kind: 'person'; minor: number; currency: string } | null
export function parseFragment(hash: string): Fragment {
  const h = hash.replace(/^#/, '')
  if (h === 'g') return { kind: 'group' }
  const m = /^p\.(\d{1,13})\.([A-Z]{3})$/.exec(h)
  return m ? { kind: 'person', minor: Number(m[1]), currency: m[2] as string } : null
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`)

/** A claim that will never succeed by retrying: the answer is final, tell the person. */
const isFinal = (err: unknown) => err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429

export function useClaims(token: string) {
  const qc = useQueryClient()
  const [sending, setSending] = useState<string[]>(() => pendingFor(token).map((p) => slot(token, p.personKey)))
  const [error, setError] = useState<string | null>(null)
  const timers = useRef(new Map<string, number>())
  const gone = useRef(false)

  const done = useCallback(
    (p: Pending, data?: PublicShareOut) => {
      dropPending(p.clientKey)
      setSending((s) => s.filter((x) => x !== slot(p.token, p.personKey)))
      if (data) qc.setQueryData(qk.publicShare(token), data)
    },
    [qc, token],
  )

  const attempt = useCallback(
    async (p: Pending) => {
      for (let round = 0; ; round++) {
        try {
          const data = await api<PublicShareOut>(`/public/share/${encodeURIComponent(p.token)}/claims`, {
            method: 'POST',
            auth: false,
            timeoutMs: 75_000,
            body: { client_key: p.clientKey, ...(p.personKey ? { person_key: p.personKey } : {}) },
          })
          rememberMine(p.token, p.personKey, p.clientKey)
          done(p, data)
          return
        } catch (err) {
          if (isFinal(err)) {
            done(p)
            setError(err instanceof ApiError ? err.message : 'Couldn’t send that. Try again.')
            void qc.invalidateQueries({ queryKey: qk.publicShare(token) })
            return
          }
          const wait = RETRY_MS[round]
          if (wait === undefined || gone.current) {
            if (!gone.current) setError('Still can’t reach even. It’s saved on this phone and will send next time you open this link.')
            return
          }
          await new Promise((resolve) => timers.current.set(p.clientKey, window.setTimeout(resolve, wait)))
          if (gone.current) return
        }
      }
    },
    [done, qc, token],
  )

  // a claim left over from last time (tab closed before it went through) goes first
  useEffect(() => {
    gone.current = false
    pendingFor(token).forEach((p) => void attempt(p))
    const all = timers.current
    return () => {
      gone.current = true
      all.forEach((t) => window.clearTimeout(t))
    }
  }, [attempt, token])

  const claim = (personKey: string | null) => {
    setError(null)
    const p: Pending = { token, personKey, clientKey: newKey(), at: Date.now() }
    addPending(p)
    setSending((s) => [...s.filter((x) => x !== slot(token, personKey)), slot(token, personKey)])
    void attempt(p)
  }

  const [undoing, setUndoing] = useState(false)
  const undo = async (personKey: string | null) => {
    const key = myClaimKey(token, personKey)
    if (!key) return
    setError(null)
    setUndoing(true)
    try {
      const data = await api<PublicShareOut>(`/public/share/${encodeURIComponent(token)}/claims/${key}`, { method: 'DELETE', auth: false, timeoutMs: 75_000 })
      qc.setQueryData(qk.publicShare(token), data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t undo that. Try again.')
    } finally {
      setUndoing(false)
    }
  }

  return {
    claim,
    undo,
    undoing,
    error,
    isSending: (personKey: string | null) => sending.includes(slot(token, personKey)),
  }
}
