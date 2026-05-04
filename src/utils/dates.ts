// src/utils/dates.ts
// Shared date helpers. The whole codebase uses a single timezone convention:
// trip/schedule/expense dates are stored as "local midnight" Firestore
// Timestamps, and displayed/edited as local 'YYYY-MM-DD' strings. Mixing
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

/**
 * Build a Firestore Timestamp at local midnight for a 'YYYY-MM-DD' string.
 * The Timestamp factory is injected so this helper stays bundle-neutral —
 * callers pass the one from `getFirebase()`. Using this keeps all trip-
 * date writes aligned on the local-midnight convention.
 */
export function toLocalMidnightTimestamp<T>(
  dateStr: string,
  TimestampCtor: { fromDate: (d: Date) => T },
): T {
  return TimestampCtor.fromDate(fromLocalDateString(dateStr))
}

/**
 * Inclusive day count between two local-midnight Timestamps. The Timestamps
 * share the same time-of-day so a fixed 86,400,000 ms divisor is exact —
 * no DST drift within a single trip's date range.
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
