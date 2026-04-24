// src/features/schedule/utils.ts
// Schedule-specific helpers. Date helpers moved to `@/utils/dates`; re-
// exported here for the few consumers that imported them from this module.
import type { Schedule } from '@/types'

export { buildDateRange } from '@/utils/dates'

/** 將 Schedule 陣列依 date 分組 */
export function groupByDate(list: Schedule[]): Record<string, Schedule[]> {
  return list.reduce<Record<string, Schedule[]>>((acc, s) => {
    ;(acc[s.date] ??= []).push(s)
    return acc
  }, {})
}
