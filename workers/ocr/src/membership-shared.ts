// workers/ocr/src/membership-shared.ts
// Shared membership primitives split out of membership-write.ts: the
// MembershipValidationError, the authz/read helpers (requireTripMember /
// requireTripOwner, assertTripNotDeleting, readTripRoster, encodeMemberIds),
// and the LOAD-BEARING member-strip pair (buildMemberStripWrites +
// runMemberStripCascade) shared verbatim by /member-remove and /member-leave.
// invite-write.ts + member-lifecycle-write.ts import from here. Pure boundary
// move — no tx / cascade / authz logic changed.
import {
  readString,
  readStringArray,
  listDocNames,
  batchStripDepartedMember,
  deleteUserTripNotifications,
  deleteDoc,
  type FsValue,
}                                                           from './firestore'
import { mapWithConcurrency }                               from './concurrency'
import { CascadeError, TRIP_SUBCOLLECTIONS }                from './cascade'
import {
  docResourceName,
  type TxContext,
  type TxReadDoc,
  type TxWrite,
}                                                           from './firestore-tx'
import { FieldValidationError }                              from './field-validation'

export { TripIdRe } from './field-validation'

// ─── Shared constants (request-schema building blocks) ─────────────
/** Trip id shape — shared by every membership request schema. */
/** Firebase uid length cap — bounds uid-shaped string fields. */
export const UID_MAX  = 128

// ─── Validation error ─────────────────────────────────────────────

/** Thrown for any membership validation failure. Same `{ field, message }`
 *  shape as Expense/Wish/Booking/Settlement so
 *  route-dispatch.validationErrorCatcher handles all five identically. */
export class MembershipValidationError extends FieldValidationError {
  constructor(field: string, message: string) {
    super('MembershipValidationError', field, message)
  }
}

// ─── Shared helpers ────────────────────────────────────────────────

/** 410 if `deletingAt` is set on the trip. Same gate as settlement-write,
 *  expense-write, etc. -- documented at the rules layer as the
 *  cascade-write-quiesce marker (firestore.rules `tripNotDeleting`). */
export function assertTripNotDeleting(trip: TxReadDoc): void {
  if ('deletingAt' in trip.fields) {
    throw new CascadeError(410, 'trip is being deleted')
  }
}

/** Decode `memberIds` from a doc's REST fields. Returns empty array when
 *  the field is missing or contains non-string entries -- defensive
 *  decode that mirrors firestore.ts/getDocMemberIds without the round trip. */
function decodeMemberIds(fields: Record<string, FsValue>): string[] {
  return readStringArray(fields, 'memberIds')
}

export function readTripRoster(trip: TxReadDoc): string[] {
  return decodeMemberIds(trip.fields)
}

/** Asserts: trip exists, not deleting, caller has a member doc.
 *  Returns the two reads so callers can inspect role / roster / fields
 *  without re-fetching. */
export async function requireTripMember(
  tx:        TxContext,
  tripId:    string,
  callerUid: string,
): Promise<{ trip: TxReadDoc; member: TxReadDoc }> {
  const [trip, member] = await Promise.all([
    tx.get(`trips/${tripId}`),
    tx.get(`trips/${tripId}/members/${callerUid}`),
  ])
  if (!trip.exists)   throw new CascadeError(404, 'trip not found')
  assertTripNotDeleting(trip)
  if (!member.exists) throw new CascadeError(403, 'caller is not a trip member')
  return { trip, member }
}

/** As `requireTripMember`, plus `ownerId == callerUid`. Returns the
 *  same shape so callers can branch on role / roster afterward. */
export async function requireTripOwner(
  tx:        TxContext,
  tripId:    string,
  callerUid: string,
): Promise<{ trip: TxReadDoc; member: TxReadDoc }> {
  const { trip, member } = await requireTripMember(tx, tripId, callerUid)
  const ownerId = readString(trip.fields, 'ownerId')
  if (ownerId !== callerUid) {
    throw new CascadeError(403, 'caller is not the trip owner')
  }
  return { trip, member }
}

/** Encode a list of uids as a Firestore REST arrayValue payload. */
export function encodeMemberIds(uids: string[]): FsValue {
  return {
    arrayValue: { values: uids.map(u => ({ stringValue: u })) },
  }
}

