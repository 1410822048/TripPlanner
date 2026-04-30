// src/types/trip.ts
// Trip entity + members + invites. All three are tightly coupled (a member
// belongs to a trip, an invite redeems into a member), so they live in the
// same file rather than splintering further.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { TimestampSchema } from './_shared'

// ─── Trip ─────────────────────────────────────────────────────────
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

export const CreateTripSchema = z.object({
  title:       z.string().min(1, '請輸入行程名稱').max(50),
  destination: z.string().min(1, '請輸入目的地'),
  icon:        z.string().optional(),
  startDate:   z.string().min(1, '請選擇開始日期'),
  endDate:     z.string().min(1, '請選擇結束日期'),
  currency:    z.string().default('TWD'),
})
export type CreateTripInput = z.infer<typeof CreateTripSchema>

/** Update payload — fields optional, per-field rules still enforced. */
export const UpdateTripSchema = CreateTripSchema.partial()
export type UpdateTripInput = z.infer<typeof UpdateTripSchema>

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

// ─── Member ───────────────────────────────────────────────────────
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

export const MemberDocSchema = z.object({
  tripId:      z.string(),
  userId:      z.string(),
  displayName: z.string().min(1),
  avatarUrl:   z.string().optional(),
  role:        z.enum(['owner', 'editor', 'viewer']),
  joinedAt:    TimestampSchema,
  inviteToken: z.string().optional(),
})

// ─── Invite ───────────────────────────────────────────────────────
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

/**
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
