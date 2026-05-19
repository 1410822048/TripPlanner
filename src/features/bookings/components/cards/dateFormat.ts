// src/features/bookings/components/cards/dateFormat.ts
// Booking-card-specific date formatters. Kept here (not in utils/dates.ts)
// because the format is opinionated — it includes a Japanese weekday in
// parentheses (e.g. `05/15 (土)`) which only makes sense for booking
// cards' compact date strip. Schedule / expense pages use different
// formats and shouldn't be tempted by these.
//
// Both fns return '' on missing / unparseable input so the caller can
// branch with `if (date)` instead of guarding with try/catch.
import { diffDays } from '@/utils/dates'

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

/** Number of nights between hotel check-in / check-out ISO datetimes.
 *  checkIn / checkOut are full ISO ('YYYY-MM-DDTHH:mm'); we strip to
 *  the date portion so a 15:00 -> 11:00 stay correctly registers as 1
 *  night (raw ms math would round down to 0). Returns null when
 *  either input is missing / malformed, or when the stay is same-day
 *  or reversed. */
export function nightsBetween(
  checkIn:  string | undefined,
  checkOut: string | undefined,
): number | null {
  if (!checkIn || !checkOut) return null
  const a = checkIn.slice(0, 10)
  const b = checkOut.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null
  const n = diffDays(a, b)
  return n > 0 ? n : null
}
