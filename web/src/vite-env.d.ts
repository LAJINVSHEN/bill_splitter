/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_AUTH_EMAIL_DOMAIN?: string
  /** "supabase" (production) or "dev" (local/E2E: backend /api/dev/auth, never in production builds) */
  readonly VITE_AUTH_MODE?: 'supabase' | 'dev'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
