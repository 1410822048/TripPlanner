import { describe, expect, test } from 'vitest'
import type { Schedule } from '@/types'
import { currencyCountrySuggestion } from '@/utils/country'
import {
  countryAfterCurrencyChange,
  deriveScheduleSearchContext,
} from './countryContext'

function schedule(
  id: string,
  date: string,
  countryCode?: string,
): Pick<Schedule, 'id' | 'date' | 'location'> {
  return {
    id,
    date,
    ...(countryCode ? {
      location: {
        status: 'resolved' as const,
        place: {
          provider: 'geoapify' as const,
          providerPlaceId: `place-${id}`,
          name: id,
          lat: 35,
          lng: 139,
          timeZone: 'Asia/Tokyo',
          countryCode,
        },
      },
    } : {}),
  }
}

describe('trip country context', () => {
  test('uses currency only as the initial country suggestion', () => {
    expect(currencyCountrySuggestion('JPY')).toBe('JP')
    expect(currencyCountrySuggestion('TWD')).toBe('TW')
    expect(currencyCountrySuggestion('USD')).toBeUndefined()
  })

  test('preserves a manually selected country when currency changes', () => {
    expect(countryAfterCurrencyChange('JP', 'KRW', false)).toBe('KR')
    expect(countryAfterCurrencyChange('TW', 'KRW', true)).toBe('TW')
    expect(countryAfterCurrencyChange('JP', 'USD', false)).toBe('')
  })

  test('uses the single resolved country on the form date', () => {
    expect(deriveScheduleSearchContext({
      date: '2026-07-20',
      schedules: [schedule('a', '2026-07-20', 'JP'), schedule('b', '2026-07-20', 'JP')],
      defaultCountryCode: 'TW',
    })).toEqual({ biasCountryCode: 'JP', normalizationCountryCode: 'JP' })
  })

  test('falls back to the trip country when that date has no resolved place', () => {
    expect(deriveScheduleSearchContext({
      date: '2026-07-21',
      schedules: [schedule('a', '2026-07-20', 'JP'), schedule('b', '2026-07-21')],
      defaultCountryCode: 'TW',
    })).toEqual({ biasCountryCode: 'TW', normalizationCountryCode: 'TW' })
  })

  test('keeps only weak trip bias for a mixed-country date', () => {
    expect(deriveScheduleSearchContext({
      date: '2026-07-20',
      schedules: [schedule('a', '2026-07-20', 'JP'), schedule('b', '2026-07-20', 'KR')],
      defaultCountryCode: 'TW',
    })).toEqual({ biasCountryCode: 'TW' })
  })

  test('excludes the schedule being edited so its old place cannot bias its replacement', () => {
    expect(deriveScheduleSearchContext({
      date: '2026-07-20',
      schedules: [schedule('editing', '2026-07-20', 'KR'), schedule('other', '2026-07-20', 'JP')],
      defaultCountryCode: 'TW',
      excludeScheduleId: 'editing',
    })).toEqual({ biasCountryCode: 'JP', normalizationCountryCode: 'JP' })
  })
})
