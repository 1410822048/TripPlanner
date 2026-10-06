// src/utils/dates.ts
// Shared date helpers. Calendar dates are displayed/edited as 'YYYY-MM-DD'
// strings. Trip start/end are stored as Timestamps at 00:00 UTC (see
// toTripDateTimestamp / tripTimestampToDateString — never read them via
// ts.toDate() + local getters, which shifts the day across timezones). Mixing
// `toISOString()` (UTC) into this chain shifts dates by one day in east-of-
// UTC locales, which is the bug these helpers exist to prevent.
//
// Everything here is pure + side-effect free. No firebase imports so this
// module stays bundle-neutral.
import type { Timestamp } from 'firebase/firestore'

/** Format a Date into local 'YYYY-MM-DD'. Use this instead of toISOString(). */
export function toLocalDateString(d: Date): string {
  const y  = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

/** Parse 'YYYY-MM-DD' into a JS Date anchored at local midnight. */
export function fromLocalDateString(s: string): Date {
  return new Date(s + 'T00:00:00')
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Parse a stored date that may be either a calendar date ('YYYY-MM-DD') or
 * a full ISO datetime. Bare `new Date(s)` reads the date-only form as UTC
 * per ECMA-262, so west-of-UTC locales render the previous day; anything
 * with a time part is a real instant and keeps the native parse.
 */
export function parseStoredDate(s: string): Date {
  return DATE_ONLY_RE.test(s) ? fromLocalDateString(s) : new Date(s)
}

/**
 * Build the Firestore Timestamp stored for a trip calendar date
 * ('YYYY-MM-DD' → that date at 00:00 UTC). The Timestamp factory is
 * injected so this helper stays bundle-neutral — callers pass the one
 * from `getFirebase()`.
 *
 * Why UTC and not local midnight: trip members (or the same person after
 * flying abroad) live in different timezones. A Taipei local-midnight
 * Timestamp read back with `toLocalDateString(ts.toDate())` in PDT is the
 * PREVIOUS day, so the whole trip range shifted by one and the last day's
 * schedules lost their day chip. Always read back with
 * `tripTimestampToDateString`.
 */
export function toTripDateTimestamp<T>(
  dateStr: string,
  TimestampCtor: { fromDate: (d: Date) => T },
): T {
  const [y, m, d] = dateStr.split('-').map(Number)
  return TimestampCtor.fromDate(new Date(Date.UTC(y!, m! - 1, d!)))
}

/**
 * Read a stored trip date Timestamp back as its calendar date
 * ('YYYY-MM-DD'), independent of the viewer's timezone.
 *
 * Handles both encodings in the database: current writes (00:00 UTC) and
 * legacy writes (00:00 in the writer's local zone, i.e. up to ±12h away
 * from UTC midnight). Rounding to the NEAREST UTC midnight (+12h, then
 * take the UTC date) maps both to the intended calendar day for any
 * writer offset in (-12h, +12h].
 */
export function tripTimestampToDateString(ts: { toMillis: () => number }): string {
  const d  = new Date(ts.toMillis() + 12 * 3_600_000)
  const y  = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

/**
 * Inclusive day count between two stored trip-date Timestamps. Rounding
 * the difference absorbs the ≤12h skew when one bound is a legacy
 * local-midnight write and the other a current UTC-midnight write.
 */
export function daysBetween(start: Timestamp, end: Timestamp): number {
  return Math.round((end.toMillis() - start.toMillis()) / 86_400_000) + 1
}

/** Inclusive date range from startDate to endDate as 'YYYY-MM-DD' strings. */
export function buildDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  const cur = fromLocalDateString(startDate)
  const end = fromLocalDateString(endDate)
  while (cur <= end) {
    dates.push(toLocalDateString(cur))
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

/**
 * Add a (possibly negative) integer number of days to a 'YYYY-MM-DD'
 * string and return the result as a 'YYYY-MM-DD' string. Used by
 * copyTrip to shift schedule dates relative to the source trip's start.
 *
 * Stays in local-midnight space (no UTC conversion) so DST transitions
 * inside a trip date range don't shift by an hour and accidentally
 * round into the previous or next day.
 */
export function addDays(dateStr: string, days: number): string {
  const d = fromLocalDateString(dateStr)
  d.setDate(d.getDate() + days)
  return toLocalDateString(d)
}

/**
 * Day delta between two 'YYYY-MM-DD' strings, exclusive of the second
 * day. `diffDays('2026-05-01', '2026-05-04') === 3`.
 *
 * Returns a signed integer — negative when `to` is earlier than `from`.
 */
export function diffDays(from: string, to: string): number {
  const a = fromLocalDateString(from).getTime()
  const b = fromLocalDateString(to).getTime()
  return Math.round((b - a) / 86_400_000)
}
