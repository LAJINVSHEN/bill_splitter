import { describe, expect, it } from 'vitest'
import { oauthErrorMessage } from './oauth'

describe('oauthErrorMessage', () => {
  it('ignores a normal page load and a successful PKCE return', () => {
    expect(oauthErrorMessage('', '')).toBeNull()
    expect(oauthErrorMessage('?code=abc', '')).toBeNull()
    expect(oauthErrorMessage('?next=%2Fbills', '')).toBeNull()
  })

  it('explains a Gmail the admin has not added (query or hash)', () => {
    const query = '?error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed+for+this+instance'
    expect(oauthErrorMessage(query, '')).toMatch(/hasn’t been added/)
    expect(oauthErrorMessage('', `#${query.slice(1)}`)).toMatch(/hasn’t been added/)
    expect(oauthErrorMessage('?error=server_error&error_description=Signups%20not%20allowed', '')).toMatch(/hasn’t been added/)
  })

  it('falls back to a generic message for other failures', () => {
    expect(oauthErrorMessage('?error=access_denied&error_description=User+cancelled', '')).toBe('Google sign-in didn’t finish. Try again.')
  })
})
