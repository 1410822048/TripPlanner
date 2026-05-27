// workers/ocr/src/upload-intent.ts
// Phase 3.5: server-issued upload intents.
//
// Why this endpoint exists: under direct-client-to-Storage uploads,
// `storage.rules` was the only contract enforcement point. Any change
// to the metadata schema, allowed content types, or path layout
// required coordinating client + rules deploys with a PWA rollout
// window (old clients lag behind, get 403s). Worker-issued intents
// move the binding contract (allowedContentTypes, maxBytes,
// path-exactness, single-use, expiresAt) off of storage.rules and
// onto the Worker's authoritative consume step.
//
// Two-gate split (post 2026-05-24 race fix -- see the long block
// in storage.rules for the incident):
//   - storage.rules = STABLE GATE. Checks self-contained claimed
//     metadata (uploadIntentId shape, claimed tripId/entityType/
//     entityId match URL params, size cap, content-type allowlist
//     by kind, schemaVersion literal), uploader uid match, and
//     upload-time permission (role / membership / tripNotDeleting).
//     Does NOT read the intent doc -- the cross-service read on a
//     freshly-minted doc races and 403s legitimate uploads.
//   - Worker entity-write endpoints (/booking-file-create,
//     /booking-file-update, /wish-file-create, /wish-file-update,
//     /expense-create, /expense-update) = AUTHORITATIVE GATE. Each
//     reads the matched intent docs inside a Firestore tx, verifies
//     status='pending', expiresAt, path exactness, single-use
//     markUsed, AND re-checks the uploaded object's customMetadata /
//     contentType / size against the intent's allowedContentTypes /
//     maxBytes / customMetadata. Entity doc write commits in the
//     same tx -- atomic doc-and-attachment, no separate finalize
//     round-trip (the Phase-3.6 /upload-finalize endpoint was deleted
//     after Phase 3.7 moved booking/wish file writes to dedicated
//     /booking-file-* and /wish-file-* endpoints).
//
// Client flow:
//   1. POST /upload-intents → Worker returns { intents: [...] }
//      with canonical path + customMetadata for each blob.
//   2. Client uses Firebase Storage SDK uploadBytesResumable to
//      upload to Worker-provided path with Worker-provided metadata.
//   3. POST the matching entity-write endpoint with the intentIds.
//      Worker consumes the intents (path + customMetadata + size
//      re-verified) and writes the entity doc atomically in one tx.
//
// Worker doesn't touch upload bytes. Latency added per upload is one
// extra Worker round-trip + one Storage rules cross-service read --
// not the Worker raw-body proxy pattern that would burn the Free
// plan's 10ms CPU/request budget.
import { z }                                                        from 'zod'
import { getAdminToken, getProjectId }                              from './admin'
import {
  readString,
  readTimestampMs,
  type FsValue,
}                                                                   from './firestore'
import { withTokenRetry, CascadeError }                             from './cascade'
import {
  runFirestoreTransaction,
  docResourceName,
  type TxContext,
  type TxWrite,
}                                                                   from './firestore-tx'
import {
  getObjectMetadata,
  downloadUrlFromMetadata,
  type ObjectMetadata,
}                                                                   from './storage'

// ─── Constants ────────────────────────────────────────────────────

const TripIdRe = /^[A-Za-z0-9_-]{1,60}$/

/** Intent TTL. 30 min covers the realistic upload + retry envelope
 *  (compress 5MB image + slow 3G upload + iOS Safari background
 *  suspension) without leaving long-lived stale-permission tokens. */
const EXPIRE_MS = 30 * 60 * 1000

/** Hard cap on object size, matches the existing storage.rules check.
 *  Per-entityType caps live below in case we ever want booking < wish. */
const MAX_BYTES = 5 * 1024 * 1024

