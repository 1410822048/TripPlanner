// src/features/expense/services/expenseStorage.ts
// Phase 3.5: Worker-issued upload intent flow. Helper no longer
// decides path / metadata client-side -- it delegates to the shared
// `mintAndUploadEntityIntents` primitive and returns intentIds + paths
// in the shape the expense service needs.
//
// Why this shape: the Worker's /expense-create + /expense-update
// consume intentIds in the same Firestore transaction as the
// expense doc write (no separate finalize round-trip), so
// the helper hands off intentIds to the service caller. `paths` are
// kept on the client side for `safePurgeWithEnqueueFallback` rollback
// -- if the Worker rejects (definitive 4xx) or the post-upload
// Worker call is ambiguous (timeout / 5xx), the service layer can
// still address each blob for purge without re-deriving the path
// from the (rejected) intent.
//
// compressReceiptImage still runs client-side -- the Worker doesn't touch
// bytes, it only mints policy. PDF receipts skip thumbnail generation
// (compressReceiptImage returns `{ full }` only); image receipts produce
// both full + thumb and upload in parallel.

import { compressReceiptImage } from '@/utils/image'
import { mintAndUploadEntityIntents } from '@/services/uploadIntentEntity'
import { type UploadIntent } from '@/services/uploadIntent'
import { deleteStorageObject } from '@/services/storageDelete'

/** Returned by `uploadReceipt` -- the service caller passes `intentIds`
 *  to the Worker (`/expense-create` or `/expense-update`) and keeps
 *  `paths` for rollback via `safePurgeWithEnqueueFallback` on Worker
 *  rejection / timeout. `traceId` is the upload-flow correlation id
 *  that must be forwarded to the entity-write `workerFetch` so the
 *  same `X-Upload-Trace-Id` value ties the two calls together in
 *  Sentry breadcrumbs + Worker logs. */
export interface UploadedReceiptIntents {
  intentIds: string[]
  paths:     string[]
  traceId:   string
}

/**
 * Upload a receipt + (when image) its thumbnail via the Worker-issued
 * intent flow. Returns intentIds for the Worker call, paths for
 * client-side rollback, AND the per-flow traceId to forward to the
 * entity-write workerFetch. No `mode` -- expense doesn't carry the
 * wish proposer-check distinction (Worker authzUpload uses the
 * canWrite-only path for entityType 'expense').
 */
export async function uploadReceipt(
  tripId:    string,
  expenseId: string,
  file:      File,
): Promise<UploadedReceiptIntents> {
  const compressed = await compressReceiptImage(file)
  return await mintAndUploadEntityIntents({
    tripId, entityType: 'expense', entityId: expenseId, compressed,
  })
}

/**
 * Delete the receipt's full + thumb storage objects. Tolerates
 * already-deleted paths; the underlying `deleteStorageObject` retries
 * transient failures internally and the calling site (service-layer
 * `safePurgeWithEnqueueFallback`) handles unrecoverable failures
 * via the `_purges` queue.
 *
 * Accepts both the legacy `{ path, thumbPath }` shape (for any
 * receipt already stored in Firestore) AND the array shape returned
 * by `uploadReceipt` on a fresh upload. Internal call sites can use
 * either without an adapter layer.
 */
export async function purgeReceipt(existing: {
  path?:      string
  thumbPath?: string
} | { paths: string[] }): Promise<void> {
  const tasks: Promise<void>[] = []
  if ('paths' in existing) {
    for (const p of existing.paths) {
      if (p) tasks.push(deleteStorageObject(p))
    }
  } else {
    if (existing.path)      tasks.push(deleteStorageObject(existing.path))
    if (existing.thumbPath) tasks.push(deleteStorageObject(existing.thumbPath))
  }
  await Promise.all(tasks)
}

/** Re-export the UploadIntent type for service callers that want to
 *  consume intent metadata directly (rare; mostly tests). */
export type { UploadIntent }
