// src/features/bookings/services/bookingStorage.ts
// Storage-side helpers for booking attachments. Split out from
// bookingService.ts so the read/write CRUD module isn't 400+ LOC of
// mixed concerns. Service-layer logic stays in bookingService; the
// "talk to Firebase Storage" code lives here.
import type { UploadMetadata } from 'firebase/storage'
import { getFirebaseStorage } from '@/services/firebase'
import { deleteStorageObject } from '@/services/storageDelete'
import { uploadFile, withUploadTimeout, UPLOAD_TIMEOUT_MS } from '@/services/storageUpload'
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

/** 8-char random id to keep each upload at a unique path. Without
 *  this, a same-mime replace (jpg → jpg) would collide on the fixed
 *  `file.jpg` filename: Storage upload silently overwrites the old
 *  blob, then the post-doc `purgeAttachments` of the OLD paths (also
 *  `file.jpg`) wipes the just-uploaded NEW blob, leaving the booking
 *  doc referencing a deleted file. Random suffix means new path ≠
 *  old path always, so the purge step only targets the genuinely-old
 *  blob. Mirrors the same fix in expenseStorage. */
function shortId(): string {
  return Math.random().toString(36).slice(2, 10)
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
  const id        = shortId()
  const filePath  = `${folder}/${id}.${extForMime(full.type)}`
  const thumbPath = thumb ? `${folder}/${id}.thumb.${extForMime(thumb.type)}` : undefined

  const { storage, ref, uploadBytesResumable, getDownloadURL } = await getFirebaseStorage()
  // Mirror expenseStorage: uploadBytesResumable + explicit timeout
  // avoids the iOS Safari single-multipart-POST stall that hangs
  // uploadBytes for the full 2-minute internal retry window.
  const fullMetadata: UploadMetadata = { contentType: full.type }
  const thumbMetadata: UploadMetadata | undefined = thumb ? { contentType: thumb.type } : undefined

  const [fullRef, thumbRef] = await Promise.all([
    retry(
      () => uploadFile(
        uploadBytesResumable(ref(storage, filePath), full, fullMetadata),
        'booking-full',
        UPLOAD_TIMEOUT_MS,
      ),
      { shouldRetry: isTransientStorageError },
    ),
    thumb && thumbPath && thumbMetadata
      ? retry(
          () => uploadFile(
            uploadBytesResumable(ref(storage, thumbPath), thumb, thumbMetadata),
            'booking-thumb',
            UPLOAD_TIMEOUT_MS,
          ),
          { shouldRetry: isTransientStorageError },
        )
      : Promise.resolve(null),
  ])
  const [fileUrl, thumbUrl] = await Promise.all([
    withUploadTimeout(getDownloadURL(fullRef), UPLOAD_TIMEOUT_MS, 'getDownloadURL(booking-full)'),
    thumbRef
      ? withUploadTimeout(getDownloadURL(thumbRef), UPLOAD_TIMEOUT_MS, 'getDownloadURL(booking-thumb)')
      : Promise.resolve(undefined),
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
