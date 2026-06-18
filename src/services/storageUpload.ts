// src/services/storageUpload.ts
// Shared helpers for Firebase Storage uploads — extracted once a 2nd
// caller (bookingStorage) needed the same iOS-Safari-stall workaround
// that expenseStorage had been carrying.
//
// Why uploadBytesResumable over uploadBytes:
//   uploadBytes uses a single multipart POST. iOS Safari + Firebase
//   Storage have a recurring issue where this POST stalls partway and
//   the SDK's internal retry loop fails to detect the stall, leaving
//   the upload promise hanging for the full 2-minute
//   maxOperationRetryTime. uploadBytesResumable uses chunked PUT
//   requests with explicit completion/error events — we can subscribe
//   and time out reliably.
//
// Errors propagate to the mutation's onError handler (toast + rollback)
// + Sentry via captureError upstream. No console logging needed.
import type { UploadTask, StorageReference, StorageError } from 'firebase/storage'

/** Default upload timeout. 30s comfortably covers a multi-MB receipt
 *  on slow travel Wi-Fi while bailing out fast when the connection is
 *  actually black-holing. */
export const UPLOAD_TIMEOUT_MS = 30_000

/**
 * Wrap an UploadTask in a Promise<StorageReference> that resolves on
 * upload completion and rejects on timeout. Caller is expected to
 * have constructed the UploadTask via `uploadBytesResumable(...)` —
 * passing a non-resumable task here defeats the timeout purpose.
 */
export function uploadFile(
  task:    UploadTask,
  label:   string,
  timeoutMs: number = UPLOAD_TIMEOUT_MS,
): Promise<StorageReference> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // task.cancel() is synchronous and returns a bool indicating
      // whether a running task was actually cancelled. We don't care
      // about the return — the reject below propagates regardless.
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
