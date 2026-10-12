// src/features/planning/categories.ts
// Plan category → lucide icon。PlanningPage(section header)與 PlanningFormModal
// (picker)的標籤文案不同(預約確認 / 預約 等),但圖示共用,所以
// 集中在這裡。捨棄 emoji,統一用 lucide 線性圖示。
import { Backpack, FileText, Shirt, ListChecks, MapPin, type LucideIcon } from 'lucide-react'
import type { PlanCategory } from '@/types'

export const PLAN_CATEGORY_ICON: Record<PlanCategory, LucideIcon> = {
  essentials: Backpack,
  documents:  FileText,
  packing:    Shirt,
  todo:       ListChecks,
  other:      MapPin,   // 「其他」與其他 feature 一樣統一用 MapPin
}
