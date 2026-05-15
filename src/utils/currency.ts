// src/utils/currency.ts
// Currency registry + amount formatter. Used by every place that
// displays trip-scoped money (expenses, expense form, settlement,
// schedule cost chips, trip header total). The trip's currency code
// is stored on the Trip doc (`trip.currency`) and propagated via
// useTripCurrency() so individual components don't have to thread it
// through props.
//
// Symbols are hard-coded rather than derived from Intl.NumberFormat
// because the Intl output depends on locale (e.g. `Intl.NumberFormat
// ('zh-TW', { style: 'currency', currency: 'TWD' })` gives `$1,234`,
// which collides with USD's `$`). Picking a single symbol per code
// keeps the rendered amount unambiguous across locales.

export interface CurrencyMeta {
  code:   string   // ISO 4217
  symbol: string   // Prefix shown next to the amount
  label:  string   // User-facing label in the picker (Japanese)
}

// Picked for the realistic destinations of this app's user base — East
// + Southeast Asia travel from Taiwan / Japan / Hong Kong, plus the
// common reserve currencies. Add more as needed; the lookup degrades
// gracefully (unknown code falls back to "{CODE} {amount}").
const REGISTRY: Record<string, CurrencyMeta> = {
  JPY: { code: 'JPY', symbol: '¥',   label: '日本円 (JPY)'    },
  TWD: { code: 'TWD', symbol: 'NT$', label: '新台幣 (TWD)'    },
  USD: { code: 'USD', symbol: '$',   label: '米ドル (USD)'    },
  EUR: { code: 'EUR', symbol: '€',   label: 'ユーロ (EUR)'    },
  KRW: { code: 'KRW', symbol: '₩',   label: '韓国ウォン (KRW)' },
  CNY: { code: 'CNY', symbol: 'CN¥', label: '人民元 (CNY)'    },
  HKD: { code: 'HKD', symbol: 'HK$', label: '香港ドル (HKD)'   },
  THB: { code: 'THB', symbol: '฿',   label: 'タイバーツ (THB)' },
  SGD: { code: 'SGD', symbol: 'S$',  label: 'シンガポール (SGD)' },
  GBP: { code: 'GBP', symbol: '£',   label: 'ポンド (GBP)'    },
  AUD: { code: 'AUD', symbol: 'A$',  label: '豪ドル (AUD)'    },
  PHP: { code: 'PHP', symbol: '₱',   label: 'フィリピン (PHP)' },
  VND: { code: 'VND', symbol: '₫',   label: 'ベトナム (VND)'  },
  MYR: { code: 'MYR', symbol: 'RM',  label: 'マレーシア (MYR)' },
  IDR: { code: 'IDR', symbol: 'Rp',  label: 'インドネシア (IDR)' },
}

/** Ordered list for the picker dropdown. JPY first (most-used in this
 *  app's demo trips); then East Asia → ASEAN → Western. */
export const CURRENCY_OPTIONS: CurrencyMeta[] = [
  REGISTRY.JPY!, REGISTRY.TWD!, REGISTRY.USD!, REGISTRY.EUR!,
  REGISTRY.KRW!, REGISTRY.CNY!, REGISTRY.HKD!, REGISTRY.THB!,
  REGISTRY.SGD!, REGISTRY.GBP!, REGISTRY.AUD!, REGISTRY.PHP!,
  REGISTRY.VND!, REGISTRY.MYR!, REGISTRY.IDR!,
]

/** Default when a trip has no currency set (legacy data, demo fallback,
 *  loading state). Matches the historical hardcoded ¥. */
export const DEFAULT_CURRENCY = 'JPY'

/** Symbol-only lookup — for placeholders / input prefixes where the
 *  amount renders separately. Unknown codes return the code itself so
 *  the UI never silently shows an empty prefix. */
export function currencySymbol(code: string | undefined): string {
  if (!code) return REGISTRY[DEFAULT_CURRENCY]!.symbol
  return REGISTRY[code]?.symbol ?? code + ' '
}

/** Full "{symbol}{amount}" with thousands separator. Amounts are
 *  integers throughout the app (the form layer enforces it), so no
 *  fractional digits are emitted. Adding fractional support later
 *  would only require swapping `.toLocaleString()` with an Intl
 *  formatter using the currency's expected fractionDigits. */
export function formatAmount(amount: number, code: string | undefined): string {
  return `${currencySymbol(code)}${amount.toLocaleString()}`
}
