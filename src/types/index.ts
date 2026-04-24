// src/types/index.ts
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'

// ─── Firestore 資料模型 ───────────────────────────────────────────
// trips/{tripId}
export interface Trip {
  id: string
  title: string
  destination: string
  icon?: string             // Single emoji for the trip tile; default '✈️'
  coverImage?: string
  startDate: Timestamp
  endDate: Timestamp
  currency: string          // 'TWD' | 'JPY' | 'USD' ...
  ownerId: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

// trips/{tripId}/members/{memberId}
export interface Member {
  id: string
  tripId: string
  userId: string
  displayName: string
  avatarUrl?: string
  role: 'owner' | 'editor' | 'viewer'
  joinedAt: Timestamp
  /**
   * Populated when the member doc was created via invite redemption. Carries
   * the token used so Firestore rules can verify the matching invite exists
   * at create time. Kept post-commit as an audit trail.
   */
  inviteToken?: string
}

// trips/{tripId}/invites/{token}
// Doc-id is the token itself (32-byte crypto random, hex-encoded → 64 chars).
// Knowing the full path IS the authentication — the get rule is isSignedIn()
// only. tripTitle/tripIcon are snapshotted at create time so the redeemer can
// see which trip they're joining before membership is granted (the /trips/{id}
// get rule requires membership, which they don't have yet).
//
// Semantics: the doc's EXISTENCE is the only validity gate. Any number of
// users can redeem while the doc lives and expiresAt is in the future. Owner
// invalidates by deleting (directly, or implicitly via createInvite which
// clears existing invites before writing the new one).
export interface Invite {
  id: string
  tripId: string
  tripTitle: string
  tripIcon: string
  role: 'editor' | 'viewer'
  createdBy: string
  createdAt: Timestamp
  expiresAt: Timestamp
}

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

// trips/{tripId}/expenses/{expenseId}
export interface ExpenseSplit {
  memberId: string
  amount:   number          // 該成員實際分攤金額
}

export interface Expense {
  id: string
  tripId: string
  title: string
  amount: number            // 總額
  currency: string
  category: ExpenseCategory
  paidBy: string            // memberId
  splits: ExpenseSplit[]    // sum(splits.amount) === amount
  date: string              // 'YYYY-MM-DD'
  receiptUrl?: string
  note?: string
  createdBy: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type ExpenseCategory =
  | 'food'
  | 'transport'
  | 'accommodation'
  | 'activity'
  | 'shopping'
  | 'other'

// trips/{tripId}/journals/{journalId}
export interface Journal {
  id: string
  tripId: string
  date: string
  title: string
  content: string           // markdown
  images: string[]          // storage URLs
  authorId: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

// trips/{tripId}/bookings/{bookingId}
export interface Booking {
  id: string
  tripId: string
  type: 'flight' | 'hotel' | 'train' | 'bus' | 'other'
  title: string
  confirmationCode?: string
  provider?: string
  checkIn?: string          // ISO datetime
  checkOut?: string
  fileUrl?: string
  note?: string
  createdAt: Timestamp
}

// ─── Zod Schemas (表單驗證) ───────────────────────────────────────
export const CreateTripSchema = z.object({
  title:       z.string().min(1, '請輸入行程名稱').max(50),
  destination: z.string().min(1, '請輸入目的地'),
  icon:        z.string().optional(),
  startDate:   z.string().min(1, '請選擇開始日期'),
  endDate:     z.string().min(1, '請選擇結束日期'),
  currency:    z.string().default('TWD'),
})
export type CreateTripInput = z.infer<typeof CreateTripSchema>

export const CreateScheduleSchema = z.object({
  title:         z.string().min(1, '請輸入行程標題').max(100),
  date:          z.string().min(1),
  startTime:     z.string().optional(),
  endTime:       z.string().optional(),
  category:      z.enum(['transport','accommodation','food','activity','shopping','other']),
  description:   z.string().optional(),
  estimatedCost: z.coerce.number().min(0).optional(),
  location:      z.object({
    name:    z.string().min(1),
    address: z.string().optional(),
    lat:     z.number().optional(),
    lng:     z.number().optional(),
    placeId: z.string().optional(),
  }).optional(),
})
export type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>

// ─── Firestore 讀取驗證 ───────────────────────────────────────────
// Timestamp 用 duck-type 判斷（避免 runtime import firebase class）
const TimestampSchema = z.custom<Timestamp>(
  v => v != null && typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function',
  { message: 'Expected Firestore Timestamp' },
)

export const ScheduleLocationSchema = z.object({
  name:    z.string(),
  address: z.string().optional(),
  lat:     z.number().optional(),
  lng:     z.number().optional(),
  placeId: z.string().optional(),
})

/** 驗證從 Firestore 讀回的 trip doc（不含 id，id 另外合併） */
export const TripDocSchema = z.object({
  title:       z.string().min(1),
  destination: z.string(),
  icon:        z.string().optional(),
  coverImage:  z.string().optional(),
  startDate:   TimestampSchema,
  endDate:     TimestampSchema,
  currency:    z.string(),
  ownerId:     z.string().min(1),
  createdAt:   TimestampSchema,
  updatedAt:   TimestampSchema,
})

/** 驗證從 Firestore 讀回的 schedule doc（不含 id，id 另外合併） */
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
  estimatedCost: z.number().optional(),
  createdBy:     z.string(),
  createdAt:     TimestampSchema,
  updatedAt:     TimestampSchema,
})

/** 驗證從 Firestore 讀回的 member doc（不含 id） */
export const MemberDocSchema = z.object({
  tripId:      z.string(),
  userId:      z.string(),
  displayName: z.string().min(1),
  avatarUrl:   z.string().optional(),
  role:        z.enum(['owner', 'editor', 'viewer']),
  joinedAt:    TimestampSchema,
  inviteToken: z.string().optional(),
})

/**
 * 驗證從 Firestore 讀回的 invite doc（不含 id；id 即 token）.
 * Legacy one-shot fields (consumed/consumedBy/consumedAt) may still exist on
 * old docs written before the reusable-link migration; `.passthrough()` keeps
 * the zod parse forgiving so those extras don't reject parsing.
 */
export const InviteDocSchema = z.object({
  tripId:    z.string(),
  tripTitle: z.string(),
  tripIcon:  z.string(),
  role:      z.enum(['editor', 'viewer']),
  createdBy: z.string(),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
}).passthrough()

export const ExpenseSplitSchema = z.object({
  memberId: z.string().min(1),
  amount:   z.number().nonnegative(),
})

export const CreateExpenseSchema = z.object({
  title:    z.string().min(1, '請輸入標題').max(100),
  amount:   z.coerce.number().positive('金額必須大於 0'),
  currency: z.string().default('JPY'),
  category: z.enum(['food','transport','accommodation','activity','shopping','other']),
  paidBy:   z.string().min(1, '請選擇付款人'),
  splits:   z.array(ExpenseSplitSchema).min(1, '至少需選擇一位分攤人'),
  date:     z.string().min(1, '請選擇日期'),
  note:     z.string().optional(),
}).refine(
  data => Math.abs(data.splits.reduce((s, x) => s + x.amount, 0) - data.amount) < 0.01,
  { message: '分攤金額總和需等於總額', path: ['splits'] },
)
export type CreateExpenseInput = z.infer<typeof CreateExpenseSchema>

/** 驗證從 Firestore 讀回的 expense doc（不含 id） */
export const ExpenseDocSchema = z.object({
  tripId:     z.string(),
  title:      z.string(),
  amount:     z.number(),
  currency:   z.string(),
  category:   z.enum(['food','transport','accommodation','activity','shopping','other']),
  paidBy:     z.string(),
  splits:     z.array(ExpenseSplitSchema),
  date:       z.string(),
  receiptUrl: z.string().optional(),
  note:       z.string().optional(),
  createdBy:  z.string(),
  createdAt:  TimestampSchema,
  updatedAt:  TimestampSchema,
})

/**
 * 驗證從 Firestore 讀回的 booking doc（不含 id）.
 * `type` 限制在現行支援集合，未來擴充時需同步擴表。
 */
export const BookingDocSchema = z.object({
  tripId:           z.string(),
  type:             z.enum(['flight', 'hotel', 'train', 'bus', 'other']),
  title:            z.string(),
  confirmationCode: z.string().optional(),
  provider:         z.string().optional(),
  checkIn:          z.string().optional(),
  checkOut:         z.string().optional(),
  fileUrl:          z.string().optional(),
  note:             z.string().optional(),
  createdAt:        TimestampSchema,
})
