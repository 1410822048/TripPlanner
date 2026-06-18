// Shared icon mapping for expense / schedule categories.
// ScheduleCategory and ExpenseCategory share the same 6 keys; each feature
// uses the same canonical icon. Schedule also shares list/detail labels
// and soft colors here so card + sheet styling cannot drift.
// lucide line-icons (not emoji) keep the UI tone consistent across features.
import { Utensils, Bus, Hotel, Star, ShoppingBag, MapPin, type LucideIcon } from 'lucide-react'
import type { ExpenseCategory, ScheduleCategory } from '@/types'

export type CategoryKey = ExpenseCategory | ScheduleCategory

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

export const SCHEDULE_CATEGORY_LABEL: Record<ScheduleCategory, string> = {
  transport:     '交通',
  accommodation: '住宿',
  food:          '餐廳',
  activity:      '活動',
  shopping:      '購物',
  other:         '其他',
}

export const SCHEDULE_CATEGORIES: { value: ScheduleCategory; label: string }[] = [
  { value: 'transport',     label: SCHEDULE_CATEGORY_LABEL.transport },
  { value: 'accommodation', label: SCHEDULE_CATEGORY_LABEL.accommodation },
  { value: 'food',          label: SCHEDULE_CATEGORY_LABEL.food },
  { value: 'activity',      label: SCHEDULE_CATEGORY_LABEL.activity },
  { value: 'shopping',      label: SCHEDULE_CATEGORY_LABEL.shopping },
  { value: 'other',         label: SCHEDULE_CATEGORY_LABEL.other },
]

export const SCHEDULE_CATEGORY_STYLE: Record<ScheduleCategory, { bg: string; color: string }> = {
  transport:     { bg:'#E8EEF5', color:'#4A6FA0' },
  accommodation: { bg:'#F5EDE6', color:'#9A6840' },
  food:          { bg:'#F5E8E8', color:'#9A4848' },
  activity:      { bg:'#E6F2EC', color:'#3A7858' },
  shopping:      { bg:'#F0E8F5', color:'#724888' },
  other:         { bg:'#EBEBEB', color:'#707070' },
}
