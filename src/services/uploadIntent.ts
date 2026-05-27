// src/services/uploadIntent.ts
// Phase 3.5+ client primitives for the Worker-issued upload intent
// flow. Two low-level operations + zero domain-shape knowledge:
//
//   1. requestUploadIntents  — POST /upload-intents → batch of intents
//      with server-minted path + customMetadata.
//   2. uploadToIntent        — Firebase Storage SDK upload to the
//      intent's path with the intent's metadata, wrapped in the same
//      retry + timeout pattern legacy uploads used.
//
// Compose into entity-shaped flows in src/services/uploadIntentEntity.ts
// (mintAndUploadEntityIntents) + each feature service. Keeping the
// primitives uid-/entity-agnostic means future entity additions reuse
// the same two calls without retouching this file. Entity doc writes
// happen at the Worker entity-write endpoints (/expense-create,
// /expense-update, /booking-file-*, /wish-file-*), which consume the
// intentIds atomically in the same Firestore tx as the doc write.
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
  /** Phase 3.7 wish-only distinguisher: `'create'` skips the
   *  wish-doc-exists + proposer check inside Worker authzUpload because
   *  the wish doc legitimately doesn't exist yet (Worker
   *  `/wish-file-create` is the writer). Omit (or `'update'`) for the
   *  legacy "mint intents for an existing doc" flow. booking/expense
   *  ignore this field. */
  mode?:      'create' | 'update'
  uploads:    Array<{
    kind:        IntentKind
    contentType: string
    size:        number
  }>
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
 * URL is fetched server-side at the entity-write endpoint from
 * `intent.path` once the Worker tx commits.
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
