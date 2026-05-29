// src/features/trips/invites/inviteService.ts
// Invite model: an owner generates an unguessable 256-bit token → creates a
// doc at /trips/{tripId}/invites/{token}. The invitee reaches the redeem URL
// /invite/:tripId/:token, signs in, and POSTs to the Worker's /invite-redeem
// endpoint. The Worker (admin token, bypasses rules) atomically validates
// the invite doc, creates the member doc, bumps trip.memberIds, then runs
// the ACL projection cascade — see workers/ocr/src/membership-write.ts
// `doInviteRedeem`. The client never writes invite-flow member docs
// directly; firestore.rules `members update: if false` / `delete: if false`
// plus a narrowly-scoped owner-self-bootstrap-only `create` (gated by
// getAfter trip-create batch) close every non-Worker membership write.
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
import { subscribeToCollection } from '@/services/realtimeQuery'
import { InviteDocSchema, type Invite, type Trip } from '@/types'
import { getTripsByIds } from '@/features/trips/services/tripService'
import { requireWorkerWriteBase, preflightIdToken, workerFetch } from '@/services/workerBase'

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

/**
 * Result of redeeming an invite. Carries the freshly-loaded Trip object
 * alongside the outcome so the caller can:
 *   - seed TanStack Query's tripKeys.mine / myIds caches synchronously
 *     (no 1+ second wait for an invalidate refetch to round-trip)
 *   - render the destination page pointing at the just-joined trip
 *     instead of whatever was selected before (useCurrentTrip on the
 *     destination resolves the Trip object from the seeded cache)
 *
 * `trip` may be null in the unlikely case that the post-redeem fetch
 * fails (rules race, schema mismatch). When that happens the Worker
 * already confirmed the join, so callers should fall back to the URL
 * `tripId` (the redemption target is the authoritative active-trip
 * answer) — see InvitePage.handleAccept. The grace window in
 * useCurrentTripSync keeps that selection sticky until the realtime
 * listener catches up.
 */
export interface AcceptResult {
  outcome: AcceptOutcome
  trip:    Trip | null
}

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

/**
 * Realtime variant — pushes Invite[] when the owner creates or revokes
 * an invite. Same client-side sort (newest first) as listInvites so
 * both code paths produce matching shapes. No LIST_LIMIT: invite
 * counts are bounded (typically 0-1 per trip thanks to the "one
 * active invite at a time" semantic).
 */
export const subscribeToInvites = (
  tripId: string,
  onData: (data: Invite[]) => void,
  onError: (e: Error) => void,
) => subscribeToCollection<Invite>({
  buildQuery: ({ db, collection }) => collection(db, ...P.invites(tripId)),
  fromDoc:    d => toInvite(d.id, d.data({ serverTimestamps: 'estimate' })),
  postProcess: items => items.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis()),
  source:     'subscribeToInvites',
}, onData, onError)

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
 * Redeem an invite through the Worker. The Worker owns the cross-document
 * membership lifecycle: invite validation, member doc create/repair,
 * trip.memberIds update, and ACL projection cascade are one authoritative
 * flow instead of a client-side three-step best-effort sequence.
 */
export async function acceptInvite(
  tripId: string,
  token: string,
  user: User,
): Promise<AcceptResult> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()

  const displayName = user.displayName?.trim() || 'Member'
  const payload: {
    tripId:      string
    token:       string
    displayName: string
    avatarUrl?:  string
  } = { tripId, token, displayName }
  if (user.photoURL) payload.avatarUrl = user.photoURL

  const result = await workerFetch(workerBase, idToken, '/invite-redeem', payload) as {
    ok:      true
    outcome: AcceptOutcome
  }

  // Fetch trip for caller cache seeding. Failure here is non-fatal; callers
  // still invalidate/refetch through their normal path.
  const [trip] = await getTripsByIds([tripId]).catch(e => {
    captureError(e, { source: 'acceptInvite/postFetchTrip', tripId, uid: user.uid })
    return [] as Trip[]
  })
  return { outcome: result.outcome, trip: trip ?? null }
}
