import { describe, expect, test } from 'vitest'
import {
  EITHER_MAX_WALKING_MINUTES,
  LONG_DISTANCE_STRAIGHT_METERS,
  TIGHT_SLACK_MINUTES,
  WALKING_DIRECT_THRESHOLD_MINUTES,
  classifySegment,
  dayFeasibility,
  estimateTransitRange,
  segmentTimeRange,
  straightLineMeters,
  type FeasibilityItem,
  type SegmentMeasurement,
  type TravelTimeRange,
} from './index'

describe('estimateTransitRange (door-to-door)', () => {
  test('keeps the shared thresholds stable', () => {
    expect(WALKING_DIRECT_THRESHOLD_MINUTES).toBe(15)
    expect(EITHER_MAX_WALKING_MINUTES).toBe(30)
    expect(LONG_DISTANCE_STRAIGHT_METERS).toBe(80_000)
    expect(TIGHT_SLACK_MINUTES).toBe(10)
  })

  test.each([
    [0, 10, 15],
    [1_500, 10, 20],
    [2_000, 10, 20],
    [3_000, 15, 25],
    [5_000, 20, 30],
    [7_000, 20, 35],
    [10_000, 25, 45],
    [30_000, 35, 60],
    [60_000, 50, 80],
  ])('%sm → %s–%s minutes', (distanceMeters, minMinutes, maxMinutes) => {
    expect(estimateTransitRange(distanceMeters)).toEqual({ minMinutes, maxMinutes })
  })

  test('never gets faster as the distance grows', () => {
    let previous = estimateTransitRange(0)
    for (let meters = 250; meters <= 120_000; meters += 250) {
      const current = estimateTransitRange(meters)
      expect(current.minMinutes).toBeGreaterThanOrEqual(previous.minMinutes)
      expect(current.maxMinutes).toBeGreaterThanOrEqual(previous.maxMinutes)
      expect(current.maxMinutes).toBeGreaterThan(current.minMinutes)
      previous = current
    }
  })

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid distance %s', distanceMeters => {
    expect(() => estimateTransitRange(distanceMeters)).toThrow(/finite non-negative/)
  })
})

describe('straightLineMeters', () => {
  test('measures the great-circle distance', () => {
    // Tokyo Station → Kyoto Station, about 372 km.
    const meters = straightLineMeters({ lat: 35.6812, lng: 139.7671 }, { lat: 34.9858, lng: 135.7588 })
    expect(meters).toBeGreaterThan(365_000)
    expect(meters).toBeLessThan(380_000)
    expect(straightLineMeters({ lat: 35, lng: 139 }, { lat: 35, lng: 139 })).toBe(0)
  })

  test('rejects an invalid coordinate', () => {
    expect(() => straightLineMeters({ lat: 91, lng: 0 }, { lat: 0, lng: 0 })).toThrow(/invalid route coordinate/)
  })
})

describe('classifySegment', () => {
  const measure = (overrides: Partial<SegmentMeasurement>): SegmentMeasurement => ({
    walkingMinutes: 10,
    walkingDistanceMeters: 800,
    straightLineMeters: 650,
    originIsTransport: false,
    ...overrides,
  })

  test('walking up to the direct threshold', () => {
    expect(classifySegment(measure({ walkingMinutes: 15 }))).toEqual({ kind: 'walking', walkingMinutes: 15 })
  })

  test('16–30 minutes of walking offers both modes', () => {
    expect(classifySegment(measure({ walkingMinutes: 16, walkingDistanceMeters: 1_300 }))).toEqual({
      kind: 'either', walkingMinutes: 16, transit: { minMinutes: 10, maxMinutes: 20 },
    })
    expect(classifySegment(measure({ walkingMinutes: 30, walkingDistanceMeters: 2_400 })).kind).toBe('either')
  })

  test('beyond 30 minutes of walking is transit', () => {
    expect(classifySegment(measure({ walkingMinutes: 31, walkingDistanceMeters: 2_500 }))).toEqual({
      kind: 'transit', walkingMinutes: 31, transit: { minMinutes: 15, maxMinutes: 20 },
    })
  })

  test('long distance is judged on the straight line, not the walking network', () => {
    // A detour makes the walking network longer than 80 km; the class must
    // stay the same before and after a route is applied.
    expect(classifySegment(measure({
      walkingMinutes: 1_000, walkingDistanceMeters: 85_000, straightLineMeters: 70_000,
    })).kind).toBe('transit')
    expect(classifySegment(measure({
      walkingMinutes: 1_000, walkingDistanceMeters: 85_000, straightLineMeters: 80_001,
    }))).toEqual({ kind: 'long-distance' })
  })

  test('a segment leaving a transport schedule is unknown, however short', () => {
    expect(classifySegment(measure({ walkingMinutes: 3, originIsTransport: true }))).toEqual({ kind: 'unknown' })
  })

  test('rejects invalid measurements', () => {
    expect(() => classifySegment(measure({ walkingMinutes: -1 }))).toThrow(/finite non-negative/)
  })
})

