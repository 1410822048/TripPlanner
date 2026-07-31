// workers/ocr/src/upload-intent.ts
// Phase 3.5: server-issued upload intents.
//
// The Worker is the only R2 writer. An intent binds caller, canonical path,
// entity, MIME, byte length, expiry and metadata before any bytes are accepted.
// Upload advances pending → uploaded; entity-write consumption re-verifies the
// immutable R2 object and atomically advances uploaded → used with the entity.
//
// Client flow:
//   1. POST /upload-intents → Worker returns { intents: [...] }
//      with canonical path + customMetadata for each blob.
//   2. Client POSTs raw bytes to /attachment-upload with the intent id.
//      The Worker validates size, MIME, magic bytes and digest, then writes R2.
//   3. POST the matching entity-write endpoint with the intentIds.
//      Worker consumes the intents and writes the entity doc atomically.
// PDF page count remains a consume-time product invariant, so the <=5MB object
// is parsed before any entity doc may reference it.
import { z }                                                        from 'zod'
import { getAdminToken, getProjectId }                              from './admin'
import {
  readString,
  readTimestampMs,
  type FsValue,
}                                                                   from './firestore'
import { withTokenRetry, CascadeError }                              from './cascade'
import {
  runFirestoreTransaction,
  docResourceName,
  type TxContext,
  type TxWrite,
}                                                                   from './firestore-tx'
import {
  createR2Object,
  deleteR2Object,
  getR2Object,
  headR2Object,
  type R2StoredObject,
}                                                                   from './r2-storage'
import {
  assertPdfPageLimitBytes,
}                                                                   from './pdf-page-limit'
import { PdfPageLimitError }                                        from '@tripmate/pdf-page-limit'
import { TripIdRe }                                                  from './field-validation'

// ─── Constants ────────────────────────────────────────────────────

/** Intent TTL. 30 min covers the realistic upload + retry envelope
 *  (compress 5MB image + slow 3G upload + iOS Safari background
 *  suspension) without leaving long-lived stale-permission tokens. */
const EXPIRE_MS = 30 * 60 * 1000

/** Hard cap on object size, mirrored by the raw upload endpoint and client. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

/** Worker-owned metadata schema version. The client passes it through
 *  opaquely; upload and consume both compare the exact intent-bound shape. */
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
 *  `mode` is a wish-only discriminator at intent-minting time:
 *  `'create'` skips the wish-doc-exists + proposer check in
 *  `authorizeUpload` because the wish doc legitimately doesn't exist
 *  yet (Worker `/wish-file-create` writes it in the same tx that
 *  consumes these intents); `'update'` enforces both checks. For
 *  expense + booking `authorizeUpload` is pure trip-role authz with
 *  no doc read, so `mode` is ignored at this layer — create vs
 *  update semantics for those entities are enforced at the
 *  /{booking,expense}-file-* / /expense-{create,update} write
 *  endpoints, not here.
 *
 *  Optional + defaulted to `'update'` in `doCreate` keeps the
 *  pre-Phase-3.7 wish update path working when mode is absent
 *  (proposer check still runs). */
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

/** Single intent the Worker mints. Path and metadata are opaque to clients. */
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

