// workers/ocr/src/cascade.ts
// Server-side membership projection cascade for invite/member flows.
//
// The Worker owns the invariant "after accept, trip.memberIds and every
// entity doc's memberIds[] contains the invitee uid". `/invite-redeem`
// writes the member doc + trip roster, then calls this helper to update
// every trip-scoped doc carrying memberIds[].
//
// This file arrayUnions the uid onto every trip-scoped doc that carries
// memberIds[] — members/*, schedules/*, expenses/*, bookings/*, wishes/*,
// planning/*, and the trip doc itself.
//
// The trip doc is included in the batch alongside subcollections so
// every memberIds[] projection lands in one commit. arrayUnion is
// idempotent (re-running on a uid that's already present is a no-op).
//
// Projection precondition: trip.memberIds must already include memberUid.
// `/invite-redeem` establishes that inside its transaction before calling
// this helper. `/member-remove` strips trip.memberIds before its remove
// cascade, so a kicked-but-not-yet-deleted member cannot re-add themselves
// through projection repair.
import { getAdminToken, getProjectId, invalidateAdminToken } from './admin'
import {
  docExists,
  getDocFields,
  getDocMemberIds,
  listDocNames,
  batchArrayUnionMemberIds,
  arrayUnionMembersOnDoc,
  buildDocName,
} from './firestore'
import { mapWithConcurrency }                from './concurrency'

export interface CascadeRequest {
  tripId:    string
  memberUid: string
}

/** Subcollections under /trips/{tripId} whose docs carry memberIds[]
 *  and therefore need cascading on member add/remove. The trip doc
 *  itself is added separately (it's a single doc, not a collection
 *  list). Exported so /member-remove can reuse the exact same set --
 *  any future subcollection added with a memberIds projection MUST
 *  appear here or the remove-cascade silently leaves the uid behind. */
export const TRIP_SUBCOLLECTIONS = [
  'members', 'schedules', 'expenses', 'bookings', 'wishes', 'planning',
] as const

export class CascadeError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'CascadeError'
  }
}

/** Thrown when the download-token strip can't be made to stick after
 *  bounded retry during intent consume (upload-intent.ts). The just-
 *  uploaded blob is deleted before this throws, so the failure is
 *  TERMINAL (not transparently retryable): the same upload payload
 *  cannot be replayed (its blob is gone) and no Firestore doc was
 *  written. The route maps it to a definitive-reject 409 so the client
 *  rolls back the optimistic row and prompts a fresh re-pick, rather
 *  than keeping a phantom row or auto-resending the dead payload. */
export class AttachmentHardeningError extends Error {
  readonly code = 'ATTACHMENT_HARDENING_FAILED' as const
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentHardeningError'
  }
}

/** Drive the cascade. Throws CascadeError(status, msg) for the
 *  index.ts handler to translate into an HTTP response.
 *
 *  Retries once on 401 from Firestore: if our cached OAuth token was
 *  revoked mid-cache (e.g. service account key rotation), the first
 *  attempt fails with 401 → invalidate cache → retry with freshly
 *  minted token. All writes downstream are arrayUnion (idempotent)
 *  so retry-from-scratch is safe. */
export async function cascadeMemberAdd(
  callerUid:           string,
  req:                 CascadeRequest,
  serviceAccountJson:  string,
): Promise<{ updatedDocs: number }> {
  // Anti-spoofing: the bearer token's uid must match the memberUid
  // they're cascading for. Otherwise A could grant B access to a
  // trip A doesn't even belong to. Checked outside the retry loop —
  // it's an input-validation failure, not a transient one.
  if (callerUid !== req.memberUid) {
    throw new CascadeError(403, 'caller uid does not match memberUid')
  }

  return withTokenRetry(() => runCascade(req, serviceAccountJson))
}

/** Run `fn` once. If it throws an error whose message looks like a
 *  Firestore REST 401 (the helpers in firestore.ts format as `... → 401:
 *  ...`), invalidate the cached admin token and retry exactly once.
 *
 *  Exported for unit testing — the retry policy is logic-only (no
 *  network) and is easier to verify directly than through the full
 *  cascade flow. */
export async function withTokenRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const msg = (e as Error).message ?? ''
    if (msg.includes(' -> 401') || msg.includes(' → 401')) {
      console.warn('[cascade] firestore returned 401; invalidating cached admin token and retrying once')
      invalidateAdminToken()
      return await fn()
    }
    throw e
  }
}

