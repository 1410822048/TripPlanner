// src/features/bookings/services/bookingStorage.ts
// Storage-side helpers for booking attachments. Split out from
// bookingService.ts so the read/write CRUD module isn't 400+ LOC of
// mixed concerns. Service-layer logic stays in bookingService; the
// "talk to Firebase Storage" code lives here.
import { getFirebaseStorage } from '@/services/firebase'
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

export interface UploadResult {
  fileUrl:    string
  filePath:   string
  thumbUrl?:  string
  thumbPath?: string
  fileType:   string
}

/**
 * Upload an attachment + (when applicable) its thumbnail variant. Returns
 * the URLs and paths so the caller can persist them on the booking doc.
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
): Promise<UploadResult> {
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
 * Delete a Storage object by path. Swallows "object not found" — the doc
 * may reference a path that's already been cleaned up by a prior failed
 * attempt, and the caller cares only about the post-condition.
 */
async function deleteAttachment(filePath: string): Promise<void> {
  const { storage, ref, deleteObject } = await getFirebaseStorage()
  try {
    await deleteObject(ref(storage, filePath))
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'storage/object-not-found') return
    throw e
  }
}

/**
 * Delete the full + thumb storage objects for an existing attachment.
 * Either path may be missing (PDF has no thumb; older bookings have no
 * thumb at all) — deleteAttachment tolerates that.
 */
export async function purgeAttachments(existing: {
  filePath?: string
  thumbPath?: string
}): Promise<void> {
  const tasks: Promise<void>[] = []
  if (existing.filePath)  tasks.push(deleteAttachment(existing.filePath))
  if (existing.thumbPath) tasks.push(deleteAttachment(existing.thumbPath))
  await Promise.all(tasks)
}
