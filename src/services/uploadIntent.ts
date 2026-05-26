// src/services/uploadIntent.ts
// Phase 3.5/3.6 client primitives for the Worker-issued upload intent
// flow. Three low-level operations + zero domain-shape knowledge:
//
//   1. requestUploadIntents  — POST /upload-intents → batch of intents
//      with server-minted path + customMetadata.
//   2. uploadToIntent        — Firebase Storage SDK upload to the
//      intent's path with the intent's metadata, wrapped in the same
//      retry + timeout pattern legacy uploads used.
//   3. finalizeUploadIntents — POST /upload-finalize (booking/wish
//      only) → Worker marks intents 'used' AND patches the entity
//      doc's attachment/image field atomically with the intent
//      markUsed writes, then returns `{ ok: true }`. Expense skips
//      this step: /expense-create + /expense-update consume intentIds
//      directly in a single Firestore transaction with the doc write,
//      so no separate finalize round-trip.
//
// Feature-level wrappers (expenseStorage / bookingStorage /
// wishService) compose these into entity-shaped flows. Keeping the
// primitive uid-/entity-agnostic means future entity additions reuse
// the same three calls without retouching this file.
//
// Phase 3.6 change: the Worker is the authoritative writer for
// booking.attachment / wish.image. /upload-finalize patches the
// entity doc directly, and the response no longer carries blob URLs
// or paths -- the client re-reads via its realtime listener instead.
// Callers MUST pass an `applyToDoc` directive that declares the
// CURRENT primary-path state of the entity (or null = "no attachment
// yet"). The Worker rejects with 409 if the doc has drifted between
// upload and finalize (stale-finalize guard).
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

/** Phase 3.6 apply-to-doc directive. The Worker patches the entity
 *  doc's attachment (booking) or image (wish) field atomically with
 *  the intent markUsed writes. `mode` is `'patch'` only -- no no-op
 *  escape hatch, no doc-creation mode (the entity is doc-first by
 *  the time finalize fires).
 *
 *  `expectedCurrentPath` is the primary blob path the caller
 *  believes the entity is currently pointing at:
 *    - `null`   → expect doc.attachment / doc.image to be absent
 *                 (first-attach OR detach-then-re-attach flow)
 *    - string   → expect doc.attachment.filePath / doc.image.path
 *                 to equal this string exactly
 *
 *  Mismatch → 409 stale-finalize. This closes the "Tab A slow
 *  finalize overwrites Tab B's already-committed replacement" race. */
export interface FinalizeApplyToDoc {
  mode:                'patch'
  expectedCurrentPath: string | null
}

export interface FinalizeResponse {
  ok: true
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
 * Notify the Worker the upload landed. The Worker verifies the
 * Storage object exists + matches the intent's customMetadata
 * contract, marks intents 'used' in a Firestore transaction, AND
 * patches the entity doc's attachment / image field in the SAME tx
 * (Phase 3.6 -- Worker is authoritative writer for those fields).
 *
 * Expense flow does NOT call this -- /expense-create + /expense-update
 * consume intentIds directly so the expense doc write commits
 * atomically with the intent transition.
 *
 * `applyToDoc.expectedCurrentPath` declares what the client believes
 * the entity's CURRENT primary path is:
 *   - `null`  → first-attach flow OR doc-first create (entity has no
 *               attachment yet)
 *   - string  → replace flow (caller is upgrading from that path)
 *
 * Worker rejects with 409 if the entity has drifted between upload
 * and finalize. The Worker's idempotent-replay path requires the doc
 * to STILL reflect THIS intent's path exactly -- if the user has
 * since detached or replaced, the intent's blob is dead bytes (will
 * be reaped by orphan-scan) and the Worker refuses to resurrect it.
 *
 * Response is `{ ok: true }` only -- no blob payload. Callers re-read
 * the entity via their realtime listener to observe the patched
 * attachment/image field.
 */
export async function finalizeUploadIntents(
  tripId:     string,
  intentIds:  string[],
  applyToDoc: FinalizeApplyToDoc,
): Promise<FinalizeResponse> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()
  return await workerFetch(workerBase, idToken, '/upload-finalize', {
    tripId, intentIds, applyToDoc,
  }) as FinalizeResponse
}
