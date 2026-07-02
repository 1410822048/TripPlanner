// workers/ocr/src/trip-cascade.ts
// Server-side cascade-delete for a whole trip and everything under it.
//
// Why this endpoint exists (replaces client-side `tripCascade.ts`):
//   - Closes P1 accepted-risk: TWO doc kinds are Worker-exclusive
//     for hard-delete because their tombstones / integrity protect
//     replay-style invariants:
//       • trip root  — `allow delete: if false` (cascade integrity)
//       • expense    — `allow delete: if false` (settlement replay
//                      needs tombstones preserved)
//     Every OTHER trip subcollection (schedules / bookings / wishes
//     / planning / settlements / invites / members) keeps ordinary
//     client-side delete rules (`canWrite` / `isTripOwner` /
//     `memberOfDoc`) — that's normal editing UX with no replay
//     invariant. The Worker also drains those subcollections during
//     a cascade, but it isn't the only path that can delete a
//     schedule / booking / etc.
//   - Storage cleanup runs with admin GCS scope, so we don't need
//     storage.rules to grant the caller perm to delete every nested
//     object — the rule can stay tight ("members only, no bulk").
//
// Cascade order (matches the contract documented in the design):
//   1.   Verify ownership — GET trip doc, compare ownerId == callerUid
//   1.5. Stamp deletingAt — write-quiesce flag. firestore.rules
//        `tripNotDeleting(tripId)` AND'd into every subcollection
//        CREATE; storage.rules mirrors the same check via
//        cross-service firestore.get(). Blocks in-flight editors
//        on other devices from racing new docs / uploads into the
//        cascade window.
//   2.   Storage purge (sweep #1) — recursive delete of trips/{tripId}/*
//   3.   Subcollections  — schedules / expenses / wishes / bookings /
//                          planning / settlements / invites / members
//                          (members LAST: every other subcollection's
//                          rules dereference members/{uid}, but admin
//                          token bypasses rules anyway — order is
//                          defensive in case we ever fall back to a
//                          rules-respecting path)
//   3.5. Storage purge (sweep #2) — final defence-in-depth pass that
//        catches uploads whose storage.rules eval read the trip doc
//        BEFORE the stamp at step 1.5 but whose actual write
//        completes AFTER. Must run before trip-doc delete so
//        cross-service tripNotDeleting can still resolve (post-
//        delete the get() throws and we'd lose the admin path).
//   4.   Trip doc        — DELETE the root doc
//
// Core delete ops are idempotent (404 on a re-run = success). On any
// core failure we throw a CascadeError with the step name; the caller
// may retry and continue where we stopped. Notification cleanup runs
// best-effort after the trip doc is gone.
import { z }                                                        from 'zod'
import { getAdminToken, getProjectId, invalidateAdminToken }        from './admin'
import {
  batchDeleteDocs,
  deleteUserTripNotifications,
  deleteDoc,
  getDocFields,
  listDocNames,
  readString,
  updateDocFields,
  type FsValue,
}                                                                   from './firestore'
import { purgeObjectsByPrefix }                                     from './storage'
import { CascadeError, withTokenRetry }                             from './cascade'
import { mapWithConcurrency }                                       from './concurrency'

// Firestore auto-IDs are 20-char [A-Za-z0-9]; we also tolerate `_-` for
// any future custom-ID path. The regex is the load-bearing defense: a
// tripId containing `/` would let the caller interpolate path segments
// into Firestore / Storage REST URLs ("abc/expenses/xyz" → operations
// scoped to a wrong path). `[A-Za-z0-9_-]` excludes every URL-special
// char (slash, query separators, fragment, percent-encoding triggers).
const TRIP_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export const TripDeleteRequestSchema = z.object({
  tripId: z.string()
            .min(1)
            .max(60)
            .regex(TRIP_ID_PATTERN, 'invalid tripId — must match [A-Za-z0-9_-]'),
})
export type TripDeleteRequest = z.infer<typeof TripDeleteRequestSchema>

