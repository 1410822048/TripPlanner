import type { Schedule } from '@/types'
import { currencyCountrySuggestion } from '@/utils/country'

export interface ScheduleSearchContext {
  biasCountryCode?: string
  normalizationCountryCode?: string
}

export function countryAfterCurrencyChange(
  currentCountryCode: string,
  nextCurrency: string,
  countryWasSelected: boolean,
): string {
  if (countryWasSelected) return currentCountryCode
  return currencyCountrySuggestion(nextCurrency) ?? ''
}

interface DeriveScheduleSearchContextInput {
  date: string
  schedules: Array<Pick<Schedule, 'id' | 'date' | 'location'>>
  defaultCountryCode: string
  excludeScheduleId?: string
}

/**
 * 搜尋日期只有單一已驗證國家時，可安全套用該國語言正規化。
 * 混合國家時只保留旅程預設國家的弱偏向，絕不改寫使用者查詢。
 */
export function deriveScheduleSearchContext({
  date,
  schedules,
  defaultCountryCode,
  excludeScheduleId,
}: DeriveScheduleSearchContextInput): ScheduleSearchContext {
  const countries = new Set(
    schedules
      .filter(schedule => schedule.date === date && schedule.id !== excludeScheduleId)
      .flatMap(schedule => schedule.location?.status === 'resolved'
        ? [schedule.location.place.countryCode]
        : []),
  )

  if (countries.size === 1) {
    const countryCode = countries.values().next().value as string
    return { biasCountryCode: countryCode, normalizationCountryCode: countryCode }
  }
  if (countries.size === 0) {
    return {
      biasCountryCode: defaultCountryCode,
      normalizationCountryCode: defaultCountryCode,
    }
  }
  return { biasCountryCode: defaultCountryCode }
}
