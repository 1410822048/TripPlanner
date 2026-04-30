// src/types/planning.ts
// Pre-trip planning checklist — collaborative to-do list grouped by
// category. Members add items (passport, charger, currency exchange,
// etc.) and tick them off as preparation progresses. The whole list is
// shared; any member can add / edit / toggle / delete.
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
  done: boolean         // shared checkbox state — anyone can toggle
  /** uid of who last toggled `done`. Resets on toggle so it always
   *  reflects "the most recent person to touch this row". */
  doneBy?: string
  doneAt?: Timestamp
  createdBy: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

export const PlanItemDocSchema = z.object({
  tripId:    z.string(),
  category:  z.enum(['essentials', 'documents', 'packing', 'todo', 'other']),
  title:     z.string(),
  note:      z.string().optional(),
  done:      z.boolean(),
  doneBy:    z.string().optional(),
  doneAt:    TimestampSchema.optional(),
  createdBy: z.string(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})

export const CreatePlanItemSchema = z.object({
  category: z.enum(['essentials', 'documents', 'packing', 'todo', 'other']),
  title:    z.string().min(1, 'タイトルを入力してください').max(100),
  note:     z.string().max(500).optional(),
})
export type CreatePlanItemInput = z.infer<typeof CreatePlanItemSchema>

/** Update payload — fields optional, per-field rules still enforced. */
export const UpdatePlanItemSchema = CreatePlanItemSchema.partial()
export type UpdatePlanItemInput = z.infer<typeof UpdatePlanItemSchema>
