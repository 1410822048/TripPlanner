// Shared emoji mapping for expense / schedule categories.
// ScheduleCategory and ExpenseCategory share the same 6 keys; each feature
// provides its own locale-specific labels but the emoji is canonical.
import type { ExpenseCategory } from '@/types'

export type CategoryKey = ExpenseCategory   // alias — identical union to ScheduleCategory

export const CATEGORY_EMOJI: Record<CategoryKey, string> = {
  food:          '🍜',
  transport:     '🚌',
  accommodation: '🏨',
  activity:      '⛩️',
  shopping:      '🛍️',
  other:         '📌',
}
