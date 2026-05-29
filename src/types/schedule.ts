// src/types/schedule.ts
// Schedule = a single timeline entry for a day of a trip.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { TimestampSchema } from './_shared'

// trips/{tripId}/schedules/{scheduleId}
export interface Schedule {
  id: string
  tripId: string
  date: string              // 'YYYY-MM-DD'
  order: number
  title: string
  description?: string
  location?: ScheduleLocation
  startTime?: string        // 'HH:mm'
  endTime?: string
  category: ScheduleCategory
  estimatedCost?: number
  createdBy: string
  /** Last-writer uid. See useFeatureBadges. */
  updatedBy: string
  /** Denormalised member uids — drives the same-doc read rule
   *  `allow read: if request.auth.uid in resource.data.memberIds`.
   *  Synced by Worker membership endpoints on membership changes. */
  memberIds: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface ScheduleLocation {
  name: string
  address?: string
  lat?: number
  lng?: number
  placeId?: string
}

export type ScheduleCategory =
  | 'transport'
  | 'accommodation'
  | 'food'
  | 'activity'
  | 'shopping'
  | 'other'

export const ScheduleLocationSchema = z.object({
  name:    z.string(),
  address: z.string().optional(),
  lat:     z.number().optional(),
  lng:     z.number().optional(),
  placeId: z.string().optional(),
})

export const CreateScheduleSchema = z.object({
  title:         z.string().min(1, '請輸入行程標題').max(100),
  date:          z.string().min(1),
  startTime:     z.string().optional(),
  endTime:       z.string().optional(),
  category:      z.enum(['transport','accommodation','food','activity','shopping','other']),
  description:   z.string().optional(),
  // 1B major-units sanity cap (mirrors expense.amount). Above this is
  // corruption / typo, not a real cost estimate; rules layer also gates.
  estimatedCost: z.coerce.number().finite().min(0).max(1_000_000_000).optional(),
  location:      z.object({
    name:    z.string().min(1),
    address: z.string().optional(),
    lat:     z.number().optional(),
    lng:     z.number().optional(),
    placeId: z.string().optional(),
  }).optional(),
})
export type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>

/** Update payload — fields optional, per-field rules still enforced. */
export const UpdateScheduleSchema = CreateScheduleSchema.partial()
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleSchema>

export const ScheduleDocSchema = z.object({
  tripId:        z.string(),
  date:          z.string(),
  order:         z.number(),
  title:         z.string(),
  description:   z.string().optional(),
  location:      ScheduleLocationSchema.optional(),
  startTime:     z.string().optional(),
  endTime:       z.string().optional(),
  category:      z.enum(['transport','accommodation','food','activity','shopping','other']),
  estimatedCost: z.number().finite().min(0).max(1_000_000_000).optional(),
  createdBy:     z.string(),
  updatedBy:     z.string(),
  memberIds:     z.array(z.string().min(1)).min(1),
  createdAt:     TimestampSchema,
  updatedAt:     TimestampSchema,
})
