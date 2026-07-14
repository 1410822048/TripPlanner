// src/types/planning.ts
// Pre-trip planning checklist grouped by category. The item content is
// shared, while completion state is tracked per member so each traveler can
// prepare independently.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { TimestampSchema } from './_shared'

/**
 * UI groups items by these categories. Order in the list view matches
 * the enum order below — most "I might forget this" items first.
 */
export type PlanCategory =
  | 'essentials'   // 必備：護照、現金、手機
  | 'documents'    // 予約確認：機票 / 飯店 / 簽證 / 保險
  | 'packing'      // 行李清單：衣物 / 充電器 / 盥洗用品
  | 'todo'         // 行前 todo：換錢、停水、寄信
  | 'other'        // 其他

// trips/{tripId}/planning/{itemId}
export interface PlanItem {
  id: string
  tripId: string
  category: PlanCategory
  title: string
  note?: string         // optional details (size / 數量 / 提醒)
  /** Map of uid -> completion timestamp. A member can only toggle their
   *  own key; rules reject writes that touch another member's progress. */
  completedBy: Record<string, Timestamp>
  createdBy: string
  /** Last-writer uid (incl. toggleDone). See useFeatureBadges. */
  updatedBy: string
  /** Denormalised member uids — drives the same-doc read rule. See
   *  trip.memberIds for rationale. */
  memberIds: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

export const PlanItemDocSchema = z.object({
  tripId:    z.string(),
  category:  z.enum(['essentials', 'documents', 'packing', 'todo', 'other']),
  title:     z.string(),
  note:      z.string().optional(),
  completedBy: z.record(z.string().min(1), TimestampSchema),
  createdBy: z.string(),
  updatedBy: z.string(),
  memberIds: z.array(z.string().min(1)).min(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})

export const CreatePlanItemSchema = z.object({
  category: z.enum(['essentials', 'documents', 'packing', 'todo', 'other']),
  title:    z.string().min(1, '請輸入標題').max(100),
  note:     z.string().max(500).optional(),
})
export type CreatePlanItemInput = z.infer<typeof CreatePlanItemSchema>

/** Update payload — fields optional, per-field rules still enforced. */
export const UpdatePlanItemSchema = CreatePlanItemSchema.partial()
export type UpdatePlanItemInput = z.infer<typeof UpdatePlanItemSchema>