/** Subcollections under /trips/{tripId} to drain. Members LAST so any
 *  rule-respecting fallback path doesn't lose write perm mid-cascade.
 *  Mirrors src/services/paths.ts TRIP_SUBCOLLECTIONS — duplicated here
 *  because the worker bundle stays standalone, no client-types import. */
const TRIP_SUBCOLLECTIONS = [
  'schedules', 'expenses', 'wishes', 'bookings',
  'planning', 'settlements', 'settlementPairLocks',
  '_purges', 'invites', 'inviteState', 'members',
] as const

function readStringArray(fields: Record<string, unknown> | null, key: string): string[] {
  const value = fields?.[key] as FsValue | undefined
  return (value?.arrayValue?.values ?? [])
    .map(v => v.stringValue)
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
}

function docIdFromName(name: string): string | null {
  const id = name.split('/').pop()
  return id && id.length > 0 ? id : null
}

export interface CascadeTripResult {
  /** Total Firestore docs removed across all subcollections + the
   *  trip doc itself. Used by the client to surface a friendly
   *  «delete X items» toast. */
  deletedDocs:    number
  /** Storage objects deleted under `trips/{tripId}/*`. */
  deletedObjects: number
}

/** Drive the full trip cascade. Throws `CascadeError(status, message)`
 *  for the index.ts handler to translate to HTTP. */
