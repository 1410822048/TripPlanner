// src/features/trips/invites/inviteService.ts
// Invite model — every MUTATION is Worker-authoritative; the client only
// READS invite docs:
//   - createInvite → POST /invite-create. The Worker mints the 256-bit
//     token, reads tripTitle/tripIcon off the trip doc, caps the expiry,
//     and atomically rotates the single-active pointer inviteState/current
//     (the transaction conflict point that makes "one live invite" a real
//     invariant, not a client-batch convention).
//   - revokeInvite → POST /invite-revoke. Deletes the active invite + clears
//     the pointer; 409s a stale (already-rotated) token.
//   - acceptInvite → POST /invite-redeem. Validates the invite, gates on
//     inviteState/current.token === token, creates the member doc + bumps
//     trip.memberIds, then runs the ACL projection cascade — see
//     workers/ocr/src/membership-write.ts.
// firestore.rules deny ALL client writes to /invites (create/update/delete:
// if false) and ALL client access to /inviteState. Reads stay client-SDK:
// the redeemer GETs the invite doc by its unguessable token, the owner LISTs
// /invites for the management UI (listInvites / subscribeToInvites below).
//
// Reusable-link semantics: while the pointer names a token and its expiresAt
// hasn't passed, any number of users can redeem it. Rotating (createInvite)
// or revoking moves/clears the pointer, so older links fail the redeem gate.
import type { User } from 'firebase/auth'
import type { Timestamp } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError } from '@/services/sentry'
import { subscribeToCollection } from '@/services/realtimeQuery'
import { InviteDocSchema, type Invite, type Trip } from '@/types/trip'
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
 * Owner creates a new invite via the Worker (/invite-create). The Worker
 * mints the token, reads tripTitle/tripIcon off the trip doc, caps the
 * expiry, and rotates the single-active pointer atomically — see
 * membership-write.ts `inviteCreate`. The client passes only tripId + role.
 *
 * The returned Invite is an OPTIMISTIC shape for the mutation cache: the
 * Worker-minted `token` + computed `expiresAt` come back over the wire;
 * tripTitle/tripIcon/role/createdBy are reconstructed from local inputs
 * (they match what the Worker wrote), and `createdAt` uses a local
 * Timestamp.now() sentinel — the real server value arrives on the next
 * realtime push via subscribeToInvites.
 */
export async function createInvite(
  trip: Trip,
  role: 'editor' | 'viewer',
  user: User,
): Promise<Invite> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()

  const result = await workerFetch(workerBase, idToken, '/invite-create', {
    tripId: trip.id,
    role,
  }) as { ok: true; token: string; expiresAt: string }

  const { Timestamp } = await getFirebase()
  return {
    id:        result.token,
    tripId:    trip.id,
    tripTitle: trip.title,
    tripIcon:  trip.icon ?? '✈️',
    role,
    createdBy: user.uid,
    createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromMillis(Date.parse(result.expiresAt)),
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

/**
 * Owner revokes an invite via the Worker (/invite-revoke). The Worker
 * deletes the invite doc + clears the single-active pointer; a stale token
 * (already rotated by a newer createInvite) comes back as a 409 →
 * WorkerRejected, and the realtime listener resyncs the owner to the
 * actual active invite.
 */
export async function revokeInvite(tripId: string, token: string): Promise<void> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()
  await workerFetch(workerBase, idToken, '/invite-revoke', { tripId, token })
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
