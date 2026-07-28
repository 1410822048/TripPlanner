import { describe, expect, test } from 'vitest'
import { estimateTransitRange, WALKING_DIRECT_THRESHOLD_MINUTES } from './index'

describe('route estimate core', () => {
  test('keeps the shared walking threshold stable', () => {
    expect(WALKING_DIRECT_THRESHOLD_MINUTES).toBe(15)
  })

  test.each([
    [3500, { minMinutes: 10, maxMinutes: 15 }],
    [8000, { minMinutes: 15, maxMinutes: 25 }],
  ])('estimates the canonical transit range for %sm', (distanceMeters, expected) => {
    expect(estimateTransitRange(distanceMeters)).toEqual(expected)
  })

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid distance %s',
    distanceMeters => {
      expect(() => estimateTransitRange(distanceMeters)).toThrow(/finite non-negative/)
    },
  )
})
