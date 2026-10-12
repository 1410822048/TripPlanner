// src/features/wish/categories.ts
// Wish 分類(景點 / 餐廳)的圖示 + 標籤集中在一處。tab(WishPage)/
// 分類 picker(WishFormModal)/ 縮圖(WishCard)都看同一份定義,
// 新增、改名分類或替換圖示一次就完成。捨棄 emoji,統一用 lucide
// 線性圖示,讓 UI 調性一致(相當於業界標準的 icon font)。
import { MapPin, Utensils, type LucideIcon } from 'lucide-react'
import type { WishCategory } from '@/types'

export interface WishCategoryMeta {
  value: WishCategory
  icon:  LucideIcon
  label: string
}

/** 顯示順序(tab / picker 的排列)。 */
export const WISH_CATEGORIES: WishCategoryMeta[] = [
  { value: 'place', icon: MapPin,   label: '景點' },
  { value: 'food',  icon: Utensils, label: '餐廳' },
]

/** category → 圖示的直接 lookup(縮圖用)。由 WISH_CATEGORIES 推導,
 *  避免雙重維護。 */
export const WISH_CATEGORY_ICON = Object.fromEntries(
  WISH_CATEGORIES.map(c => [c.value, c.icon]),
) as Record<WishCategory, LucideIcon>
