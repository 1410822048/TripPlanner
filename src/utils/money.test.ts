// money.test.ts — boundary between display strings and persisted
// integer minor units. The full matrix from the refactor spec lives
// here; anything that's allowed to round-trip must pass these.
import { describe, expect, test } from 'vitest'
import {
  currencyFractionDigits,
  parseMoneyToMinor,
  formatMinorAmount,
  MoneyParseError,
} from './money'

describe('currencyFractionDigits', () => {
  test('zero-fraction currencies (per app convention)', () => {
    expect(currencyFractionDigits('JPY')).toBe(0)
    expect(currencyFractionDigits('TWD')).toBe(0)
    expect(currencyFractionDigits('KRW')).toBe(0)
    expect(currencyFractionDigits('VND')).toBe(0)
    expect(currencyFractionDigits('IDR')).toBe(0)
  })

  test('two-fraction currencies', () => {
    expect(currencyFractionDigits('USD')).toBe(2)
    expect(currencyFractionDigits('EUR')).toBe(2)
    expect(currencyFractionDigits('CNY')).toBe(2)
    expect(currencyFractionDigits('HKD')).toBe(2)
    expect(currencyFractionDigits('GBP')).toBe(2)
  })

  test('unknown code falls back to 2', () => {
    expect(currencyFractionDigits('XYZ')).toBe(2)
  })

  test('undefined uses default currency (JPY → 0)', () => {
    expect(currencyFractionDigits(undefined)).toBe(0)
  })
})

describe('parseMoneyToMinor — spec matrix', () => {
  test('USD 12.34 -> 1234', () => {
    expect(parseMoneyToMinor('12.34', 'USD')).toBe(1234)
  })

  test('USD 12 -> 1200', () => {
    expect(parseMoneyToMinor('12', 'USD')).toBe(1200)
  })

  test('USD 12.3 -> 1230 (single fractional digit padded)', () => {
    expect(parseMoneyToMinor('12.3', 'USD')).toBe(1230)
  })

  test('USD 12.345 rejected (more digits than currency allows)', () => {
    expect(() => parseMoneyToMinor('12.345', 'USD')).toThrow(MoneyParseError)
  })

  test('JPY 1200 -> 1200', () => {
    expect(parseMoneyToMinor('1200', 'JPY')).toBe(1200)
  })

  test('JPY 1200.5 rejected (zero-fraction currency)', () => {
    expect(() => parseMoneyToMinor('1200.5', 'JPY')).toThrow(MoneyParseError)
  })

  // OCR boundary: Gemini occasionally emits a decimal string that the
  // Worker schema (currency-agnostic) accepts but is invalid for the
  // currency hint. The form modal's onSuccess relies on this rejection
  // so it can abort the import instead of silently materialising zero
  // rows. Same shape for any zero-fraction currency.
  test('JPY 12.34 rejected (OCR mismatch — zero-fraction currency)', () => {
    expect(() => parseMoneyToMinor('12.34', 'JPY')).toThrow(MoneyParseError)
  })

  test('TWD 100 -> 100', () => {
    expect(parseMoneyToMinor('100', 'TWD')).toBe(100)
  })

  test('TWD 12.34 rejected (OCR mismatch — zero-fraction currency)', () => {
    expect(() => parseMoneyToMinor('12.34', 'TWD')).toThrow(MoneyParseError)
  })
})

