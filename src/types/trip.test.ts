import { describe, expect, test } from 'vitest'
import { CreateTripSchema, UpdateTripSchema, TripDocSchema } from './trip'
import { Timestamp } from 'firebase/firestore'
import { buildDateRange } from '@/utils/dates'

const validTrip = {
  title: '東京旅行',
  destination: '東京',
  startDate: '2026-07-20',
  endDate: '2026-07-25',
  currency: 'JPY',
  defaultCountryCode: 'JP',
}

describe('Trip country model', () => {
  test('requires an uppercase ISO 3166-1 alpha-2 default country', () => {
    expect(CreateTripSchema.safeParse(validTrip).success).toBe(true)
    expect(CreateTripSchema.safeParse({ ...validTrip, defaultCountryCode: 'jp' }).success).toBe(false)
    const withoutCountry = { ...validTrip } as Partial<typeof validTrip>
    delete withoutCountry.defaultCountryCode
    expect(CreateTripSchema.safeParse(withoutCountry).success).toBe(false)
  })
})

describe('Trip date bounds', () => {
  test.each([
    ['2026-01-01', '2027-01-01', true],
    ['2026-01-01', '2027-01-02', false],
    ['2026-01-02', '2026-01-01', false],
    ['2026-02-30', '2026-03-02', false],
    ['2026-01-01', '2125-12-31', false],
  ])('%s → %s accepted=%s', (startDate, endDate, accepted) => {
    const dates = { startDate, endDate }
    expect(CreateTripSchema.safeParse({ ...validTrip, ...dates }).success).toBe(accepted)
    expect(UpdateTripSchema.safeParse(dates).success).toBe(accepted)
    expect(buildDateRange(startDate, endDate).length > 0).toBe(accepted)
  })

  test('rejects an oversized persisted range before rendering it', () => {
    const ts = (s: string) => Timestamp.fromDate(new Date(`${s}T00:00:00Z`))
    const trip = {
      ...validTrip, startDate: ts('2026-01-01'), endDate: ts('2027-01-02'),
      ownerId: 'u1', memberIds: ['u1'], createdAt: ts('2026-01-01'), updatedAt: ts('2026-01-01'),
      wishVotingDeadlineAt: null, wishVotingDeadlineNotifiedAt: null,
    }
    expect(TripDocSchema.safeParse(trip).success).toBe(false)
    expect(TripDocSchema.safeParse({ ...trip, endDate: ts('2027-01-01') }).success).toBe(true)
    expect(buildDateRange('2026-01-01', '2027-01-01')).toHaveLength(366)
  })
})
