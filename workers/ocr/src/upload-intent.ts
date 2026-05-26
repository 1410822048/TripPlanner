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
//   - Worker /upload-finalize + /expense-create + /expense-update
//     = AUTHORITATIVE GATE. Reads intent doc inside a Firestore tx,
//     verifies status='pending' (or 'used' for idempotent replay),
//     expiresAt, path exactness, single-use markUsed, AND re-checks
//     the uploaded object's customMetadata / contentType / size
//     against the intent's allowedContentTypes / maxBytes /
//     customMetadata. THIS is where the intent-bound check lives.
//
// Client flow:
//   1. POST /upload-intents → Worker returns { intents: [...] }
//      with canonical path + customMetadata for each blob.
//   2. Client uses Firebase Storage SDK uploadBytesResumable to
//      upload to Worker-provided path with Worker-provided metadata.
//   3. (booking/wish) POST /upload-finalize → Worker verifies the
//      Storage object exists AND patches `attachment` / `image` on
//      the booking / wish doc atomically with the intent markUsed
//      writes, then returns `{ ok: true }`. Phase 3.6: Worker is the
//      authoritative writer for booking.attachment / wish.image --
//      client no longer constructs the field shape, and firestore.
//      rules forbid client direct edits to those fields (deleteField
//      is the only client-allowed mutation, used for detach).
//   4. (expense) /expense-create + /expense-update consume intent
//      IDs directly -- no separate finalize step, saves one round-trip.
//
// Worker doesn't touch upload bytes. Latency added per upload is one
// extra Worker round-trip + one Storage rules cross-service read --
// not the Worker raw-body proxy pattern that would burn the Free
// plan's 10ms CPU/request budget.
//
// Phase 3.6 stale-finalize guard:
//   /upload-finalize takes `applyToDoc.expectedCurrentPath` -- the
//   primary attachment path the CLIENT believes is on the entity
//   right now (null = "expect no attachment"). Worker reads the
//   entity doc inside the tx and rejects with 409 if the actual
//   path differs. This closes the race where Tab A's slow finalize
//   would otherwise overwrite Tab B's already-committed replacement
//   blob, leaking B's bytes as orphans. Used-intent idempotent
//   replay applies a stricter version: the doc must already reflect
//   THIS intent's path exactly (else the intent's blob was already
//   superseded -- replaying would resurrect dead bytes).
import { z }                                                        from 'zod'
import { getAdminToken, getProjectId }                              from './admin'
import {
  readString,
  readTimestampMs,
  readNestedString,
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
 *    2. Worker /upload-finalize's customMetadata equality check
 *       against the intent doc's stored customMetadata.
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
 *  read pass), per-blob fields inside `uploads[]`. */