const COLLECTION_BY_ENTITY = {
  expense: 'expenses',
  booking: 'bookings',
  wish:    'wishes',
} as const satisfies Record<EntityType, 'expenses' | 'bookings' | 'wishes'>

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
  if ('removingAt' in member.fields) {
    throw new CascadeError(403, 'caller is being removed from the trip')
  }
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
    if (u.size > MAX_ATTACHMENT_BYTES) {
      throw new CascadeError(413, `upload size ${u.size} exceeds maxBytes ${MAX_ATTACHMENT_BYTES}`)
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
    // `mode` is wish-only at the authz layer (see schema doc above).
    // Default `'update'` keeps the proposer + doc-exists checks on
    // when the caller omits `mode` — the safer fallback, since
    // `'create'` is the path that skips those checks.
    const mode = req.mode ?? 'update'
    await authorizeUpload(tx, req.tripId, req.entityType, req.entityId, callerUid, mode)

    const expiresAtMs = Date.now() + EXPIRE_MS
    const expiresAt   = new Date(expiresAtMs).toISOString()
    const writes:    TxWrite[]              = []
    const responses: UploadIntentResponse[] = []
    const collection = COLLECTION_BY_ENTITY[req.entityType]

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
      // image/jpeg. The exact-CT lock fires
      // at consume time inside consumeIntentInTx below, which
      // re-reads the intent doc and rejects when the uploaded
      // object's contentType is not in allowedContentTypes.
      const fields: Record<string, FsValue> = {
        uid:        { stringValue: callerUid },
        tripId:     { stringValue: req.tripId },
        entityType: { stringValue: req.entityType },
        entityId:   { stringValue: req.entityId },
        mode:       { stringValue: mode },
        kind:       { stringValue: upload.kind },
        path:       { stringValue: path },
        allowedContentTypes: {
          arrayValue: { values: [{ stringValue: upload.contentType }] },
        },
        maxBytes:   { integerValue: String(MAX_ATTACHMENT_BYTES) },
        expectedBytes: { integerValue: String(upload.size) },
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
 *  All consumers (consumeEntityIntents) require status='uploaded' and
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
  storage:        R2StoredObject
}

interface ConsumeResult {
  consumed:       ConsumedIntent
  /** The uploaded → used transition write. Caller MUST include this in
   *  their tx commit writes -- otherwise the intent stays uploaded and
   *  a replay re-consumes the same blob. */
  markUsedWrite:  TxWrite
}

/** Per-request PDF page-count cache. Firestore may re-run the tx body on
 * ABORTED/pre-commit retry; tying the cache key to the R2 version avoids
 * re-downloading/re-parsing the same immutable bytes while still revalidating
 * if the object was deleted and recreated at the same path. */
export type PdfValidationCache = Set<string>

export interface AttachmentUploadInput {
  tripId:     string
  intentId:   string
  contentType: string
  bytes:      ArrayBuffer
  sha256:     string
}

type UploadMode = 'create' | 'update'
type UploadStatus = 'pending' | 'uploaded' | 'used'

interface UploadContract {
  path:             string
  status:           UploadStatus
  entityType:       EntityType
  entityId:         string
  mode:             UploadMode
  recordedDigest?:  string
  expiresAtMs?:     number
  customMetadata:   Record<string, string>
}

type UploadPhaseResult =
  | { kind: 'upload'; path: string; customMetadata: Record<string, string>; replayed: boolean }
  | { kind: 'skip'; path: string; replayed: true }
  | { kind: 'finalized'; path: string }
  | { kind: 'rejected'; path: string; status: number; message: string; cleanupObject: boolean }

function readUploadContract(
  fields:     Record<string, FsValue>,
  callerUid: string,
  input:     AttachmentUploadInput,
): UploadContract {
  const uid = readString(fields, 'uid')
  if (uid !== callerUid) throw new CascadeError(403, `intent ${input.intentId} not owned by caller`)

  const tripId = readString(fields, 'tripId')
  const path = readString(fields, 'path')
  if (tripId !== input.tripId || !path) {
    throw new CascadeError(400, `intent ${input.intentId} scope mismatch`)
  }

  const entityTypeRaw = readString(fields, 'entityType')
  if (entityTypeRaw !== 'expense' && entityTypeRaw !== 'booking' && entityTypeRaw !== 'wish') {
    throw new CascadeError(500, `intent ${input.intentId} has invalid entityType`)
  }
  const entityId = readString(fields, 'entityId')
  if (!entityId) throw new CascadeError(500, `intent ${input.intentId} missing entityId`)

  const modeRaw = readString(fields, 'mode')
  if (modeRaw !== undefined && modeRaw !== 'create' && modeRaw !== 'update') {
    throw new CascadeError(500, `intent ${input.intentId} has invalid mode`)
  }

  const statusRaw = readString(fields, 'status')
  if (statusRaw !== 'pending' && statusRaw !== 'uploaded' && statusRaw !== 'used') {
    throw new CascadeError(409, `intent ${input.intentId} status=${statusRaw ?? 'unknown'} cannot accept upload`)
  }

  const allowed = (fields.allowedContentTypes as { arrayValue?: { values?: FsValue[] } } | undefined)
    ?.arrayValue?.values
    ?.map(value => value.stringValue)
    .filter((value): value is string => typeof value === 'string') ?? []
  const expectedBytesRaw = (fields.expectedBytes as { integerValue?: string | number } | undefined)?.integerValue
  const expectedBytes = expectedBytesRaw === undefined ? undefined : Number(expectedBytesRaw)
  if (!allowed.includes(input.contentType)) {
    throw new CascadeError(415, `contentType '${input.contentType}' does not match intent`)
  }
  if (expectedBytes === undefined || expectedBytes !== input.bytes.byteLength) {
    throw new CascadeError(400, `upload size ${input.bytes.byteLength} does not match intent size ${expectedBytes ?? 'missing'}`)
  }
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new CascadeError(413, `upload size ${input.bytes.byteLength} exceeds maxBytes ${MAX_ATTACHMENT_BYTES}`)
  }

  const metadataFields = (fields.customMetadata as { mapValue?: { fields?: Record<string, FsValue> } } | undefined)?.mapValue?.fields
  if (!metadataFields) throw new CascadeError(500, `intent ${input.intentId} missing customMetadata`)
  const customMetadata = Object.fromEntries(
    Object.entries(metadataFields)
      .map(([key, value]) => [key, value.stringValue] as const)
      .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string'),
  )
  customMetadata.sha256 = input.sha256

  return {
    path,
    status: statusRaw,
    entityType: entityTypeRaw,
    entityId,
    mode: modeRaw ?? 'update',
    recordedDigest: readString(fields, 'sha256'),
    expiresAtMs: readTimestampMs(fields, 'expiresAt'),
    customMetadata,
  }
}

