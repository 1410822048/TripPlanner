// fx-core unit tests — locks the Phase 1 contract before any consumer
// (Worker fx-rate, expense-write Phase 3, client preview Phase 4) wires
// against it. Each describe maps to one public function; the matrix
// covers the currency pairs the app actually ships (USD/EUR/JPY/TWD/
// VND/IDR) plus half-even tie-breaking edges + negative-amount refunds.
import { describe, expect, test } from 'vitest'
import {
  allocateRoundingResidual,
  canonicalizeRate,
  convertMinorHalfEven,
  currencyFractionDigits,
  estimateSourceMinorAtMostTargetHalfEven,
  isCanonicalRateString,
  parseDecimalRate,
} from './index'

describe('isCanonicalRateString', () => {
  test('accepts canonical positive forms', () => {
    expect(isCanonicalRateString('1')).toBe(true)
    expect(isCanonicalRateString('146')).toBe(true)
    expect(isCanonicalRateString('146.2')).toBe(true)
    expect(isCanonicalRateString('0.5')).toBe(true)
    expect(isCanonicalRateString('0.912345')).toBe(true)
    expect(isCanonicalRateString('0.00684')).toBe(true)
  })

  test('rejects non-canonical forms', () => {
    expect(isCanonicalRateString('')).toBe(false)
    expect(isCanonicalRateString(' ')).toBe(false)
    expect(isCanonicalRateString('+1')).toBe(false)
    expect(isCanonicalRateString('-1')).toBe(false)
    expect(isCanonicalRateString('01')).toBe(false)        // leading zero on whole part
    expect(isCanonicalRateString('1.20')).toBe(false)      // trailing zero
    expect(isCanonicalRateString('1.0')).toBe(false)       // trailing zero
    expect(isCanonicalRateString('1.')).toBe(false)        // bare decimal
    expect(isCanonicalRateString('.5')).toBe(false)        // missing whole part
    expect(isCanonicalRateString('1e2')).toBe(false)       // scientific
    expect(isCanonicalRateString('1,234.5')).toBe(false)   // separator
  })

  // FX rates are strictly positive — accepting "0" would let a cache
  // bug silently zero out conversions instead of failing fast.
  test('rejects zero rate', () => {
    expect(isCanonicalRateString('0')).toBe(false)
    expect(isCanonicalRateString('0.0')).toBe(false)
    expect(isCanonicalRateString('0.00')).toBe(false)
  })
})

describe('currencyFractionDigits', () => {
  test('zero-fraction codes (app convention)', () => {
    expect(currencyFractionDigits('JPY')).toBe(0)
    expect(currencyFractionDigits('TWD')).toBe(0)
    expect(currencyFractionDigits('KRW')).toBe(0)
    expect(currencyFractionDigits('VND')).toBe(0)
    expect(currencyFractionDigits('IDR')).toBe(0)
  })

  test('two-fraction codes', () => {
    expect(currencyFractionDigits('USD')).toBe(2)
    expect(currencyFractionDigits('EUR')).toBe(2)
    expect(currencyFractionDigits('CNY')).toBe(2)
    expect(currencyFractionDigits('HKD')).toBe(2)
    expect(currencyFractionDigits('THB')).toBe(2)
    expect(currencyFractionDigits('SGD')).toBe(2)
    expect(currencyFractionDigits('GBP')).toBe(2)
    expect(currencyFractionDigits('AUD')).toBe(2)
    expect(currencyFractionDigits('PHP')).toBe(2)
    expect(currencyFractionDigits('MYR')).toBe(2)
  })

  // Unknown ISO codes default to 2 (worldwide majority). Locks the
  // contract callers depend on for forward-compat with currencies the
  // app hasn't explicitly opined on yet (e.g. NOK, SEK, MXN).
  test('unknown codes default to 2', () => {
    expect(currencyFractionDigits('NOK')).toBe(2)
    expect(currencyFractionDigits('ZZZ')).toBe(2)
  })
})