export const UploadIntentsRequestSchema = z.object({
  tripId:     z.string().regex(TripIdRe),
  entityType: z.enum(['expense', 'booking', 'wish']),
  entityId:   z.string().regex(TripIdRe),
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
    // Wish uploads: any member CAN propose, but uploads must be by
    // the wish's proposer (doc-first flow → wish doc must already
    // exist by upload time). Mirrors firestore.rules + the existing
    // storage.rules `isWishProposer` check.
    if (role !== 'owner' && role !== 'editor' && role !== 'viewer') {
      throw new CascadeError(403, 'caller role invalid')
    }
    const wish = await tx.get(`trips/${tripId}/wishes/${entityId}`)
    if (!wish.exists) {
      throw new CascadeError(404, 'wish doc not found (doc-first flow requires the wish to exist before upload)')
    }
    const proposer = readString(wish.fields, 'proposedBy')
    if (proposer !== callerUid) {
      throw new CascadeError(403, 'only the wish proposer can upload its cover')
    }
  } else {
    // expense / booking: editor or owner only.
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
    await authorizeUpload(tx, req.tripId, req.entityType, req.entityId, callerUid)

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

// ─── Intent consumption (shared by /upload-finalize + expense-write) ──

/** Validated + consumed intent + the tx write that marks it 'used'.
 *
 *  Atomicity story:
 *    - expense path: intent markUsed write + expense doc write are in
 *      the SAME tx commit. No half-state. consumeExpenseIntents always
 *      gets `markUsedWrite` non-null and adds it to commit writes.
 *    - booking/wish finalize path: intent markUsed write commits, then
 *      client writes the doc. If client crashes between, half-state
 *      exists (intent used, doc missing, blob in storage). Mitigated
 *      via `allowUsed=true` on finalize -- a retry can re-finalize an
 *      already-used intent and get the same blobs response (markUsedWrite
 *      null in that case), letting the client complete its doc write.
 *      Orphan-storage-scan cleans the blob if the client never retries.
 */
export interface ConsumedIntent {
  intentId:       string
  tripId:         string
  entityType:     EntityType
  entityId:       string
  kind:           UploadKind
  path:           string
  storage:        ObjectMetadata
  downloadUrl:    string | null
  /** True when this consume was an idempotent re-finalize of an
   *  already-`used` intent -- caller didn't actually trigger the
   *  status transition this round, just verified the prior consume
   *  is still valid. False for the first-time `pending` → `used`
   *  case. */
  alreadyUsed:    boolean
}

interface ConsumeResult {
  consumed:       ConsumedIntent
  /** Null when the intent was ALREADY 'used' on entry (idempotent
   *  replay path). Non-null when transitioning pending → used; caller
   *  MUST include this write in their tx commit. */
  markUsedWrite:  TxWrite | null
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
 *  `expected` lets callers (e.g. /upload-finalize) reject intents that
 *  belong to a different trip / entity / kind than the request claims.
 *  When `expected` is undefined, the scope check is skipped (used by
 *  consumers that already know the scope from intent itself).
 */
async function consumeIntentInTx(
  tx:           TxContext,
  intentId:     string,
  callerUid:    string,
  accessToken:  string,
  projectId:    string,
  bucket:       string,
  /** Tripe-scoped lookup: intents live under
   *  `trips/{lookupTripId}/uploadIntents/{intentId}`. Caller MUST
   *  supply the tripId it expects the intent to belong to -- this
   *  IS the storage-path scope check (intent.tripId field is then
   *  cross-verified below). For booking/wish /upload-finalize this
   *  comes from the request body; for expense-write it comes from
   *  the expense's own tripId. A wrong lookupTripId returns 404
   *  (intent doc not found at that subcollection path) -- which is
   *  the correct outcome (caller has no business with that intent). */
  lookupTripId: string,
  expected?: {
    tripId?:     string
    entityType?: EntityType
    entityId?:   string
    kind?:       UploadKind
  },
  opts: {
    /** When true, accept `status='used'` and return the same blobs
     *  without re-marking. Used by /upload-finalize for booking/wish
     *  so a client that crashed between finalize-success and doc-write
     *  can retry without paying for a new upload. uid + storage +
     *  customMetadata still verified -- idempotency is per-uploader,
     *  not a general bypass. expense path leaves this default false:
     *  expense create/update writes the doc in the SAME tx as consume,
     *  so no half-state to recover from; second create=409. */
    allowUsed?:  boolean
  } = {},
): Promise<ConsumeResult> {
  const intent = await tx.get(`trips/${lookupTripId}/uploadIntents/${intentId}`)
  if (!intent.exists) throw new CascadeError(404, `intent ${intentId} not found`)

  const status = readString(intent.fields, 'status')
  const isPending = status === 'pending'
  const isReplayable = status === 'used' && opts.allowUsed === true
  if (!isPending && !isReplayable) {
    throw new CascadeError(409, `intent ${intentId} status=${status ?? 'unknown'} (must be pending)`)
  }

  const uid = readString(intent.fields, 'uid')
  if (uid !== callerUid) throw new CascadeError(403, `intent ${intentId} not owned by caller`)

  // expiresAt check applies only to pending intents. A 'used' intent's
  // expiresAt is irrelevant -- it was consumed before expiry by
  // construction (otherwise consume would have rejected it then).
  // Used-intent retention is handled by purgeExpiredUploadIntents
  // cron (USED_RETENTION_DAYS); within that window, replay is safe.
  if (isPending) {
    const expiresAtMs = readTimestampMs(intent.fields, 'expiresAt')
    if (expiresAtMs === undefined) throw new CascadeError(500, `intent ${intentId} missing expiresAt`)
    if (Date.now() > expiresAtMs)  throw new CascadeError(410, `intent ${intentId} expired`)
  }

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
  // concurrent finalize / cron-cleanup race shows up as ABORTED commit
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

  // Idempotent replay path: intent was already 'used'. Skip the
  // mark-used write (idempotent no-op), return same blobs response
  // built from the still-existing storage object.
  //
  // updateMask MUST contain only fields actually present in
  // `fields` -- listing 'usedAt' there would be Firestore's
  // delete-then-transform sequence, which is wasted churn AND
  // semantically wrong (transforms handle usedAt entirely, the
  // mask shouldn't claim it). Mirrors expense-write's pattern:
  // updateMask = Object.keys(fields); transforms own audit timestamps.
  const markUsedWrite: TxWrite | null = isPending ? {
    document: docResourceName(projectId, `trips/${lookupTripId}/uploadIntents/${intentId}`),
    fields: {
      status: { stringValue: 'used' },
    },
    updateMask: ['status'],
    currentDocument: { exists: true },
    updateTransforms: [
      { fieldPath: 'usedAt', setToServerValue: 'REQUEST_TIME' },
    ],
  } : null

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
      alreadyUsed: !isPending,
    },
    markUsedWrite,
  }
}

/** Public consume helper for expense-write: validates one or two
 *  intents (full + optional thumb), enforces same-entity pairing,
 *  and returns the consumed shape ready for receipt-field encoding.
 *  Returns the tx writes to mark all intents used; caller adds them
 *  to its tx commit writes alongside the expense doc write. */
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
  if (intentIds.length === 0) {
    return { consumed: [], markUsedWrites: [] }
  }
  if (intentIds.length > MAX_UPLOADS_PER_REQUEST) {
    throw new CascadeError(400, `too many intentIds (max ${MAX_UPLOADS_PER_REQUEST})`)
  }
  const consumed:        ConsumedIntent[] = []
  const markUsedWrites:  TxWrite[]        = []
  for (const intentId of intentIds) {
    // No allowUsed for expense: the expense doc write is in the SAME
    // tx as consume, so idempotency isn't needed (and a 2nd attempt
    // would 409 on expense doc currentDocument.exists=false check
    // anyway). Strict 409 on used keeps the error reason clean.
    const r = await consumeIntentInTx(
      tx, intentId, callerUid, accessToken, projectId, bucket,
      expected.tripId,
      { tripId: expected.tripId, entityType: 'expense', entityId: expected.entityId },
    )
    consumed.push(r.consumed)
    // markUsedWrite is non-null for the strict (default) consume path.
    if (r.markUsedWrite) markUsedWrites.push(r.markUsedWrite)
  }
  // No duplicate kinds across intents.
  const kinds = consumed.map(c => c.kind)
  if (new Set(kinds).size !== kinds.length) {
    throw new CascadeError(400, 'duplicate kinds in expense intent set')
  }
  return { consumed, markUsedWrites }
}

