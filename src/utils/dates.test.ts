// src/utils/dates.test.ts
// Pin the date math used by copyTrip's schedule date-shifting and
// EditTripModal's orphan-detection. These functions are pure + small
// but the off-by-one risk on "is a date inclusive or exclusive" caused
// the previous toISOString() bug; tests guard against the regression.
import { describe, expect, it, test } from 'vitest'
import { addDays, diffDays, toLocalDateString, fromLocalDateString, toTripDateTimestamp, tripTimestampToDateString } from './dates'

describe('addDays', () => {
  test('adds positive days', () => {
    expect(addDays('2026-05-01', 1)).toBe('2026-05-02')
    expect(addDays('2026-05-01', 30)).toBe('2026-05-31')
  })

  test('adds zero (identity)', () => {
    expect(addDays('2026-05-15', 0)).toBe('2026-05-15')
  })

  test('handles negative offset (subtracts)', () => {
    expect(addDays('2026-05-10', -5)).toBe('2026-05-05')
  })

  test('crosses month boundary', () => {
    expect(addDays('2026-04-30', 2)).toBe('2026-05-02')
  })

  test('crosses year boundary', () => {
    expect(addDays('2026-12-30', 5)).toBe('2027-01-04')
  })

  test('handles leap year', () => {
    // 2028 is a leap year — Feb has 29 days.
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2028-02-28', 2)).toBe('2028-03-01')
    // 2026 is NOT a leap year.
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })
})

describe('diffDays', () => {
  test('positive delta when `to` later', () => {
    expect(diffDays('2026-05-01', '2026-05-04')).toBe(3)
  })

  test('zero when same day', () => {
    expect(diffDays('2026-05-15', '2026-05-15')).toBe(0)
  })

  test('negative delta when `to` earlier', () => {
    expect(diffDays('2026-05-10', '2026-05-05')).toBe(-5)
  })

  test('crosses month / year boundary', () => {
    expect(diffDays('2026-12-30', '2027-01-04')).toBe(5)
  })

  test('respects DST-free local-midnight contract', () => {
    // The timezone where DST occurred between these dates would shift by
    // 1h if we were doing UTC math. We use local midnight + 86400000ms.
    expect(diffDays('2026-03-01', '2026-04-01')).toBe(31)
    expect(diffDays('2026-10-15', '2026-11-15')).toBe(31)
  })
})

describe('toLocalDateString / fromLocalDateString', () => {
  test('round-trip preserves the date', () => {
    const cases = ['2026-01-01', '2026-05-15', '2026-12-31']
    for (const d of cases) {
      expect(toLocalDateString(fromLocalDateString(d))).toBe(d)
    }
  })

  test('toLocalDateString does NOT shift due to UTC conversion', () => {
    // The bug we're guarding against: in a UTC+8 zone, `new Date('2026-05-01')`
    // is parsed as UTC midnight, then displayed in local as 2026-05-01 08:00
    // (still that day) — but `toISOString()` would then give '2026-04-30T...'
    // for some dates near the boundary.
    const d = new Date(2026, 4, 1)   // local May 1
    expect(toLocalDateString(d)).toBe('2026-05-01')
  })
})

describe('trip date Timestamps (timezone-independent calendar dates)', () => {
  const Ts = { fromDate: (d: Date) => ({ toMillis: () => d.getTime() }) }

  it('round-trips a calendar date through the stored Timestamp', () => {
    for (const day of ['2026-01-01', '2026-03-08', '2026-11-05', '2028-02-29']) {
      expect(tripTimestampToDateString(toTripDateTimestamp(day, Ts))).toBe(day)
    }
  })

  it('stores 00:00 UTC regardless of the writer timezone', () => {
    expect(toTripDateTimestamp('2026-11-01', Ts).toMillis()).toBe(Date.UTC(2026, 10, 1))
  })

  it('reads legacy local-midnight writes from any offset in (-12h, +12h] as the same day', () => {
    // Legacy encoding = 00:00 in the WRITER's zone. Taipei (+8) wrote
    // 2026-11-01 as 2026-10-31T16:00Z; a PDT viewer used to see 10/31.
    for (const offsetHours of [-11, -8, -3, 0, 5.5, 8, 9, 12]) {
      const legacy = { toMillis: () => Date.UTC(2026, 10, 1) - offsetHours * 3_600_000 }
      expect(tripTimestampToDateString(legacy)).toBe('2026-11-01')
    }
  })
})