describe('segmentTimeRange', () => {
  test('either never assumes transit slower than walking', () => {
    expect(segmentTimeRange({ kind: 'either', walkingMinutes: 22, transit: { minMinutes: 15, maxMinutes: 25 } }))
      .toEqual({ min: 15, max: 22 })
  })

  test('unknown and long distance are [0, ∞)', () => {
    expect(segmentTimeRange({ kind: 'unknown' })).toEqual({ min: 0, max: Number.POSITIVE_INFINITY })
    expect(segmentTimeRange({ kind: 'long-distance' })).toEqual({ min: 0, max: Number.POSITIVE_INFINITY })
  })

  test('walking and transit use their own bounds', () => {
    expect(segmentTimeRange({ kind: 'walking', walkingMinutes: 8 })).toEqual({ min: 8, max: 8 })
    expect(segmentTimeRange({ kind: 'transit', walkingMinutes: 60, transit: { minMinutes: 20, maxMinutes: 30 } }))
      .toEqual({ min: 20, max: 30 })
  })
})

describe('dayFeasibility', () => {
  const at = (time: string) => {
    const [h, m] = time.split(':').map(Number)
    return h! * 60 + m!
  }
  const timed = (time: string, durationMinutes: number): FeasibilityItem => ({ startMinutes: at(time), durationMinutes })
  const flexible = (durationMinutes: number): FeasibilityItem => ({ durationMinutes })
  const range = (min: number, max = min): TravelTimeRange => ({ min, max })
  const UNKNOWN = range(0, Number.POSITIVE_INFINITY)

  // A: 15:00–16:30, then a 17:00 reservation.
  test('fastest arrival 17:05, slowest 17:15 → late by at least 5', () => {
    expect(dayFeasibility([timed('15:00', 90), timed('17:00', 60)], [range(35, 45)])[1])
      .toEqual({ status: 'late', lateMinutes: 5 })
  })

  test('fastest arrival 16:55, slowest 17:10 → possibly late by up to 10', () => {
    expect(dayFeasibility([timed('15:00', 90), timed('17:00', 60)], [range(25, 40)])[1])
      .toEqual({ status: 'possibly-late', maxLateMinutes: 10 })
  })

  test('on time at worst but under the tight threshold', () => {
    expect(dayFeasibility([timed('15:00', 90), timed('17:00', 60)], [range(25)])[1])
      .toEqual({ status: 'tight', minSlack: 5, maxSlack: 5 })
  })

  test('exactly the tight threshold is ok', () => {
    expect(dayFeasibility([timed('15:00', 90), timed('17:00', 60)], [range(10, 20)])[1])
      .toEqual({ status: 'ok', minSlack: 10, maxSlack: 20 })
  })

  test('zero slack at worst is tight, not late', () => {
    expect(dayFeasibility([timed('15:00', 90), timed('17:00', 60)], [range(20, 30)])[1])
      .toEqual({ status: 'tight', minSlack: 0, maxSlack: 10 })
  })

  test('no travel at all is never tight, even with no spare time', () => {
    expect(dayFeasibility([timed('10:00', 60), timed('11:00', 60)], [range(0)])[1])
      .toEqual({ status: 'ok', minSlack: 0, maxSlack: 0 })
  })

  test('direct overlap ignores travel', () => {
    expect(dayFeasibility([timed('10:00', 120), timed('11:30', 60)], [range(5)])[1])
      .toEqual({ status: 'overlap', overflowMinutes: 30, flexibleBetween: 0 })
  })

  test('flexible stops in between push the stretch and can overflow it', () => {
    expect(dayFeasibility([timed('10:00', 60), flexible(90), timed('12:00', 60)], [range(5), range(5)])[2])
      .toEqual({ status: 'overlap', overflowMinutes: 30, flexibleBetween: 1 })
    expect(dayFeasibility([timed('09:00', 60), flexible(60), timed('11:30', 60)], [range(10), range(10)])[2])
      .toEqual({ status: 'ok', minSlack: 10, maxSlack: 10 })
  })

  test('lateness does not cascade: the next stretch starts from the planned end', () => {
    // A 10:00–11:30 → B 12:00 (arrives 12:10 at best) → C 13:10.
    const verdicts = dayFeasibility(
      [timed('10:00', 90), timed('12:00', 60), timed('13:10', 60)],
      [range(40, 50), range(5)],
    )
    expect(verdicts[1]).toEqual({ status: 'late', lateMinutes: 10 })
    // From B's planned 13:00 end, not from a simulated 13:10.
    expect(verdicts[2]).toEqual({ status: 'tight', minSlack: 5, maxSlack: 5 })
  })

  test('an unknown segment only clouds the stretch up to the next anchor', () => {
    const verdicts = dayFeasibility(
      [timed('10:00', 60), timed('12:00', 60), timed('13:30', 60)],
      [UNKNOWN, range(10)],
    )
    expect(verdicts[1]).toEqual({ status: 'unknown' })
    expect(verdicts[2]).toEqual({ status: 'ok', minSlack: 20, maxSlack: 20 })
  })

  test('an unknown segment still yields definite overlaps and lateness', () => {
    // 新幹線 12:00–14:15, then a 14:00 check-in: the onward segment is unknown.
    expect(dayFeasibility([timed('12:00', 135), timed('14:00', 30)], [UNKNOWN])[1])
      .toEqual({ status: 'overlap', overflowMinutes: 15, flexibleBetween: 0 })
    // A known 30-minute leg before the unknown one already makes it late.
    expect(dayFeasibility(
      [timed('09:00', 60), flexible(30), timed('10:45', 60)],
      [range(30, 40), UNKNOWN],
    )[2]).toEqual({ status: 'late', lateMinutes: 15 })
  })

  test('no verdict for the first anchor, flexible schedules, or anything before an anchor', () => {
    const verdicts = dayFeasibility(
      [flexible(30), timed('10:00', 60), flexible(30), timed('12:00', 60), flexible(30)],
      [range(5), range(5), range(5), range(5)],
    )
    expect(verdicts[0]).toBeUndefined()
    expect(verdicts[1]).toBeUndefined()
    expect(verdicts[2]).toBeUndefined()
    expect(verdicts[3]?.status).toBe('ok')
    expect(verdicts[4]).toBeUndefined()
  })

  test('times that run backwards are an order problem, not a huge overlap', () => {
    // order 0 at 14:00, order 1 at 10:00.
    expect(dayFeasibility([timed('14:00', 60), timed('10:00', 60)], [range(5)])[1])
      .toEqual({ status: 'out-of-order' })
    // The next stretch starts again from the out-of-order anchor's plan.
    expect(dayFeasibility(
      [timed('14:00', 60), timed('10:00', 60), timed('11:30', 60)],
      [range(5), range(10)],
    )[2]).toEqual({ status: 'ok', minSlack: 20, maxSlack: 20 })
    // Equal start times are an overlap, not an ordering problem.
    expect(dayFeasibility([timed('10:00', 60), timed('10:00', 60)], [range(5)])[1]?.status).toBe('overlap')
  })

  test('requires one segment between consecutive items', () => {
    expect(dayFeasibility([], [])).toEqual([])
    expect(() => dayFeasibility([timed('10:00', 60), timed('11:00', 60)], [])).toThrow(/exactly one segment/)
  })
})
