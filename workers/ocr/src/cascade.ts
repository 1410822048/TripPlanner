// workers/ocr/src/cascade.ts
// Server-side membership cascade for the accept-invite flow.
//
// Writes are split between client and worker, but both share the
// invariant "after accept, trip.memberIds and every entity doc's
// memberIds[] contains the invitee uid". Roles:
//
//   - Client (governed by rules):
//       1. setDoc(/trips/X/members/{uid})  — invite-redeem create rule
//       2. updateDoc(/trips/X, memberIds += uid) — memberSyncSelfAdd rule
//      → fast path. After these two writes the invitee has trip-level
//        access immediately, even if the worker is unreachable.
//
//   - Worker (admin SDK, bypasses rules) — THIS FILE:
//       arrayUnion the uid onto EVERY trip-scoped doc that carries
//       memberIds[] — members/*, schedules/*, expenses/*, bookings/*,
//       wishes/*, planning/*, AND the trip doc itself.
//
// The trip doc is intentionally written by BOTH sides. arrayUnion is
// idempotent (re-running on a uid that's already present is a no-op),
// so the redundancy costs ~one extra write and gives strong
// resilience: if the client's trip self-add silently failed (rules
// lag, intermittent network) the worker still establishes the
// invariant. The earlier "client-only writes trip" design exposed a
// propagation race where worker REST read didn't yet see the client's
// just-committed update — switching to idempotent redundancy
// eliminates that class of bug entirely.
import { z }                                from 'zod'
import { getAdminToken, getProjectId, invalidateAdminToken } from './admin'
import {
  docExists,
  getDocMemberIds,
  listDocNames,
  batchArrayUnionMemberIds,
  arrayUnionMembersOnDoc,
  buildDocName,
} from './firestore'
import { mapWithConcurrency }                from './concurrency'

export const CascadeRequestSchema = z.object({
  tripId:    z.string().min(1).max(60),
  memberUid: z.string().min(1).max(128),
})
export type CascadeRequest = z.infer<typeof CascadeRequestSchema>

/** Subcollections under /trips/{tripId} whose docs carry memberIds[]
 *  and therefore need cascading on member add. The trip doc itself
 *  is added separately in cascadeMemberAdd (it's a single doc, not
 *  a collection list). */
const TRIP_SUBCOLLECTIONS = [
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
  const tripRoster = await getDocMemberIds(
    accessToken, projectId, `trips/${req.tripId}`,
  )
  await arrayUnionMembersOnDoc(
    accessToken,
    projectId,
    buildDocName(projectId, `trips/${req.tripId}/members/${req.memberUid}`),
    tripRoster,
  )

  return { updatedDocs: docNames.length }
}
