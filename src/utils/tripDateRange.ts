/** Inclusive calendar-day limit; keep firestore.rules in sync. */
export const MAX_TRIP_DAYS = 366
const DAY_MS = 86_400_000
export const TRIP_DATE_RANGE_MESSAGE = `旅程最多 ${MAX_TRIP_DAYS} 天`

export function calendarDateMs(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return NaN
  const ms = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : NaN
}

export function validTripSpan(startMs: number, endMs: number): boolean {
  return Number.isFinite(startMs) && Number.isFinite(endMs)
    && endMs >= startMs && endMs - startMs <= (MAX_TRIP_DAYS - 1) * DAY_MS
}

export function tripDateRangeError(start: string, end: string): string | null {
  const from = calendarDateMs(start)
  const to = calendarDateMs(end)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '請輸入有效日期'
  if (to < from) return '結束日期不可早於開始日期'
  return validTripSpan(from, to) ? null : TRIP_DATE_RANGE_MESSAGE
}
