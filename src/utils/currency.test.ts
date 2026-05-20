// Currency formatting feeds every money string in the app (expenses,
// settlements, schedule cost chips, trip header total). The fallback
// paths matter: an unknown ISO 4217 code must NOT render an empty
// prefix (that's a silent UI bug — amount shows alone with no $).
import { describe, expect, test } from 'vitest'
import { currencySymbol, formatAmount, DEFAULT_CURRENCY } from './currency'

describe('currencySymbol', () => {
  test('returns registered symbol for known codes', () => {
    expect(currencySymbol('JPY')).toBe('¥')
    expect(currencySymbol('TWD')).toBe('NT$')
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('HKD')).toBe('HK$')
    expect(currencySymbol('CNY')).toBe('CN¥')
  })

  test('undefined code falls back to default (JPY)', () => {
    expect(currencySymbol(undefined)).toBe('¥')
    expect(DEFAULT_CURRENCY).toBe('JPY')
  })

  test('unknown code returns the code + space (never empty prefix)', () => {
    expect(currencySymbol('XYZ')).toBe('XYZ ')
  })
})

describe('formatAmount', () => {
  test('thousands separator + symbol prefix', () => {
    expect(formatAmount(12345, 'JPY')).toBe('¥12,345')
    expect(formatAmount(1000000, 'USD')).toBe('$1,000,000')
  })

  test('zero formats without weird artifacts', () => {
    expect(formatAmount(0, 'JPY')).toBe('¥0')
  })

  test('negative amounts (refunds / cashback) keep the sign', () => {
    expect(formatAmount(-150, 'JPY')).toBe('¥-150')
  })

  test('unknown currency code prefixed with code + space', () => {
    expect(formatAmount(500, 'XYZ')).toBe('XYZ 500')
  })

  test('undefined currency uses default JPY', () => {
    expect(formatAmount(100, undefined)).toBe('¥100')
  })
})