function assertDigest(contract: UploadContract, input: AttachmentUploadInput): void {
  if (contract.recordedDigest !== undefined && contract.recordedDigest !== input.sha256) {
    throw new CascadeError(409, `intent ${input.intentId} already contains different bytes`)
  }
}

function assertUnexpired(contract: UploadContract, input: AttachmentUploadInput): void {
  if (contract.expiresAtMs === undefined) {
    throw new CascadeError(500, `intent ${input.intentId} missing expiresAt`)
  }
  if (Date.now() > contract.expiresAtMs) {
    throw new CascadeError(410, `intent ${input.intentId} expired`)
  }
}

function matchesUpload(object: R2StoredObject, input: AttachmentUploadInput): boolean {
  return object.customMetadata.sha256 === input.sha256
    && object.contentType === input.contentType
    && object.size === input.bytes.byteLength
}

function isAuthorizationStateError(error: unknown): error is CascadeError {
  return error instanceof CascadeError
    && (error.status === 403 || error.status === 404 || error.status === 410)
}

async function uploadAuthorizationFailure(
  tx:        TxContext,
  contract:  UploadContract,
  tripId:    string,
  callerUid: string,
): Promise<CascadeError | null> {
  try {
    await authorizeUpload(
      tx, tripId, contract.entityType, contract.entityId, callerUid, contract.mode,
    )
    return null
  } catch (error) {
    if (isAuthorizationStateError(error)) return error
    throw error
  }
}

function rejectedUploadResult(
  projectId: string,
  docPath:   string,
  contract:  UploadContract,
  error:     CascadeError,
) {
  const cleanupObject = contract.status !== 'used'
  return {
    writes: cleanupObject ? [{
      op: 'delete' as const,
      document: docResourceName(projectId, docPath),
      currentDocument: { exists: true },
    }] : [],
    result: {
      kind: 'rejected' as const,
      path: contract.path,
      status: error.status,
      message: error.message,
      cleanupObject,
    },
  }
}

async function throwRejectedUpload(
  result: Extract<UploadPhaseResult, { kind: 'rejected' }>,
  bucket: R2Bucket,
): Promise<never> {
  if (result.cleanupObject) await deleteRejectedObject(bucket, result.path)
  throw new CascadeError(result.status, result.message)
}

/**
 * Reserve the digest in a Firestore transaction, write the create-only R2
 * object outside the retryable transaction body, then re-authorize and mark
 * the intent uploaded in a second transaction. This deliberately avoids an
 * irreversible R2 side effect inside `runFirestoreTransaction`, whose body
 * may run again after a conflict or a definitive pre-commit timeout.
 */
