import { describe, expect, it } from 'vitest'
import { invertRate, normaliseRate, rateError, rateRows } from './rates'

describe('rateError', () => {
  it('accepts positive decimals', () => {
    expect(rateError('0.0091')).toBeNull()
    expect(rateError('1,284.5')).toBeNull()
    expect(rateError('.5')).toBeNull()
    expect(rateError('1234567.89012345')).toBeNull()
    expect(rateError('0.000000000001')).toBeNull()
  })
  it('rejects empty, zero, junk and out-of-range input', () => {
    expect(rateError('')).toBe('Enter a rate.')
    expect(rateError('0')).toBe('The rate must be more than 0.')
    expect(rateError('0.000')).toBe('The rate must be more than 0.')
    expect(rateError('-1')).toMatch(/digits/)
    expect(rateError('1.2.3')).toMatch(/digits/)
    expect(rateError('abc')).toMatch(/digits/)
    expect(rateError('.')).toMatch(/digits/)
    expect(rateError('1e5')).toMatch(/digits/)
    expect(rateError('0.0000000000001')).toBe('That rate is out of range.')
    expect(rateError('2000000000000')).toBe('That rate is out of range.')
  })
  it('counts significant digits, ignoring leading and trailing zeros', () => {
    expect(rateError('0.000123456789012345')).toBeNull()
    expect(rateError('1.234567890123456')).toMatch(/15 significant/)
    expect(rateError('1.50000000000000000')).toBeNull()
  })
  it('normalises grouping commas', () => {
    expect(normaliseRate(' 1,284.50 ')).toBe('1284.50')
  })
})

describe('invertRate', () => {
  it('matches the API: 12 significant digits, half-up, trimmed', () => {
    expect(invertRate('0.0091')).toBe('109.89010989')
    expect(invertRate('4')).toBe('0.25')
    expect(invertRate('3')).toBe('0.333333333333')
    expect(invertRate('0.00894')).toBe('111.856823266')
    expect(invertRate('1.284')).toBe('0.778816199377')
    expect(invertRate('0.000000000001')).toBe('1000000000000')
  })
  it('returns empty for nonsense', () => {
    expect(invertRate('0')).toBe('')
    expect(invertRate('x')).toBe('')
  })
})

describe('rateRows', () => {
  it('puts each saved rate before its read-only inverse', () => {
    const rows = rateRows([{ base: 'JPY', quote: 'SGD', rate: '0.0091', derived: false, updated_at: 't' }])
    expect(rows).toEqual([
      { base: 'JPY', quote: 'SGD', rate: '0.0091', derived: false, updated_at: 't' },
      { base: 'SGD', quote: 'JPY', rate: '109.89010989', derived: true, updated_at: 't' },
    ])
  })
})
