// src/features/trips/invites/inviteService.ts
// Invite model: an owner generates an unguessable 256-bit token → creates a
// doc at /trips/{tripId}/invites/{token}. The invitee reaches the redeem URL
// /invite/:tripId/:token, signs in, and writes a single member doc carrying
// `inviteToken` so rules can verify the referenced invite still exists and
// matches the claimed role.
//
// Reusable-link semantics: the invite doc's EXISTENCE is the validity gate.
// Any number of users can redeem while the doc lives and `expiresAt` hasn't
// passed. Owner invalidates by deleting (directly via revokeInvite, or
// implicitly via createInvite which clears existing invites before writing
// the new one). No client ever writes to an invite doc — only create+delete.
import type { User } from 'firebase/auth'
import type { Timestamp } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError } from '@/services/sentry'
import { InviteDocSchema, type Invite, type Trip } from '@/types'
import { addMemberToTripBookings } from '@/services/memberSync'

export type InviteErrorCode = 'not-found' | 'expired'

export class InviteError extends Error {
  readonly code: InviteErrorCode
  constructor(code: InviteErrorCode, message: string) {
    super(message)
    this.name = 'InviteError'
    this.code = code
  }
}

export type AcceptOutcome = 'joined' | 'already-member'

const DEFAULT_EXPIRY_MS = 5 * 60 * 60 * 1000   // 5 hours
const TOKEN_BYTES       = 32                   // 256 bits → infeasible to guess

/**
 * Render a human-readable countdown for an invite's `expiresAt`. Adapts to
 * the magnitude of the window — hour-scale expiries show "あと N 時間" /
 * "あと N 分", longer windows fall back to "あと N 日". Callers pass the
 * current time from render scope (useState snapshot) so the formatter stays
 * pure / idempotent within a render pass.
 */
export function formatInviteExpiry(expiresAt: Timestamp, now: number): string {
  const diffMs = expiresAt.toMillis() - now
  if (diffMs <= 0)     return '期限切れ'
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1)     return 'まもなく期限切れ'
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 1)      return `あと ${diffMin} 分`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 1)     return `あと ${diffHr} 時間`
  return `あと ${diffDay} 日`
}

/**
 * Crypto-random token, hex-encoded (64 chars). Uses WebCrypto which is
 * available in every modern browser + every supported PWA surface.
 * Hex (not base64url) so the token is URL-safe without additional escaping
 * and readable in console logs during debugging.
 *
 * Exported for unit testing; treat as an internal helper otherwise.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function toInvite(id: string, data: Record<string, unknown>): Invite {
  // Narrow + validate before handing to the rest of the app. Keeps one
  // trust boundary: anything in-memory typed as Invite has been checked.
  // Schema uses .passthrough() so legacy one-shot fields on older docs
  // don't reject the parse; we project down to the Invite shape.
  const result = InviteDocSchema.safeParse(data)
  if (!result.success) {
    captureError(result.error, { source: 'inviteService/toInvite', docId: id })
    throw new Error(`Invite ${id} failed schema validation`)
  }
  const parsed = result.data
  return {
    id,
    tripId:    parsed.tripId,
    tripTitle: parsed.tripTitle,
    tripIcon:  parsed.tripIcon,
    role:      parsed.role,
    createdBy: parsed.createdBy,
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
  }
}

/**
 * Owner creates a new invite. "One active invite at a time" semantics:
 * existing invite docs for the trip are deleted atomically with the new
 * create, so any in-flight links become not-found on next read. Token is
 * generated client-side; collision probability with 256-bit random is ~0,
 * so no pre-check getDoc. Defaults to a 7-day expiry.
 *
 * Race: if a redeemer's acceptInvite commits between this function's
 * read-existing-docs and batch-commit, their member doc still lands; this
 * create then proceeds with the delete+set. The invariant we care about —
 * "at most one unexpired invite at a time" — holds either way.
 */
