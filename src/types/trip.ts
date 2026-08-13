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
  defaultCountryCode: string // ISO 3166-1 alpha-2; independent from currency after create
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
   * uid → 該成員離開當下的 displayName。由 Worker 的 member-strip cascade
   * 在把 uid 從 `memberIds` 移除的同一個 transaction 裡寫入。
   *
   * 為什麼要留:費用與清算紀錄會永久保留已退出成員的 uid(不能改寫已結算的
   * 歷史),但 member doc 會被刪掉,名字就跟著消失。少了這張表,兩個以上的
   * 已退出成員在分帳畫面上完全無法辨識 —— 帳目對不起來時沒人查得出是誰。
   *
   * 逐列快照(在每筆 split / allocation 存名字)也能解,但要動三處 schema、
   * Worker Zod 與 rules cap;trip 層一張表換來同樣的結果。
   *
   * Client 唯讀:rules 對 owner 的編輯路徑鎖 `unchanged`,只有 admin SDK 寫得到。
   */
  formerMemberNames: Record<string, string>
  /**
   * Per-feature "last activity" stamps. Drives the bottom-nav unread-
   * dot badge — see useFeatureBadges. Each service mutation calls
   * bumpTripActivity() best-effort after the main write to update the
   * matching feature key. Optional because createTrip never seeds it —
   * bumpTripActivity creates the map lazily on the first activity, so a
   * brand-new trip legitimately has no stamps; missing → no badge.
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
  /**
   * Owner-set shared cutoff for Wish voting. `null` = no deadline (default).
   * Once past, firestore.rules + the Worker /wish-file-* endpoints reject
   * all wish create/update/delete/vote writes — see wishVotingOpen(tripId).
   * Always present. New trips are seeded with explicit null values; this
   * codebase intentionally does not support legacy trip docs missing these
   * keys.
   */
  wishVotingDeadlineAt: Timestamp | null
  /**
   * Stamped by the Worker's wish-deadline-sweep cron (Admin SDK) the first
   * time it observes wishVotingDeadlineAt <= now. Client rules enforce
   * `unchanged` on this field — only the Worker can set it. Once non-null,
   * the owner can no longer change wishVotingDeadlineAt (no re-open).
   */
  wishVotingDeadlineNotifiedAt: Timestamp | null
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
  defaultCountryCode: z.string().regex(/^[A-Z]{2}$/, '請選擇旅程國家'),
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
  defaultCountryCode: z.string().regex(/^[A-Z]{2}$/),
  ownerId:     z.string().min(1),
  memberIds:   z.array(z.string().min(1)).min(1),
  // `.default({})` 而非 `.optional()`:讀取端永遠拿到一個 map,不需要
  // backfill 也不需要在每個消費點寫 `?? {}`。值的長度上限跟 invite-write
  // 的 `displayName: z.string().min(1).max(100)` 對齊 —— 兩邊都是同一個
  // 名字的入口,cap 一旦漂移就是 Worker 比 rules 寬的老問題。
  formerMemberNames: z.record(z.string().min(1), z.string().min(1).max(100)).default({}),
  lastActivityByFeature: z.object({
    schedule: ActivityStampSchema.optional(),
    expense:  ActivityStampSchema.optional(),
    bookings: ActivityStampSchema.optional(),
    wish:     ActivityStampSchema.optional(),
    planning: ActivityStampSchema.optional(),
  }).optional(),
  /** Cascade write-quiesce marker. Worker-controlled (admin SDK). */
  deletingAt: TimestampSchema.nullable().optional(),
  // Always present: the database is initialized from the current schema and
  // the create rule forces both fields to be written as explicit null values.
  wishVotingDeadlineAt:         TimestampSchema.nullable(),
  wishVotingDeadlineNotifiedAt: TimestampSchema.nullable(),
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
  // 100 是這個名字的全域上限:invite-redeem 的 Worker schema、rules 的
  // owner bootstrap、以及 trip doc 的 formerMemberNames 值都用同一個數字。
  // 任何一邊放寬,離開時複製過去的名字就會讓整份 trip doc 解析失敗。
  displayName: z.string().min(1).max(100),
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

export const InviteDocSchema = z.object({
  tripId:    z.string(),
  tripTitle: z.string(),
  tripIcon:  z.string(),
  role:      z.enum(['editor', 'viewer']),
  createdBy: z.string(),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
})