// ─── Shared member-strip (member-remove + member-leave) ────────────
// /member-remove (owner kicks someone) and /member-leave (member removes
// themselves) share IDENTICAL strip mechanics -- only the authz/block
// checks at each call site differ (owner-only + kick-target rules vs
// member + owner-can't-leave). These two helpers hold the shared,
// security-critical pieces so the LOAD-BEARING order lives in ONE place
// and can't drift between the two endpoints.

/** Build the small atomic writes that must land inside the authz tx
 *  BEFORE the non-tx strip cascade begins, for removing `targetUid`
 *  from `tripId`.
 *
 *  Write 1 -- `removingAt` on the target member doc (when it exists):
 *    blocks the departing user from continuing to write during the
 *    cascade phase (firestore.rules canWrite() refuses when present),
 *    closing the addDoc-then-be-stripped race.
 *  Write 2 -- `trip.memberIds := roster \ [targetUid]` (when the roster
 *    still carries it): closes the OTHER race -- another editor reading a
 *    stale roster AFTER the cascade's listDocNames snapshot and copying
 *    targetUid onto a freshly created subcollection doc. Skipped when the
 *    roster doesn't carry targetUid (data-at-rest inconsistency from a
 *    prior partial removal); the marker still fires and the cascade still
 *    converges.
 *
 *  Why these belong inside the authz tx (the caller wraps them): atomic
 *  with the trip/member read, so a concurrent trip-cascade-delete either
 *  ABORTs us (retry observes deletingAt → 410) or commits first (next
 *  read observes deletingAt → 410) -- the marker/strip never lands on a
 *  trip being torn down. Snapshot isolation also makes two concurrent
 *  removals converge (loser retries on the committed roster).
 *
 *  `removingAt` uses a client-stamped Date (not REQUEST_TIME): the field
 *  is consumed as exists/not-exists in rules, never compared by value;
 *  and updateTransforms can't express the roster strip anyway, so both
 *  writes stay on the plain-PATCH path.
 *
 *  `removalKind` ('removed' = owner kicked / 'left' = self-leave) and
 *  `removedBy` (the acting caller's uid) ride the same marker write so they
 *  survive on the member doc until the cascade deletes it. Their ONLY consumer
 *  is the delete trigger's notification normalizer (firebase-functions):
 *  removalKind tells "○○ was removed" + a "you were removed" self-notice apart
 *  from a voluntary "○○ left" (no self-notice); removedBy is the actor, so the
 *  owner who performed a kick is excluded from the "○○ was removed" fan-out
 *  (otherwise they'd be pushed about their own action — the member doc carries
 *  no updatedBy for admin writes, so the actor is otherwise unknowable). Not
 *  read by rules or any Worker path. */
/** Max length of a stored former-member name. Must match `TripDocSchema`'s
 *  `formerMemberNames` value cap in src/types/trip.ts — this Worker uses the
 *  Admin SDK, so nothing else checks it. */
const FORMER_NAME_MAX = 100

/**
 * Gate a member's `displayName` before it is copied into the trip doc.
 *
 * The client reads the whole trip through `TripDocSchema`, so ONE oversized
 * or empty entry here makes the entire trip doc fail to parse — the trip
 * vanishes from the user's list and the failure surfaces as a Sentry parse
 * error, far from its cause. Both write paths now cap the name (invite-redeem
 * here, owner self-bootstrap in firestore.rules), but this Worker uses the
 * Admin SDK and bypasses rules entirely — so a doc written before those caps
 * landed, or by any future admin path, still reaches this line unchecked.
 *
 * Returns undefined for anything unusable: the departure then proceeds with
 * no recorded name and the UI falls back to the anonymous ghost label.
 * Losing a name is a display regression; blocking the removal, or writing a
 * doc nobody can read, is worse.
 */
function sanitizeFormerName(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  return trimmed.length <= FORMER_NAME_MAX ? trimmed : undefined
}

