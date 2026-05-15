// src/features/expense/services/expenseStorage.ts
// Storage-side helpers for expense receipts. Same shape and retry
// pattern as bookingStorage — pulled into a sibling rather than fully
// generalised because the path layout and result shape differ enough
// to make a single helper hide more than it shares (booking uses
// fileUrl/filePath/fileType keys, expense uses ExpenseReceipt's
// url/path/type/thumb*). A future consolidation could thread a
// "shape mapper" through, but two callers don't justify the indirection.

import type { UploadTask, StorageReference, UploadMetadata, StorageError } from 'firebase/storage'
import { getFirebaseStorage } from '@/services/firebase'
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

/** Race a promise against a timeout. Throws after `ms` if the underlying
 *  operation hasn't resolved — used to escape Firebase Storage's 2-minute
 *  internal retry loop when something has actually gone wrong (CORS,
 *  network blackhole, etc.) instead of stranding the user on "保存中". */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const UPLOAD_TIMEOUT_MS = 30_000

/**
 * Wrap an UploadTask in a Promise<StorageReference> that resolves on
 * upload completion and rejects on timeout.
 *
 * Why uploadBytesResumable over uploadBytes:
 *   uploadBytes uses a single multipart POST. iOS Safari + Firebase
 *   Storage have a recurring issue where this POST stalls partway and
 *   the SDK's internal retry loop fails to detect the stall, leaving
 *   the upload promise hanging for the full 2-minute maxOperationRetryTime.
 *   uploadBytesResumable uses chunked PUT requests with explicit
 *   completion/error events — we can subscribe and time out reliably.
 *
 * Errors propagate to the mutation's onError handler (toast + rollback)
 * + Sentry via captureError upstream. No console logging needed.
 */
function uploadFile(
  task:    UploadTask,
  label:   string,
  timeoutMs: number,
): Promise<StorageReference> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // task.cancel() is synchronous and returns a bool indicating whether
      // a running task was actually cancelled. We don't care about the
      // return — the reject below propagates regardless.
      try { task.cancel() } catch { /* best-effort */ }
      reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    task.on(
      'state_changed',
      undefined,
      (err: StorageError) => {
        clearTimeout(timer)
        reject(err)
      },
      () => {
        clearTimeout(timer)
        resolve(task.snapshot.ref)
      },
    )
  })
}

/**
 * Upload a receipt + (when image) its thumbnail. Returns the
 * ExpenseReceipt doc shape ready to write on the expense.
 * Storage layout: `trips/{tripId}/expenses/{expenseId}/{receipt,thumb}.ext`
 */
export async function uploadReceipt(
  tripId: string,
  expenseId: string,
  file: File,
): Promise<ExpenseReceipt> {
  const { full, thumb } = await compressImage(file)

  const folder    = `trips/${tripId}/expenses/${expenseId}`
  const path      = `${folder}/receipt.${extForMime(full.type)}`
  const thumbPath = thumb ? `${folder}/thumb.${extForMime(thumb.type)}` : undefined

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
    withTimeout(getDownloadURL(fullRef), UPLOAD_TIMEOUT_MS, 'getDownloadURL(full)'),
    thumbRef
      ? withTimeout(getDownloadURL(thumbRef), UPLOAD_TIMEOUT_MS, 'getDownloadURL(thumb)')
      : Promise.resolve(undefined),
  ])

  const receipt: ExpenseReceipt = { url, path, type: full.type }
  if (thumbUrl && thumbPath) {
    receipt.thumbUrl  = thumbUrl
    receipt.thumbPath = thumbPath
  }
  return receipt
}

/** Delete a single Storage object. Swallows "object not found" so
 *  re-runs after a partial failure are safe. */
async function deleteObjectAt(filePath: string): Promise<void> {
  const { storage, ref, deleteObject } = await getFirebaseStorage()
  try {
    await deleteObject(ref(storage, filePath))
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'storage/object-not-found') return
    throw e
  }
}

/** Delete both variants of a receipt — full + thumb. PDFs only have
 *  a full path; that's still safe (deleteObjectAt tolerates missing). */
export async function purgeReceipt(existing: {
  path?:      string
  thumbPath?: string
}): Promise<void> {
  const tasks: Promise<void>[] = []
  if (existing.path)      tasks.push(deleteObjectAt(existing.path))
  if (existing.thumbPath) tasks.push(deleteObjectAt(existing.thumbPath))
  await Promise.all(tasks)
}
