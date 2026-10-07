import { describe, expect, it } from 'vitest'
import type { AdminUserOut } from '@/lib/types'
import { emailError, formatUsd, microsToUsdInput, normaliseUsername, parseCount, parseUsdToMicros, usernameError, userTags } from './logic'

describe('usernames', () => {
  it('lower-cases as typed and drops spaces', () => {
    expect(normaliseUsername('Mei Ling')).toBe('meiling')
    expect(normaliseUsername('GEORGE.P')).toBe('george.p')
  })
  it('validates length and characters', () => {
    expect(usernameError('ab')).toMatch(/3/)
    expect(usernameError('a'.repeat(33))).toMatch(/32/)
    expect(usernameError('_mei')).toMatch(/start/)
    expect(usernameError('mei!')).toMatch(/Letters/)
    expect(usernameError('mei_ling-2.x')).toBeNull()
  })
  it('checks Google emails loosely', () => {
    expect(emailError('mei@gmail.com')).toBeNull()
    expect(emailError('mei@')).not.toBeNull()
  })
})

describe('numbers and money', () => {
  it('parses whole counts in range', () => {
    expect(parseCount('30', 0, 10000)).toBe(30)
    expect(parseCount(' 0 ', 0, 10)).toBe(0)
    expect(parseCount('3.5', 0, 10)).toBeNull()
    expect(parseCount('11', 0, 10)).toBeNull()
    expect(parseCount('', 0, 10)).toBeNull()
  })
  it('formats micros as dollars', () => {
    expect(formatUsd(1_820_000)).toBe('$1.82')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(1_200)).toBe('< $0.01')
    expect(formatUsd(1_234_560_000)).toBe('$1,234.56')
  })
  it('parses dollar input to micros', () => {
    expect(parseUsdToMicros('8')).toBe(8_000_000)
    expect(parseUsdToMicros('$8.5')).toBe(8_500_000)
    expect(parseUsdToMicros('1,000.25')).toBe(1_000_250_000)
    expect(parseUsdToMicros('8.505')).toBeNull()
    expect(parseUsdToMicros('-1')).toBeNull()
    expect(parseUsdToMicros('')).toBeNull()
    expect(microsToUsdInput(8_000_000)).toBe('8.00')
  })
})

describe('userTags', () => {
  const base: AdminUserOut = {
    id: '1',
    username: 'mei',
    email: null,
    display_name: 'Mei',
    role: 'member',
    must_change_password: false,
    monthly_scan_quota: 30,
    disabled_at: null,
    created_at: '',
    pages_used_this_month: 2,
  }
  it('says Member when nothing stands out', () => {
    expect(userTags(base)).toEqual([{ label: 'Member', tone: 'quiet' }])
  })
  it('lists every state that matters, disabled first', () => {
    const tags = userTags({ ...base, role: 'admin', must_change_password: true, disabled_at: 'x' }).map((t) => t.label)
    expect(tags).toEqual(['Disabled', 'Admin', 'Must change password'])
    expect(userTags({ ...base, pages_used_this_month: 30 }).map((t) => t.label)).toEqual(['At limit'])
  })
})
