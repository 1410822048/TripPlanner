// src/types/trip.ts
// Trip entity + members + invites. All three are tightly coupled (a member
// belongs to a trip, an invite redeems into a member), so they live in the
// same file rather than splintering further.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'
import { TimestampSchema } from './_shared'

// Per-tab unread-dot key. Mirrors BadgeFeature in lastViewedStore;
// kept identical so the trip-doc aggregate (lastActivityByFeature)
// can be indexed by the same keys clients use to render dots.
export type ActivityFeature = 'schedule' | 'expense' | 'bookings' | 'wish' | 'planning'

/** Per-feature "last activity" stamp denormalised onto the trip doc.
 *  Powers the bottom-nav unread-dot badge WITHOUT mounting per-entity
 *  listeners — useFeatureBadges reads this single field instead of
 *  scanning 5 subcollections for max(updatedAt). `by` is the uid that
 *  caused the bump; useFeatureBadges filters own writes by checking
 *  `by === currentUid`. */
export interface ActivityStamp {
  ts: Timestamp
  by: string
}

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
  /**
   * Denormalised list of all member uids. Mirrored from
   * /trips/{id}/members/* and updated by Worker membership endpoints
   * on every membership change. Drives the read rules — `allow get / list:
   * if request.auth.uid in resource.data.memberIds` — so rules
   * evaluate against THIS doc only, not a cross-document exists()
   * lookup. Eliminates the rules-eval propagation lag window that
   * used to 403 listeners right after a fresh batch.commit.
   *
   * Sync invariants:
   *   - createTrip seeds with [ownerUid]
   *   - acceptInvite appends invitee uid
   *   - removeMember strips removed uid
   *   - deleteTrip removes the whole doc; no cleanup needed
   */
  memberIds: string[]
  /**
   * Per-feature "last activity" stamps. Drives the bottom-nav unread-
   * dot badge — see useFeatureBadges. Each service mutation calls
   * bumpTripActivity() best-effort after the main write to update the
   * matching feature key. Optional for backward-compat with trip docs
   * created before this field existed; missing → no badge.
   */
  lastActivityByFeature?: Partial<Record<ActivityFeature, ActivityStamp>>
  /**
   * Cascade write-quiesce marker. The Worker `/cascade-trip-delete`
   * endpoint stamps this with a server Timestamp BEFORE it starts
   * deleting subcollections, so any in-flight editor on another
   * device sees their `setDoc(.../subcollection/NEW)` reject at the
   * rules layer (rules add `tripNotDeleting(tripId)` to every
   * subcollection CREATE). Without this flag, an editor could
   * create a new expense between the Worker's expense-drain and
   * trip-doc-delete steps, producing an orphan that subsequent
   * cascade retries skip (idempotent no-op on missing trip doc).
   *
   * Write-only by admin SDK (the Worker). Client rules enforce
   * `unchanged('deletingAt')` on every trip update path so editors
   * can't either set or clear the flag themselves. The field dies
   * with the trip doc at end of cascade.
   */
  deletingAt?: Timestamp | null
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

const ActivityStampSchema = z.object({
  ts: TimestampSchema,
  by: z.string(),
})

export const TripDocSchema = z.object({
  title:       z.string().min(1),
  destination: z.string(),
  icon:        z.string().optional(),
  coverImage:  z.string().optional(),
  startDate:   TimestampSchema,
  endDate:     TimestampSchema,
  currency:    z.string(),
  ownerId:     z.string().min(1),
  memberIds:   z.array(z.string().min(1)).min(1),
  lastActivityByFeature: z.object({
    schedule: ActivityStampSchema.optional(),
    expense:  ActivityStampSchema.optional(),
    bookings: ActivityStampSchema.optional(),
    wish:     ActivityStampSchema.optional(),
    planning: ActivityStampSchema.optional(),
  }).optional(),
  /** Cascade write-quiesce marker. Worker-controlled (admin SDK). */
  deletingAt: TimestampSchema.nullable().optional(),
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
  /**
   * Mirror of trip.memberIds. Lets the members-list rule check
   * `request.auth.uid in resource.data.memberIds` against THIS doc
   * instead of a cross-document exists() — same-doc, no lag.
   * Cascade-updated by Worker membership endpoints alongside other
   * entity docs.
   */
  memberIds: string[]
}

export const MemberDocSchema = z.object({
  tripId:      z.string(),
  userId:      z.string(),
  displayName: z.string().min(1),
  avatarUrl:   z.string().optional(),
  role:        z.enum(['owner', 'editor', 'viewer']),
  joinedAt:    TimestampSchema,
  inviteToken: z.string().optional(),
  memberIds:   z.array(z.string().min(1)).min(1),
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
