// src/features/bookings/services/bookingStorage.ts
// Phase 3.5: Worker-issued upload intent flow. The wrapper requests
// intents, uploads to the server-minted paths, calls /upload-finalize
// to mark intents used + receive the download URLs, then assembles
// the BookingAttachment shape the booking doc expects.
//
// Why intent flow + finalize (and not the expense pattern of "Worker
// consumes intents inline with the doc write"): booking docs are
// written client-side via setDoc, so the Worker chokepoint pattern
// would require turning bookingService.createBooking into a Worker
// endpoint -- a much larger refactor than Phase 3.5 wants. Finalize
// gives us back the blob URLs + sizes so the client can complete
// the booking doc write itself.

import type { BookingAttachment } from '@/types'
import { compressImage } from '@/utils/image'
import {
  requestUploadIntents,
  uploadToIntent,
  finalizeUploadIntents,
  type IntentKind,
  type UploadIntentsRequest,
} from '@/services/uploadIntent'
import { deleteStorageObject } from '@/services/storageDelete'

/**
 * Upload an attachment + (when applicable) its thumbnail. Returns a
 * `BookingAttachment` ready to assign on a booking doc.
 *
 * For images: full-size + 192px thumb uploaded in parallel. For PDFs:
 * only the full file; the list row falls back to the type emoji.
 *
 * Failure modes:
 *   - requestUploadIntents rejects → throws to caller, no storage
 *     side effects, nothing to clean.
 *   - uploadToIntent rejects → some intents may have landed in
 *     Storage; the Worker's intent-expiry cron + orphan-storage-scan
 *     will reclaim them on their own 24h+ grace windows.
 *   - finalizeUploadIntents rejects → storage objects exist but
 *     intents stay 'pending'; same cron + scan handle cleanup.
 *
 * All three failure paths surface as a thrown error to the calling
 * service layer; downstream rollback (e.g. createBooking's
 * safePurgeWithEnqueueFallback) doesn't apply here because we don't
 * yet hold paths at the point requestUploadIntents fails, and the
 * intent flow's own retention policies guarantee eventual cleanup.
 */
export async function uploadAttachment(
  tripId:    string,
  bookingId: string,
  file:      File,
): Promise<BookingAttachment> {
  const { full, thumb } = await compressImage(file)

  const primaryKind: IntentKind = full.type === 'application/pdf' ? 'pdf' : 'full'
  const uploads: UploadIntentsRequest['uploads'] = [
    { kind: primaryKind, contentType: full.type, size: full.size },
  ]
  if (thumb) {
    uploads.push({ kind: 'thumb', contentType: thumb.type, size: thumb.size })
  }

  const intents = await requestUploadIntents({
    tripId, entityType: 'booking', entityId: bookingId, uploads,
  })
  const fullIntent  = intents[0]!
  const thumbIntent = thumb ? intents[1] : undefined

  await Promise.all([
    uploadToIntent(fullIntent, full, 'booking-full'),
    thumb && thumbIntent
      ? uploadToIntent(thumbIntent, thumb, 'booking-thumb')
      : Promise.resolve(),
  ])

  const finalize = await finalizeUploadIntents(intents.map(i => i.intentId))
  // Worker guarantees same-order blobs as the requested intentIds;
  // we lookup by kind for safety against any future reordering.
  const fullBlob  = finalize.blobs.find(b => b.kind === primaryKind)
  const thumbBlob = finalize.blobs.find(b => b.kind === 'thumb')
  if (!fullBlob) {
    // Worker accepted the request but returned no primary blob -- a
    // contract violation. Worker code should reject thumb-only sets
    // at /upload-finalize, but defense-in-depth here in case that
    // gate ever regresses.
    throw new Error('finalizeUploadIntents returned no primary blob')
  }
  if (!fullBlob.url) {
    // Firebase Storage SDK upload should always add a download token.
    // Missing token means the upload landed via a non-SDK path that
    // we don't support.
    throw new Error('finalize response missing download URL for primary blob')
  }
  const attachment: BookingAttachment = {
    fileUrl:  fullBlob.url,
    filePath: fullBlob.path,
    fileType: fullBlob.contentType,
  }
  if (thumbBlob) {
    if (!thumbBlob.url) {
      throw new Error('finalize response missing download URL for thumb blob')
    }
    attachment.thumbUrl  = thumbBlob.url
    attachment.thumbPath = thumbBlob.path
  }
  return attachment
}

/**
 * Delete the full + thumb storage objects for an existing attachment.
 * Thumb path may be missing on PDFs -- deleteStorageObject tolerates
 * that along with already-deleted objects.
 */
export async function purgeAttachments(
  existing: BookingAttachment | undefined,
): Promise<void> {
  if (!existing) return
  const tasks: Promise<void>[] = [deleteStorageObject(existing.filePath)]
  if (existing.thumbPath) tasks.push(deleteStorageObject(existing.thumbPath))
  await Promise.all(tasks)
}
