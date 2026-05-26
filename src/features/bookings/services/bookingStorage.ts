// src/features/bookings/services/bookingStorage.ts
// Phase 3.5 + 3.6: Worker-issued upload intent flow. The wrapper
// requests intents, uploads to the server-minted paths, and calls
// /upload-finalize. From Phase 3.6 onward the Worker is the
// authoritative writer for booking.attachment -- /upload-finalize
// patches the doc atomically with the intent markUsed writes, so
// this wrapper returns void and the booking doc's attachment field
// shows up via the realtime listener.
//
// `expectedCurrentPath` lets the Worker detect drift between upload
// and finalize: caller passes the path the booking is currently
// pointing at (null for first-attach / doc-first create). Tab A's
// finalize after Tab B already replaced the attachment gets
// 409 stale-finalize and surfaces back here as a thrown error.
//
// Why intent flow + Worker-finalize (rather than the expense pattern
// of "Worker consumes intents inline with the doc write"): booking
// docs are written client-side via setDoc, so the Worker chokepoint
// pattern would require turning bookingService.createBooking into a
// Worker endpoint -- a much larger refactor than Phase 3.6 wants.
// The doc-first + Worker-finalize-patches split keeps the booking
// text edits client-side while making attachment field tamper-proof.

import { compressImage } from '@/utils/image'
import {
  requestUploadIntents,
  uploadToIntent,
  finalizeUploadIntents,
  type IntentKind,
  type UploadIntentsRequest,
} from '@/services/uploadIntent'
import { deleteStorageObject } from '@/services/storageDelete'
import type { BookingAttachment } from '@/types'

/**
 * Upload an attachment + (when applicable) its thumbnail and let the
 * Worker patch `booking.attachment` directly. Returns void; the
 * realtime listener surfaces the patched attachment to the client.
 *
 * For images: full-size + 192px thumb uploaded in parallel. For PDFs:
 * only the full file; the list row falls back to the type emoji.
 *
 * `expectedCurrentPath`:
 *   - `null`   → first-attach flow (doc-first create or post-detach
 *                re-attach). Worker expects `attachment` to be absent
 *                on the booking doc at finalize time.
 *   - string   → replace flow (caller passes existing.filePath).
 *                Worker rejects with 409 if the booking's actual
 *                current path differs.
 *
 * Failure modes:
 *   - requestUploadIntents rejects → throws to caller, no storage
 *     side effects, nothing to clean.
 *   - uploadToIntent rejects → some intents may have landed in
 *     Storage; the Worker's intent-expiry cron + orphan-storage-scan
 *     reclaim them on their own 24h+ grace windows.
 *   - finalizeUploadIntents rejects → storage objects exist but
 *     intents stay 'pending' (Worker tx rolled back). Same cron +
 *     scan handle cleanup. Booking doc is left unmodified (Worker is
 *     the only writer for `attachment` in Phase 3.6).
 *
 * All three failure paths surface as a thrown error to the calling
 * service layer; the booking doc's attachment field is either
 * untouched (Worker fail) or fully written (Worker success) -- no
 * partial state for the client to assemble.
 */
export async function uploadAttachment(
  tripId:              string,
  bookingId:           string,
  file:                File,
  expectedCurrentPath: string | null,
): Promise<void> {
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

  await finalizeUploadIntents(tripId, intents.map(i => i.intentId), {
    mode: 'patch',
    expectedCurrentPath,
  })
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