async function runCascade(
  req:                CascadeRequest,
  serviceAccountJson: string,
): Promise<{ updatedDocs: number }> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  // Prereq: the invitee must have actually written their member doc
  // (which the invite-redeem create rule guards with the token check).
  // Without this, a signed-in stranger could POST here for any tripId
  // they guess and become a member without holding a valid invite.
  const memberDocPath = `trips/${req.tripId}/members/${req.memberUid}`
  if (!await docExists(accessToken, projectId, memberDocPath)) {
    throw new CascadeError(403, 'member doc does not exist — accept invite first')
  }

  // tripNotDeleting re-check. /invite-redeem already gated on
  // `deletingAt` inside its REST tx, but trip-cascade-delete can start
  // between tx commit and the cascade kickoff below. Without this
  // re-read, an invitee who slips through that window keeps their
  // member doc + ACL projection on every subcollection doc, racing the
  // delete cascade and leaving zombie reads. Re-reading the trip is
  // one round-trip in exchange for closing a window measured in
  // milliseconds but real-world reachable under owner-driven delete.
  const tripFields = await getDocFields(accessToken, projectId, `trips/${req.tripId}`)
  if (!tripFields) {
    throw new CascadeError(404, 'trip not found')
  }
  if ('deletingAt' in tripFields) {
    throw new CascadeError(410, 'trip is being deleted')
  }

  // Removal-aware refuse. /member-remove's safe-failure mode strips
  // ACL projection FIRST (trip.memberIds and every subcollection
  // memberIds), then deletes the member doc LAST. If the final delete
  // fails or is delayed, the target still holds a Firebase token and
  // could otherwise re-arrayUnion themselves into every memberIds[],
  // silently undoing the kick. The check here closes that attack surface:
  // if trip.memberIds doesn't include the cascade target, refuse.
  // Symmetric on the inviteRedeem retry path -- a
  // stale member doc from a previous tx-committed-but-cascade-failed
  // attempt is fine to recover from (roster still includes caller),
  // but a member doc from a partially-finished kick is not.
  const tripRosterValues = tripFields.memberIds?.arrayValue?.values ?? []
  const tripRoster = tripRosterValues
    .map(v => v.stringValue)
    .filter((v): v is string => typeof v === 'string')
  if (!tripRoster.includes(req.memberUid)) {
    throw new CascadeError(403, 'member is not in trip roster — cascade refused')
  }

  // Collect every doc that needs memberIds += uid: each /trips/{tripId}/<sub>/*
  // doc plus the trip doc itself. The trip doc is INCLUDED even though the
  // client also writes it (idempotent arrayUnion) — if the client's write
  // silently failed, the worker still establishes the invariant.
  //
  // Concurrency cap at 3: Workers allows 6 simultaneous open connections,
  // and listDocNames paginates internally. Running 6 listDocNames in
  // parallel exhausts the pool so pagination subrequests serialize behind
  // them; 3 leaves headroom for pagination + the trailing commit.
  const lists = await mapWithConcurrency(TRIP_SUBCOLLECTIONS, 3, sub =>
    listDocNames(accessToken, projectId, `trips/${req.tripId}/${sub}`),
  )
  const docNames: string[] = lists.flat()
  docNames.push(buildDocName(projectId, `trips/${req.tripId}`))

  // Single commit per 500-doc chunk; idempotent on re-run via
  // appendMissingElements (arrayUnion REST equivalent).
  await batchArrayUnionMemberIds(accessToken, projectId, docNames, req.memberUid)

  // Special case: the freshly-created invitee member doc was written
  // by the client with memberIds=[invitee.uid] only — the invitee
  // couldn't read trip.memberIds at create time (trip get rule
  // requires same-doc membership they didn't have yet) so couldn't
  // seed the full roster. Without this step, owner / existing
  // members' listeners (filtered by array-contains own-uid) never
  // match the new member doc, so the new joiner doesn't appear in
  // their UI in real time. Fix: read trip.memberIds (just patched
  // above to include invitee) and arrayUnion that full roster onto
  // the invitee's member doc. Result: every member doc carries the
  // identical roster — invariant restored.
  const freshRoster = await getDocMemberIds(
    accessToken, projectId, `trips/${req.tripId}`,
  )
  await arrayUnionMembersOnDoc(
    accessToken,
    projectId,
    buildDocName(projectId, `trips/${req.tripId}/members/${req.memberUid}`),
    freshRoster,
  )

  return { updatedDocs: docNames.length }
}
