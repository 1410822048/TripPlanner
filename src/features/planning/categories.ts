// src/features/planning/categories.ts
// Plan category → lucide icon。PlanningPage(section header)と PlanningFormModal
// (picker)でラベル文言は異なる(予約確認 / 予約 等)が、アイコンは共通なので
// ここに集約。絵文字をやめて lucide の線アイコンに統一する。
import { Backpack, FileText, Shirt, ListChecks, MapPin, type LucideIcon } from 'lucide-react'
import type { PlanCategory } from '@/types'

export const PLAN_CATEGORY_ICON: Record<PlanCategory, LucideIcon> = {
  essentials: Backpack,
  documents:  FileText,
  packing:    Shirt,
  todo:       ListChecks,
  other:      MapPin,   // 「その他」は他 feature と同様 MapPin で統一
}
