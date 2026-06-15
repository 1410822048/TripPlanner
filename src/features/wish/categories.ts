// src/features/wish/categories.ts
// Wish 分類(景點 / 餐廳)のアイコン + ラベルを 1 か所に集約。tab(WishPage)/
// カテゴリ picker(WishFormModal)/ サムネ(WishCard)が同じ定義を見るので、
// 分類の追加・改名・アイコン差し替えが一括で済む。絵文字をやめて lucide の
// 線アイコンに統一し、UI トーンを揃える(業界標準のアイコンフォント相当)。
import { MapPin, Utensils, type LucideIcon } from 'lucide-react'
import type { WishCategory } from '@/types'

export interface WishCategoryMeta {
  value: WishCategory
  icon:  LucideIcon
  label: string
}

/** 表示順(tab / picker の並び)。 */
export const WISH_CATEGORIES: WishCategoryMeta[] = [
  { value: 'place', icon: MapPin,   label: '景點' },
  { value: 'food',  icon: Utensils, label: '餐廳' },
]

/** category → アイコンの直接 lookup(サムネ用)。WISH_CATEGORIES から導出して
 *  二重管理を避ける。 */
export const WISH_CATEGORY_ICON = Object.fromEntries(
  WISH_CATEGORIES.map(c => [c.value, c.icon]),
) as Record<WishCategory, LucideIcon>