export async function createInvite(
  trip: Trip,
  role: 'editor' | 'viewer',
  user: User,
  expiresInMs: number = DEFAULT_EXPIRY_MS,
): Promise<Invite> {
  const { db, doc, collection, getDocs, writeBatch, Timestamp, serverTimestamp } = await getFirebase()

  const invitesCol = collection(db, ...P.invites(trip.id))
  const existing   = await getDocs(invitesCol)

  const token   = generateToken()
  const ref     = doc(invitesCol, token)
  const expires = Timestamp.fromDate(new Date(Date.now() + expiresInMs))

  const payload = {
    tripId:    trip.id,
    tripTitle: trip.title,
    tripIcon:  trip.icon ?? '✈️',
    role,
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    expiresAt: expires,
  }

  // Batch cap is 500 ops — with the "one at a time" invariant held after
  // this first deployment, existing.size is typically 0–1. If older data
  // left more behind, we still stay well under the cap.
  const batch = writeBatch(db)
  existing.docs.forEach(d => batch.delete(d.ref))
  batch.set(ref, payload)
  await batch.commit()

  // Local Timestamp as a sentinel for createdAt — the real server value
  // arrives on the next read via listInvites / useInvites invalidation.
  return {
    id:        token,
    tripId:    trip.id,
    tripTitle: trip.title,
    tripIcon:  trip.icon ?? '✈️',
    role,
    createdBy: user.uid,
    createdAt: Timestamp.now(),
    expiresAt: expires,
  }
}

/**
 * Owner lists all invites for a trip. Expired invites are included so the
 * UI can present a full audit view; callers filter client-side.
 */
export async function listInvites(tripId: string): Promise<Invite[]> {
  const { db, collection, getDocs } = await getFirebase()
  const snap = await getDocs(collection(db, ...P.invites(tripId)))
  return snap.docs
    .map(d => toInvite(d.id, d.data()))
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
}

/** Owner revokes an invite by deleting it. */
export async function revokeInvite(tripId: string, token: string): Promise<void> {
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.invite(tripId, token)))
}

/**
 * Read an invite doc by token. Throws InviteError for the two hard-fail
 * cases (not-found / expired) so the UI can branch on `.code` without
 * parsing message text. Called by InvitePage to render trip info before
 * asking the user to confirm.
 */
export async function getInvite(tripId: string, token: string): Promise<Invite> {
  const { db, doc, getDoc } = await getFirebase()
  const snap = await getDoc(doc(db, ...P.invite(tripId, token)))
  if (!snap.exists()) throw new InviteError('not-found', 'Invite not found')

  const invite = toInvite(snap.id, snap.data())
  if (invite.expiresAt.toMillis() < Date.now()) throw new InviteError('expired', 'Invite expired')
  return invite
}

/**
 * Redeem an invite. Idempotent on `already-member` — if the user is already
 * a member of this trip (any role), returns without writing.
 *
 * Writes a single member doc carrying `inviteToken` so Firestore rules can
 * verify the referenced invite exists with matching role at commit time.
 * No invite mutation: reusable-link semantics mean multiple redeemers can
 * succeed in parallel without contending for a shared row.
 *
 * Race with owner regenerating the invite: rules dereference the invite at
 * member-create time via exists()/get(). If the owner's batch (delete old +
 * create new) lands first, exists() on the old token returns false and this
 * redeem cleanly rejects. If the redeem lands first, the new member sticks;
 * the subsequent delete removes only the invite doc, not the member record.
 */
export async function acceptInvite(
  tripId: string,
  token: string,
  user: User,
): Promise<AcceptOutcome> {
  const { db, doc, getDoc, setDoc, serverTimestamp } = await getFirebase()

  const invite = await getInvite(tripId, token)  // throws on not-found/expired

  const memberRef = doc(db, ...P.member(tripId, user.uid))
  const memberSnap = await getDoc(memberRef)
  if (memberSnap.exists()) return 'already-member'

  const memberPayload: Record<string, unknown> = {
    tripId,
    userId:      user.uid,
    displayName: user.displayName ?? 'Member',
    role:        invite.role,
    joinedAt:    serverTimestamp(),
    inviteToken: token,
  }
  // avatarUrl omitted when null — ignoreUndefinedProperties strips undefined;
  // explicit branch matches the shape used in createTrip.
  if (user.photoURL) memberPayload.avatarUrl = user.photoURL

  await setDoc(memberRef, memberPayload)

  // Sync the new member into every booking's denormalised `memberIds`
  // array so collection-group queries (PastLodgingPage's hotel history)
  // pick up this trip's bookings immediately. Failure here is non-fatal:
  // the member doc already landed, so the user has access via standard
  // per-trip queries — they just won't appear in the cross-trip history
  // until a later sync. We log to Sentry so persistent failures surface.
  try {
    await addMemberToTripBookings(tripId, user.uid)
  } catch (e) {
    captureError(e, { source: 'acceptInvite/syncBookings', tripId, uid: user.uid })
  }

  return 'joined'
}
