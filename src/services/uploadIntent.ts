// src/services/uploadIntent.ts
// Phase 3.5+ client primitives for the Worker-issued upload intent
// flow. Two low-level operations + zero domain-shape knowledge:
//
//   1. requestUploadIntents  — POST /upload-intents → batch of intents
//      with server-minted path + customMetadata.
//   2. uploadToIntent        — authenticated raw-byte upload to the Worker;
//      the Worker validates and stores at the intent's canonical R2 path.
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

import {
  requireWorkerWriteBase,
  preflightIdToken,
  workerFetch,
  workerRawUpload,
  WorkerAmbiguous,
  WORKER_FETCH_TIMEOUT_MS,
} from './workerBase'
import { retry } from '@/utils/retry'

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
  /** Wish-only discriminator at intent-minting time. `'create'` skips
   *  the wish-doc-exists + proposer check in Worker `authorizeUpload`
   *  (wish doc doesn't exist yet — `/wish-file-create` writes it in
   *  the same tx that consumes these intents). `'update'` enforces
   *  both checks. For expense + booking the Worker ignores this field
   *  at intent-mint time — authz is pure trip-role; create vs update
   *  semantics for those entities are enforced at the
   *  /{booking,expense}-file-* / /expense-{create,update} write
   *  endpoints. Optional + Worker defaults to `'update'` (the safer
   *  fallback that keeps proposer + doc-exists checks on). */
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
 *
 * `opts.traceId` (optional) threads through to the `X-Upload-Trace-Id`
 * header so this call shares its trace with the downstream entity-write
 * workerFetch in the same upload flow.
 */
export async function requestUploadIntents(
  req:   UploadIntentsRequest,
  opts?: { traceId?: string },
): Promise<UploadIntent[]> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()
  const result = await workerFetch(workerBase, idToken, '/upload-intents', req, opts) as {
    intents: UploadIntent[]
  }
  return result.intents
}

// ─── Primitive 2: upload to a single intent ───────────────────────

/**
 * Upload `file` to the intent-bound Worker endpoint. The client never writes
 * directly to R2 and only `intent.path` is persisted; private reads also flow
 * through the authenticated Worker proxy.
 *
 * `label` is a short tag used in the timeout error message
 * ('expense-full', 'booking-thumb', 'wish-full', etc).
 */
export async function uploadToIntent(
  intent: UploadIntent,
  file:   Blob | File,
  label:  string,
  opts?:  { traceId?: string },
): Promise<void> {
  const workerBase = requireWorkerWriteBase()
  const idToken = await preflightIdToken()
  const tripId = intent.metadata.customMetadata.tripId
  if (!tripId) throw new Error(`${label}: upload intent is missing tripId`)
  if (file.type !== intent.metadata.contentType) {
    throw new Error(
      `${label}: file type '${file.type || '<empty>'}' does not match intent '${intent.metadata.contentType}'`,
    )
  }
  await retry(
    () => workerRawUpload(
      workerBase,
      idToken,
      '/attachment-upload',
      { tripId, intentId: intent.intentId },
      file,
      { traceId: opts?.traceId, timeoutMs: WORKER_FETCH_TIMEOUT_MS },
    ),
    { shouldRetry: error => error instanceof WorkerAmbiguous },
  )
}
