// Pin nightsBetween() against the two regressions we know about:
//   1. 15:00 check-in -> 11:00 next-day check-out is 1 night, not 0
//      (raw ms math rounded down to 0 -- that was the original bug)
//   2. Same-day check-out / reversed dates are NOT zero nights -- the
//      caller wants null so the badge can render '-' instead of '0 泊'
import { describe, expect, test } from 'vitest'
import { nightsBetween } from './dateFormat'

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
