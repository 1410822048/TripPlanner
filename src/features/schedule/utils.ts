// src/features/schedule/utils.ts
// Schedule-specific helpers. Date helpers moved to `@/utils/dates`; re-
// exported here for the few consumers that imported them from this module.
import type { Schedule } from '@/types'

export { buildDateRange } from '@/utils/dates'

/**
 * Within-day sort: items with `startTime` come first in chronological
 * order, items without `startTime` fall back to insertion order via the
 * `order` field. 'HH:mm' compares correctly as a lexicographic string,
 * so no parsing needed.
 *
 * Why client-side: the Firestore query returns rows sorted by `(date,
 * order)` — `order` is the manual rank used by future drag-to-reorder
 * UI. We override with `startTime` here so the user's typed time
 * actually drives the visible order, while keeping `order` available
 * for the day a drag-handle UI is added.
 */
function compareScheduleByTime(a: Schedule, b: Schedule): number {
  if (a.startTime && b.startTime) return a.startTime.localeCompare(b.startTime)
  if (a.startTime) return -1
  if (b.startTime) return 1
  return a.order - b.order
}

/** 將 Schedule 陣列依 date 分組，並對每組依 startTime → order 排序 */
export function groupByDate(list: Schedule[]): Record<string, Schedule[]> {
  const grouped = list.reduce<Record<string, Schedule[]>>((acc, s) => {
    ;(acc[s.date] ??= []).push(s)
    return acc
  }, {})
  for (const date of Object.keys(grouped)) {
    grouped[date]!.sort(compareScheduleByTime)
  }
  return grouped
}
