// src/features/schedule/utils.ts
// Schedule-specific helpers. Date helpers moved to `@/utils/dates`; re-
// exported here for the few consumers that imported them from this module.
import type { Schedule } from '@/types'
import { groupBy } from '@/utils/groupBy'

export { buildDateRange } from '@/utils/dates'

/**
 * Within-day sort: `order` is the single source of truth, with `id` as a
 * stable tiebreak. Route-apply rewrites `order` to reflect the optimized
 * (or manually reordered) sequence, so we don't re-sort by `startTime`
 * here — otherwise a fixed 09:00 item added after a 14:00 item would jump
 * ahead of the sequence the route deliberately produced.
 */
function compareScheduleByOrder(a: Schedule, b: Schedule): number {
  return a.order - b.order || a.id.localeCompare(b.id)
}

/** 將 Schedule 陣列依 date 分組，並對每組依 order 排序 */
export function groupByDate(list: Schedule[]): Record<string, Schedule[]> {
  const grouped = groupBy(list, s => s.date)
  for (const date of Object.keys(grouped)) {
    grouped[date]!.sort(compareScheduleByOrder)
  }
  return grouped
}
