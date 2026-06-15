// Shared icon mapping for expense / schedule categories.
// ScheduleCategory and ExpenseCategory share the same 6 keys; each feature
// provides its own locale-specific labels but the icon is canonical.
// lucide line-icons (not emoji) keep the UI tone consistent across features.
import { Utensils, Bus, Hotel, Star, ShoppingBag, MapPin, type LucideIcon } from 'lucide-react'
import type { ExpenseCategory } from '@/types'

export type CategoryKey = ExpenseCategory   // alias — identical union to ScheduleCategory

// 既存の schedule タイムライン(TimelineCard)が使っていたアイコンに合わせる
// ことで、リスト表示とフォーム picker のアイコンが一致する。
export const CATEGORY_ICON: Record<CategoryKey, LucideIcon> = {
  food:          Utensils,
  transport:     Bus,
  accommodation: Hotel,
  activity:      Star,
  shopping:      ShoppingBag,
  other:         MapPin,
}