/** Customer-controlled metadata schema version. Bump when the
 *  customMetadata shape changes. Clients pass through whatever the
 *  Worker mints (they don't know schema details), so bumps avoid
 *  the PWA rollout window for client code -- but the literal value
 *  IS asserted at two places, both of which must move together:
 *    1. storage.rules' `intentMatches` (`schemaVersion == 'v1'`).
 *    2. Worker entity-write endpoints' customMetadata equality check
 *       against the intent doc's stored customMetadata (booking-write
 *       / wish-write / expense-write all consume intents the same way).
 *  A bump is therefore Worker constant + storage.rules literal +
 *  the usual two-deploy sequence (rules first to accept both old
 *  and new, then Worker switches; or rules-only-new with a brief
 *  in-flight upload denial window). */
const SCHEMA_VERSION = 'v1'

/** Cap per request. full + thumb is the realistic usage; PDF only
 *  ships full (no thumb generated). Three would still be sane but
 *  there's no use case today, and a tighter bound makes batch authz
 *  bounded too. */
const MAX_UPLOADS_PER_REQUEST = 2

const ALLOWED_IMAGE_CTS = [
  'image/webp', 'image/jpeg', 'image/png', 'image/heic', 'image/heif',
] as const

const ALLOWED_CTS_BY_ENTITY: Record<EntityType, readonly string[]> = {
  expense: [...ALLOWED_IMAGE_CTS, 'application/pdf'],
  booking: [...ALLOWED_IMAGE_CTS, 'application/pdf'],
  wish:    ALLOWED_IMAGE_CTS,
}

// ─── Types + schemas ──────────────────────────────────────────────

export type EntityType = 'expense' | 'booking' | 'wish'
export type UploadKind = 'full' | 'thumb' | 'pdf'

/** Batch-first request shape: trip-level fields at top (one authz
 *  read pass), per-blob fields inside `uploads[]`.
 *
 *  Phase 3.7: `mode` distinguishes "intent for a not-yet-existing
 *  entity doc" (create) from "intent for an existing doc" (update).
 *  Defaults to 'update' for backward compatibility with pre-3.7
 *  clients which always called intents AFTER setDoc.
 *
 *  Affects wish only at this layer: mode='create' skips the
 *  wish-doc-exists + proposer check in `authorizeUpload` because
 *  the wish doc legitimately doesn't exist yet (Worker `/wish-file-
 *  create` is the writer). booking/expense `authorizeUpload` is
 *  pure trip-role authz, no doc read, so `mode` is a no-op there. */
export const UploadIntentsRequestSchema = z.object({
  tripId:     z.string().regex(TripIdRe),
  entityType: z.enum(['expense', 'booking', 'wish']),
  entityId:   z.string().regex(TripIdRe),
  mode:       z.enum(['create', 'update']).optional(),
  uploads:    z.array(z.object({
    kind:        z.enum(['full', 'thumb', 'pdf']),
    contentType: z.string().min(1).max(80),
    size:        z.number().int().positive(),
  })).min(1).max(MAX_UPLOADS_PER_REQUEST),
})
export type UploadIntentsRequest = z.infer<typeof UploadIntentsRequestSchema>

/** Single intent the Worker mints. Returned to client; client uses
 *  `path` as the Storage target and `metadata` verbatim as the
 *  uploadBytesResumable metadata arg. */
