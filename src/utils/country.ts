export interface CountryOption {
  code: string
  label: string
}

/** 目前產品支援的旅遊市場。值一律是 ISO 3166-1 alpha-2。 */
export const COUNTRY_OPTIONS: readonly CountryOption[] = [
  { code: 'JP', label: '日本' },
  { code: 'TW', label: '台灣' },
  { code: 'KR', label: '韓國' },
  { code: 'CN', label: '中國' },
  { code: 'HK', label: '香港' },
  { code: 'MO', label: '澳門' },
  { code: 'TH', label: '泰國' },
  { code: 'SG', label: '新加坡' },
  { code: 'MY', label: '馬來西亞' },
  { code: 'ID', label: '印尼' },
  { code: 'PH', label: '菲律賓' },
  { code: 'VN', label: '越南' },
  { code: 'AU', label: '澳洲' },
  { code: 'GB', label: '英國' },
  { code: 'US', label: '美國' },
  { code: 'CA', label: '加拿大' },
] as const

const CURRENCY_COUNTRY: Readonly<Record<string, string>> = {
  JPY: 'JP',
  TWD: 'TW',
  KRW: 'KR',
  CNY: 'CN',
  HKD: 'HK',
  THB: 'TH',
  SGD: 'SG',
  MYR: 'MY',
  IDR: 'ID',
  PHP: 'PH',
  VND: 'VN',
  AUD: 'AU',
  GBP: 'GB',
}

export function currencyCountrySuggestion(currency: string): string | undefined {
  return CURRENCY_COUNTRY[currency.toUpperCase()]
}
