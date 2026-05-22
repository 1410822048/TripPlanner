// workers/ocr/src/upload-intent.ts
// Phase 3.5: server-issued upload intents.
//
// Why this endpoint exists: under direct-client-to-Storage uploads,
// `storage.rules` is the only contract enforcement point. Any change
// to the metadata schema, allowed content types, or path layout
// requires coordinating client + rules deploys with a PWA rollout
// window (old clients lag behind, get 403s). Worker-issued intents
// move the contract from rules + client to Worker -- the rules
// become a simple "does the upload match an intent the Worker
// minted?" check, and future schema changes only touch the Worker.
//
// Client flow:
//   1. POST /upload-intents → Worker returns { intents: [...] }
//      with canonical path + customMetadata for each blob.
//   2. Client uses Firebase Storage SDK uploadBytesResumable to
//      upload to Worker-provided path with Worker-provided metadata.
//   3. (booking/wish) POST /upload-finalize → Worker verifies the
//      Storage object exists, marks intent.status='used', returns
//      attachment payload for the client to write into Firestore.
//   4. (expense) /expense-create + /expense-update consume intent
//      IDs directly -- no separate finalize step, saves one round-trip.
//
// Worker doesn't touch upload bytes. Latency added per upload is one
// extra Worker round-trip + one Storage rules cross-service read --
// not the Worker raw-body proxy pattern that would burn the Free
// plan's 10ms CPU/request budget.
import { z }                                                        from 'zod'
import { getAdminToken, getProjectId }                              from './admin'
import {
  readString,
  type FsValue,
}                                                                   from './firestore'
import { withTokenRetry, CascadeError }                             from './cascade'
import {
  runFirestoreTransaction,
  docResourceName,
  type TxContext,
  type TxWrite,
}                                                                   from './firestore-tx'

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
 *  storage.rules ↔ intent metadata shape changes; clients pass
 *  through whatever the Worker mints (they don't know schema
 *  details), so future bumps need ONLY this constant + a Worker
 *  redeploy -- no client coordination, no PWA rollout window. */
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

/** Short random id for intent doc + filename. 8 hex chars = 32 bits
 *  of entropy; collision probability for two intents in a 30-minute
 *  TTL window with even 10k req/min is < 1e-9. crypto.randomUUID is
 *  available in Cloudflare Workers (Web Crypto). */
function shortId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8)
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
      const intentId = shortId()
      const fileId   = shortId()
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
      // image/jpeg and slips past the rules check. Storage rule
      // checks `request.resource.contentType in intent.allowedContentTypes`,
      // so a single-element array gives exact-match semantics.
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
        document:        docResourceName(projectId, `uploadIntents/${intentId}`),
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