export interface UploadIntentResponse {
  intentId: string
  path:     string
  metadata: {
    contentType:    string
    customMetadata: Record<string, string>
  }
  expiresAt: string  // ISO 8601
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Map content type to filename extension. Mirrors the client-side
 *  helpers in expenseStorage / bookingStorage but server-owned now. */
function extForContentType(ct: string): string {
  if (ct === 'image/webp')      return 'webp'
  if (ct === 'image/jpeg')      return 'jpg'
  if (ct === 'image/png')       return 'png'
  if (ct === 'image/heic')      return 'heic'
  if (ct === 'image/heif')      return 'heif'
  if (ct === 'application/pdf') return 'pdf'
  return 'bin'   // unreachable: schema gate above rejects others
}

/** Map entityType to its Storage path collection segment. */
function collectionFor(entityType: EntityType): 'expenses' | 'bookings' | 'wishes' {
  if (entityType === 'expense') return 'expenses'
  if (entityType === 'booking') return 'bookings'
  return 'wishes'
}

/** Random ID for an intent document or Storage filename suffix.
 *  Full UUID hex (32 chars = 128 bits) -- collision-resistant at any
 *  realistic scale.
 *
 *  Note (earlier mistake): an 8-char truncation was used originally
 *  (32 bits of entropy), which is unsafe for either of these:
 *    - intentId is a globally-scoped Firestore doc ID. Birthday-
 *      paradox collision hits 50% at sqrt(2^32) = ~65k docs. Even
 *      with the 7-day used-retention cleanup, sustained traffic
 *      crosses that threshold easily and `currentDocument.exists=false`
 *      creates start rejecting.
 *    - fileId is per-(tripId,entityId) but the same logic applies to
 *      replace-attachment flows that rapidly cycle paths. A collision
 *      = silent Storage overwrite or a stale path stranded in
 *      Firestore docs that reference the now-overwritten blob.
 *  Full UUID closes both classes. crypto.randomUUID is available in
 *  Cloudflare Workers (Web Crypto API). */
function newId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/** Per-request authorization. Runs inside the Firestore transaction
 *  so trip / member / wish state can't drift between authz and the
 *  intent write -- a concurrent cascade-delete or member kick is
 *  caught by the commit-time conflict check, same pattern as
 *  expense-write's `authorizeCanWriteTx`. */
async function authorizeUpload(
  tx:         TxContext,
  tripId:     string,
  entityType: EntityType,
  entityId:   string,
  callerUid:  string,
  mode:       'create' | 'update',
): Promise<void> {
  // 1. Trip exists + not being cascade-deleted.
  const trip = await tx.get(`trips/${tripId}`)
  if (!trip.exists)               throw new CascadeError(404, 'trip not found')
  if ('deletingAt' in trip.fields) throw new CascadeError(410, 'trip is being deleted')

  // 2. Member doc + role.
  const member = await tx.get(`trips/${tripId}/members/${callerUid}`)
  if (!member.exists) throw new CascadeError(403, 'caller is not a trip member')
  const role = readString(member.fields, 'role')

  if (entityType === 'wish') {
    // Wish uploads: any member role can propose.
    if (role !== 'owner' && role !== 'editor' && role !== 'viewer') {
      throw new CascadeError(403, 'caller role invalid')
    }
    if (mode === 'create') {
      // Phase 3.7 upload-first flow: the wish doc legitimately
      // doesn't exist yet -- Worker `/wish-file-create` will
      // create it in the same tx that consumes these intents.
      // Skip the wish-doc-exists + proposer check; proposer
      // identity is `callerUid` by construction at create time
      // (Worker stamps proposedBy = callerUid in encodeWish).
      return
    }
    // mode='update': wish must exist + caller must be proposer.
    // Mirrors firestore.rules' proposer-only update gate.
    const wish = await tx.get(`trips/${tripId}/wishes/${entityId}`)
    if (!wish.exists) {
      throw new CascadeError(404, 'wish doc not found (mode=update requires the wish to exist)')
    }
    const proposer = readString(wish.fields, 'proposedBy')
    if (proposer !== callerUid) {
      throw new CascadeError(403, 'only the wish proposer can upload a replacement cover')
    }
  } else {
    // expense / booking: editor or owner only. No doc read needed --
    // role is the sole authz signal regardless of create vs update.
    if (role !== 'owner' && role !== 'editor') {
      throw new CascadeError(403, 'caller role is not owner/editor')
    }
  }
}

// ─── Pre-tx request validation ────────────────────────────────────

/** Validate static-only fields (no Firestore involved). Runs BEFORE
 *  entering the transaction so an invalid request burns one auth +
 *  schema parse, not a Firestore tx round-trip. */
function validateUploadRequests(req: UploadIntentsRequest): void {
  const allowed = ALLOWED_CTS_BY_ENTITY[req.entityType]
  for (const u of req.uploads) {
    if (!allowed.includes(u.contentType)) {
      throw new CascadeError(400, `contentType '${u.contentType}' not allowed for ${req.entityType}`)
    }
    if (u.size > MAX_BYTES) {
      throw new CascadeError(413, `upload size ${u.size} exceeds maxBytes ${MAX_BYTES}`)
    }
    // kind ↔ contentType pairing
    if (u.kind === 'pdf' && u.contentType !== 'application/pdf') {
      throw new CascadeError(400, 'kind=pdf requires contentType=application/pdf')
    }
    if (u.kind !== 'pdf' && u.contentType === 'application/pdf') {
      throw new CascadeError(400, 'application/pdf requires kind=pdf')
    }
    // wish accepts only image (no PDF)
    if (req.entityType === 'wish' && u.kind === 'pdf') {
      throw new CascadeError(400, 'wish uploads cannot be PDF')
    }
  }
  // Duplicate kind in same request (e.g. two `full`s) — likely
  // client bug; reject so the intent space doesn't accidentally get
  // two slots for the same logical blob.
  const kinds = req.uploads.map(u => u.kind)
  if (new Set(kinds).size !== kinds.length) {
    throw new CascadeError(400, 'uploads[].kind must be unique within a request')
  }
}

// ─── Public API ───────────────────────────────────────────────────

export async function createUploadIntents(
  callerUid:          string,
  req:                UploadIntentsRequest,
  serviceAccountJson: string,
): Promise<{ intents: UploadIntentResponse[] }> {
  return withTokenRetry(() => doCreate(callerUid, req, serviceAccountJson))
}

async function doCreate(
  callerUid:          string,
  req:                UploadIntentsRequest,
  serviceAccountJson: string,
): Promise<{ intents: UploadIntentResponse[] }> {
  validateUploadRequests(req)

  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  return runFirestoreTransaction(accessToken, projectId, async (tx) => {
    // Phase 3.7 default: 'update' preserves pre-3.7 behavior for any
    // client that doesn't yet send `mode` (existing booking/wish
    // update flows continue to work unchanged).
    const mode = req.mode ?? 'update'
    await authorizeUpload(tx, req.tripId, req.entityType, req.entityId, callerUid, mode)

    const expiresAtMs = Date.now() + EXPIRE_MS
    const expiresAt   = new Date(expiresAtMs).toISOString()
    const writes:    TxWrite[]              = []
    const responses: UploadIntentResponse[] = []
    const collection = collectionFor(req.entityType)

    for (const upload of req.uploads) {
      const intentId = newId()
      const fileId   = newId()
      const ext      = extForContentType(upload.contentType)
      // `.thumb.` infix differentiates thumb from full when they share
      // the same extension. Mirrors the existing client-side filename
      // scheme so post-Phase-3.5 blobs land at recognizable paths.
      const suffix   = upload.kind === 'thumb' ? `.thumb.${ext}` : `.${ext}`
      const path     = `trips/${req.tripId}/${collection}/${req.entityId}/${fileId}${suffix}`

      const customMetadata: Record<string, string> = {
        uploadIntentId: intentId,
        uploaderUid:    callerUid,
        tripId:         req.tripId,
        entityType:     req.entityType,
        entityId:       req.entityId,
        kind:           upload.kind,
        schemaVersion:  SCHEMA_VERSION,
      }

      // Intent doc fields. `allowedContentTypes` is single-element
      // (the exact CT the client declared) intentionally -- locking
      // the upload to the declared CT closes the trick where a
      // client requests intent for image/webp but uploads as
      // image/jpeg. storage.rules CANNOT cross-service-read this
      // freshly-minted intent doc (see the 2026-05-24 race note in
      // storage.rules), so it can only verify that the upload's
      // contentType is within the per-entity-kind allowlist (any
      // image CT for kind='full'/'thumb'). The exact-CT lock fires
      // at consume time inside consumeIntentInTx below, which
      // re-reads the intent doc and rejects when the uploaded
      // object's contentType is not in allowedContentTypes.
      const fields: Record<string, FsValue> = {
        uid:        { stringValue: callerUid },
        tripId:     { stringValue: req.tripId },
        entityType: { stringValue: req.entityType },
        entityId:   { stringValue: req.entityId },
        kind:       { stringValue: upload.kind },
        path:       { stringValue: path },
        allowedContentTypes: {
          arrayValue: { values: [{ stringValue: upload.contentType }] },
        },
        maxBytes:   { integerValue: String(MAX_BYTES) },
        customMetadata: {
          mapValue: {
            fields: Object.fromEntries(
              Object.entries(customMetadata).map(([k, v]) => [k, { stringValue: v }]),
            ),
          },
        },
        status:     { stringValue: 'pending' },
        expiresAt:  { timestampValue: expiresAt },
      }

      writes.push({
        document:        docResourceName(projectId, `trips/${req.tripId}/uploadIntents/${intentId}`),
        fields,
        currentDocument: { exists: false },  // create-only; shortId collision astronomically unlikely
        updateTransforms: [
          { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
        ],
      })

      responses.push({
        intentId,
        path,
        metadata: { contentType: upload.contentType, customMetadata },
        expiresAt,
      })
    }

    return { writes, result: { intents: responses } }
  })
}

// ─── Intent consumption (shared by all entity-write endpoints) ─────

/** Validated + consumed intent + the tx write that marks it 'used'.
 *
 *  Atomicity story: intent markUsed write + entity doc write commit
 *  in the SAME Firestore tx, so there's no half-state to recover from.
 *  All consumers (consumeEntityIntents) require status='pending' and
 *  always receive a non-null `markUsedWrite` to include in commit
 *  writes. A retry hits a 409 (status='used') and the client restarts
 *  from /upload-intents -- simpler than idempotent replay and the
 *  same-tx atomicity removes the crash-window that replay used to
 *  cover. */
export interface ConsumedIntent {
  intentId:       string
  tripId:         string
  entityType:     EntityType
  entityId:       string
  kind:           UploadKind
  path:           string
  storage:        ObjectMetadata
  downloadUrl:    string | null
}

interface ConsumeResult {
  consumed:       ConsumedIntent
  /** The pending → used transition write. Caller MUST include this in
   *  their tx commit writes -- otherwise the intent stays pending and
   *  a replay re-consumes the same blob. */
  markUsedWrite:  TxWrite
}

/** Read an intent doc inside a tx, validate all the consume-time
 *  preconditions, and verify the corresponding Storage object exists.
 *  Returns the consumed intent + the tx write to mark it used; caller
 *  must include the write in their TxResult.writes.
 *
 *  Validation order is deliberate -- cheaper local checks before the
 *  remote Storage roundtrip:
 *    intent exists → status=pending → uid match → not expired →
 *    storage object exists → entity scope matches (caller-supplied)
 *
 *  `expected` lets callers reject intents that belong to a different
 *  trip / entity / kind than the request claims. When `expected` is
 *  undefined, the scope check is skipped (used by consumers that
 *  already know the scope from intent itself).
 */
async function consumeIntentInTx(
  tx:           TxContext,
  intentId:     string,
  callerUid:    string,
  accessToken:  string,
  projectId:    string,
  bucket:       string,
  /** Trip-scoped lookup: intents live under
   *  `trips/{lookupTripId}/uploadIntents/{intentId}`. Caller MUST
   *  supply the tripId it expects the intent to belong to -- this
   *  IS the storage-path scope check (intent.tripId field is then
   *  cross-verified below). A wrong lookupTripId returns 404 (intent
   *  doc not found at that subcollection path) -- which is the correct
   *  outcome (caller has no business with that intent). */
  lookupTripId: string,
  expected?: {
    tripId?:     string
    entityType?: EntityType
    entityId?:   string
    kind?:       UploadKind
  },
): Promise<ConsumeResult> {
  const intent = await tx.get(`trips/${lookupTripId}/uploadIntents/${intentId}`)
  if (!intent.exists) throw new CascadeError(404, `intent ${intentId} not found`)

  const status = readString(intent.fields, 'status')
  if (status !== 'pending') {
    throw new CascadeError(409, `intent ${intentId} status=${status ?? 'unknown'} (must be pending)`)
  }

  const uid = readString(intent.fields, 'uid')
  if (uid !== callerUid) throw new CascadeError(403, `intent ${intentId} not owned by caller`)

  const expiresAtMs = readTimestampMs(intent.fields, 'expiresAt')
  if (expiresAtMs === undefined) throw new CascadeError(500, `intent ${intentId} missing expiresAt`)
  if (Date.now() > expiresAtMs)  throw new CascadeError(410, `intent ${intentId} expired`)

  const tripId     = readString(intent.fields, 'tripId')
  const entityType = readString(intent.fields, 'entityType') as EntityType | undefined
  const entityId   = readString(intent.fields, 'entityId')
  const kind       = readString(intent.fields, 'kind') as UploadKind | undefined
  const path       = readString(intent.fields, 'path')
  if (!tripId || !entityType || !entityId || !kind || !path) {
    throw new CascadeError(500, `intent ${intentId} missing required fields`)
  }

  if (expected?.tripId     && expected.tripId     !== tripId)     throw new CascadeError(400, `intent ${intentId} tripId mismatch`)
  if (expected?.entityType && expected.entityType !== entityType) throw new CascadeError(400, `intent ${intentId} entityType mismatch`)
  if (expected?.entityId   && expected.entityId   !== entityId)   throw new CascadeError(400, `intent ${intentId} entityId mismatch`)
  if (expected?.kind       && expected.kind       !== kind)       throw new CascadeError(400, `intent ${intentId} kind mismatch (expected ${expected.kind}, got ${kind})`)

  // Extract the intent's binding fields -- the contract the Storage
  // upload MUST match. Worker-minted at /upload-intents time; read
  // here as the AUTHORITATIVE intent-bound check. storage.rules is
  // a STABLE GATE only (claimed-metadata self-consistency, role,
  // membership, tripNotDeleting); it does NOT read this intent doc
  // because cross-service reads on freshly-written docs race (see
  // the 2026-05-24 prod 403 incident note in storage.rules). The
  // bypass cases this catches -- non-Firebase-SDK direct GCS upload,
  // manual customMetadata tamper, contentType drift between intent
  // request and upload -- all land here and get rejected before the
  // intent transitions to 'used' or the entity doc is patched.
  const intentMetadataFields = (intent.fields.customMetadata as { mapValue?: { fields?: Record<string, FsValue> } } | undefined)?.mapValue?.fields
  const intentAllowedCtValues = (intent.fields.allowedContentTypes as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values
  const intentMaxBytesRaw = (intent.fields.maxBytes as { integerValue?: string | number } | undefined)?.integerValue
  if (!intentMetadataFields || !intentAllowedCtValues || intentMaxBytesRaw === undefined) {
    throw new CascadeError(500, `intent ${intentId} missing required binding fields (allowedContentTypes / maxBytes / customMetadata)`)
  }
  const intentMaxBytes = Number(intentMaxBytesRaw)
  const intentAllowedCts = intentAllowedCtValues
    .map(v => v.stringValue)
    .filter((s): s is string => typeof s === 'string')

  // Storage object existence + metadata. Done inside the tx body so a
  // concurrent consume / cron-cleanup race shows up as ABORTED commit
  // (the intent doc would change). The fetch itself doesn't participate
  // in Firestore tx, but the intent.status='pending' read above + the
  // commit-time write below pin the moment of consumption.
  const storage = await getObjectMetadata(accessToken, bucket, path)
  if (!storage) throw new CascadeError(404, `storage object missing at ${path} (upload not yet committed?)`)

  // Storage object MUST match the intent's contract. Three classes
  // of check, ordered cheapest first:
  //   1. contentType -- intent allowedContentTypes is single-element
  //      (locked to the requested CT), so this is exact-match.
  //   2. size -- object bytes must fit under the intent's maxBytes.
  //   3. customMetadata -- every key the Worker minted at intent time
  //      (uploadIntentId, uploaderUid, tripId, entityType, entityId,
  //      kind, schemaVersion) must be present on the object with the
  //      exact same value. Missing OR mismatched both fail.
  //
  // Why all three at the Worker: storage.rules is a STABLE GATE
  // only -- it accepts any image-CT for kind='full'/'thumb', any
  // claimed tripId/entityType/entityId that matches the URL params,
  // and any uploadIntentId of the right shape. It does NOT read
  // this intent doc, so it cannot enforce the exact-CT lock, the
  // intent's maxBytes (it has a static 5MB cap instead), or the
  // intent-vs-upload customMetadata equality. This block is the
  // ONLY layer where the intent-bound contract is verified -- the
  // consume-time chokepoint.
  if (!intentAllowedCts.includes(storage.contentType)) {
    throw new CascadeError(400,
      `storage contentType '${storage.contentType}' does not match intent allowedContentTypes [${intentAllowedCts.join(', ')}]`)
  }
  if (storage.size > intentMaxBytes) {
    throw new CascadeError(413,
      `storage object size ${storage.size} exceeds intent maxBytes ${intentMaxBytes}`)
  }
  const expectedKeys = ['uploadIntentId', 'uploaderUid', 'tripId', 'entityType', 'entityId', 'kind', 'schemaVersion'] as const
  for (const key of expectedKeys) {
    const expectedValue = intentMetadataFields[key]?.stringValue
    if (!expectedValue) {
      // Intent doc malformed at the source (shouldn't happen given
      // /upload-intents always mints all 7). 500 because it's a
      // server-side data integrity issue, not a client mistake.
      throw new CascadeError(500,
        `intent ${intentId} missing customMetadata.${key} (intent doc malformed)`)
    }
    const actualValue = storage.customMetadata?.[key]
    if (actualValue !== expectedValue) {
      throw new CascadeError(400,
        `storage customMetadata.${key} mismatch (intent ${intentId}): expected '${expectedValue}', got '${actualValue ?? '<missing>'}'`)
    }
  }

  const downloadUrl = downloadUrlFromMetadata(bucket, path, storage.customMetadata)

  // updateMask MUST contain only fields actually present in
  // `fields` -- listing 'usedAt' there would be Firestore's
  // delete-then-transform sequence, which is wasted churn AND
  // semantically wrong (transforms handle usedAt entirely, the
  // mask shouldn't claim it). Mirrors expense-write's pattern:
  // updateMask = Object.keys(fields); transforms own audit timestamps.
  const markUsedWrite: TxWrite = {
    document: docResourceName(projectId, `trips/${lookupTripId}/uploadIntents/${intentId}`),
    fields: {
      status: { stringValue: 'used' },
    },
    updateMask: ['status'],
    currentDocument: { exists: true },
    updateTransforms: [
      { fieldPath: 'usedAt', setToServerValue: 'REQUEST_TIME' },
    ],
  }

  return {
    consumed: {
      intentId,
      tripId,
      entityType,
      entityId,
      kind,
      path,
      storage,
      downloadUrl,
    },
    markUsedWrite,
  }
}

/** Public consume helper for Worker-side entity write paths
 *  (expense-create/update, wish-file-create/update, booking-file-
 *  create/update). Validates one or two intents (full + optional thumb,
 *  or pdf for booking/expense), enforces same-entity pairing, and
 *  returns the consumed shape ready for entity-field encoding. Returns
 *  the tx writes to mark all intents used; caller adds them to its tx
 *  commit writes alongside the entity doc write.
 *
 *  No `allowUsed`: entity doc write is in the SAME tx as consume, so
 *  idempotency isn't needed (a 2nd attempt would 409 on the entity's
 *  currentDocument check anyway). Strict 409 on used keeps the error
 *  reason clean. */
export async function consumeEntityIntents(
  tx:           TxContext,
  intentIds:    string[],
  callerUid:    string,
  accessToken:  string,
  projectId:    string,
  bucket:       string,
  expected: {
    tripId:     string
    entityType: EntityType
    entityId:   string
  },
): Promise<{ consumed: ConsumedIntent[]; markUsedWrites: TxWrite[] }> {
  if (intentIds.length === 0) {
    return { consumed: [], markUsedWrites: [] }
  }
  if (intentIds.length > MAX_UPLOADS_PER_REQUEST) {
    throw new CascadeError(400, `too many intentIds (max ${MAX_UPLOADS_PER_REQUEST})`)
  }
  const consumed:        ConsumedIntent[] = []
  const markUsedWrites:  TxWrite[]        = []
  for (const intentId of intentIds) {
    const r = await consumeIntentInTx(
      tx, intentId, callerUid, accessToken, projectId, bucket,
      expected.tripId,
      { tripId: expected.tripId, entityType: expected.entityType, entityId: expected.entityId },
    )
    consumed.push(r.consumed)
    if (r.markUsedWrite) markUsedWrites.push(r.markUsedWrite)
  }
  // No duplicate kinds across intents (e.g. two `full`s in the same
  // entity-create call would double-attach the primary blob).
  const kinds = consumed.map(c => c.kind)
  if (new Set(kinds).size !== kinds.length) {
    throw new CascadeError(400, `duplicate kinds in ${expected.entityType} intent set`)
  }
  return { consumed, markUsedWrites }
}

/** @deprecated use `consumeEntityIntents` with `entityType: 'expense'`.
 *  Kept as a thin wrapper so the expense-write.ts call site doesn't
 *  need to thread the entityType through; will be inlined in a future
 *  cleanup. */
export async function consumeExpenseIntents(
  tx:           TxContext,
  intentIds:    string[],
  callerUid:    string,
  accessToken:  string,
  projectId:    string,
  bucket:       string,
  expected: {
    tripId:    string
    entityId:  string
  },
): Promise<{ consumed: ConsumedIntent[]; markUsedWrites: TxWrite[] }> {
  return consumeEntityIntents(
    tx, intentIds, callerUid, accessToken, projectId, bucket,
    { tripId: expected.tripId, entityType: 'expense', entityId: expected.entityId },
  )
}

// ─── Attachment payload encoding (booking + wish) ──────────────────

/** Build the Firestore mapValue payload for a booking/wish attachment
 *  field from the consumed intents. Field-name asymmetry (BookingAttachment
 *  uses fileUrl/filePath/fileType; WishImage uses url/path) is captured
 *  here so the call sites in booking-write.ts and wish-write.ts stay
 *  clean and the encoding contract has one source. */
export function buildAttachmentMapValue(
  entityType: 'booking' | 'wish',
  primary:    ConsumedIntent,
  thumb:      ConsumedIntent | undefined,
): FsValue {
  if (entityType === 'booking') {
    // BookingAttachment: fileUrl + filePath + fileType required;
    // thumbUrl + thumbPath optional (PDFs ship without thumbs).
    const fields: Record<string, FsValue> = {
      fileUrl:  { stringValue: primary.downloadUrl! },  // null-checked by caller
      filePath: { stringValue: primary.path },
      fileType: { stringValue: primary.storage.contentType },
    }
    if (thumb) {
      fields.thumbUrl  = { stringValue: thumb.downloadUrl! }  // null-checked by caller
      fields.thumbPath = { stringValue: thumb.path }
    }
    return { mapValue: { fields } }
  }
  // WishImage: url + path + thumbUrl + thumbPath ALL required. When
  // the upload didn't include a thumb (HEIC / HEIF pass-through or
  // canvas decode failure -- see src/utils/image.ts PASSTHROUGH_TYPES),
  // collapse the thumb fields to the primary blob. Matches the
  // pre-Phase-3.6 client-side fallback so existing UI that always
  // indexes into both fields keeps rendering; cost is a full-size
  // image in the list thumbnail slot for these edge cases (~10x
  // bandwidth vs WebP thumb), which is the same trade we always made.
  return {
    mapValue: {
      fields: {
        url:       { stringValue: primary.downloadUrl! },
        path:      { stringValue: primary.path },
        thumbUrl:  { stringValue: thumb?.downloadUrl ?? primary.downloadUrl! },
        thumbPath: { stringValue: thumb?.path        ?? primary.path },
      },
    },
  }
}