export function buildMemberStripWrites(
  projectId:   string,
  tripId:      string,
  targetUid:   string,
  target:      TxReadDoc,
  trip:        TxReadDoc,
  removalKind: 'removed' | 'left',
  removedBy:   string,
): TxWrite[] {
  const writes: TxWrite[] = []
  if (target.exists) {
    writes.push({
      document:   docResourceName(projectId, `trips/${tripId}/members/${targetUid}`),
      fields:     {
        removingAt:  { timestampValue: new Date().toISOString() },
        removalKind: { stringValue: removalKind },
        removedBy:   { stringValue: removedBy },
      },
      updateMask: ['removingAt', 'removalKind', 'removedBy'],
    })
  }
  const currentRoster = readTripRoster(trip)
  const stripsRoster  = currentRoster.includes(targetUid)
  // The member doc is about to be deleted by the cascade and it is the ONLY
  // place this person's name lives, while their uid survives forever on
  // settled expenses. Capture it now or the settlement view can never name
  // them again. No name when the doc is already gone (a retry after a partial
  // removal) — leave the entry absent rather than inventing one.
  const departingName = target.exists
    ? sanitizeFormerName(readString(target.fields, 'displayName'))
    : undefined

  if (stripsRoster || departingName !== undefined) {
    const tripFields:  Record<string, FsValue> = {}
    const tripMask:    string[] = []
    if (stripsRoster) {
      tripFields.memberIds = encodeMemberIds(currentRoster.filter(u => u !== targetUid))
      tripMask.push('memberIds')
    }
    if (departingName !== undefined) {
      // Whole-map read-modify-write rather than a `formerMemberNames.<uid>`
      // field path: the map was read inside this transaction, so a racing
      // removal ABORTs and retries against the committed map instead of
      // clobbering it — and it sidesteps field-path escaping for the uid.
      const existing = trip.fields?.formerMemberNames?.mapValue?.fields ?? {}
      tripFields.formerMemberNames = {
        mapValue: { fields: { ...existing, [targetUid]: { stringValue: departingName } } },
      }
      tripMask.push('formerMemberNames')
    }
    writes.push({
      document:   docResourceName(projectId, `trips/${tripId}`),
      fields:     tripFields,
      updateMask: tripMask,
    })
  }
  return writes
}

/** The non-tx strip cascade. Order is LOAD-BEARING:
 *    1. list every subcollection doc carrying memberIds
 *    2. strip targetUid in ONE commit -- memberIds off every doc + wish
 *       `votes` off wish docs (folded into the same commit, see
 *       batchStripDepartedMember for why votes doesn't get its own call)
 *    3. ONLY THEN delete members/{targetUid}
 *    4. Best-effort cleanup of that user's per-trip notification docs
 *  Mid-step failure between (2) and (3) leaves "still a member doc, ACL
 *  projection gone" -- the user keeps formal membership but loses
 *  subcollection visibility; a retry converges. The reverse (delete
 *  first) would leave a departed user still reading via collection-group
 *  array-contains queries -- a real exfiltration surface.
 *
 *  The trip doc's memberIds is stripped in the precheck tx
 *  (buildMemberStripWrites), not here -- this batch covers subcollection
 *  docs only. */
export async function runMemberStripCascade(
  accessToken:  string,
  projectId:    string,
  tripId:       string,
  targetUid:    string,
  targetExists: boolean,
): Promise<void> {
  const lists = await mapWithConcurrency(TRIP_SUBCOLLECTIONS, 3, sub =>
    listDocNames(accessToken, projectId, `trips/${tripId}/${sub}`),
  )
  // mapWithConcurrency preserves input order, so the wishes entry sits at
  // the same index as in TRIP_SUBCOLLECTIONS; the >=0 guard degrades a
  // future reorder/removal of that constant to "no wish docs" rather than
  // mis-targeting the votes strip.
  const wishIndex    = TRIP_SUBCOLLECTIONS.indexOf('wishes')
  const wishDocNames = wishIndex >= 0 ? (lists[wishIndex] ?? []) : []
  // memberIds strip (every doc) + wish-votes strip (wish docs) in ONE
  // commit -- votes never becomes a separate post-ACL-strip failure window.
  await batchStripDepartedMember(accessToken, projectId, lists.flat(), wishDocNames, targetUid)

  // Member doc delete is the final membership mutation: by now every
  // subcollection + trip doc has had targetUid stripped from memberIds,
  // so collection-group `array-contains targetUid` queries no longer
  // match this trip's docs.
  if (targetExists) {
    await deleteDoc(accessToken, projectId, `trips/${tripId}/members/${targetUid}`)
  }

  // Inbox cleanup is data hygiene, not the security boundary. Do not let
  // a transient Firestore failure strand member-leave after ACL removal.
  try {
    await deleteUserTripNotifications(accessToken, projectId, targetUid, tripId)
  } catch (err) {
    console.warn('deleteUserTripNotifications failed', {
      tripId,
      targetUid,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// Re-export TxReadDoc for the spec's mock typing -- same pattern
// settlement-write uses.
export type { TxReadDoc }
