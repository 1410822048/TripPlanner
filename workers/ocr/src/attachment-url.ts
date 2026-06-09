// workers/ocr/src/attachment-url.ts
// Worker-authoritative GCS V4 signed-URL minting for attachment reads.
//
// Two endpoints, both PURE READS (trip-member is the only authz gate —
// viewers can read attachments too, mirroring storage.rules
// `allow read: if isMember(tripId)`; we do NOT require owner/editor the
// way /expense-receipt-ocr does, because that one is "preparing a write"):
//
//   POST /attachment-thumb-urls  — batch thumb signer. Client supplies the
//     paths. Bounded to `trips/{tripId}/...*.thumb.*` for a member of that
//     trip — which grants nothing beyond the member's existing getBlob read
//     access, so client-supplied paths are NOT a BOLA hole here. The
//     `.thumb.` restriction is POLICY (force full/pdf through the entity-ref
//     endpoint + its shorter TTL), not a security boundary.
//
//   POST /attachment-url  — entity-ref full/pdf signer. Client supplies
//     {entityType, entityId, variant}, NEVER a path. The Worker reads the
//     Firestore doc and DERIVES the object path (BOLA defence, same pattern
//     as /expense-receipt-ocr), then signs only that path.
//
// SECURITY: the minted URL carries a bearer signature. Handlers never log
// it; index.ts formatLog emits counts / ids only. signed URLs are returned
// to the authenticated caller and live in client memory — never persisted
// (see docs/design/attachment-signed-url-v2.md §1).
import { z }                                              from 'zod'
import { getAdminToken, getProjectId, getSigningCredentials } from './admin'
import { getDocFields, readNestedString, readTimestampMs }    from './firestore'
import { CascadeError, withTokenRetry }                  from './cascade'
import { signV4Url }                                     from './gcs-sign'

const TripIdRe = /^[A-Za-z0-9_-]{1,60}$/

/** TTLs (seconds). thumb is the longest because list thumbnails churn
 *  cheaply and benefit most from browser caching; full/pdf are short
 *  because they're opened deliberately and are higher-value bytes. */
const THUMB_TTL_SEC = 30 * 60
const FULL_TTL_SEC  = 10 * 60
const PDF_TTL_SEC   = 5 * 60

/** Batch cap. A list screen issues 1–3 batches of ≤20; tighter than 20
 *  is fine to revisit if signing 20 per request shows up in Worker CPU. */
const MAX_THUMB_PATHS = 20

// ─── Schemas ──────────────────────────────────────────────────────

/** `.strict()` so a client that smuggles `entityId` / extra keys into the
 *  thumb endpoint gets a 400, not a silently-ignored field. */
export const AttachmentThumbUrlsRequestSchema = z.object({
  tripId: z.string().regex(TripIdRe),
  paths:  z.array(z.string().min(1).max(500)).min(1).max(MAX_THUMB_PATHS),
}).strict()
export type AttachmentThumbUrlsRequest = z.infer<typeof AttachmentThumbUrlsRequestSchema>

/** `.strict()` so a smuggled `path` / `url` is a 400 (the Worker derives
 *  the path from the doc; the client is never allowed to name the object). */
export const AttachmentUrlRequestSchema = z.object({
  tripId:     z.string().regex(TripIdRe),
  entityType: z.enum(['expense', 'booking', 'wish']),
  entityId:   z.string().regex(TripIdRe),
  variant:    z.enum(['full', 'pdf']),
}).strict()
export type AttachmentUrlRequest = z.infer<typeof AttachmentUrlRequestSchema>

export interface ThumbUrlEntry { path: string; url: string; expiresAt: string }

type EntityType = 'expense' | 'booking' | 'wish'

/** entityType → (Storage path collection segment, Firestore attachment map
 *  field, inner path key, inner type key). Captures the booking/wish/expense
 *  field-name asymmetry (BookingAttachment uses filePath/fileType; expense
 *  receipt uses path/type; WishImage uses path and has NO type). */
const ATTACHMENT_FIELD: Record<EntityType, {
  collection: 'expenses' | 'bookings' | 'wishes'
  map:        string
  pathKey:    string
  typeKey?:   string
}> = {
  expense: { collection: 'expenses', map: 'receipt',    pathKey: 'path',     typeKey: 'type' },
  booking: { collection: 'bookings', map: 'attachment', pathKey: 'filePath', typeKey: 'fileType' },
  wish:    { collection: 'wishes',   map: 'image',      pathKey: 'path' },
}

// ─── Shared authz: trip member ─────────────────────────────────────

/** Resolve trip existence + caller membership in one parallel read pass.
 *  Throws CascadeError on any failure; returns nothing on success (member
 *  is the only gate — role doesn't matter for a read). */
async function requireTripMember(
  accessToken: string,
  projectId:   string,
  tripId:      string,
  callerUid:   string,
): Promise<void> {
  const [tripFields, memberFields] = await Promise.all([
    getDocFields(accessToken, projectId, `trips/${tripId}`),
    getDocFields(accessToken, projectId, `trips/${tripId}/members/${callerUid}`),
  ])
  if (!tripFields)                throw new CascadeError(404, 'trip not found')
  if ('deletingAt' in tripFields) throw new CascadeError(410, 'trip is being deleted')
  if (!memberFields)              throw new CascadeError(403, 'caller is not a trip member')
}

// ─── Thumb path validation ─────────────────────────────────────────

/** Only `A-Za-z0-9._/-` — rejects whitespace, control chars, `?`/`#`
 *  (query/fragment), `%` (encoded-slash tricks), and anything exotic. */
const SAFE_PATH_RE = /^[A-Za-z0-9._/-]+$/