describe('parseMoneyToMinor — edge cases', () => {
  test('zero', () => {
    expect(parseMoneyToMinor('0', 'JPY')).toBe(0)
    expect(parseMoneyToMinor('0', 'USD')).toBe(0)
    expect(parseMoneyToMinor('0.00', 'USD')).toBe(0)
  })

  test('surrounding whitespace trimmed', () => {
    expect(parseMoneyToMinor('  12.34  ', 'USD')).toBe(1234)
  })

  test('negative amounts (refunds)', () => {
    expect(parseMoneyToMinor('-12.34', 'USD')).toBe(-1234)
    expect(parseMoneyToMinor('-150', 'JPY')).toBe(-150)
  })

  test('IEEE-754 trap value parsed exactly', () => {
    // Number("0.1") * 100 === 10.000000000000002 — must not happen.
    expect(parseMoneyToMinor('0.10', 'USD')).toBe(10)
    expect(parseMoneyToMinor('0.20', 'USD')).toBe(20)
    expect(parseMoneyToMinor('0.30', 'USD')).toBe(30)
  })

  test('leading-zero whole part accepted', () => {
    expect(parseMoneyToMinor('00.10', 'USD')).toBe(10)
  })

  test('unknown currency defaults to 2 digits', () => {
    expect(parseMoneyToMinor('12.34', 'XYZ')).toBe(1234)
    expect(() => parseMoneyToMinor('12.345', 'XYZ')).toThrow(MoneyParseError)
  })

  test('rejects empty / whitespace-only', () => {
    expect(() => parseMoneyToMinor('', 'USD')).toThrow(MoneyParseError)
    expect(() => parseMoneyToMinor('   ', 'USD')).toThrow(MoneyParseError)
  })

  test('rejects malformed forms', () => {
    expect(() => parseMoneyToMinor('12.', 'USD')).toThrow(MoneyParseError)
    expect(() => parseMoneyToMinor('.5', 'USD')).toThrow(MoneyParseError)
    expect(() => parseMoneyToMinor('1.5e3', 'USD')).toThrow(MoneyParseError)
    expect(() => parseMoneyToMinor('+12.34', 'USD')).toThrow(MoneyParseError)
    expect(() => parseMoneyToMinor('abc', 'USD')).toThrow(MoneyParseError)
    expect(() => parseMoneyToMinor('12.3.4', 'USD')).toThrow(MoneyParseError)
  })

  // Symmetry with the OCR Zod schema: receipt amounts like "¥10,276"
  // pasted by hand should parse the same as the OCR-side amountText so
  // we don't get "OCR accepts, manual edit rejects". Strips ASCII comma,
  // full-width comma, and inner whitespace before validation.
  test('normalizes grouping separators (ASCII comma, full-width comma, space)', () => {
    expect(parseMoneyToMinor('1,234.56', 'USD')).toBe(123456)
    expect(parseMoneyToMinor('10,276', 'JPY')).toBe(10276)
    expect(parseMoneyToMinor('10，276', 'JPY')).toBe(10276)
    expect(parseMoneyToMinor('10 276', 'JPY')).toBe(10276)
    expect(parseMoneyToMinor('1,000,000', 'JPY')).toBe(1_000_000)
  })

  test('rejects grouping-only input (no digits)', () => {
    expect(() => parseMoneyToMinor(',,', 'USD')).toThrow(MoneyParseError)
    expect(() => parseMoneyToMinor('  ,  ', 'USD')).toThrow(MoneyParseError)
  })
})

describe('formatMinorAmount', () => {
  test('USD with cents', () => {
    expect(formatMinorAmount(1234, 'USD')).toBe('$12.34')
    expect(formatMinorAmount(100, 'USD')).toBe('$1.00')
    expect(formatMinorAmount(5, 'USD')).toBe('$0.05')
    expect(formatMinorAmount(0, 'USD')).toBe('$0.00')
  })

  test('JPY whole units', () => {
    expect(formatMinorAmount(1200, 'JPY')).toBe('¥1,200')
    expect(formatMinorAmount(0, 'JPY')).toBe('¥0')
    expect(formatMinorAmount(1000000, 'JPY')).toBe('¥1,000,000')
  })

  test('TWD whole units with NT$ prefix', () => {
    expect(formatMinorAmount(100, 'TWD')).toBe('NT$100')
    expect(formatMinorAmount(12345, 'TWD')).toBe('NT$12,345')
  })

  test('negative amounts — sign between symbol and digits', () => {
    expect(formatMinorAmount(-150, 'JPY')).toBe('¥-150')
    expect(formatMinorAmount(-1234, 'USD')).toBe('$-12.34')
  })

  test('thousands separator on large USD', () => {
    expect(formatMinorAmount(123456789, 'USD')).toBe('$1,234,567.89')
  })

  test('unknown currency falls back to code prefix', () => {
    expect(formatMinorAmount(1234, 'XYZ')).toBe('XYZ 12.34')
  })

  test('undefined currency uses default JPY', () => {
    expect(formatMinorAmount(100, undefined)).toBe('¥100')
  })
})

describe('round-trip parse ↔ format', () => {
  test('format(parse(x)) re-parses to same minor units', () => {
    for (const [text, code] of [
      ['12.34',  'USD'],
      ['1200',   'JPY'],
      ['0',      'USD'],
      ['-12.34', 'USD'],
      ['1234567.89', 'USD'],
      ['100',    'TWD'],
    ] as const) {
      const minor = parseMoneyToMinor(text, code)
      const back  = formatMinorAmount(minor, code)
      // Strip symbol and thousands separators before re-parsing.
      const stripped = back.replace(/^[^0-9-]+/, '').replace(/,/g, '')
      expect(parseMoneyToMinor(stripped, code)).toBe(minor)
    }
  })
})
