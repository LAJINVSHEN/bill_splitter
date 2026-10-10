/**
 * A failed Google sign-in comes back to the app with error params instead of a code
 * (query string for PKCE, hash for older flows). Signups are disabled in Supabase, so a Gmail
 * the admin hasn't pre-created ends here with `error_code=signup_disabled`.
 */
export function oauthErrorMessage(search: string, hash: string): string | null {
  const query = new URLSearchParams(search)
  const fragment = new URLSearchParams(hash.replace(/^#/, ''))
  const get = (key: string) => query.get(key) ?? fragment.get(key)
  if (!get('error') && !get('error_code')) return null
  if (get('error_code') === 'signup_disabled' || /signups? not allowed/i.test(get('error_description') ?? '')) {
    return 'This Google account hasn’t been added yet. Ask the admin to add your Gmail address.'
  }
  return 'Google sign-in didn’t finish. Try again.'
}
