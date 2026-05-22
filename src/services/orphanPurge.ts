// src/services/orphanPurge.ts
// Level 3 orphan-blob durability: when an in-process purge.catch finally
// gives up (after `deleteStorageObject`'s internal retry budget), we
// enqueue a record in `trips/{tripId}/_purges/{auto}` for the daily
// Worker cron to retry later. This closes the residual PII window where
// a permanent purge failure used to mean "blob lives until trip delete".
//
// Design:
//   - One queue doc per path (not per entity event). Retry granularity
//     stays at the individual blob — a thumb-only failure doesn't pull
//     the already-deleted full blob back into another delete attempt.
//   - `entityRef` lets the cron do an O(1) "is this path still
//     referenced?" check before deleting (race protection: between
//     enqueue and cron drain, the user may have re-uploaded the same
//     blob, making it no longer orphan).
//   - Member-side create only (rules enforce path-within-trip +
//     entityRef-within-trip). Worker handles update/delete via admin
//     SDK so a malicious member can't rapid-delete queue entries to
//     defeat cleanup.
//
// See `workers/ocr/src/orphan-purge.ts` for the drain side.

import { getFirebase } from './firebase'
import { P } from './paths'
import { captureError } from './sentry'

/**
 * Subset of entity collections the orphan cron knows how to verify
 * against. Keep in sync with the `entityRef` regex in firestore.rules
 * (`_purges` create) and the cron's path-still-referenced check.
 */
/** Collections whose entities carry a Storage path field the orphan
 *  cron knows how to verify against. Schedules deliberately excluded
 *  -- they don't store attachments today, and allowing them through
 *  would create a "borrow-the-blade" attack (see firestore.rules). */
export type OrphanEntityCollection =
  | 'expenses'
  | 'bookings'
  | 'wishes'

export interface EnqueueOrphanPurgeInput {
  /** Trip the orphan blob lives under. */
  tripId:     string
  /** Collection name the blob's owning entity belongs to. */
  collection: OrphanEntityCollection
  /** Entity doc id under `trips/{tripId}/{collection}/`. */
  entityId:   string
  /** Storage paths to delete. Typically 1-2 (full + thumb). */
  paths:      string[]
  /** Free-form context tag — e.g. `updateExpense/purge-old-receipt`.
   *  Surfaces in cron logs + Sentry when the cron itself escalates. */
  source:     string
}

/**
 * Write one queue doc per path. Best-effort across the batch — if one
 * path's enqueue rejects we still try the others; the caller decides
 * what to do with the partial-failure case (typically: capture all
 * rejections in Sentry, accept residual orphan on the failed paths).
 *
 * Returns the array of doc-ref ids written (success only).
 */
export async function enqueueOrphanPurges(
  input: EnqueueOrphanPurgeInput,
): Promise<string[]> {
  if (input.paths.length === 0) return []
  const { db, collection, doc, setDoc, serverTimestamp } = await getFirebase()
  const entityRef = `trips/${input.tripId}/${input.collection}/${input.entityId}`

  const results = await Promise.allSettled(input.paths.map(async path => {
    const ref = doc(collection(db, ...P.purges(input.tripId)))
    await setDoc(ref, {
      tripId:    input.tripId,
      entityRef,
      path,
      source:    input.source,
      attempts:  0,
      createdAt: serverTimestamp(),
    })
    return ref.id
  }))

  const ids: string[] = []
  const errors: unknown[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') ids.push(r.value)
    else errors.push(r.reason)
  }
  if (errors.length > 0) {
    // Throw on ANY enqueue failure, partial or full. Without this a
    // 1-of-2 failure (e.g. thumb enqueue rejected) would silently
    // return only the successful id and the wrapper would Sentry
    // nothing -- meaning the orphan blob whose enqueue failed lives
    // forever with no retry, no signal. Successful ids are still in
    // the queue and will drain normally; we only need to alert about
    // the missed paths.
    throw new EnqueueOrphanPurgeError(input.paths.length, errors, ids)
  }
  return ids
}

/** Thrown when at least one path failed to enqueue. Carries the
 *  count + the individual rejection reasons + the ids that DID
 *  enqueue so the caller can structure Sentry context if it wants
 *  to differentiate full-fail from partial-fail. */
export class EnqueueOrphanPurgeError extends Error {
  readonly totalPaths:    number
  readonly causes:        unknown[]
  readonly succeededIds:  string[]
  constructor(totalPaths: number, causes: unknown[], succeededIds: string[]) {
    super(
      `enqueueOrphanPurges: ${causes.length}/${totalPaths} paths failed ` +
      `(${succeededIds.length} succeeded)`,
    )
    this.name = 'EnqueueOrphanPurgeError'
    this.totalPaths   = totalPaths
    this.causes       = causes
    this.succeededIds = succeededIds
  }
}

/**
 * Outcome of `safePurgeWithEnqueueFallback`. Tri-state so destructive
 * delete paths (deleteBooking / deleteWish) can branch on
 * `unrecoverable` and refuse to delete the owning doc — otherwise
 * we'd lose the attachment.path → blob binding permanently and the
 * orphan-blob cron would have nothing to verify against, leaving the
 * bytes billing forever with zero recovery path.
 *
 *   - `purged`        — in-process delete succeeded; nothing queued.
 *   - `queued`        — purge failed but `_purges` enqueue OK; cron
 *                       will drain on the next scheduled run. Caller
 *                       is safe to proceed with downstream deletes.
 *   - `unrecoverable` — both purge and enqueue rejected. Caller MUST
 *                       decide:
 *                         * non-destructive (create/update rollback
 *                           or success-path old-blob purge): accept,
 *                           Sentry already alerted, original op
 *                           result stands;
 *                         * destructive (deleteBooking/deleteWish):
 *                           THROW before deleting the doc, so a
 *                           human-driven retry has a chance.
 */
export type SafePurgeResult = 'purged' | 'queued' | 'unrecoverable'

/**
 * Canonical "best-effort purge with durable fallback" wrapper used by
 * every service that has a post-doc cleanup catch. The escalation
 * ladder:
 *
 *   1. `purge()` runs (already retries transient failures internally
 *      via deleteStorageObject's `retry()` wrapper).
 *   2. On permanent purge failure, enqueue a `_purges` entry so the
 *      Worker cron retries asynchronously. Successful enqueue = the
 *      caller's blob has a durable cleanup path; no Sentry noise.
 *   3. Only when BOTH purge and enqueue fail do we Sentry the
 *      compound failure -- that's the genuine "PII orphan stranded
 *      with no automated recovery" alert -- AND return
 *      `'unrecoverable'` so destructive callers can refuse to proceed
 *      with the owning-doc delete (without the doc, the blob's path
 *      is unknown to any future cleanup attempt).
 *
 * Sentry context carries the original purge error message so the
 * operator can see "what tried to delete what" without having to
 * cross-reference the source tag against the service code.
 */
export async function safePurgeWithEnqueueFallback(args: {
  purge:   () => Promise<void>
  enqueue: EnqueueOrphanPurgeInput
  sentry:  Record<string, unknown>
}): Promise<SafePurgeResult> {
  try {
    await args.purge()
    return 'purged'
  } catch (cleanupErr) {
    try {
      await enqueueOrphanPurges(args.enqueue)
      return 'queued'
    } catch (enqueueErr) {
      captureError(enqueueErr, {
        ...args.sentry,
        original: String((cleanupErr as Error)?.message ?? cleanupErr),
      })
      return 'unrecoverable'
    }
  }
}
