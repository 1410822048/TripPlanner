import { describe, expect, test } from 'vitest'
import {
  effectiveEndTime,
  routeOptimizationAvailability,
  ScheduleTimingError,
  shouldRequestLocationAutocomplete,
  validateScheduleTiming,
  type ScheduleTimingInput,
} from './routeModel'

describe('schedule route timing model', () => {
  test('rejects fixed without a start time', () => {
    const input: ScheduleTimingInput = { timeMode: 'fixed', durationMinutes: 30 }
    try {
      validateScheduleTiming(input)
      throw new Error('expected timing validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleTimingError)
      expect((error as ScheduleTimingError).code).toBe('START_TIME_REQUIRED')
    }
  })

  test('preferred also requires a start time and flexible does not retain one', () => {
    expect(() => validateScheduleTiming({ timeMode: 'preferred', durationMinutes: 30 })).toThrow()
    expect(validateScheduleTiming({ timeMode: 'flexible', durationMinutes: 30, startTime: '10:00' })).toEqual({
      timeMode: 'flexible',
      durationMinutes: 30,
      startTime: undefined,
    })
  })

  test('infers preferred/flexible but requires an explicit duration', () => {
    expect(validateScheduleTiming({ startTime: '10:00', durationMinutes: 30 }).timeMode).toBe('preferred')
    expect(validateScheduleTiming({ durationMinutes: 30 }).timeMode).toBe('flexible')
    expect(() => validateScheduleTiming({ startTime: '10:00' })).toThrow(/durationMinutes/i)
  })

  test('derives the display end from start time and duration only', () => {
    expect(effectiveEndTime({ startTime: '10:00', durationMinutes: 90 })).toBe('11:30')
    expect(effectiveEndTime({ durationMinutes: 90 })).toBeUndefined()
  })

  test('rejects schedules that cross midnight and does not display a wrapped end time', () => {
    try {
      validateScheduleTiming({
        startTime: '23:30',
        timeMode: 'preferred',
        durationMinutes: 60,
      })
      throw new Error('expected timing validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleTimingError)
      expect((error as ScheduleTimingError).code).toBe('CROSSES_MIDNIGHT')
    }
    expect(effectiveEndTime({ startTime: '23:30', durationMinutes: 60 })).toBeUndefined()
  })

  test('treats an exact 24:00 end as crossing into the next day', () => {
    const input: ScheduleTimingInput = {
      startTime: '23:00',
      timeMode: 'preferred',
      durationMinutes: 60,
    }

    expect(() => validateScheduleTiming(input)).toThrow(ScheduleTimingError)
    expect(effectiveEndTime(input)).toBeUndefined()
  })

  test('allows autocomplete for unresolved legacy locations but not verified places', () => {
    expect(shouldRequestLocationAutocomplete({
      isOpen: true,
      query: 'Tokyo Station',
      location: { status: 'unresolved', query: 'Tokyo Station' },
    })).toBe(true)
    expect(shouldRequestLocationAutocomplete({
      isOpen: true,
      query: 'Tokyo Station',
      location: { status: 'resolved', place: {
        provider: 'geoapify',
        providerPlaceId: 'place-1',
        name: 'Tokyo Station',
        lat: 35.6812,
        lng: 139.7671,
        timeZone: 'Asia/Tokyo',
        countryCode: 'JP',
      } },
    })).toBe(false)
    expect(shouldRequestLocationAutocomplete({ isOpen: true, query: 'T', location: undefined })).toBe(false)
    expect(shouldRequestLocationAutocomplete({ isOpen: false, query: 'Tokyo', location: undefined })).toBe(false)
  })
})

describe('route optimization CTA', () => {
  const resolved = (timeZone = 'Asia/Tokyo') => ({
    status: 'resolved' as const,
    place: {
      provider: 'geoapify' as const,
      providerPlaceId: `place-${timeZone}`,
      name: '地點',
      lat: 35.6,
      lng: 139.7,
      timeZone,
      countryCode: 'JP',
    },
  })

  test('keeps the demo sign-in CTA available even though demo places are unresolved', () => {
    expect(routeOptimizationAvailability({
      canWrite: true,
      hasDate: true,
      isDemo: true,
      locations: [
        { status: 'unresolved', query: '東京' },
        { status: 'unresolved', query: '淺草' },
      ],
    })).toEqual({ status: 'ready' })
  })

  test('stays hidden without a writable day or enough schedules', () => {
    expect(routeOptimizationAvailability({ canWrite: false, hasDate: true, isDemo: false, locations: [resolved(), resolved()] })).toEqual({ status: 'hidden' })
    expect(routeOptimizationAvailability({ canWrite: true, hasDate: true, isDemo: false, locations: [resolved()] })).toEqual({ status: 'hidden' })
    expect(routeOptimizationAvailability({ canWrite: true, hasDate: false, isDemo: false, locations: [resolved(), resolved()] })).toEqual({ status: 'hidden' })
  })

  test('blocks cloud preview with an actionable reason instead of issuing a doomed request', () => {
    expect(routeOptimizationAvailability({
      canWrite: true,
      hasDate: true,
      isDemo: false,
      locations: [resolved(), { status: 'unresolved', query: '淺草' }],
    })).toEqual({ status: 'blocked', reason: 'unresolved-locations', count: 1 })

    expect(routeOptimizationAvailability({
      canWrite: true,
      hasDate: true,
      isDemo: false,
      locations: Array.from({ length: 13 }, () => resolved()),
    })).toEqual({ status: 'blocked', reason: 'too-many-schedules', count: 13 })

    expect(routeOptimizationAvailability({
      canWrite: true,
      hasDate: true,
      isDemo: false,
      locations: [resolved(), resolved('Asia/Seoul')],
    })).toEqual({ status: 'blocked', reason: 'mixed-time-zones' })
  })

  test('allows a cloud preview only when all route prerequisites are met', () => {
    expect(routeOptimizationAvailability({
      canWrite: true,
      hasDate: true,
      isDemo: false,
      locations: [resolved(), resolved()],
    })).toEqual({ status: 'ready' })
  })
})