export async function uploadAttachmentToIntent(
  callerUid:          string,
  input:              AttachmentUploadInput,
  serviceAccountJson: string,
  bucket:             R2Bucket,
): Promise<{ path: string; replayed: boolean }> {
  return withTokenRetry(async () => {
    const accessToken = await getAdminToken(serviceAccountJson)
    const projectId   = getProjectId(serviceAccountJson)

    const docPath = `trips/${input.tripId}/uploadIntents/${input.intentId}`

    const prepared = await runFirestoreTransaction<UploadPhaseResult>(accessToken, projectId, async (tx) => {
      const intent = await tx.get(docPath)
      if (!intent.exists) throw new CascadeError(404, `intent ${input.intentId} not found`)
      const contract = readUploadContract(intent.fields, callerUid, input)
      const authError = await uploadAuthorizationFailure(tx, contract, input.tripId, callerUid)
      if (authError) return rejectedUploadResult(projectId, docPath, contract, authError)

      assertDigest(contract, input)
      if (contract.status === 'used') {
        return { writes: [], result: { kind: 'skip', path: contract.path, replayed: true } }
      }
      if (contract.status === 'uploaded') {
        const existing = await headR2Object(bucket, contract.path)
        if (existing) {
          if (!matchesUpload(existing, input)) {
            throw new CascadeError(409, `canonical path ${contract.path} already contains different bytes`)
          }
          return { writes: [], result: { kind: 'skip', path: contract.path, replayed: true } }
        }
      }
      assertUnexpired(contract, input)

      const reserveWrite: TxWrite = {
        document: docResourceName(projectId, docPath),
        fields: {
          status: { stringValue: 'pending' },
          sha256: { stringValue: input.sha256 },
        },
        updateMask: ['status', 'sha256'],
        currentDocument: { exists: true },
        updateTransforms: [
          { fieldPath: 'uploadAuthorizedAt', setToServerValue: 'REQUEST_TIME' },
        ],
      }
      return {
        writes: [reserveWrite],
        result: {
          kind: 'upload',
          path: contract.path,
          customMetadata: contract.customMetadata,
          replayed: contract.status === 'uploaded' || contract.recordedDigest !== undefined,
        },
      }
    })

    if (prepared.kind === 'rejected') return throwRejectedUpload(prepared, bucket)
    if (prepared.kind === 'skip') return { path: prepared.path, replayed: true }
    if (prepared.kind !== 'upload') {
      throw new CascadeError(500, `unexpected upload preparation result: ${prepared.kind}`)
    }

    const created = await createR2Object(
      bucket, prepared.path, input.bytes, input.contentType, prepared.customMetadata,
    )
    const stored = created ?? await headR2Object(bucket, prepared.path)
    if (!stored) throw new CascadeError(502, `R2 object missing after create at ${prepared.path}`)
    if (!matchesUpload(stored, input)) {
      throw new CascadeError(409, `canonical path ${prepared.path} already contains different bytes`)
    }

    let finalized: UploadPhaseResult
    try {
      finalized = await runFirestoreTransaction<UploadPhaseResult>(accessToken, projectId, async (tx) => {
        const intent = await tx.get(docPath)
        if (!intent.exists) throw new CascadeError(404, `intent ${input.intentId} not found`)
        const contract = readUploadContract(intent.fields, callerUid, input)
        const authError = await uploadAuthorizationFailure(tx, contract, input.tripId, callerUid)
        if (authError) return rejectedUploadResult(projectId, docPath, contract, authError)

        assertDigest(contract, input)
        if (contract.status === 'used') {
          return { writes: [], result: { kind: 'skip', path: contract.path, replayed: true } }
        }
        if (contract.status === 'uploaded') {
          const existing = await headR2Object(bucket, contract.path)
          if (!existing || !matchesUpload(existing, input)) {
            throw new CascadeError(409, `uploaded intent ${input.intentId} no longer matches R2`)
          }
          return { writes: [], result: { kind: 'skip', path: contract.path, replayed: true } }
        }
        assertUnexpired(contract, input)

        const current = await headR2Object(bucket, contract.path)
        if (!current || !matchesUpload(current, input)) {
          throw new CascadeError(409, `R2 object does not match reserved intent ${input.intentId}`)
        }
        const fields: Record<string, FsValue> = {
          status:              { stringValue: 'uploaded' },
          sha256:              { stringValue: input.sha256 },
          uploadedBytes:       { integerValue: String(current.size) },
          uploadedContentType: { stringValue: current.contentType },
          r2Version:           { stringValue: current.version },
        }
        return {
          writes: [{
            document: docResourceName(projectId, docPath),
            fields,
            updateMask: Object.keys(fields),
            currentDocument: { exists: true },
            updateTransforms: [
              { fieldPath: 'uploadedAt', setToServerValue: 'REQUEST_TIME' },
            ],
          }],
          result: { kind: 'finalized', path: contract.path },
        }
      })
    } catch (error) {
      if (isAuthorizationStateError(error)) await deleteRejectedObject(bucket, prepared.path)
      throw error
    }

    if (finalized.kind === 'rejected') return throwRejectedUpload(finalized, bucket)
    if (finalized.kind === 'upload') {
      throw new CascadeError(500, 'unexpected nested upload reservation during finalize')
    }
    return {
      path: prepared.path,
      replayed: prepared.replayed || created === null || finalized.kind === 'skip',
    }
  })
}

