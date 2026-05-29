// src/utils/money.ts
// Money domain — integer minor unit conversion. All persisted /
// wire-level amounts in this app are integer minor units (¥1200 =
// 1200 minor; $12.34 = 1234 minor). Only UI and OCR ever see decimal
// strings; the boundary converts via parseMoneyToMinor (display →
// store) and formatMinorAmount (store → display).
//
// Why string input is mandatory on parse: `Number("12.34") * 100`
// returns 1233.9999999999998 — the canonical IEEE-754 trap that bit
// us before we drew the minor-unit line. parseMoneyToMinor reads the
// digits before / after the decimal point as separate integers and
// composes the result via integer arithmetic only.

import { currencySymbol, DEFAULT_CURRENCY } from './currency'

// What we persist, matching the app's existing UI convention. TWD /
// IDR are treated as zero-fraction even though official ISO 4217 says
// 2, because the app's pre-minor-units formatter rendered them with
// no decimals and we don't want to silently re-interpret persisted
// integers from before this migration.
const FRACTION_DIGITS: Record<string, number> = {
  JPY: 0, TWD: 0, KRW: 0, VND: 0, IDR: 0,
  USD: 2, EUR: 2, CNY: 2, HKD: 2, THB: 2,
  SGD: 2, GBP: 2, AUD: 2, PHP: 2, MYR: 2,
}

/** Digits of fractional precision for an ISO 4217 code. Unknown
 *  codes default to 2, matching the worldwide majority. */
export function currencyFractionDigits(code: string | undefined): number {
  if (!code) return FRACTION_DIGITS[DEFAULT_CURRENCY]!
  return FRACTION_DIGITS[code] ?? 2
}

// Structured reason so callers (form modals, OCR import) can show the
// specific failure mode instead of a generic "請輸入金額". Adding a new
// reason here is safe — UI mappers only switch on these, no string
// matching anywhere.
export type MoneyParseErrorReason =
  | 'EMPTY'
  | 'MALFORMED'
  | 'DECIMALS_FORBIDDEN'
  | 'TOO_MANY_DECIMALS'
  | 'OUT_OF_RANGE'
  | 'EXPECTED_STRING'

export class MoneyParseError extends Error {
  text: string
  code: string
  reason: MoneyParseErrorReason
  constructor(text: string, code: string, reason: MoneyParseErrorReason) {
    super(`parseMoneyToMinor("${text}", "${code}"): ${reason}`)
    this.name = 'MoneyParseError'
    this.text = text
    this.code = code
    this.reason = reason
  }
}

// Result-style wrapper for callers that need to branch on reason
// without try/catch — typically form preview / submit-validation paths
// that re-derive on every keystroke.
export type MoneyParseResult =
  | { ok: true;  value: number }
  | { ok: false; reason: MoneyParseErrorReason }

export function parseMoneyToMinorResult(text: string, code: string): MoneyParseResult {
  try {
    return { ok: true, value: parseMoneyToMinor(text, code) }
  } catch (error) {
    if (error instanceof MoneyParseError) {
      return { ok: false, reason: error.reason }
    }
    throw error
  }
}

// Strict grammar (applied AFTER stripping grouping separators in
// parseMoneyToMinor):
//   <optional sign> <one-or-more digits> ( "." <one-or-more digits> )?
// Rejects: empty, "12." (trailing dot), ".5" (missing whole),
// "1e3" (no exponent), "+12" (no plus).
// Accepts (via pre-strip): "1,234.56", "10，276", "10 276".
const MONEY_RE = /^(-?)(\d+)(?:\.(\d+))?$/

/** Parse a decimal money string into integer minor units.
 *  Throws MoneyParseError on malformed input or excess fractional
 *  digits for the currency.
 *
 *  Grouping separators (ASCII comma, full-width comma, inner
 *  whitespace) are stripped before regex match so receipt-style
 *  input like "1,234.56" or "10，276" round-trips. Mirrors the same
 *  normalisation the OCR Zod schema does on amountText — keeping the
 *  two boundaries symmetric prevents "OCR accepts but manual edit
 *  rejects" surprises. */
