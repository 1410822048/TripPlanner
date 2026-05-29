// Currency formatting feeds every money string in the app (expenses,
// settlements, schedule cost chips, trip header total). The fallback
// paths matter: an unknown ISO 4217 code must NOT render an empty
// prefix (that's a silent UI bug — amount shows alone with no $).
import { describe, expect, test } from 'vitest'
import { currencySymbol, DEFAULT_CURRENCY } from './currency'

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
