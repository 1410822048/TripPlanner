import { describe, expect, test } from 'vitest'
import { Timestamp } from 'firebase/firestore'
import { CreateScheduleSchema, ScheduleDocSchema, ScheduleLocationSchema, UpdateScheduleSchema } from './schedule'

const audit = {
  createdBy: 'u1', updatedBy: 'u1', memberIds: ['u1'],
  createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
}

describe('Schedule route fields', () => {
  test('resolved location requires Geoapify coordinates and IANA zone', () => {
    expect(ScheduleLocationSchema.safeParse({ status: 'resolved', place: {
      provider: 'geoapify', providerPlaceId: 'p1', name: 'Tokyo Tower', lat: 35.65, lng: 139.74, timeZone: 'Asia/Tokyo', countryCode: 'JP',
    } }).success).toBe(true)
    expect(ScheduleLocationSchema.safeParse({ status: 'resolved', place: { name: 'Tokyo' } }).success).toBe(false)
    expect(ScheduleLocationSchema.safeParse({ status: 'resolved', place: {
      provider: 'geoapify', providerPlaceId: 'p1', name: 'Tokyo Tower', lat: 35.65, lng: 139.74, timeZone: 'Asia/Tokyo', countryCode: 'jp',
    } }).success).toBe(false)
  })

  test('resolved location accepts only supported place providers', () => {
    const place = {
      providerPlaceId: 'google-pin', name: '澀谷 SKY', lat: 35.6586719, lng: 139.7019848,
      timeZone: 'Asia/Tokyo', countryCode: 'JP',
    }
    expect(ScheduleLocationSchema.safeParse({
      status: 'resolved', place: { ...place, provider: 'google-maps' },
    }).success).toBe(true)
    expect(ScheduleLocationSchema.safeParse({
      status: 'resolved', place: { ...place, provider: 'untrusted-provider' },
    }).success).toBe(false)
  })

  test('legacy text objects cannot be mistaken for canonical unresolved locations', () => {
    expect(ScheduleLocationSchema.safeParse({ name: 'typed place' }).success).toBe(false)
    expect(ScheduleLocationSchema.parse({ status: 'unresolved', query: 'typed place' }))
      .toEqual({ status: 'unresolved', query: 'typed place' })
  })

  test('flexible input cannot persist a user startTime', () => {
    expect(CreateScheduleSchema.safeParse({
      title: 'Flexible stop', date: '2026-05-01', timeMode: 'flexible', durationMinutes: 60, startTime: '10:00', category: 'activity', ...audit,
    }).success).toBe(false)
  })

  test('docs still reject missing timing fields and a legacy location shape', () => {
    expect(ScheduleDocSchema.safeParse({
      tripId: 'trip', date: '2026-05-01', order: 0, title: 'Old', category: 'activity',
      startTime: '10:00', endTime: '11:30', optimizedStartTime: '12:00', location: { name: 'Old place' }, ...audit,
    }).success).toBe(false)
  })

  describe('travelToNext (read side)', () => {
    const base = {
      tripId: 'trip', date: '2026-05-01', order: 0, title: 'Stop', category: 'activity',
      timeMode: 'preferred', durationMinutes: 60, startTime: '10:00',
      routeRevision: 'revision-1234567890', ...audit,
    }
    const parse = (travelToNext: unknown) => ScheduleDocSchema.parse({ ...base, travelToNext })

    test('keeps the measured walking time and distance', () => {
      expect(parse({ toId: 'next', walkingMinutes: 6, walkingDistanceMeters: 480 }).travelToNext)
        .toEqual({ toId: 'next', walkingMinutes: 6, walkingDistanceMeters: 480 })
    })

    test('strips fields a newer Worker might add instead of failing', () => {
      expect(parse({ toId: 'next', walkingMinutes: 6, walkingDistanceMeters: 480, extra: 'x' }).travelToNext)
        .toEqual({ toId: 'next', walkingMinutes: 6, walkingDistanceMeters: 480 })
    })

    test.each([
      ['the legacy derived shape', { toId: 'next', kind: 'walking', minutes: 6 }],
      ['a fractional distance', { toId: 'next', walkingMinutes: 6, walkingDistanceMeters: 480.5 }],
      ['a negative time', { toId: 'next', walkingMinutes: -1, walkingDistanceMeters: 480 }],
      ['a non-object', 'walking'],
    ])('turns %s into null and keeps the schedule', (_label, travelToNext) => {
      const result = ScheduleDocSchema.safeParse({ ...base, travelToNext })
      expect(result.success).toBe(true)
      expect(result.data?.travelToNext).toBeNull()
    })

    test('still requires a route revision alongside a valid measurement', () => {
      expect(ScheduleDocSchema.safeParse({
        ...base,
        routeRevision: null,
        travelToNext: { toId: 'next', walkingMinutes: 6, walkingDistanceMeters: 480 },
      }).success).toBe(false)
    })
  })

  test('new schedule writes reject the removed optimizedStartTime field', () => {
    expect(CreateScheduleSchema.safeParse({
      title: 'Stop', date: '2026-05-01', timeMode: 'preferred', durationMinutes: 60,
      startTime: '10:00', optimizedStartTime: '11:00', category: 'activity',
    }).success).toBe(false)
  })

  test('client input schemas reject Worker-owned route fields', () => {
    const input = {
      title: 'Stop', date: '2026-05-01', timeMode: 'preferred', durationMinutes: 60,
      startTime: '10:00', category: 'activity',
    }
    for (const workerField of [
      { routeRevision: null },
      { travelToNext: null },
    ]) {
      expect(CreateScheduleSchema.safeParse({ ...input, ...workerField }).success).toBe(false)
      expect(UpdateScheduleSchema.safeParse(workerField).success).toBe(false)
    }
  })

  test('new writes reject the removed endTime field; documents tolerate and strip it', () => {
    expect(CreateScheduleSchema.safeParse({
      title: 'Stop', date: '2026-05-01', timeMode: 'preferred', durationMinutes: 90,
      startTime: '10:00', endTime: '11:30', category: 'activity',
    }).success).toBe(false)

    // Read side: an installed bundle must not drop a schedule because the
    // document carries a field it does not know.
    const doc = ScheduleDocSchema.parse({
      tripId: 'trip', date: '2026-05-01', order: 0, title: 'Stop', category: 'activity',
      timeMode: 'preferred', durationMinutes: 90, startTime: '10:00', endTime: '11:30',
      routeRevision: null, travelToNext: null, ...audit,
    })
    expect(doc).not.toHaveProperty('endTime')
  })
})
