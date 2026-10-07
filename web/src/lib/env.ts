const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? ''
const explicitMode = import.meta.env.VITE_AUTH_MODE

export const env = {
  /** Empty in dev: requests go to /api through the Vite proxy. */
  apiUrl: (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, ''),
  supabaseUrl,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
  authEmailDomain: import.meta.env.VITE_AUTH_EMAIL_DOMAIN ?? 'users.even.app',
  authMode: explicitMode ?? (supabaseUrl ? 'supabase' : 'dev'),
} as const

if (import.meta.env.PROD && !explicitMode && !supabaseUrl) {
  // A production build must never fall back to the dev login by accident.
  // (E2E builds opt in with VITE_AUTH_MODE=dev; the production API doesn't mount dev auth anyway.)
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY for a production build.')
}
