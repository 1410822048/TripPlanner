// workers/ocr/src/attachment-url.ts
// Worker-authoritative GCS V4 signed-URL minting for attachment reads.
//
// ONE endpoint (signed reads are full/pdf only — thumb signing was removed,
// thumbnails stay on getBlob; see docs/design/attachment-signed-url-v2.md §7):
//
//   POST /attachment-url  — entity-ref full/pdf signer. Client supplies
//     {entityType, entityId, variant}, NEVER a path. The Worker reads the
//     Firestore doc and DERIVES the object path (BOLA defence, same pattern
//     as /expense-receipt-ocr), then signs only that path. Authz is
//     trip-member only (viewers can read attachments too, mirroring
//     storage.rules `allow read: if isMember(tripId)`); we do NOT require
//     owner/editor the way /expense-receipt-ocr does — that one is
//     "preparing a write".
//
// SECURITY: the minted URL carries a bearer signature. Handlers never log it;
// index.ts formatLog emits entity ids only. signed URLs are returned to the
// authenticated caller and live in client memory — never persisted (see
// docs/design/attachment-signed-url-v2.md §1).
import { z }                                              from 'zod'
import { getAdminToken, getProjectId, getSigningCredentials } from './admin'
import { getDocFields, readNestedString, readTimestampMs }    from './firestore'
import { CascadeError, withTokenRetry }                  from './cascade'
import { signV4Url }                                     from './gcs-sign'

const TripIdRe = /^[A-Za-z0-9_-]{1,60}$/

/** TTLs (seconds). full/pdf are short because they're opened deliberately and
 *  are higher-value bytes. */
const FULL_TTL_SEC = 10 * 60
const PDF_TTL_SEC  = 5 * 60

// ─── Schema ────────────────────────────────────────────────────────

/** `.strict()` so a smuggled `path` / `url` is a 400 (the Worker derives the
 *  path from the doc; the client is never allowed to name the object). */
export const AttachmentUrlRequestSchema = z.object({
  tripId:     z.string().regex(TripIdRe),
  entityType: z.enum(['expense', 'booking', 'wish']),
  entityId:   z.string().regex(TripIdRe),
  variant:    z.enum(['full', 'pdf']),
}).strict()
export type AttachmentUrlRequest = z.infer<typeof AttachmentUrlRequestSchema>

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

// ─── Handler: entity-ref full/pdf signer ───────────────────────────

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
