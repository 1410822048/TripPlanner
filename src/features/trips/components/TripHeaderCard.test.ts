// src/features/trips/components/TripHeaderCard.test.ts
// Pins the memo comparator's contract. A regression in either direction
// is a real bug:
//   - Returning false when nothing changed → memo stops working, every
//     parent state change cascades into the header (the bug we just
//     fixed by memoising selectedTrip).
//   - Returning true when actual data changed → header shows stale data
//     (worse: silent wrong UI, no crash, no toast, hard to debug).
import { describe, expect, test } from 'vitest'
import { tripHeaderCardPropsAreEqual } from './tripHeaderCardPropsAreEqual'
import type { TripItem } from '@/features/trips/types'

const trip: TripItem = {
  id:        't1',
  title:     'Tokyo',
  dest:      'Japan',
  emoji:     '🗼',
  startDate: '2026-05-01',
  endDate:   '2026-05-05',
  members:   [],
}

const baseProps = {
  selectedTrip:  trip,
  tripDays:      5,
  scheduleCount: 12,
  tripTotal:     45000,
  onEditTrip:    () => {},
  onInvite:      () => {},
}

describe('tripHeaderCardPropsAreEqual', () => {
  test('returns true when ALL data props are reference-equal', () => {
    expect(tripHeaderCardPropsAreEqual(baseProps, baseProps)).toBe(true)
  })

  test('returns true when only callback identity changes (the whole point)', () => {
    const next = { ...baseProps, onEditTrip: () => {}, onInvite: () => {} }
    expect(tripHeaderCardPropsAreEqual(baseProps, next)).toBe(true)
  })

  test('returns false when selectedTrip reference changes (even with same data)', () => {
    // The page-level useMemo over selectedTrip means an identity change
    // here ALWAYS reflects a real upstream change — we don't deep-compare.
    const next = { ...baseProps, selectedTrip: { ...trip } }
    expect(tripHeaderCardPropsAreEqual(baseProps, next)).toBe(false)
  })

  test('returns false when tripDays changes', () => {
    expect(tripHeaderCardPropsAreEqual(baseProps, { ...baseProps, tripDays: 6 })).toBe(false)
  })

  test('returns false when scheduleCount changes', () => {
    expect(tripHeaderCardPropsAreEqual(baseProps, { ...baseProps, scheduleCount: 13 })).toBe(false)
  })

  test('returns false when tripTotal changes', () => {
    expect(tripHeaderCardPropsAreEqual(baseProps, { ...baseProps, tripTotal: 50000 })).toBe(false)
  })
})
