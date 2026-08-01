// Pin the booking-card date helpers. These run on every card render
// and have several silent-regression failure modes:
//   - fmtTime: regex must reject date-only input so date-only bookings
//     do NOT render '00:00' (would look like a midnight booking).
//   - fmtDate: WEEKDAYS_ZH index must stay aligned with Date.getDay()
//     so weekday rendering doesn't shift by one.
//   - fmtDate: date-only input must be read as a calendar date, not a
//     UTC instant -- see the fixed-timezone block below.
//   - nightsBetween: raw-ms math used to floor "15:00 -> 11:00 next day"
//     to 0 nights -- the diffDays-based version returns 1.
//
// Pinned west of UTC on purpose: a UTC test box cannot tell a calendar
// date from a UTC instant, so the date-only assertions would pass even
// with the bug they exist to catch.
process.env.TZ = 'America/New_York'

import { describe, expect, test } from 'vitest'
import { fmtDate, fmtTime, nightsBetween } from './dateFormat'

describe('fmtTime', () => {
  test('extracts HH:mm from a full ISO datetime', () => {
    expect(fmtTime('2026-05-15T15:00')).toBe('15:00')
    expect(fmtTime('2026-05-15T08:30')).toBe('08:30')
  })

  test('date-only input returns empty string (no fake 00:00)', () => {
    // Critical: the regex test must reject date-only strings. If it
    // accidentally passes them, fmtTime would render the projection of a
    // parsed date -- making every date-only booking falsely show a time.
    expect(fmtTime('2026-05-15')).toBe('')
  })

  test('missing or invalid input returns empty string', () => {
    expect(fmtTime(undefined)).toBe('')
    expect(fmtTime('')).toBe('')
    expect(fmtTime('not-a-datetime')).toBe('')
  })
})

describe('fmtDate', () => {
  // Both shapes reach production: the form's DatePicker and the PDF
  // import path emit date-only 'YYYY-MM-DD', while manually entered
  // times give a full ISO datetime. Datetime strings without a Z suffix
  // parse as local time; date-only strings must go through
  // parseStoredDate or ECMA-262 reads them as UTC instants.
  test('formats MM/DD with Chinese weekday', () => {
    // 2026-05-15 is a Friday. WEEKDAYS_ZH[5] === '五'.
    expect(fmtDate('2026-05-15T12:00')).toBe('05/15 (五)')
    // 2026-05-17 is a Sunday. WEEKDAYS_ZH[0] === '日'.
    expect(fmtDate('2026-05-17T12:00')).toBe('05/17 (日)')
  })

  test('accepts the production check-in datetime shape', () => {
    expect(fmtDate('2026-05-15T15:00')).toBe('05/15 (五)')
  })

  test('date-only input keeps its calendar day west of UTC', () => {
    // Bare `new Date('2026-05-15')` is 2026-05-14T20:00 in New York, so
    // both the day and the weekday would slip by one.
    expect(fmtDate('2026-05-15')).toBe('05/15 (五)')
    expect(fmtDate('2026-01-01')).toBe('01/01 (四)')
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