// ─── /upload-finalize endpoint (booking + wish only) ───────────────

/** Apply-to-doc directive. Worker patches the entity's
 *  `attachment` (booking) or `image` (wish) field atomically with
 *  the intent markUsed writes. `mode` is `'patch'` only -- no
 *  no-op escape hatch, no doc-creation mode (booking/wish flows
 *  are doc-first by the time finalize fires). */
export const FinalizeApplyToDocSchema = z.object({
  mode: z.literal('patch'),
  /** The primary blob path the CLIENT believes the entity is
   *  currently pointing at:
   *    - `null`  → expect doc.attachment / doc.image to be absent
   *                (first-attach flow OR detach-then-re-attach)
   *    - string  → expect doc.attachment.filePath / doc.image.path
   *                to equal this string exactly
   *
   *  Mismatch → 409. Closes the "Tab A slow finalize overwrites
   *  Tab B's replacement" race. The intent system already pins
   *  one-blob-per-intent; this pins one-attachment-per-doc-version. */
  expectedCurrentPath: z.string().nullable(),
})
export type FinalizeApplyToDoc = z.infer<typeof FinalizeApplyToDocSchema>

export const FinalizeRequestSchema = z.object({
  /** Trip scope for the intent lookup. Intents live under
   *  `trips/{tripId}/uploadIntents/{intentId}` (Phase-3.5-bis), so the
   *  caller MUST declare which trip they expect the intents to belong
   *  to. Worker re-verifies each intent's `tripId` field matches; a
   *  forged tripId either lands at a non-existent subcollection path
   *  (404 intent not found) or hits the intent field mismatch check. */
  tripId:    z.string().regex(TripIdRe),
  /** 1 or 2 intent IDs, expected to belong to the SAME entity (one
   *  full or pdf, optionally one thumb). Worker rejects mismatched
   *  scope across the set. */
  intentIds: z.array(z.string().min(1).max(60)).min(1).max(MAX_UPLOADS_PER_REQUEST),
  /** Phase 3.6: Worker is now the authoritative writer for
   *  booking.attachment / wish.image. Caller declares which doc to
   *  patch (implied by the intents' entityType/entityId) and what
   *  state of the doc it expects (expectedCurrentPath). */
  applyToDoc: FinalizeApplyToDocSchema,
})
export type FinalizeRequest = z.infer<typeof FinalizeRequestSchema>

