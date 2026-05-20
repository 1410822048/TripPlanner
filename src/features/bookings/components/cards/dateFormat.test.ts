// Pin the booking-card date helpers. These run on every card render
// and have several silent-regression failure modes:
//   - fmtTime: regex must reject date-only input so date-only bookings
//     do NOT render '00:00' (would look like a midnight booking).
//   - fmtDate: WEEKDAYS_JA index must stay aligned with Date.getDay()
//     so weekday rendering doesn't shift by one.
//   - nightsBetween: raw-ms math used to floor "15:00 -> 11:00 next day"
//     to 0 nights -- the diffDays-based version returns 1.
import { describe, expect, test } from 'vitest'
import { fmtDate, fmtTime, nightsBetween } from './dateFormat'

describe('fmtTime', () => {
  test('extracts HH:mm from a full ISO datetime', () => {
    expect(fmtTime('2026-05-15T15:00')).toBe('15:00')
    expect(fmtTime('2026-05-15T08:30')).toBe('08:30')
  })

  test('date-only input returns empty string (no fake 00:00)', () => {
    // Critical: the regex test must reject date-only strings. If it
    // accidentally passes them, `new Date('2026-05-15')` produces a
    // local-midnight Date and fmtTime would return '00:00' -- making
    // every date-only booking falsely show as a midnight booking.
    expect(fmtTime('2026-05-15')).toBe('')
  })

  test('missing or invalid input returns empty string', () => {
    expect(fmtTime(undefined)).toBe('')
    expect(fmtTime('')).toBe('')
    expect(fmtTime('not-a-datetime')).toBe('')
  })
})

describe('fmtDate', () => {
  // Production callers always pass `booking.checkIn` / `checkOut`, which
  // are full ISO datetime strings per the Booking type comment. We test
  // that exact shape -- noon local time -- because:
  //   - Date-only strings like '2026-05-15' would parse as UTC midnight
  //     per the ECMA-262 spec, then getDay() / getDate() projects back
  //     to local time -- giving the wrong day in UTC- timezones. CI
  //     boxes running in UTC would shift the assertion.
  //   - Datetime strings WITHOUT a Z suffix parse as local time, so
  //     getDay() / getDate() return stable values regardless of CI TZ.
  // Noon (12:00) is also far enough from midnight to be safe even with
  // extreme TZ offsets, which only matters if a future change adds
  // explicit hour math.
  test('formats MM/DD with Japanese weekday', () => {
    // 2026-05-15 is a Friday. WEEKDAYS_JA[5] === '金'.
    expect(fmtDate('2026-05-15T12:00')).toBe('05/15 (金)')
    // 2026-05-17 is a Sunday. WEEKDAYS_JA[0] === '日'.
    expect(fmtDate('2026-05-17T12:00')).toBe('05/17 (日)')
  })

  test('accepts the production check-in datetime shape', () => {
    expect(fmtDate('2026-05-15T15:00')).toBe('05/15 (金)')
  })

  test('missing or invalid input returns empty string', () => {
    expect(fmtDate(undefined)).toBe('')
    expect(fmtDate('')).toBe('')
    expect(fmtDate('not-a-date')).toBe('')
  })
})

describe('nightsBetween', () => {
  test('15:00 -> next-day 11:00 = 1 night (raw ms would round to 0)', () => {
    expect(nightsBetween('2026-05-15T15:00', '2026-05-16T11:00')).toBe(1)
  })

  test('same-day check-out returns null', () => {
    expect(nightsBetween('2026-05-15T15:00', '2026-05-15T20:00')).toBeNull()
  })

  test('multi-night stay across two nights', () => {
    expect(nightsBetween('2026-05-15T15:00', '2026-05-17T11:00')).toBe(2)
  })

  test('reversed dates return null (defensive)', () => {
    expect(nightsBetween('2026-05-17T11:00', '2026-05-15T15:00')).toBeNull()
  })

  test('missing inputs return null', () => {
    expect(nightsBetween(undefined, '2026-05-16T11:00')).toBeNull()
    expect(nightsBetween('2026-05-15T15:00', undefined)).toBeNull()
    expect(nightsBetween(undefined, undefined)).toBeNull()
  })

  test('malformed input returns null', () => {
    expect(nightsBetween('not-a-date', '2026-05-16T11:00')).toBeNull()
  })
})