/** Validate a client-supplied thumb path against the trip scope + thumb
 *  policy. Returns true when the path is signable; false otherwise (caller
 *  rejects the whole batch — one bad path is a client bug, not partial
 *  success). */
function isValidThumbPath(path: string, tripId: string): boolean {
  if (!SAFE_PATH_RE.test(path))                  return false  // control chars / encoded slash / query
  if (path.includes('..') || path.includes('//')) return false  // traversal / empty segment
  if (!path.startsWith(`trips/${tripId}/`))      return false  // cross-trip
  if (!path.includes('.thumb.'))                 return false  // thumb-only policy
  return true
}

// ─── Handlers ──────────────────────────────────────────────────────

export async function signThumbUrls(
  callerUid:          string,
  req:                AttachmentThumbUrlsRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ urls: ThumbUrlEntry[] }> {
  // Dedupe + validate BEFORE any Firestore read. This is a high-frequency
  // read surface; auth + rate-limit already ran in index.ts, so rejecting a
  // malformed / cross-trip batch here (rather than after getAdminToken +
  // requireTripMember) saves two Firestore reads per bad request without
  // weakening any gate. A list with repeated paths shouldn't double-sign.
  const unique = [...new Set(req.paths)]
  for (const path of unique) {
    if (!isValidThumbPath(path, req.tripId)) {
      throw new CascadeError(400, 'invalid thumb path')
    }
  }

  return withTokenRetry(async () => {
    const accessToken = await getAdminToken(serviceAccountJson)
    const projectId   = getProjectId(serviceAccountJson)
    await requireTripMember(accessToken, projectId, req.tripId, callerUid)

    const { clientEmail, privateKey } = getSigningCredentials(serviceAccountJson)
    const nowMs = Date.now()
    const urls: ThumbUrlEntry[] = []
    for (const path of unique) {
      const { url, expiresAt } = await signV4Url({
        bucket, objectPath: path, clientEmail, privateKeyPem: privateKey,
        expiresSeconds: THUMB_TTL_SEC, nowMs,
      })
      urls.push({ path, url, expiresAt })
    }
    return { urls }
  })
}

export async function signEntityUrl(
  callerUid:          string,
  req:                AttachmentUrlRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ url: string; expiresAt: string }> {
  return withTokenRetry(async () => {
    const accessToken = await getAdminToken(serviceAccountJson)
    const projectId   = getProjectId(serviceAccountJson)

    const spec = ATTACHMENT_FIELD[req.entityType]

    const [tripFields, memberFields, entityFields] = await Promise.all([
      getDocFields(accessToken, projectId, `trips/${req.tripId}`),
      getDocFields(accessToken, projectId, `trips/${req.tripId}/members/${callerUid}`),
      getDocFields(accessToken, projectId, `trips/${req.tripId}/${spec.collection}/${req.entityId}`),
    ])
    if (!tripFields)                throw new CascadeError(404, 'trip not found')
    if ('deletingAt' in tripFields) throw new CascadeError(410, 'trip is being deleted')
    if (!memberFields)              throw new CascadeError(403, 'caller is not a trip member')
    if (!entityFields)              throw new CascadeError(404, `${req.entityType} not found`)

    // Expense soft-delete: a deleted expense's receipt is purge-pending and
    // hidden in the UI; signing it is anomalous → 404. Booking / wish have
    // no soft-delete tombstone, so this only applies to expense.
    if (req.entityType === 'expense' && readTimestampMs(entityFields, 'deletedAt') !== undefined) {
      throw new CascadeError(404, 'expense is deleted')
    }

    // Derive the object path from the DOC — never the client.
    const path = readNestedString(entityFields, spec.map, spec.pathKey)
    if (!path) throw new CascadeError(404, `${req.entityType} has no attachment`)

    // BOLA defence in depth: even though the path came from the doc, assert
    // it lives under this trip+entity (guards a corrupt / hand-written doc).
    const prefix = `trips/${req.tripId}/${spec.collection}/${req.entityId}/`
    if (!path.startsWith(prefix)) {
      throw new CascadeError(400, 'attachment path does not belong to this entity')
    }

    // variant ↔ stored type. wish has no type field (image only) so reject
    // variant=pdf outright; expense/booking cross-check the stored mime.
    if (req.entityType === 'wish') {
      if (req.variant === 'pdf') throw new CascadeError(400, 'wish has no PDF variant')
    } else {
      // expense.receipt.type / booking.attachment.fileType are REQUIRED by
      // schema. A missing one is data-at-rest corruption — refuse rather than
      // sign an unknown-MIME object under a full/pdf TTL it may not match
      // (full=10m image, pdf=5m). 500 = server-side integrity issue, not a
      // client mistake. (spec.typeKey is always set for expense/booking.)
      const type = spec.typeKey ? readNestedString(entityFields, spec.map, spec.typeKey) : undefined
      if (!type) {
        throw new CascadeError(500, `${req.entityType} attachment is missing its content type`)
      }
      if (req.variant === 'pdf' && type !== 'application/pdf') {
        throw new CascadeError(415, 'attachment is not a PDF')
      }
      if (req.variant === 'full' && !type.startsWith('image/')) {
        throw new CascadeError(415, 'attachment is not an image')
      }
    }
    const ttl = req.variant === 'pdf' ? PDF_TTL_SEC : FULL_TTL_SEC

    const { clientEmail, privateKey } = getSigningCredentials(serviceAccountJson)
    return signV4Url({
      bucket, objectPath: path, clientEmail, privateKeyPem: privateKey,
      expiresSeconds: ttl, nowMs: Date.now(),
    })
  })
}
