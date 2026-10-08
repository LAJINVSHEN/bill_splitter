import { authClient } from './auth'
import { env } from './env'

/** Every API failure surfaces as this: show `message`, branch on `code`. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly body: Record<string, unknown>
  constructor(status: number, code: string, message: string, body: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.body = body
  }
  get isNetwork() {
    return this.status === 0
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  form?: FormData
  signal?: AbortSignal
  idempotencyKey?: string
  /** default true */
  auth?: boolean
  /** default 60 s: a sleeping Render instance can take ~50 s to wake */
  timeoutMs?: number
}

// ---- slow-request signal (cold starts) -------------------------------------------------------
const SLOW_AFTER_MS = 2500
let slowCount = 0
const slowListeners = new Set<() => void>()
const emitSlow = () => slowListeners.forEach((l) => l())
export const slowNetwork = {
  subscribe(l: () => void) {
    slowListeners.add(l)
    return () => slowListeners.delete(l)
  },
  get: () => slowCount > 0,
}

export function newIdempotencyKey(prefix = 'k'): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function friendly(status: number): string {
  if (status === 0) return 'Can’t reach the server. Check your connection and try again.'
  if (status >= 500) return 'Something went wrong on our side. Try again in a moment.'
  if (status === 429) return 'That’s a lot of requests — wait a few seconds and try again.'
  return 'Something went wrong.'
}

async function send(path: string, opts: RequestOptions, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  if (token) headers.Authorization = `Bearer ${token}`
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

  const controller = new AbortController()
  const onAbort = () => controller.abort(opts.signal?.reason)
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), opts.timeoutMs ?? 60_000)
  let slow = false
  const slowTimer = setTimeout(() => {
    slow = true
    slowCount++
    emitSlow()
  }, SLOW_AFTER_MS)
  try {
    return await fetch(`${env.apiUrl}/api${path}`, { method: opts.method ?? 'GET', headers, body, signal: controller.signal })
  } catch (err) {
    if (opts.signal?.aborted) throw err
    throw new ApiError(0, 'network', friendly(0))
  } finally {
    clearTimeout(timer)
    clearTimeout(slowTimer)
    opts.signal?.removeEventListener('abort', onAbort)
    if (slow) {
      slowCount--
      emitSlow()
    }
  }
}

async function toError(res: Response): Promise<ApiError> {
  let data: Record<string, unknown> = {}
  try {
    data = (await res.json()) as Record<string, unknown>
  } catch {
    /* non-JSON error page (proxy, cold start) */
  }
  const detail = typeof data.detail === 'string' ? data.detail : null
  const code = typeof data.code === 'string' ? data.code : `http_${res.status}`
  return new ApiError(res.status, code, detail ?? friendly(res.status), data)
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const needsAuth = opts.auth !== false
  let token = needsAuth ? await authClient.getAccessToken() : null
  if (needsAuth && !token) throw new ApiError(401, 'missing_token', 'Please sign in again.')

  let res = await send(path, opts, token)
  if (res.status === 401 && needsAuth) {
    token = await authClient.getAccessToken({ forceRefresh: true })
    if (token) res = await send(path, opts, token)
    if (res.status === 401) {
      await authClient.signOut()
      throw await toError(res)
    }
  }
  if (!res.ok) throw await toError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Fire-and-forget wake-up for the free-tier backend; called once on app start. */
export function warmUpApi(): void {
  fetch(`${env.apiUrl}/api/health`, { cache: 'no-store' }).catch(() => undefined)
}
