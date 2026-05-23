// src/features/expense/services/expenseStorage.ts
// Phase 3.5: Worker-issued upload intent flow. Helper no longer
// decides path / metadata client-side -- it requests intents, uploads
// to the server-minted paths, and returns the intentIds + paths.
//
// Why this shape: the Worker's /expense-create + /expense-update
// consume intentIds in the same Firestore transaction as the
// expense doc write (no separate /upload-finalize round-trip), so
// the helper hands off intentIds to the service caller. `paths` are
// kept on the client side for `safePurgeWithEnqueueFallback` rollback
// -- if the Worker rejects (definitive 4xx) or the post-upload
// Worker call is ambiguous (timeout / 5xx), the service layer can
// still address each blob for purge without re-deriving the path
// from the (rejected) intent.
//
// compressImage still runs client-side -- the Worker doesn't touch
// bytes, it only mints policy. PDF receipts skip thumbnail generation
// (compressImage returns `{ full }` only); image receipts produce
// both full + thumb and upload in parallel.

import { compressImage } from '@/utils/image'
import {
  requestUploadIntents,
  uploadToIntent,
  type IntentKind,
  type UploadIntent,
  type UploadIntentsRequest,
} from '@/services/uploadIntent'
import { deleteStorageObject } from '@/services/storageDelete'

/** Returned by `uploadReceipt` -- the service caller passes `intentIds`
 *  to the Worker (`/expense-create` or `/expense-update`) and keeps
 *  `paths` for rollback via `safePurgeWithEnqueueFallback` on Worker
 *  rejection / timeout. */
export interface UploadedReceiptIntents {
  intentIds: string[]
  paths:     string[]
}

/**
 * Upload a receipt + (when image) its thumbnail via the Worker-issued
 * intent flow. Returns intentIds for the Worker call and paths for
 * client-side rollback. No path / metadata authoring happens here --
 * the Worker mints both at intent-request time.
 */
export async function uploadReceipt(
  tripId:    string,
  expenseId: string,
  file:      File,
): Promise<UploadedReceiptIntents> {
  const { full, thumb } = await compressImage(file)

  // Build the intent batch. Primary blob's kind depends on contentType
  // (PDF stays as PDF; everything else is treated as a "full" image).
  // The Worker re-validates -- kind 'pdf' requires `application/pdf`,
  // kind 'full' rejects PDFs -- so a wrong pairing here surfaces as a
  // 400 from /upload-intents rather than a silent upload that fails
  // later at the rules layer.
  const primaryKind: IntentKind = full.type === 'application/pdf' ? 'pdf' : 'full'
  const uploads: UploadIntentsRequest['uploads'] = [
    { kind: primaryKind, contentType: full.type, size: full.size },
  ]
  if (thumb) {
    uploads.push({ kind: 'thumb', contentType: thumb.type, size: thumb.size })
  }

  const intents = await requestUploadIntents({
    tripId, entityType: 'expense', entityId: expenseId, uploads,
  })
  // Order is preserved -- Worker returns intents in the same order
  // as the request's `uploads` array. Index 0 is the primary, index
  // 1 is the thumb (when present).
  const fullIntent  = intents[0]!
  const thumbIntent = thumb ? intents[1] : undefined

  // Parallel upload. Either succeeds or any failure throws; partial
  // upload doesn't strand intents because the Worker's purge cron
  // expires unused 'pending' intents past their 30-min TTL anyway.
  await Promise.all([
    uploadToIntent(fullIntent, full, 'expense-full'),
    thumb && thumbIntent
      ? uploadToIntent(thumbIntent, thumb, 'expense-thumb')
      : Promise.resolve(),
  ])

  return {
    intentIds: intents.map(i => i.intentId),
    paths:     intents.map(i => i.path),
  }
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
