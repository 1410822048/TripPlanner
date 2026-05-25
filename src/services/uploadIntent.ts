// src/services/uploadIntent.ts
// Phase 3.5 client primitives for the Worker-issued upload intent
// flow. Three low-level operations + zero domain-shape knowledge:
//
//   1. requestUploadIntents  — POST /upload-intents → batch of intents
//      with server-minted path + customMetadata.
//   2. uploadToIntent        — Firebase Storage SDK upload to the
//      intent's path with the intent's metadata, wrapped in the same
//      retry + timeout pattern legacy uploads used.
//   3. finalizeUploadIntents — POST /upload-finalize (booking/wish
//      only) → server marks intents 'used' + returns download URLs.
//      Expense skips this step: /expense-create + /expense-update
//      consume intentIds directly in a single Firestore transaction
//      with the doc write, so no separate finalize round-trip.
//
// Feature-level wrappers (expenseStorage / bookingStorage /
// wishService) compose these into entity-shaped objects. Keeping the
// primitive uid-/entity-agnostic means future entity additions reuse
// the same three calls without retouching this file.
//
// Errors propagate to the wrapper, which propagates to the mutation
// caller. No console logging here -- the wrappers' purge.catch +
// safePurgeWithEnqueueFallback path handles cleanup and Sentry.

import type { UploadMetadata } from 'firebase/storage'
import { getFirebaseStorage } from './firebase'
import { uploadFile, UPLOAD_TIMEOUT_MS } from './storageUpload'
import { requireWorkerWriteBase, preflightIdToken, workerFetch } from './workerBase'
import { retry, isTransientStorageError } from '@/utils/retry'

// ─── Types ────────────────────────────────────────────────────────

export type IntentEntityType = 'expense' | 'booking' | 'wish'
export type IntentKind       = 'full' | 'thumb' | 'pdf'

export interface UploadIntent {
  intentId: string
  path:     string
  metadata: {
    contentType:    string
    customMetadata: Record<string, string>
  }
  expiresAt: string  // ISO 8601
}

export interface UploadIntentsRequest {
  tripId:     string
  entityType: IntentEntityType
  entityId:   string
  uploads:    Array<{
    kind:        IntentKind
    contentType: string
    size:        number
  }>
}

export interface FinalizedBlob {
  kind:        IntentKind
  path:        string
  /** Firebase Storage download URL. Null when the storage object's
   *  customMetadata lacks `firebaseStorageDownloadTokens` (only
   *  possible if the upload bypassed the Firebase Storage SDK --
   *  shouldn't happen via our wrappers, but the type honors the
   *  Worker's nullable response). */
  url:         string | null
  contentType: string
  size:        number
}

export interface FinalizeResponse {
  ok:         true
  entityType: 'booking' | 'wish'
  tripId:     string
  entityId:   string
  blobs:      FinalizedBlob[]
}

// ─── Primitive 1: mint intents ────────────────────────────────────

/**
 * Ask the Worker for a batch of upload intents. The Worker validates
 * trip membership / role / wish proposer / contentType allowlist /
 * size cap, mints each intent's canonical path + customMetadata
 * (including a `schemaVersion`), and returns them.
 *
 * Throws WorkerRejected (401/403/404/409/410/413/429) for definitive
 * failures the caller can surface as toast. Throws WorkerAmbiguous
 * (timeout / network / 5xx) when retry might succeed -- the wrapper
 * propagates it without further action, since no storage side
 * effects have happened yet.
 */
export async function requestUploadIntents(
  req: UploadIntentsRequest,
): Promise<UploadIntent[]> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()
  const result = await workerFetch(workerBase, idToken, '/upload-intents', req) as {
    intents: UploadIntent[]
  }
  return result.intents
}

// ─── Primitive 2: upload to a single intent ───────────────────────

/**
 * Upload `file` to `intent.path` with `intent.metadata` via
 * uploadBytesResumable + the same retry/timeout pattern legacy
 * uploads used. Returns void -- the path is `intent.path` and the
 * URL is fetched later via /upload-finalize (booking/wish) or
 * server-side from intent.path (expense).
 *
 * `label` is a short tag used in the timeout error message
 * ('expense-full', 'booking-thumb', 'wish-full', etc).
 */
export async function uploadToIntent(
  intent: UploadIntent,
  file:   Blob | File,
  label:  string,
): Promise<void> {
  const { storage, ref, uploadBytesResumable } = await getFirebaseStorage()
  const metadata: UploadMetadata = {
    contentType:    intent.metadata.contentType,
    customMetadata: intent.metadata.customMetadata,
  }
  await retry(
    () => uploadFile(
      uploadBytesResumable(ref(storage, intent.path), file, metadata),
      label,
      UPLOAD_TIMEOUT_MS,
    ),
    { shouldRetry: isTransientStorageError },
  )
}

// ─── Primitive 3: finalize (booking + wish only) ──────────────────

/**
 * Notify the Worker that the upload landed; the Worker verifies the
 * Storage object exists + matches the intent's customMetadata
 * contract, marks the intent 'used' in a Firestore transaction, and
 * returns the download URLs + storage sizes for the caller to
 * assemble into an entity-shape attachment object.
 *
 * Expense flow does NOT call this -- /expense-create / /expense-update
 * consume intentIds directly so the entity doc write commits atomically
 * with the intent transition.
 *
 * The Worker's `allowUsed: true` semantics make this idempotent on
 * a same-uploader retry: if the client crashed between successful
 * finalize and the booking/wish setDoc call, re-calling finalize
 * with the same intentIds returns the same blobs without re-marking.
 */
export async function finalizeUploadIntents(
  tripId:    string,
  intentIds: string[],
): Promise<FinalizeResponse> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()
  return await workerFetch(workerBase, idToken, '/upload-finalize', { tripId, intentIds }) as FinalizeResponse
}
