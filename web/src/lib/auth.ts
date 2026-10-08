import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from './env'

/**
 * One interface over two implementations:
 *  - supabase: production (username → synthetic email, or Google for pre-created accounts)
 *  - dev: local + E2E only, backed by the API's /api/dev/auth routes (absent in production)
 * Sessions persist in localStorage and refresh silently, so people stay signed in for weeks.
 */
export interface AuthClient {
  hasSession(): Promise<boolean>
  getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string | null>
  signInWithPassword(username: string, password: string): Promise<void>
  signInWithGoogle(): Promise<void>
  updatePassword(password: string): Promise<void>
  signOut(): Promise<void>
  onChange(cb: (signedIn: boolean) => void): () => void
  readonly supportsGoogle: boolean
}

export class AuthError extends Error {}

export function usernameToEmail(username: string): string {
  const u = username.trim().toLowerCase()
  return u.includes('@') ? u : `${u}@${env.authEmailDomain}`
}

const REFRESH_MARGIN_S = 60

function createSupabaseAuth(): AuthClient {
  const sb: SupabaseClient = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: 'even.auth' },
  })
  return {
    supportsGoogle: true,
    async hasSession() {
      const { data } = await sb.auth.getSession()
      return Boolean(data.session)
    },
    async getAccessToken(opts) {
      const { data } = await sb.auth.getSession()
      const session = data.session
      if (!session) return null
      const expiresSoon = (session.expires_at ?? 0) - Date.now() / 1000 < REFRESH_MARGIN_S
      if (opts?.forceRefresh || expiresSoon) {
        const { data: refreshed, error } = await sb.auth.refreshSession()
        if (error || !refreshed.session) return null
        return refreshed.session.access_token
      }
      return session.access_token
    },
    async signInWithPassword(username, password) {
      const { error } = await sb.auth.signInWithPassword({ email: usernameToEmail(username), password })
      if (error) throw new AuthError(error.status === 400 ? 'That username and password don’t match.' : error.message)
    },
    async signInWithGoogle() {
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin, scopes: 'openid email profile' },
      })
      if (error) throw new AuthError(error.message)
    },
    async updatePassword(password) {
      const { error } = await sb.auth.updateUser({ password })
      if (error) throw new AuthError(error.message)
    },
    async signOut() {
      await sb.auth.signOut()
    },
    onChange(cb) {
      const { data } = sb.auth.onAuthStateChange((_event, session) => cb(Boolean(session)))
      return () => data.subscription.unsubscribe()
    },
  }
}

const DEV_KEY = 'even.dev-session'
interface DevSession {
  access_token: string
  expires_at: number
}

function createDevAuth(): AuthClient {
  const listeners = new Set<(signedIn: boolean) => void>()
  const read = (): DevSession | null => {
    try {
      const raw = localStorage.getItem(DEV_KEY)
      return raw ? (JSON.parse(raw) as DevSession) : null
    } catch {
      return null
    }
  }
  const write = (s: DevSession | null) => {
    try {
      if (s) localStorage.setItem(DEV_KEY, JSON.stringify(s))
      else localStorage.removeItem(DEV_KEY)
    } catch {
      /* private mode: session lives for this tab only */
    }
    listeners.forEach((l) => l(Boolean(s)))
  }
  const login = async (username: string, password: string): Promise<DevSession> => {
    const res = await fetch(`${env.apiUrl}/api/dev/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim().toLowerCase(), password }),
    })
    if (!res.ok) throw new AuthError(res.status === 401 ? 'That username and password don’t match.' : 'Dev login is unavailable.')
    const body = (await res.json()) as { access_token: string; expires_in: number }
    return { access_token: body.access_token, expires_at: Date.now() / 1000 + body.expires_in }
  }
  return {
    supportsGoogle: false,
    async hasSession() {
      return Boolean(read())
    },
    async getAccessToken(opts) {
      const s = read()
      if (!s) return null
      // Dev tokens aren't refreshable: once expired, sign in again.
      if (opts?.forceRefresh || s.expires_at - Date.now() / 1000 < REFRESH_MARGIN_S) {
        write(null)
        return null
      }
      return s.access_token
    },
    async signInWithPassword(username, password) {
      write(await login(username, password))
    },
    async signInWithGoogle() {
      throw new AuthError('Google sign-in isn’t available in local development.')
    },
    async updatePassword(password) {
      const s = read()
      if (!s) throw new AuthError('Not signed in.')
      const res = await fetch(`${env.apiUrl}/api/dev/auth/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.access_token}` },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) throw new AuthError('Couldn’t change the password.')
    },
    async signOut() {
      write(null)
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

export const authClient: AuthClient = env.authMode === 'supabase' ? createSupabaseAuth() : createDevAuth()
