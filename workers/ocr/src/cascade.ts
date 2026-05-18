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
import { getAdminToken, getProjectId }      from './admin'
import {
  docExists,
  getDocMemberIds,
  listDocNames,
  batchArrayUnionMemberIds,
  arrayUnionMembersOnDoc,
  buildDocName,
} from './firestore'

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
 *  index.ts handler to translate into an HTTP response. */
export async function cascadeMemberAdd(
  callerUid:           string,
  req:                 CascadeRequest,
  serviceAccountJson:  string,
): Promise<{ updatedDocs: number }> {
  // Anti-spoofing: the bearer token's uid must match the memberUid
  // they're cascading for. Otherwise A could grant B access to a
  // trip A doesn't even belong to.
  if (callerUid !== req.memberUid) {
    throw new CascadeError(403, 'caller uid does not match memberUid')
  }

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

  // Collect every doc that needs memberIds += uid:
  //   - each /trips/{tripId}/<sub>/* doc
  //   - the trip doc itself
  // The trip doc is INCLUDED even though the client also writes it
  // (idempotent arrayUnion) so the invariant is established
  // unconditionally — if the client's write somehow failed silently,
  // the worker still completes the cascade and the invitee has
  // consistent access.
  const docNames: string[] = []
  for (const sub of TRIP_SUBCOLLECTIONS) {
    const names = await listDocNames(
      accessToken,
      projectId,
      `trips/${req.tripId}/${sub}`,
    )
    docNames.push(...names)
  }
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