/** Read an intent doc inside a tx, validate all consume-time preconditions,
 *  and verify the corresponding R2 object exists.
 *  Returns the consumed intent + the tx write to mark it used; caller
 *  must include the write in their TxResult.writes.
 *
 *  Validation order is deliberate -- cheaper local checks before the
 *  remote Storage roundtrip:
 *    intent exists → status=uploaded → uid match → not expired →
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
  projectId:    string,
  bucket:       R2Bucket,
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
  pdfValidationCache?: PdfValidationCache,
): Promise<ConsumeResult> {
  const intent = await tx.get(`trips/${lookupTripId}/uploadIntents/${intentId}`)
  if (!intent.exists) throw new CascadeError(404, `intent ${intentId} not found`)

  const status = readString(intent.fields, 'status')
  if (status !== 'uploaded') {
    throw new CascadeError(409, `intent ${intentId} status=${status ?? 'unknown'} (must be uploaded)`)
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

  // Extract the Worker-minted binding fields. Consume verifies the R2 object
  // again so a stale/replayed request cannot attach bytes from another intent.
  const intentMetadataFields = (intent.fields.customMetadata as { mapValue?: { fields?: Record<string, FsValue> } } | undefined)?.mapValue?.fields
  const intentAllowedCtValues = (intent.fields.allowedContentTypes as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values
  const intentMaxBytesRaw = (intent.fields.maxBytes as { integerValue?: string | number } | undefined)?.integerValue
  const uploadedBytesRaw = (intent.fields.uploadedBytes as { integerValue?: string | number } | undefined)?.integerValue
  const uploadedContentType = readString(intent.fields, 'uploadedContentType')
  const uploadedDigest = readString(intent.fields, 'sha256')
  if (!intentMetadataFields || !intentAllowedCtValues || intentMaxBytesRaw === undefined || uploadedBytesRaw === undefined || !uploadedContentType || !uploadedDigest) {
    throw new CascadeError(500, `intent ${intentId} missing required binding fields (allowedContentTypes / maxBytes / customMetadata)`)
  }
  const intentMaxBytes = Number(intentMaxBytesRaw)
  const intentAllowedCts = intentAllowedCtValues
    .map(v => v.stringValue)
    .filter((s): s is string => typeof s === 'string')

  // R2 object existence + metadata. Done inside the tx body so a
  // concurrent consume / cron-cleanup race shows up as ABORTED commit
  // (the intent doc would change). The fetch itself doesn't participate
  // in Firestore tx, but the intent.status='uploaded' read above + the
  // commit-time write below pin the moment of consumption.
  const storage = await headR2Object(bucket, path)
  if (!storage) throw new CascadeError(404, `storage object missing at ${path} (upload not yet committed?)`)

  // R2 object MUST match the intent's contract. Three classes
  // of check, ordered cheapest first:
  //   1. contentType -- intent allowedContentTypes is single-element
  //      (locked to the requested CT), so this is exact-match.
  //   2. size -- object bytes must fit under the intent's maxBytes.
  //   3. customMetadata -- every key the Worker minted at intent time
  //      (uploadIntentId, uploaderUid, tripId, entityType, entityId,
  //      kind, schemaVersion) must be present on the object with the
  //      exact same value. Missing OR mismatched both fail.
  //
  // The Worker is the sole R2 trust boundary; these checks are the
  // consume-time chokepoint before an entity may reference the object.
  if (!intentAllowedCts.includes(storage.contentType)) {
    throw new CascadeError(400,
      `storage contentType '${storage.contentType}' does not match intent allowedContentTypes [${intentAllowedCts.join(', ')}]`)
  }
  if (storage.size > intentMaxBytes) {
    throw new CascadeError(413,
      `storage object size ${storage.size} exceeds intent maxBytes ${intentMaxBytes}`)
  }
  if (storage.size !== Number(uploadedBytesRaw) || storage.contentType !== uploadedContentType) {
    throw new CascadeError(409, `R2 object no longer matches uploaded intent ${intentId}`)
  }
  if (storage.customMetadata.sha256 !== uploadedDigest) {
    throw new CascadeError(409, `R2 object digest mismatch for intent ${intentId}`)
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

  if (kind === 'pdf') {
    await validatePdfPageLimitOrDelete(bucket, path, storage, pdfValidationCache)
  }

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
    },
    markUsedWrite,
  }
}

async function validatePdfPageLimitOrDelete(
  bucket:      R2Bucket,
  path:        string,
  storage:     R2StoredObject,
  cache?:      PdfValidationCache,
): Promise<void> {
  const cacheKey = pdfValidationCacheKey(path, storage)
  if (cacheKey && cache?.has(cacheKey)) return

  const object = await getR2Object(bucket, path)
  if (!object) throw new CascadeError(404, `storage object missing at ${path} during PDF page validation`)
  const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream'
  if (contentType !== 'application/pdf') {
    await deleteRejectedObject(bucket, path)
    throw new CascadeError(400, `downloaded PDF contentType mismatch: ${contentType}`)
  }
  if (object.size > MAX_ATTACHMENT_BYTES) {
    await deleteRejectedObject(bucket, path)
    throw new CascadeError(413, `downloaded PDF size ${object.size} exceeds limit ${MAX_ATTACHMENT_BYTES}`)
  }
  const bytes = await object.arrayBuffer()
  if (bytes.byteLength !== storage.size || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    await deleteRejectedObject(bucket, path)
    throw new CascadeError(413, `downloaded PDF size ${bytes.byteLength} differs from validated metadata size ${storage.size}`)
  }

  try {
    await assertPdfPageLimitBytes(bytes)
    if (cacheKey) cache?.add(cacheKey)
  } catch (e) {
    if (e instanceof PdfPageLimitError) {
      await deleteRejectedObject(bucket, path)
    }
    throw e
  }
}

function pdfValidationCacheKey(path: string, storage: R2StoredObject): string | null {
  return storage.version ? `${path}@${storage.version}` : null
}

async function deleteRejectedObject(
  bucket:      R2Bucket,
  path:        string,
): Promise<void> {
  try {
    await deleteR2Object(bucket, path)
  } catch { /* best-effort; orphan storage-scan backstops */ }
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
  projectId:    string,
  bucket:       R2Bucket,
  expected: {
    tripId:     string
    entityType: EntityType
    entityId:   string
  },
  pdfValidationCache?: PdfValidationCache,
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
      tx, intentId, callerUid, projectId, bucket,
      expected.tripId,
      { tripId: expected.tripId, entityType: expected.entityType, entityId: expected.entityId },
      pdfValidationCache,
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