/** Worker no longer returns the blob payload -- the entity doc IS
 *  the source of truth, and the client will re-read it through its
 *  realtime listener. Keeping the response narrow also avoids the
 *  "client wrote stale attachment from finalize response" failure
 *  mode that the doc-authoritative pattern is designed to prevent. */
export interface FinalizeResponse {
  ok: true
}

export async function finalizeUploadIntents(
  callerUid:          string,
  req:                FinalizeRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<FinalizeResponse> {
  return withTokenRetry(() => doFinalize(callerUid, req, serviceAccountJson, bucket))
}

/** Read the primary blob path currently stored on the entity doc.
 *  Returns `null` when the attachment / image field is absent (e.g.
 *  doc-first booking pre-attach, or post-detach via deleteField()). */
function readCurrentPrimaryPath(
  entityType: 'booking' | 'wish',
  fields:     Record<string, FsValue>,
): string | null {
  if (entityType === 'booking') {
    return readNestedString(fields, 'attachment', 'filePath') ?? null
  }
  return readNestedString(fields, 'image', 'path') ?? null
}

/** Read the thumb path currently stored. Used by the idempotent-
 *  replay verification path (must match intent.path) when a thumb
 *  intent is in the set. */
function readCurrentThumbPath(
  entityType: 'booking' | 'wish',
  fields:     Record<string, FsValue>,
): string | null {
  if (entityType === 'booking') {
    return readNestedString(fields, 'attachment', 'thumbPath') ?? null
  }
  return readNestedString(fields, 'image', 'thumbPath') ?? null
}

/** Build the Firestore mapValue payload for a booking/wish attachment
 *  field from the consumed intents. Field-name asymmetry (BookingAttachment
 *  uses fileUrl/filePath/fileType; WishImage uses url/path) is captured
 *  here so the call site stays clean. */
function buildAttachmentMapValue(
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

async function doFinalize(
  callerUid:          string,
  req:                FinalizeRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<FinalizeResponse> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  // Deduplicate intentIds early to fail-fast before the tx round-trip.
  if (new Set(req.intentIds).size !== req.intentIds.length) {
    throw new CascadeError(400, 'intentIds contains duplicates')
  }

  return runFirestoreTransaction(accessToken, projectId, async (tx) => {
    const writes:   TxWrite[]        = []
    const consumed: ConsumedIntent[] = []

    // ── Step 1: Consume each intent ────────────────────────────────
    // Validates intent doc + Storage object metadata. This IS the
    // authoritative intent-bound check (storage.rules is a STABLE
    // GATE that never reads the intent doc), so contentType /
    // size / customMetadata equality against intent.allowedContentTypes
    // / maxBytes / customMetadata happens here. markUsedWrite queued;
    // entity-doc patch added below in Step 5 so the whole thing
    // commits as one tx.
    //
    // `allowUsed: true` enables idempotent replay. uid + storage +
    // customMetadata still re-verified -- replay is scoped to the
    // original uploader.
    for (const intentId of req.intentIds) {
      const r = await consumeIntentInTx(
        tx, intentId, callerUid, accessToken, projectId, bucket,
        req.tripId,
        { tripId: req.tripId },
        { allowUsed: true },
      )
      if (r.consumed.entityType === 'expense') {
        throw new CascadeError(400,
          `intent ${intentId} is for an expense -- use /expense-create or /expense-update instead`)
      }
      consumed.push(r.consumed)
      if (r.markUsedWrite) writes.push(r.markUsedWrite)
    }

    // ── Step 2: Cross-intent coherence ─────────────────────────────
    const first = consumed[0]!
    for (const c of consumed) {
      if (c.tripId     !== first.tripId)     throw new CascadeError(400, 'tripId mismatch across intentIds')
      if (c.entityType !== first.entityType) throw new CascadeError(400, 'entityType mismatch across intentIds')
      if (c.entityId   !== first.entityId)   throw new CascadeError(400, 'entityId mismatch across intentIds')
    }
    const kinds = consumed.map(c => c.kind)
    if (new Set(kinds).size !== kinds.length) {
      throw new CascadeError(400, 'duplicate kinds in intentIds')
    }

    const primary = consumed.find(c => c.kind === 'full' || c.kind === 'pdf')
    const thumb   = consumed.find(c => c.kind === 'thumb')
    if (!primary) {
      throw new CascadeError(400, 'intentIds must include a full or pdf intent (primary blob missing)')
    }
    const entityType = first.entityType as 'booking' | 'wish'

    // Phase 3.6: WishImage requires url + path + thumbUrl + thumbPath
    // ALL present, but they can collapse to the primary blob when no
    // thumb intent landed -- HEIC / HEIF pass-throughs and decode
    // failures (see src/utils/image.ts PASSTHROUGH_TYPES) ship as
    // primary-only. The allowlist accepts these MIME types for wish
    // covers, so refusing finalize here would orphan the upload and
    // roll the wish doc back. buildAttachmentMapValue below mirrors
    // the historical client-side fallback (thumbUrl ?? fullUrl).
    if (entityType === 'wish' && primary.kind !== 'full') {
      throw new CascadeError(400, 'wish primary must be kind=full (PDF not allowed for wish)')
    }

    // Phase 3.6: all intents must share state (all pending or all
    // used). Mixed -- one used, one pending -- shouldn't arise under
    // single-tx semantics; if it does, it indicates a client double-
    // submit retry with a NEW thumb intent on top of a previously
    // finalized full intent. Rejecting is safer than guessing intent;
    // client can recover by restarting from intent request.
    const allUsed    = consumed.every(c => c.alreadyUsed)
    const allPending = consumed.every(c => !c.alreadyUsed)
    if (!allUsed && !allPending) {
      throw new CascadeError(409,
        'mixed intent states across this finalize set; re-request intents and retry from scratch')
    }

    // Phase 3.6: Worker is the authoritative writer for the entity's
    // attachment / image field. We need a valid download URL for the
    // primary blob (and for wish, also the thumb). Firebase Storage
    // SDK always sets firebaseStorageDownloadTokens on uploadBytes;
    // a null URL here implies a non-Firebase-SDK upload pathway that
    // would produce a doc violating the entity's Zod schema downstream.
    // Reject explicitly rather than write malformed data.
    if (primary.downloadUrl === null) {
      throw new CascadeError(500,
        `primary blob at ${primary.path} has no Firebase download token (upload bypassed SDK?)`)
    }
    if (thumb && thumb.downloadUrl === null) {
      throw new CascadeError(500,
        `thumb blob at ${thumb.path} has no Firebase download token (upload bypassed SDK?)`)
    }

    // ── Step 3: Re-verify caller's CURRENT write permission ─────────
    // Intent was minted up to 30 min ago. In the meantime the caller
    // could have been demoted, removed from the trip, or the trip
    // could have entered cascade-delete state. The intent system on
    // its own can't see those changes -- re-check now, in the same
    // tx as the doc patch, so a stale-permission capability token
    // can't slip through.
    const trip = await tx.get(`trips/${first.tripId}`)
    if (!trip.exists)              throw new CascadeError(410, 'trip not found')
    if ('deletingAt' in trip.fields) throw new CascadeError(410, 'trip is being deleted')

    const member = await tx.get(`trips/${first.tripId}/members/${callerUid}`)
    if (!member.exists) throw new CascadeError(403, 'caller is not a trip member')
    const role = readString(member.fields, 'role')

    if (entityType === 'booking') {
      if (role !== 'owner' && role !== 'editor') {
        throw new CascadeError(403, 'caller role is not owner/editor')
      }
    } else {
      // wish: any role, but must be proposer (checked against the
      // wish doc itself in Step 4).
      if (role !== 'owner' && role !== 'editor' && role !== 'viewer') {
        throw new CascadeError(403, 'caller role invalid')
      }
    }

    // ── Step 4: Read entity doc + stale-finalize guard ──────────────
    const entityPath = entityType === 'booking'
      ? `trips/${first.tripId}/bookings/${first.entityId}`
      : `trips/${first.tripId}/wishes/${first.entityId}`
    const entityDoc = await tx.get(entityPath)
    if (!entityDoc.exists) {
      // Doc-first flow violated -- entity should exist by upload time
      // for both booking (Phase 3.6 doc-first create) and wish
      // (intent-mint already enforces wish-doc-exists). If it's gone
      // now, either the user deleted it between upload and finalize,
      // or someone never created it. 410 in either case.
      throw new CascadeError(410,
        `${entityType} ${first.entityId} not found (deleted between upload and finalize, or never created)`)
    }

    if (entityType === 'wish') {
      const proposer = readString(entityDoc.fields, 'proposedBy')
      if (proposer !== callerUid) {
        throw new CascadeError(403, 'only the wish proposer can finalize its image')
      }
    }

    const currentPrimaryPath = readCurrentPrimaryPath(entityType, entityDoc.fields)

    if (allUsed) {
      // Idempotent-replay guard: client previously finalized this
      // intent set successfully (Worker patched the doc), and is now
      // retrying. The doc must STILL reflect this intent exactly --
      // if the user has since detached / replaced the attachment, the
      // intent's blob is dead bytes (will be reaped by orphan-scan)
      // and we MUST NOT resurrect it into the doc.
      if (currentPrimaryPath !== primary.path) {
        throw new CascadeError(409,
          `idempotent-replay denied: entity primary path '${currentPrimaryPath ?? 'absent'}' ` +
          `does not match intent '${primary.path}' (entity was detached or replaced)`)
      }
      if (thumb) {
        const currentThumbPath = readCurrentThumbPath(entityType, entityDoc.fields)
        if (currentThumbPath !== thumb.path) {
          throw new CascadeError(409,
            `idempotent-replay denied: entity thumb path '${currentThumbPath ?? 'absent'}' ` +
            `does not match intent '${thumb.path}'`)
        }
      }
      // All paths match → idempotent OK. No-op: writes[] is empty
      // (no markUsed because alreadyUsed=true, and no patch because
      // doc already reflects). Commit will be a no-op tx.
      return { writes, result: { ok: true as const } }
    }

    // allPending path: first-time finalize. Stale-finalize guard --
    // client must have declared the doc state it expected. If another
    // tab already replaced or detached the attachment between upload
    // and finalize, the client's intent is no longer current; reject
    // so the new blob doesn't overwrite the user's intended state
    // (and become an orphan itself).
    if (currentPrimaryPath !== req.applyToDoc.expectedCurrentPath) {
      throw new CascadeError(409,
        `stale-finalize: entity primary path '${currentPrimaryPath ?? 'absent'}' ` +
        `does not match expectedCurrentPath '${req.applyToDoc.expectedCurrentPath ?? 'null'}' ` +
        `(another tab replaced or detached the attachment)`)
    }

    // ── Step 5: Patch entity doc ────────────────────────────────────
    // Same tx as intent markUsed writes. updatedBy + updatedAt
    // bumped to mirror what the client-side service layers stamp on
    // ordinary booking/wish edits, so feature-badge unread tracking
    // (useFeatureBadges) sees the change just like a manual edit.
    // updateMask scoped to the three fields we're touching -- other
    // booking/wish fields are preserved.
    const fieldName = entityType === 'booking' ? 'attachment' : 'image'
    const attachmentValue = buildAttachmentMapValue(entityType, primary, thumb)

    writes.push({
      document: docResourceName(projectId, entityPath),
      fields: {
        [fieldName]: attachmentValue,
        updatedBy:   { stringValue: callerUid },
      },
      updateMask: [fieldName, 'updatedBy'],
      currentDocument: { exists: true },
      updateTransforms: [
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
      ],
    })

    return { writes, result: { ok: true as const } }
  })
}