export async function cascadeTripDelete(
  callerUid:          string,
  req:                TripDeleteRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<CascadeTripResult> {
  return withTokenRetry(() => runCascade(callerUid, req, serviceAccountJson, bucket))
}

async function runCascade(
  callerUid:          string,
  req:                TripDeleteRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<CascadeTripResult> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  // ── 1. Ownership check ────────────────────────────────────────
  // Idempotent path: trip doc missing → treat as already-deleted
  // success rather than 404. Client retries and concurrent deletes
  // both land here; throwing 404 would force the client to invent
  // recovery logic for a state that's exactly what they wanted.
  let tripFields: Record<string, unknown> | null
  try {
    tripFields = await getDocFields(accessToken, projectId, `trips/${req.tripId}`)
  } catch (e) {
    handleStepError('ownership read', e)
  }
  if (!tripFields) {
    return { deletedDocs: 0, deletedObjects: 0 }
  }
  const ownerId = readString(tripFields as Parameters<typeof readString>[0], 'ownerId')
  if (!ownerId) {
    throw new CascadeError(500, 'trip doc has no ownerId field')
  }
  if (ownerId !== callerUid) {
    throw new CascadeError(403, 'caller is not the trip owner')
  }
  const notificationCleanupUids = new Set(readStringArray(tripFields, 'memberIds'))
  // Token might have been invalidated above — re-fetch (cheap, cached)
  // so the rest of the run uses the freshest token. withTokenRetry will
  // retry the WHOLE cascade on 401, but that's the long path; this is
  // belt-and-suspenders for the common case.

  // ── 1.5. Write-quiesce: stamp `deletingAt` on the trip doc ────
  // Before draining anything, set a flag that the rules layer's
  // `tripNotDeleting(tripId)` helper checks on every subcollection
  // CREATE. This closes the race where an editor on another device
  // creates a new expense (or booking / etc.) BETWEEN the Worker's
  // subcollection-drain and trip-doc-delete steps -- without the
  // flag, that new doc would survive the cascade and become an
  // orphan that subsequent retries skip past (the trip-doc 404 path
  // is idempotent no-op).
  //
  // Idempotent: re-running this step on a doc that already has
  // deletingAt set just rewrites the same field shape. The flag
  // dies with the trip doc at the final step -- no clear step
  // needed. Client rules pin unchanged('deletingAt') on every trip
  // update path so editors can't tamper.
  try {
    const stamp: Record<string, FsValue> = {
      deletingAt: { timestampValue: new Date().toISOString() },
    }
    await updateDocFields(accessToken, projectId, `trips/${req.tripId}`, stamp)
  } catch (e) {
    handleStepError('write-quiesce stamp', e)
  }

  // ── 2. Storage purge ─────────────────────────────────────────
  // Run before Firestore so a Storage failure leaves the trip doc
  // intact → owner sees the trip, retries, and we converge. If we
  // wiped Firestore first and Storage failed, the user would see a
  // ghost trip-less directory in GCS with no UI to clean it up.
  //
  // TRAILING SLASH IS LOAD-BEARING. GCS `prefix=trips/abc` matches
  // BOTH `trips/abc/...` and `trips/abc2/...` (string starts-with,
  // no folder semantics). Without the slash, deleting trip "abc"
  // would also purge attachments of trip "abc2" / "abcdef" / etc.
  // The "/" pins the prefix to a single-trip boundary.
  let deletedObjects = 0
  try {
    deletedObjects = await purgeObjectsByPrefix(accessToken, bucket, `trips/${req.tripId}/`)
  } catch (e) {
    handleStepError('storage purge', e)
  }

  // ── 3. Subcollections ─────────────────────────────────────────
  let deletedDocs = 0
  for (const sub of TRIP_SUBCOLLECTIONS) {
    try {
      const names = await listDocNames(
        accessToken, projectId, `trips/${req.tripId}/${sub}`,
      )
      if (sub === 'members') {
        for (const name of names) {
          const uid = docIdFromName(name)
          if (uid) notificationCleanupUids.add(uid)
        }
      }
      if (names.length === 0) continue
      await batchDeleteDocs(accessToken, projectId, names)
      deletedDocs += names.length
    } catch (e) {
      handleStepError(`subcollection '${sub}'`, e)
    }
  }

  // ── 3.5. Final Storage sweep ─────────────────────────────────
  // Defence-in-depth against the upload-race window: storage.rules
  // checks `tripNotDeleting` cross-service, but rules eval against
  // Firestore is not strictly transactional with the cascade itself.
  // An upload that started just before step 1.5 stamped deletingAt
  // can still complete (its rule eval read the trip doc BEFORE the
  // stamp landed). A second sweep here catches those stragglers
  // BEFORE we delete the trip root -- after which storage.rules
  // tripNotDeleting would 500 (parent doc missing) and we'd lose
  // the ability to admin-purge cleanly.
  try {
    deletedObjects += await purgeObjectsByPrefix(
      accessToken, bucket, `trips/${req.tripId}/`,
    )
  } catch (e) {
    handleStepError('final storage sweep', e)
  }

  // ── 4. Trip doc itself ────────────────────────────────────────
  try {
    await deleteDoc(accessToken, projectId, `trips/${req.tripId}`)
    deletedDocs += 1
  } catch (e) {
    handleStepError('trip doc delete', e)
  }

  await mapWithConcurrency([...notificationCleanupUids], 3, async uid => {
    try {
      await deleteUserTripNotifications(accessToken, projectId, uid, req.tripId)
    } catch (e) {
      console.warn('trip notification cleanup failed', {
        tripId: req.tripId,
        uid,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  })

  return { deletedDocs, deletedObjects }
}

/** Translate a step failure into CascadeError. 401s are re-thrown
 *  unmodified so withTokenRetry can detect + invalidate + retry. */
function handleStepError(step: string, e: unknown): never {
  const msg = (e as Error).message ?? String(e)
  if (msg.includes(' -> 401') || msg.includes(' → 401')) {
    // Surface so withTokenRetry catches and retries once with fresh
    // admin token. invalidateAdminToken is also called by
    // withTokenRetry's catch path, no double-invalidate problem.
    invalidateAdminToken()
    throw e
  }
  throw new CascadeError(500, `trip cascade stopped at ${step}: ${msg.slice(0, 200)}`)
}
