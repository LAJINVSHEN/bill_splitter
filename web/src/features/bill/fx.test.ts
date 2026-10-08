import { describe, expect, it } from 'vitest'
import { invertRate, savedRate, validRate } from './fx'

describe('fx helpers', () => {
  it('validates typed rates', () => {
    expect(validRate('0.0091')).toBe(true)
    expect(validRate('110')).toBe(true)
    expect(validRate('0')).toBe(false)
    expect(validRate('.')).toBe(false)
    expect(validRate('1.2.3')).toBe(false)
    expect(validRate('1234567890.123456')).toBe(false) // 16 significant digits
  })

  it('inverts to 12 significant digits without exponent notation', () => {
    expect(invertRate('110')).toBe('0.00909090909091')
    expect(invertRate('0.0091')).toBe('109.89010989')
    expect(invertRate('25000000')).toBe('0.00000004')
    expect(invertRate('0')).toBe('')
  })

  it('finds a saved rate in either direction', () => {
    const rates = [{ base: 'JPY', quote: 'SGD', rate: '0.009100', derived: false, updated_at: '' }]
    expect(savedRate(rates, 'JPY', 'SGD')).toEqual({ rate: '0.0091', derived: false })
    expect(savedRate(rates, 'SGD', 'JPY')).toEqual({ rate: '109.89010989', derived: true })
    expect(savedRate(rates, 'SGD', 'MYR')).toBeNull()
  })
})
