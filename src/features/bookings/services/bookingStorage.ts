// src/features/bookings/services/bookingStorage.ts
// Storage-side helpers for booking attachments. Split out from
// bookingService.ts so the read/write CRUD module isn't 400+ LOC of
// mixed concerns. Service-layer logic stays in bookingService; the
// "talk to Firebase Storage" code lives here.
import { getFirebaseStorage } from '@/services/firebase'
import { deleteStorageObject } from '@/services/storageDelete'
import type { BookingAttachment } from '@/types'
import { compressImage } from '@/utils/image'
import { retry, isTransientStorageError } from '@/utils/retry'

/** Pick a sensible filename extension from the (post-compression) mime type. */
function extForMime(mime: string): string {
  if (mime === 'image/webp')   return 'webp'
  if (mime === 'image/jpeg')   return 'jpg'
  if (mime === 'image/png')    return 'png'
  if (mime === 'image/heic')   return 'heic'
  if (mime === 'image/heif')   return 'heif'
  if (mime === 'application/pdf') return 'pdf'
  return 'bin'
}

/**
 * Upload an attachment + (when applicable) its thumbnail variant. Returns
 * a `BookingAttachment` ready to assign directly to the booking doc.
 *
 * For images: full-size (1920px) and a 192px thumb are uploaded in
 * parallel. For PDFs / HEIC pass-throughs: only the full file is uploaded
 * — the list row will fall back to the type emoji for the leading slot.
 *
 * Each upload is wrapped in `retry()` so transient network blips (common
 * on flaky travel Wi-Fi) don't surface as user-visible failures.
 * Non-transient errors (auth, quota, validation) bail out immediately
 * via the isTransientStorageError predicate.
 */
export async function uploadAttachment(
  tripId: string,
  bookingId: string,
  file: File,
): Promise<BookingAttachment> {
  const { full, thumb } = await compressImage(file)
  const folder = `trips/${tripId}/bookings/${bookingId}`
  const filePath  = `${folder}/file.${extForMime(full.type)}`
  const thumbPath = thumb ? `${folder}/thumb.${extForMime(thumb.type)}` : undefined

  const { storage, ref, uploadBytes, getDownloadURL } = await getFirebaseStorage()
  const [fullSnap, thumbSnap] = await Promise.all([
    retry(
      () => uploadBytes(ref(storage, filePath), full, { contentType: full.type }),
      { shouldRetry: isTransientStorageError },
    ),
    thumb
      ? retry(
          () => uploadBytes(ref(storage, thumbPath!), thumb, { contentType: thumb.type }),
          { shouldRetry: isTransientStorageError },
        )
      : Promise.resolve(null),
  ])
  const [fileUrl, thumbUrl] = await Promise.all([
    getDownloadURL(fullSnap.ref),
    thumbSnap ? getDownloadURL(thumbSnap.ref) : Promise.resolve(undefined),
  ])
  return { fileUrl, filePath, thumbUrl, thumbPath, fileType: full.type }
}

/**
 * Delete the full + thumb storage objects for an existing attachment.
 * Thumb path may be missing on PDFs — deleteStorageObject tolerates that
 * along with already-deleted objects.
 */
export async function purgeAttachments(
  existing: BookingAttachment | undefined,
): Promise<void> {
  if (!existing) return
  const tasks: Promise<void>[] = [deleteStorageObject(existing.filePath)]
  if (existing.thumbPath) tasks.push(deleteStorageObject(existing.thumbPath))
  await Promise.all(tasks)
}
