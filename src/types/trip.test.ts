import { describe, expect, test } from 'vitest'
import { CreateTripSchema } from './trip'

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