// ─── Attachment payload encoding (booking + wish) ──────────────────

/** Build the Firestore mapValue payload for a booking/wish attachment
 *  field from the consumed intents. Field-name asymmetry (BookingAttachment
 *  uses filePath/fileType; WishImage uses path) is captured here so the
 *  call sites in booking-write.ts and wish-write.ts stay clean and the
 *  encoding contract has one source. */
export function buildAttachmentMapValue(
  entityType: 'booking' | 'wish',
  primary:    ConsumedIntent,
  thumb:      ConsumedIntent | undefined,
): FsValue {
  if (entityType === 'booking') {
    // BookingAttachment (path-only): filePath + fileType required;
    // thumbPath optional (PDFs ship without thumbs). No url/thumbUrl --
    // reads go through the authenticated Worker proxy.
    const fields: Record<string, FsValue> = {
      filePath: { stringValue: primary.path },
      fileType: { stringValue: primary.storage.contentType },
    }
    if (thumb) {
      fields.thumbPath = { stringValue: thumb.path }
    }
    return { mapValue: { fields } }
  }
  // WishImage (path-only): path required; thumbPath only when a real thumb
  // was uploaded. We deliberately do NOT collapse thumbPath to the primary
  // path when there's no thumb (HEIC / HEIF pass-through or canvas decode
  // failure -- see src/utils/image.ts PASSTHROUGH_TYPES): that would pull a
  // full-size blob into the client thumbnail LRU. The card shows its
  // gradient placeholder for those edge cases instead. No url/thumbUrl --
  // reads go through the authenticated Worker proxy.
  const fields: Record<string, FsValue> = {
    path: { stringValue: primary.path },
  }
  if (thumb) fields.thumbPath = { stringValue: thumb.path }
  return { mapValue: { fields } }
}