describe('canonicalizeRate', () => {
  test('passes already-canonical strings through', () => {
    expect(canonicalizeRate('146.2')).toBe('146.2')
    expect(canonicalizeRate('1')).toBe('1')
    expect(canonicalizeRate('0.00684')).toBe('0.00684')
  })

  test('normalises trailing zeros', () => {
    expect(canonicalizeRate('1.0')).toBe('1')
    expect(canonicalizeRate('1.20')).toBe('1.2')
    expect(canonicalizeRate('0.1000')).toBe('0.1')
  })

  test('accepts numeric input (Frankfurter JSON)', () => {
    expect(canonicalizeRate(146.2)).toBe('146.2')
    expect(canonicalizeRate(0.912345)).toBe('0.912345')
    expect(canonicalizeRate(5)).toBe('5')
    expect(canonicalizeRate(0.00684)).toBe('0.00684')
  })

  test('rejects invalid inputs', () => {
    expect(() => canonicalizeRate(Number.NaN)).toThrow()
    expect(() => canonicalizeRate(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => canonicalizeRate(0)).toThrow()
    expect(() => canonicalizeRate(-1)).toThrow()
    expect(() => canonicalizeRate('-1.5')).toThrow()
    expect(() => canonicalizeRate('abc')).toThrow()
  })
})

describe('parseDecimalRate', () => {
  test('integer rate', () => {
    expect(parseDecimalRate('5')).toEqual({ mantissa: 5n, scale: 0 })
    expect(parseDecimalRate('146')).toEqual({ mantissa: 146n, scale: 0 })
  })

  test('one-decimal rate', () => {
    expect(parseDecimalRate('146.2')).toEqual({ mantissa: 1462n, scale: 1 })
    expect(parseDecimalRate('0.5')).toEqual({ mantissa: 5n, scale: 1 })
  })

  test('six-decimal Frankfurter precision', () => {
    expect(parseDecimalRate('0.912345')).toEqual({ mantissa: 912345n, scale: 6 })
    expect(parseDecimalRate('0.00684')).toEqual({ mantissa: 684n, scale: 5 })
  })

  test('throws on non-canonical input', () => {
    expect(() => parseDecimalRate('1.20')).toThrow()
    expect(() => parseDecimalRate('-1')).toThrow()
    expect(() => parseDecimalRate('')).toThrow()
  })

  // Mirrors isCanonicalRateString zero-rate rejection — parsing "0"
  // would otherwise hand the converter a zero mantissa and silently
  // zero out every conversion off that rate.
  test('rejects zero rate', () => {
    expect(() => parseDecimalRate('0')).toThrow()
    expect(() => parseDecimalRate('0.0')).toThrow()
  })
})

describe('convertMinorHalfEven — currency pair matrix', () => {
  test('USD $12.34 → JPY ¥1804 @ 146.2', () => {
    // 1234 * 1462 / 1000 = 1804.108 → 1804
    expect(convertMinorHalfEven({
      sourceMinor: 1234, rateDecimal: '146.2',
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })).toBe(1804)
  })

  test('JPY ¥1000 → USD $6.84 @ 0.00684', () => {
    // 1000 * 684 * 100 / 100000 = 684 → 684 cents
    expect(convertMinorHalfEven({
      sourceMinor: 1000, rateDecimal: '0.00684',
      sourceFractionDigits: 0, targetFractionDigits: 2,
    })).toBe(684)
  })

  test('USD $12.34 → TWD NT$376 @ 30.5', () => {
    // 1234 * 305 / 1000 = 376.37 → 376
    expect(convertMinorHalfEven({
      sourceMinor: 1234, rateDecimal: '30.5',
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })).toBe(376)
  })

  test('VND 100000 → USD $4.00 @ 0.00004', () => {
    // 100000 * 4 * 100 / 100000 = 400 cents
    expect(convertMinorHalfEven({
      sourceMinor: 100000, rateDecimal: '0.00004',
      sourceFractionDigits: 0, targetFractionDigits: 2,
    })).toBe(400)
  })

  test('IDR 100000 → JPY ¥10 @ 0.0098', () => {
    // 100000 * 98 / 10000 = 980 → wait: rate "0.0098" → mantissa=98, scale=4
    // num = 100000 * 98 * 1 = 9_800_000, den = 10^4 = 10000, result = 980
    expect(convertMinorHalfEven({
      sourceMinor: 100000, rateDecimal: '0.0098',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })).toBe(980)
  })

  test('USD → EUR same-fraction @ 0.91', () => {
    // 1234 * 91 * 100 / 10000 = 1122.94 → 1123 (round up, > half)
    expect(convertMinorHalfEven({
      sourceMinor: 1234, rateDecimal: '0.91',
      sourceFractionDigits: 2, targetFractionDigits: 2,
    })).toBe(1123)
  })

  test('zero source produces zero', () => {
    expect(convertMinorHalfEven({
      sourceMinor: 0, rateDecimal: '146.2',
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })).toBe(0)
  })
})

describe('convertMinorHalfEven — half-even tie-breaking', () => {
  // 5 * 0.5 = 2.5 → round to even → 2
  test('quotient even on exact tie rounds down', () => {
    expect(convertMinorHalfEven({
      sourceMinor: 5, rateDecimal: '0.5',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })).toBe(2)
  })

  // 15 * 0.5 = 7.5 → round to even → 8
  test('quotient odd on exact tie rounds up', () => {
    expect(convertMinorHalfEven({
      sourceMinor: 15, rateDecimal: '0.5',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })).toBe(8)
  })

  // 25 * 0.5 = 12.5 → round to even → 12
  test('quotient even on exact tie rounds down (larger value)', () => {
    expect(convertMinorHalfEven({
      sourceMinor: 25, rateDecimal: '0.5',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })).toBe(12)
  })

  // Strictly less-than-half rounds down even if very close
  test('remainder less than half rounds down', () => {
    // 1234 * 146 = 180164, den=1000, 180164/1000 = 180 rem 164, twiceRem=328 < 1000 → 180
    expect(convertMinorHalfEven({
      sourceMinor: 1234, rateDecimal: '146',
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })).toBe(1802)
    // Verify the math: 12.34 USD × 146 JPY/USD = 1801.64 JPY → 1802 (half-up direction)
  })
})

describe('convertMinorHalfEven — negative amounts (refund parity)', () => {
  test('symmetric magnitude vs positive', () => {
    const positive = convertMinorHalfEven({
      sourceMinor: 1234, rateDecimal: '146.2',
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })
    const negative = convertMinorHalfEven({
      sourceMinor: -1234, rateDecimal: '146.2',
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })
    expect(negative).toBe(-positive)
    expect(negative).toBe(-1804)
  })

  test('negative half-even tie rounds to even (symmetric)', () => {
    // -5 * 0.5 = -2.5 → round to even → -2
    expect(convertMinorHalfEven({
      sourceMinor: -5, rateDecimal: '0.5',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })).toBe(-2)
  })
})

describe('convertMinorHalfEven — input validation', () => {
  test('throws on non-integer source', () => {
    expect(() => convertMinorHalfEven({
      sourceMinor: 12.34, rateDecimal: '1',
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })).toThrow()
  })

  test('throws on negative fraction digits', () => {
    expect(() => convertMinorHalfEven({
      sourceMinor: 100, rateDecimal: '1',
      sourceFractionDigits: -1, targetFractionDigits: 0,
    })).toThrow()
  })

  test('throws on non-canonical rate', () => {
    expect(() => convertMinorHalfEven({
      sourceMinor: 100, rateDecimal: '1.20',
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })).toThrow()
  })
})

describe('estimateSourceMinorAtMostTargetHalfEven', () => {
  // The settlement OVERPAY repro: closest-policy seed picks source=120
  // → forward=552, which the Worker rejects against a remaining debt
  // of 550. At-most policy must back off to source=119 → forward=547,
  // leaving 3 minor units unsettled rather than rolling back the row.
  test('does not overshoot the remaining debt (settlement OVERPAY repro)', () => {
    const sourceMinor = estimateSourceMinorAtMostTargetHalfEven({
      targetMinor: 550, rateDecimal: '4.6',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })

    expect(sourceMinor).toBe(119)
    expect(convertMinorHalfEven({
      sourceMinor, rateDecimal: '4.6',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })).toBe(547)
  })

  test('returns the exact inverse when forward conversion is exact', () => {
    const sourceMinor = estimateSourceMinorAtMostTargetHalfEven({
      targetMinor: 1804, rateDecimal: '146.2',
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })

    expect(sourceMinor).toBe(1234)
    expect(convertMinorHalfEven({
      sourceMinor, rateDecimal: '146.2',
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })).toBe(1804)
  })

  test('returns the largest candidate at or under target (tie-edge)', () => {
    // Closest-policy picks 122 (forward 549, the closer of 549/553).
    // At-most policy also picks 122 here because 122 forward=549 <= 550.
    const sourceMinor = estimateSourceMinorAtMostTargetHalfEven({
      targetMinor: 550, rateDecimal: '4.5',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })

    expect(sourceMinor).toBe(122)
    expect(convertMinorHalfEven({
      sourceMinor, rateDecimal: '4.5',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })).toBe(549)
  })

  test('returns 0 when target is 0', () => {
    expect(estimateSourceMinorAtMostTargetHalfEven({
      targetMinor: 0, rateDecimal: '4.6',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })).toBe(0)
  })

  // Weak-currency regression: low rates make the half-even rounding
  // plateau wide. The naive ±5 scan around the inverse-floor (100,000)
  // would have returned ~100,005 — visibly underfilling a 100-unit debt
  // by ~99 source minor units in VND/IDR-style domains. Binary search
  // must walk all the way out to the plateau edge at 100,500.
  test('finds the plateau edge for low rates (weak-currency regression)', () => {
    const sourceMinor = estimateSourceMinorAtMostTargetHalfEven({
      targetMinor: 100, rateDecimal: '0.001',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })

    expect(sourceMinor).toBe(100500)
    expect(convertMinorHalfEven({
      sourceMinor, rateDecimal: '0.001',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })).toBe(100)
    // Tightness: the next minor unit MUST overshoot — otherwise the
    // search returned an underfill, not the plateau edge.
    expect(convertMinorHalfEven({
      sourceMinor: sourceMinor + 1, rateDecimal: '0.001',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })).toBe(101)
  })

  // Sanity case: identity rate, no fraction-digit asymmetry. Largest
  // safe = target. Locks the trivial endpoint so refactors of the
  // search algorithm can't silently regress.
  test('identity rate returns target exactly', () => {
    expect(estimateSourceMinorAtMostTargetHalfEven({
      targetMinor: 100, rateDecimal: '1',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })).toBe(100)
  })

  test('returns 0 when even one source minor unit would overshoot', () => {
    // target=1 JPY, rate=150 (JPY per USD), sf=2 (USD), tf=0 (JPY).
    // BigInt floor seeds estimate=6; scan covers 1..11. The smallest
    // positive candidate (1 USD-minor = 0.01 USD) forwards to round
    // half-even(1.5) = 2 JPY > 1, so EVERY scanned candidate overshoots.
    // The function must fall through to the `best < 0 ? 0` return, not
    // emit a positive source amount that the Worker would later reject.
    expect(estimateSourceMinorAtMostTargetHalfEven({
      targetMinor: 1, rateDecimal: '150',
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })).toBe(0)
  })

  test('throws on negative target (settlements are non-negative)', () => {
    expect(() => estimateSourceMinorAtMostTargetHalfEven({
      targetMinor: -1, rateDecimal: '4.6',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })).toThrow(/non-negative/)
  })

  test('throws on non-integer target', () => {
    expect(() => estimateSourceMinorAtMostTargetHalfEven({
      targetMinor: 1.5, rateDecimal: '4.6',
      sourceFractionDigits: 0, targetFractionDigits: 0,
    })).toThrow()
  })

  test('throws on non-canonical rates', () => {
    expect(() => estimateSourceMinorAtMostTargetHalfEven({
      targetMinor: 100, rateDecimal: '1.20',
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })).toThrow()
  })
})

describe('allocateRoundingResidual', () => {
  test('zero residual returns unchanged copy', () => {
    expect(allocateRoundingResidual({
      lines: [100, 200], targetTotal: 300,
    })).toEqual([100, 200])
  })

  test('positive residual added to largest line', () => {
    expect(allocateRoundingResidual({
      lines: [100, 200], targetTotal: 301,
    })).toEqual([100, 201])
  })

  test('negative residual subtracted from largest line', () => {
    expect(allocateRoundingResidual({
      lines: [100, 200], targetTotal: 299,
    })).toEqual([100, 199])
  })

  test('tie on largest → first index wins (deterministic replay)', () => {
    expect(allocateRoundingResidual({
      lines: [100, 100], targetTotal: 201,
    })).toEqual([101, 100])
  })

  test('all zeros + non-zero target → first index gets full residual', () => {
    expect(allocateRoundingResidual({
      lines: [0, 0, 0], targetTotal: 5,
    })).toEqual([5, 0, 0])
  })

  test('|line| comparison ignores sign (negative refund line wins)', () => {
    expect(allocateRoundingResidual({
      lines: [50, -100], targetTotal: -45,
    })).toEqual([50, -95])
  })

  test('single line absorbs any residual', () => {
    expect(allocateRoundingResidual({
      lines: [3], targetTotal: 5,
    })).toEqual([5])
  })

  test('does not mutate input', () => {
    const lines = [100, 200]
    allocateRoundingResidual({ lines, targetTotal: 301 })
    expect(lines).toEqual([100, 200])
  })

  test('empty lines + zero target → empty result', () => {
    expect(allocateRoundingResidual({
      lines: [], targetTotal: 0,
    })).toEqual([])
  })

  test('empty lines + non-zero target → throws', () => {
    expect(() => allocateRoundingResidual({
      lines: [], targetTotal: 5,
    })).toThrow()
  })

  test('throws on non-integer line', () => {
    expect(() => allocateRoundingResidual({
      lines: [10, 20.5], targetTotal: 30,
    })).toThrow()
  })
})

// Integration scenario locking the contract Worker expense-write will
// rely on in Phase 3: convert N items individually, convert the total
// independently, then reconcile via allocateRoundingResidual so the
// per-line sum exactly equals the authoritative total.
describe('integration: itemised conversion + residual reconciliation', () => {
  test('3 × USD $4.99 items → JPY total reconciles', () => {
    const rate = '146.2'
    const items = [499, 499, 499] // each USD $4.99 in cents

    const convertedItems = items.map(m => convertMinorHalfEven({
      sourceMinor: m, rateDecimal: rate,
      sourceFractionDigits: 2, targetFractionDigits: 0,
    }))
    // 499 * 1462 / 1000 = 729.538 → 730 per item (half-up direction)
    expect(convertedItems).toEqual([730, 730, 730])

    const sourceTotal       = items.reduce((s, m) => s + m, 0) // 1497
    const convertedTotal    = convertMinorHalfEven({
      sourceMinor: sourceTotal, rateDecimal: rate,
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })
    // 1497 * 1462 / 1000 = 2188.614 → 2189 (half-up)
    expect(convertedTotal).toBe(2189)

    const reconciled = allocateRoundingResidual({
      lines: convertedItems, targetTotal: convertedTotal,
    })
    // sum(lines) = 2190; residual = 2189 - 2190 = -1 → first index (tie) absorbs
    expect(reconciled).toEqual([729, 730, 730])
    expect(reconciled.reduce((s, m) => s + m, 0)).toBe(convertedTotal)
  })

  test('mixed-sign lines (item + adjustment discount) reconcile', () => {
    // Item $10.00 + adjustment -$1.50 = total $8.50 at rate 146.2
    const rate = '146.2'
    const lines = [
      convertMinorHalfEven({ sourceMinor:  1000, rateDecimal: rate, sourceFractionDigits: 2, targetFractionDigits: 0 }),
      convertMinorHalfEven({ sourceMinor:  -150, rateDecimal: rate, sourceFractionDigits: 2, targetFractionDigits: 0 }),
    ]
    // 1000 * 1462 / 1000 = 1462; -150 * 1462 / 1000 = -219.3 → half-even → -219
    expect(lines).toEqual([1462, -219])

    const totalSource    = 850
    const convertedTotal = convertMinorHalfEven({
      sourceMinor: totalSource, rateDecimal: rate,
      sourceFractionDigits: 2, targetFractionDigits: 0,
    })
    // 850 * 1462 / 1000 = 1242.7 → 1243 (half-up)
    expect(convertedTotal).toBe(1243)

    const reconciled = allocateRoundingResidual({
      lines, targetTotal: convertedTotal,
    })
    // sum(lines) = 1462 - 219 = 1243; residual 1243 - 1243 = 0 → unchanged
    expect(reconciled).toEqual([1462, -219])
  })
})
