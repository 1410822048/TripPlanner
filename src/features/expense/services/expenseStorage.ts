// src/features/expense/services/expenseStorage.ts
// Storage-side helpers for expense receipts. Same shape and retry
// pattern as bookingStorage — pulled into a sibling rather than fully
// generalised because the path layout and result shape differ enough
// to make a single helper hide more than it shares (booking uses
// fileUrl/filePath/fileType keys, expense uses ExpenseReceipt's
// url/path/type/thumb*). A future consolidation could thread a
// "shape mapper" through, but two callers don't justify the indirection.

import type { UploadMetadata } from 'firebase/storage'
import { getFirebaseStorage } from '@/services/firebase'
import { deleteStorageObject } from '@/services/storageDelete'
import { uploadFile, withUploadTimeout, UPLOAD_TIMEOUT_MS } from '@/services/storageUpload'
import { compressImage } from '@/utils/image'
import { retry, isTransientStorageError } from '@/utils/retry'
import type { ExpenseReceipt } from '@/types'

/** Pick a sensible filename extension from the (post-compression) mime type. */
function extForMime(mime: string): string {
  if (mime === 'image/webp')      return 'webp'
  if (mime === 'image/jpeg')      return 'jpg'
  if (mime === 'image/png')       return 'png'
  if (mime === 'image/heic')      return 'heic'
  if (mime === 'image/heif')      return 'heif'
  if (mime === 'application/pdf') return 'pdf'
  return 'bin'
}

/** 8-char random id to keep each upload at a unique path. Without
 *  this, a same-mime replace (webp → webp) would collide on the
 *  fixed `receipt.webp` filename: Storage upload silently
 *  overwrites the old blob, then the post-Worker `purgeReceipt`
 *  of the OLD paths (also `receipt.webp`) wipes the just-uploaded
 *  NEW blob, leaving the Firestore doc referencing a deleted file.
 *  Random suffix means new path ≠ old path always, so the purge
 *  step targets only the genuinely-old blob. */
function shortId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Upload a receipt + (when image) its thumbnail. Returns the
 * ExpenseReceipt doc shape ready to write on the expense.
 * Storage layout: `trips/{tripId}/expenses/{expenseId}/{id}.{ext}`
 * and `{id}.thumb.{ext}` -- the per-upload random `id` prevents
 * same-mime-replace collisions (see comment on shortId above).
 */
export async function uploadReceipt(
  tripId: string,
  expenseId: string,
  file: File,
): Promise<ExpenseReceipt> {
  const { full, thumb } = await compressImage(file)

  const folder    = `trips/${tripId}/expenses/${expenseId}`
  const id        = shortId()
  const path      = `${folder}/${id}.${extForMime(full.type)}`
  const thumbPath = thumb ? `${folder}/${id}.thumb.${extForMime(thumb.type)}` : undefined

  const { storage, ref, uploadBytesResumable, getDownloadURL } = await getFirebaseStorage()

  // retry wraps the entire resumable upload — if a chunk fails transiently,
  // we retry the whole upload. uploadBytesResumable internally handles
  // chunk-level retries too, but the outer retry catches harder failures
  // (auth token refresh window, ephemeral DNS, etc.).
  const fullMetadata: UploadMetadata = { contentType: full.type }
  const thumbMetadata: UploadMetadata | undefined = thumb ? { contentType: thumb.type } : undefined

  const [fullRef, thumbRef] = await Promise.all([
    retry(
      () => uploadFile(
        uploadBytesResumable(ref(storage, path), full, fullMetadata),
        'full',
        UPLOAD_TIMEOUT_MS,
      ),
      { shouldRetry: isTransientStorageError },
    ),
    thumb && thumbPath && thumbMetadata
      ? retry(
          () => uploadFile(
            uploadBytesResumable(ref(storage, thumbPath), thumb, thumbMetadata),
            'thumb',
            UPLOAD_TIMEOUT_MS,
          ),
          { shouldRetry: isTransientStorageError },
        )
      : Promise.resolve(null),
  ])

  const [url, thumbUrl] = await Promise.all([
    withUploadTimeout(getDownloadURL(fullRef), UPLOAD_TIMEOUT_MS, 'getDownloadURL(full)'),
    thumbRef
      ? withUploadTimeout(getDownloadURL(thumbRef), UPLOAD_TIMEOUT_MS, 'getDownloadURL(thumb)')
      : Promise.resolve(undefined),
  ])

  const receipt: ExpenseReceipt = { url, path, type: full.type }
  if (thumbUrl && thumbPath) {
    receipt.thumbUrl  = thumbUrl
    receipt.thumbPath = thumbPath
  }
  return receipt
}

/** Delete both variants of a receipt — full + thumb. PDFs only have
 *  a full path; deleteStorageObject tolerates already-deleted paths. */
export async function purgeReceipt(existing: {
  path?:      string
  thumbPath?: string
}): Promise<void> {
  const tasks: Promise<void>[] = []
  if (existing.path)      tasks.push(deleteStorageObject(existing.path))
  if (existing.thumbPath) tasks.push(deleteStorageObject(existing.thumbPath))
  await Promise.all(tasks)
}