export function parseMoneyToMinor(text: string, code: string): number {
  if (typeof text !== 'string') {
    throw new MoneyParseError(String(text), code, 'EXPECTED_STRING')
  }
  const trimmed = text.trim().replace(/[,，\s]/g, '')
  if (trimmed === '') {
    throw new MoneyParseError(text, code, 'EMPTY')
  }
  const m = MONEY_RE.exec(trimmed)
  if (!m) {
    throw new MoneyParseError(text, code, 'MALFORMED')
  }
  const [, sign, whole, fracRaw = ''] = m
  const digits = currencyFractionDigits(code)
  if (fracRaw.length > digits) {
    throw new MoneyParseError(
      text, code,
      digits === 0 ? 'DECIMALS_FORBIDDEN' : 'TOO_MANY_DECIMALS',
    )
  }
  const fracPadded = fracRaw.padEnd(digits, '0')
  const multiplier = Math.pow(10, digits)
  const wholeMinor = Number(whole) * multiplier
  const fracMinor  = digits === 0 ? 0 : Number(fracPadded)
  const magnitude  = wholeMinor + fracMinor
  if (!Number.isFinite(magnitude) || !Number.isSafeInteger(magnitude)) {
    throw new MoneyParseError(text, code, 'OUT_OF_RANGE')
  }
  return sign === '-' ? -magnitude : magnitude
}

/** Format integer minor units back to "{symbol}{integer}.{fraction}"
 *  with thousands separator on the whole part and fixed fractional
 *  width (zero-fraction currencies omit the dot). Sign sits between
 *  symbol and digits, matching the pre-minor-units display layout. */
export function formatMinorAmount(minor: number, code: string | undefined): string {
  const symbol = currencySymbol(code)
  if (!Number.isSafeInteger(minor)) {
    return `${symbol}${minor}`
  }
  const digits = currencyFractionDigits(code)
  const sign   = minor < 0 ? '-' : ''
  const abs    = Math.abs(minor)
  if (digits === 0) {
    return `${symbol}${sign}${abs.toLocaleString()}`
  }
  const divisor   = Math.pow(10, digits)
  const wholePart = Math.floor(abs / divisor)
  const fracPart  = abs % divisor
  const fracStr   = String(fracPart).padStart(digits, '0')
  return `${symbol}${sign}${wholePart.toLocaleString()}.${fracStr}`
}

/** Format integer minor units as a locale-formatted decimal string
 *  WITHOUT the currency symbol — keeps thousands separator and
 *  fractional digits. Useful where the symbol is rendered separately
 *  (e.g. the summary card on /expense splits symbol and number into
 *  different font sizes). */
export function formatMinorNumber(minor: number, code: string | undefined): string {
  if (!Number.isSafeInteger(minor)) return String(minor)
  const digits = currencyFractionDigits(code)
  const sign   = minor < 0 ? '-' : ''
  const abs    = Math.abs(minor)
  if (digits === 0) return `${sign}${abs.toLocaleString()}`
  const divisor   = Math.pow(10, digits)
  const wholePart = Math.floor(abs / divisor)
  const fracPart  = abs % divisor
  const fracStr   = String(fracPart).padStart(digits, '0')
  return `${sign}${wholePart.toLocaleString()}.${fracStr}`
}

/** Format integer minor units as a raw decimal string suitable for
 *  feeding into a CurrencyInput — no symbol, no thousands separator.
 *  Zero-fraction currencies emit "1200"; two-fraction "12.34". Used
 *  to seed form fields from persisted amountMinor values. */
export function formatMinorForInput(minor: number, code: string | undefined): string {
  if (!Number.isSafeInteger(minor)) return ''
  const digits = currencyFractionDigits(code)
  const sign   = minor < 0 ? '-' : ''
  const abs    = Math.abs(minor)
  if (digits === 0) return `${sign}${abs}`
  const divisor   = Math.pow(10, digits)
  const wholePart = Math.floor(abs / divisor)
  const fracPart  = abs % divisor
  const fracStr   = String(fracPart).padStart(digits, '0')
  return `${sign}${wholePart}.${fracStr}`
}
