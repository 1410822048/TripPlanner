// src/features/bookings/components/cards/dateFormat.ts
// Booking-card-specific date formatters. Kept here (not in utils/dates.ts)
// because the format is opinionated — it includes a Japanese weekday in
// parentheses (e.g. `05/15 (土)`) which only makes sense for booking
// cards' compact date strip. Schedule / expense pages use different
// formats and shouldn't be tempted by these.
//
// Both fns return '' on missing / unparseable input so the caller can
// branch with `if (date)` instead of guarding with try/catch.

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'] as const

/** Extract HH:mm from an ISO datetime. '' when absent or no time part. */
export function fmtTime(s: string | undefined): string {
  if (!s || !/T\d{2}:\d{2}/.test(s)) return ''
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Compact MM/DD with Japanese weekday — `05/15 (土)`. */
export function fmtDate(s: string | undefined): string {
  if (!s) return ''
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  const wd = WEEKDAYS_JA[d.getDay()]
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} (${wd})`
}
