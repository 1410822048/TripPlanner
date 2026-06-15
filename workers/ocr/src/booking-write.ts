// workers/ocr/src/booking-write.ts
// Worker-side booking create / content-update with file attachment.
//
// Phase 3.7 split (mirrors wish-write.ts shape):
//   - booking create WITH file    → /booking-file-create  (this module)
//   - booking create WITHOUT file → client setDoc         (unchanged)
//   - booking update WITH new file → /booking-file-update (this module)
//   - booking update text-only / detach → client updateDoc (unchanged)
//
// Why these Worker endpoints exist:
//   1. Phase 3.6's doc-first booking flow needed a partial-failure
//      rollback dance when uploadAttachment failed after setDoc had
//      already landed: the realtime listener had pushed the blank
//      booking into TanStack cache, and a "save failed" toast next
//      to a visible-but-attachment-less booking led to user retries
//      that landed DUPLICATE bookings. Worker-authoritative create
//      commits doc + attachment atomically, so the listener sees the
//      booking for the first time WITH its file.
//   2. The doc-first race -- listener fires at ~200ms with no
//      attachment, then again ~600ms later once the Worker patched
//      `attachment` -- is gone by construction.
//
// firestore.rules (unchanged for Phase 3.7):
//   - booking create: `attachment` field must be ABSENT in
//     request.resource.data; Worker writes via admin SDK so the rule
//     doesn't gate this endpoint.
//   - booking update: `attachment` is `unchangedOrRemoved()` from the
//     client side. Worker is the only path that can set a new
//     attachment object.
//
// Differences from wish-write.ts:
//   - Role: owner/editor only (no viewer). No proposer concept.
//   - sortDate: invariant `sortDate = checkInTs ?? createdAt`. When
//     checkIn is parseable, sortDate gets its Timestamp value; when
//     absent (create) or cleared (update), sortDate falls back to the
//     doc's createdAt. Create-without-checkIn uses REQUEST_TIME on
//     BOTH createdAt + sortDate so they resolve to the same instant.
//     Update-clearing-checkIn reads the current doc's createdAt
//     (already loaded for the stale-replace guard, so no extra get)
//     and copies the FsValue verbatim into sortDate.
//   - Attachment shape (path-only): BookingAttachment has filePath/fileType
//     + optional thumbPath (PDFs ship without thumb). Shape lives in
//     buildAttachmentMapValue('booking', ...) in upload-intent.ts.
//   - PDFs supported (kind='pdf'); thumb intent optional.
//   - Stale-replace guard via `attachment.filePath` (not `image.path`).
import { z }                                                        from 'zod'
import { getAdminToken, getProjectId }                              from './admin'
import {
  readString,
  readNestedString,
  type FsValue,
}                                                                   from './firestore'
import { withTokenRetry, CascadeError }                             from './cascade'
import {
  runFirestoreTransaction,
  docResourceName,
  type TxContext,
  type TxWrite,
  type TxUpdateWrite,
}                                                                   from './firestore-tx'
import {
  consumeEntityIntents,
  buildAttachmentMapValue,
  type ConsumedIntent,
}                                                                   from './upload-intent'

// ─── Request body schema ──────────────────────────────────────────

const TripIdRe = /^[A-Za-z0-9_-]{1,60}$/

export const BookingFileCreateRequestSchema = z.object({
  tripId:    z.string().regex(TripIdRe),
  /** Client mints via `doc(collection(...))` -- matches the existing
   *  client-side `ref.id` pattern in `createBooking`. Worker enforces
   *  `currentDocument.exists=false` at tx commit so a collision is a
   *  hard 409, not a silent overwrite. */
  bookingId: z.string().regex(TripIdRe),
  /** Validated against `CreateBookingBodySchema` below after
   *  tripId/bookingId are known. Reject `unknown` here so the Worker
   *  controls the parse + the attachment-smuggle rejection runs
   *  before any tx round-trip. */
  booking:   z.unknown(),
  /** Phase 3.7 intent-driven attachment. Always present on this
   *  endpoint -- file-less booking create stays on the client SDK
   *  path. 1 = full or pdf only (PDFs and pass-through images),
   *  2 = full + thumb (typical WebP flow). */
  intentIds: z.array(z.string().min(1).max(60)).min(1).max(2),
})
export type BookingFileCreateRequest = z.infer<typeof BookingFileCreateRequestSchema>

// ─── Booking body validation ───────────────────────────────────────

/** Thrown for any booking body validation failure. `field` is a
 *  dotted path the caller can surface in form-level error UI.
 *  Mirrors WishValidationError / ExpenseValidationError's contract
 *  so index.ts handles all three the same way. */
export class BookingValidationError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name  = 'BookingValidationError'
    this.field = field
  }
}

/** Mirror of `CreateBookingSchema` in src/types/booking.ts. Duplicated
 *  here because the Worker can't import client-side modules -- the
 *  field caps (title 100 / origin 60 / destination 60 / confirmationCode
 *  64 / provider 60 / address 500 / checkIn 32 / checkOut 32 / note
 *  2000) and the type enum MUST stay in sync. The cap values pair-wise
 *  match firestore.rules booking create/update — the Worker uses admin
 *  SDK and bypasses rules, so any field rules cap but Worker doesn't
 *  is a real exploit (a megabyte `note` bypassing rules cap). Drift
 *  also surfaces as a "client says OK / Worker says 400" mismatch the
 *  user could only escape by trimming. */
const CreateBookingBodySchema = z.object({
  type:             z.enum(['flight', 'hotel', 'train', 'bus', 'other']),
  title:            z.string().max(100).optional(),
  origin:           z.string().max(60).optional(),
  destination:      z.string().max(60).optional(),
  confirmationCode: z.string().max(64).optional(),
  provider:         z.string().max(60).optional(),
  checkIn:          z.string().max(32).optional(),
  checkOut:         z.string().max(32).optional(),
  // 住所テキスト or Google Maps URL を受けるため 500(URL は 200 を超え得る)。
  address:          z.string().max(500).optional(),
  note:             z.string().max(2000).optional(),
})
type CreateBookingBody = z.infer<typeof CreateBookingBodySchema>

/** Update body shape -- all fields optional, including `type`. Mirrors
 *  `UpdateBookingSchema = CreateBookingSchema.partial()` in
 *  src/types/booking.ts. */
const UpdateBookingBodySchema = CreateBookingBodySchema.partial()
type UpdateBookingBody = z.infer<typeof UpdateBookingBodySchema>

const UPDATABLE_BOOKING_FIELDS = new Set([
  'type', 'title', 'origin', 'destination', 'confirmationCode',
  'provider', 'checkIn', 'checkOut', 'address', 'note',
])

/** Text fields the client clears via empty-string sentinel. Mirrors
 *  `updateBooking` in src/features/bookings/services/bookingService.ts:
 *  when validated[k] === '' the client emits `deleteField()`. The
 *  Worker reproduces the contract: empty-string => omit from `fields`
 *  + include in `updateMask` (REST PATCH's field-deletion convention).
 *  Without this, an attachment-replace edit that ALSO clears a text
 *  field would write '' instead of removing the field, leaving the
 *  doc inconsistent with the no-attachment client path. */
const CLEARABLE_BOOKING_FIELDS = new Set([
  'confirmationCode', 'provider', 'checkIn', 'checkOut', 'address', 'note',
])

/** Parse `checkIn` ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm') to an ISO 8601
 *  string suitable for Firestore REST `timestampValue`. Returns null
 *  for unparseable input -- caller falls back to createdAt for the
 *  sortDate slot. Mirrors `checkInToTimestamp` in bookingService.ts;
 *  Date.parse handles both forms natively. */
function parseCheckInIso(checkIn: string): string | null {
  const d = new Date(checkIn)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function parseBookingBody(raw: unknown): CreateBookingBody {
  // Reject `attachment` if the caller tries to slip one into the
  // body -- it MUST come from intents. Defense-in-depth: even though
  // firestore.rules block client-direct attachment writes, surface the
  // rejection as a Worker 400 with a clear field path rather than a
  // rules-commit deny.
  if (typeof raw === 'object' && raw !== null && 'attachment' in raw) {
    const att = (raw as { attachment?: unknown }).attachment
    if (att !== undefined && att !== null) {
      throw new BookingValidationError(
        'attachment',
        'booking.attachment cannot be set directly; upload via /upload-intents and pass intentIds',
      )
    }
  }
  const parsed = CreateBookingBodySchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new BookingValidationError(issue.path.join('.'), issue.message)
  }
  return parsed.data
}

function parseBookingUpdateBody(raw: unknown): { patch: UpdateBookingBody; rawKeys: Set<string> } {
  if (typeof raw !== 'object' || raw === null) {
    throw new BookingValidationError('patch', 'patch must be an object')
  }
  if ('attachment' in raw) {
    const att = (raw as { attachment?: unknown }).attachment
    if (att !== undefined && att !== null) {
      throw new BookingValidationError(
        'attachment',
        'patch.attachment cannot be set directly; upload via /upload-intents and pass intentIds (or use client updateDoc to detach by deleteField)',
      )
    }
  }
  const rawKeys = new Set(Object.keys(raw))
  for (const k of rawKeys) {
    if (!UPDATABLE_BOOKING_FIELDS.has(k)) {
      throw new BookingValidationError(k, 'field is not updatable via this endpoint')
    }
  }
  const parsed = UpdateBookingBodySchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new BookingValidationError(issue.path.join('.'), issue.message)
  }
  return { patch: parsed.data, rawKeys }
}

// ─── Authorization ─────────────────────────────────────────────────

interface TripContext {
  memberIds: string[]
}

/** Booking create authz: caller must be owner or editor of the trip.
 *  Trip must exist and not be cascade-deleting. memberIds returned
 *  for the booking doc's denormalized field (PastLodgingPage's
 *  collection-group hotel query gates on this). */
async function authorizeBookingCreateTx(
  tx:        TxContext,
  tripId:    string,
  callerUid: string,
): Promise<TripContext> {
  const [trip, member] = await Promise.all([
    tx.get(`trips/${tripId}`),
    tx.get(`trips/${tripId}/members/${callerUid}`),
  ])
  if (!trip.exists)                throw new CascadeError(404, 'trip not found')
  if ('deletingAt' in trip.fields) throw new CascadeError(410, 'trip is being deleted')
  if (!member.exists)              throw new CascadeError(403, 'caller is not a trip member')

  const role = readString(member.fields, 'role')
  if (role !== 'owner' && role !== 'editor') {
    throw new CascadeError(403, 'caller role is not owner/editor')
  }

  const arr = (trip.fields.memberIds as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  const memberIds = arr
    .map(v => v.stringValue)
    .filter((s): s is string => typeof s === 'string')
  if (memberIds.length === 0) {
    throw new CascadeError(500, 'trip.memberIds is empty')
  }
  return { memberIds }
}

/** Booking update authz: trip exists + not deleting + caller is
 *  owner/editor AND the booking.attachment.filePath still matches
 *  what the editor loaded with (stale-replace guard). Returns the
 *  current booking doc fields so encodeBookingUpdate can read
 *  `createdAt` for the cleared-checkIn sortDate fallback without
 *  an extra get (already loaded for the stale-replace guard).
 *
 *  Stale-replace 409: client passes `expectedCurrentPath` = the
 *  `attachment.filePath` the editor saw on load (`null` = first-attach,
 *  editor saw no attachment). If the live doc has drifted (Tab B
 *  already replaced/detached), this caller's upload would silently
 *  overwrite Tab B's commit AND orphan Tab B's blob -- reject so the
 *  client can re-load and re-confirm. Mirrors authorizeWishUpdateTx. */
async function authorizeBookingUpdateTx(
  tx:                  TxContext,
  tripId:              string,
  bookingId:           string,
  callerUid:           string,
  expectedCurrentPath: string | null,
): Promise<Record<string, FsValue>> {
  const [trip, member, booking] = await Promise.all([
    tx.get(`trips/${tripId}`),
    tx.get(`trips/${tripId}/members/${callerUid}`),
    tx.get(`trips/${tripId}/bookings/${bookingId}`),
  ])
  if (!trip.exists)                throw new CascadeError(404, 'trip not found')
  if ('deletingAt' in trip.fields) throw new CascadeError(410, 'trip is being deleted')
  if (!member.exists)              throw new CascadeError(403, 'caller is not a trip member')

  const role = readString(member.fields, 'role')
  if (role !== 'owner' && role !== 'editor') {
    throw new CascadeError(403, 'caller role is not owner/editor')
  }
  if (!booking.exists) {
    throw new CascadeError(404, 'booking not found')
  }

  // Stale-replace guard. `readNestedString` returns `undefined` when
  // the attachment map is absent -- normalise to `null` for the
  // comparison so absent and explicit-null collapse the same way
  // (matches the client's `existing?.filePath ?? null` convention).
  const currentPath = readNestedString(booking.fields, 'attachment', 'filePath') ?? null
  if (currentPath !== expectedCurrentPath) {
    throw new CascadeError(
      409,
      'booking attachment has been replaced or removed since the editor loaded',
    )
  }
  return booking.fields
}

// ─── Firestore value encoder (create) ──────────────────────────────

interface EncodedCreate {
  fields:                  Record<string, FsValue>
  sortDateNeedsTransform:  boolean
}

/** Encode a validated CreateBookingBody + Worker-built attachment into
 *  Firestore REST fields. createdAt / updatedAt stamped via
 *  updateTransforms (REQUEST_TIME) -- CF Workers' Date.now() drifts
 *  vs Firestore commit time. When `checkIn` is absent / unparseable,
 *  `sortDate` also gets REQUEST_TIME so it resolves to the same
 *  instant as createdAt (Firestore commit transforms within one
 *  commit share the request time). Optional text fields are omitted
 *  when empty-string -- matches `stripEmpty(input)` in the legacy
 *  client createBooking, so the doc shape is unchanged across the
 *  with-file / no-file paths. */
function encodeBookingCreate(
  body:        CreateBookingBody,
  tripId:      string,
  memberIds:   string[],
  callerUid:   string,
  attachment:  FsValue,
): EncodedCreate {
  const fields: Record<string, FsValue> = {
    tripId:     { stringValue: tripId },
    type:       { stringValue: body.type },
    createdBy:  { stringValue: callerUid },
    updatedBy:  { stringValue: callerUid },
    memberIds:  {
      arrayValue: { values: memberIds.map(uid => ({ stringValue: uid })) },
    },
    attachment,
  }

  // Optional text fields: include only when non-empty. Mirrors
  // `stripEmpty(input)` in bookingService.createBooking.
  const OPTIONAL = [
    'title', 'origin', 'destination', 'confirmationCode',
    'provider', 'checkIn', 'checkOut', 'address', 'note',
  ] as const
  for (const k of OPTIONAL) {
    const v = body[k]
    if (v != null && v !== '') {
      fields[k] = { stringValue: v }
    }
  }

  // sortDate invariant: checkInTs ?? createdAt.
  // - checkIn parseable -> Timestamp from checkIn now.
  // - checkIn absent / unparseable -> REQUEST_TIME transform alongside
  //   createdAt, so both stamps share the same commit instant.
  let sortDateNeedsTransform = false
  if (body.checkIn && body.checkIn !== '') {
    const iso = parseCheckInIso(body.checkIn)
    if (iso) {
      fields.sortDate = { timestampValue: iso }
    } else {
      sortDateNeedsTransform = true
    }
  } else {
    sortDateNeedsTransform = true
  }
  return { fields, sortDateNeedsTransform }
}

// ─── Endpoint: booking-file-create ─────────────────────────────────

export async function bookingFileCreate(
  callerUid:          string,
  req:                BookingFileCreateRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ bookingId: string }> {
  return withTokenRetry(() => doCreate(callerUid, req, serviceAccountJson, bucket))
}

async function doCreate(
  callerUid:          string,
  req:                BookingFileCreateRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ bookingId: string }> {
  // Parse the booking body BEFORE entering the tx -- Zod parse is
  // local, no value in burning a tx retry on a malformed body.
  const body = parseBookingBody(req.booking)

  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  return runFirestoreTransaction(accessToken, projectId, async (tx) => {
    const ctx = await authorizeBookingCreateTx(tx, req.tripId, callerUid)

    // Consume intents inside the tx so the markUsed writes commit
    // atomically with the booking doc write. Mirrors expense-create.
    const { consumed, markUsedWrites } = await consumeEntityIntents(
      tx, req.intentIds, callerUid, accessToken, projectId, bucket,
      { tripId: req.tripId, entityType: 'booking', entityId: req.bookingId },
    )

    // Build the BookingAttachment field from intents. Primary may be
    // either `full` (image) or `pdf` (PDF attachment); thumb optional
    // (PDFs and HEIC/HEIF pass-through ship without a thumb).
    const primary = consumed.find(c => c.kind === 'full' || c.kind === 'pdf')
    if (!primary) {
      throw new BookingValidationError(
        'intentIds',
        'must include a full or pdf intent (primary attachment missing)',
      )
    }
    const thumb = consumed.find(c => c.kind === 'thumb')
    // BookingAttachment supports PDF-only (no thumb). If a thumb intent
    // was minted for a PDF primary, /upload-intents already rejected it
    // (kind=pdf forces contentType=application/pdf and kind!=pdf forces
    // non-PDF). Belt-and-suspenders: tolerate thumb absent when primary
    // is PDF; buildAttachmentMapValue handles either shape.
    const attachmentValue = buildAttachmentMapValue('booking', primary, thumb)

    // Create-only: tx's optimistic-concurrency catches a concurrent
    // bookingId collision via currentDocument.exists=false on the
    // write. Pre-tx read gives a clear 409 with a meaningful message
    // ahead of the commit-time conflict reason.
    const existing = await tx.get(`trips/${req.tripId}/bookings/${req.bookingId}`)
    if (existing.exists) {
      throw new CascadeError(409, 'booking already exists at this id')
    }

    const { fields, sortDateNeedsTransform } = encodeBookingCreate(
      body, req.tripId, ctx.memberIds, callerUid, attachmentValue,
    )

    const updateTransforms: NonNullable<TxUpdateWrite['updateTransforms']> = [
      { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ]
    if (sortDateNeedsTransform) {
      // Same REQUEST_TIME instant as createdAt within this commit --
      // satisfies the `sortDate = checkInTs ?? createdAt` invariant
      // without a separate read-then-write step.
      updateTransforms.push({ fieldPath: 'sortDate', setToServerValue: 'REQUEST_TIME' })
    }

    const write: TxWrite = {
      document:        docResourceName(projectId, `trips/${req.tripId}/bookings/${req.bookingId}`),
      fields,
      currentDocument: { exists: false },
      updateTransforms,
    }
    // markUsed writes go FIRST so the whole set commits atomically.
    // If the booking write 409s, intents stay pending and a retry can
    // re-consume them; if both succeed, intents are used and the
    // booking doc owns the attachment. No half-state.
    return {
      writes: [...markUsedWrites, write],
      result: { bookingId: req.bookingId },
    }
  })
}

// ─── Endpoint: booking-file-update ─────────────────────────────────

export const BookingFileUpdateRequestSchema = z.object({
  tripId:    z.string().regex(TripIdRe),
  bookingId: z.string().regex(TripIdRe),
  /** Partial text patch; all fields optional. Parsed inside doUpdate
   *  so the Worker controls the field allowlist + the attachment-
   *  rejection defense-in-depth check (Zod's default `strip` would
   *  silently drop unknown keys; explicit reject makes the contract
   *  obvious). */
  patch:     z.unknown(),
  /** Stale-replace guard. The client passes the `attachment.filePath`
   *  value it loaded the booking with (`null` = first-attach: editor
   *  saw no attachment). Worker reads the current attachment.filePath
   *  inside the tx and rejects with 409 on mismatch -- closes the
   *  Tab-A-overwrites-Tab-B race. Same shape as wish-file-update's
   *  guard for uniform error mode. */
  expectedCurrentPath: z.union([z.string(), z.null()]),
  /** REQUIRED on this endpoint. Attachment-replace is the reason
   *  /booking-file-update exists; text-only edits stay on the client
   *  updateDoc path (no Worker round-trip). */
  intentIds: z.array(z.string().min(1).max(60)).min(1).max(2),
})
export type BookingFileUpdateRequest = z.infer<typeof BookingFileUpdateRequestSchema>

/** Encode an UpdateBookingBody into a TxWrite fields + updateMask
 *  pair. Empty-string text fields are translated to deleteField
 *  semantics (omitted from fields, listed in mask) so the doc shape
 *  matches the client's no-file `updateBooking` path -- cleared
 *  optionals truly disappear instead of lingering as '' values.
 *
 *  sortDate is recomputed only when `checkIn` was in the request
 *  body (presence check on `rawKeys`, not on parsed value, because
 *  Zod strips undefined). Cleared/unparseable checkIn falls back to
 *  the current doc's createdAt -- read from the already-loaded
 *  booking snapshot, no extra round-trip. */
function encodeBookingUpdate(
  patch:             UpdateBookingBody,
  rawKeys:           Set<string>,
  callerUid:         string,
  currentDocFields:  Record<string, FsValue>,
  attachment:        FsValue,
): { fields: Record<string, FsValue>; updateMask: string[] } {
  const fields:     Record<string, FsValue> = {}
  const updateMask: string[] = []

  for (const k of UPDATABLE_BOOKING_FIELDS) {
    if (!rawKeys.has(k)) continue
    const v = (patch as Record<string, string | undefined>)[k]
    if (v === undefined) continue
    if (v === '' && CLEARABLE_BOOKING_FIELDS.has(k)) {
      // Empty string -> field deletion. Listed in mask, omitted from
      // fields -- REST PATCH's field-deletion convention.
      updateMask.push(k)
      continue
    }
    fields[k] = { stringValue: v }
    updateMask.push(k)
  }

  // sortDate recomputation if and only if `checkIn` was provided in
  // the request body. Note: we DON'T touch sortDate when checkIn is
  // absent from the body -- the existing value (set on create or a
  // previous update) is correct.
  if (rawKeys.has('checkIn')) {
    const checkIn = patch.checkIn
    let sortDateValue: FsValue | null = null
    if (checkIn && checkIn !== '') {
      const iso = parseCheckInIso(checkIn)
      if (iso) {
        sortDateValue = { timestampValue: iso }
      }
    }
    if (sortDateValue === null) {
      // Cleared or unparseable -> fall back to createdAt. Copy the
      // FsValue verbatim from the same-tx-read current doc; no
      // additional get required since authorizeBookingUpdateTx
      // already loaded the booking for the stale-replace guard.
      const created = currentDocFields.createdAt
      if (created?.timestampValue) {
        sortDateValue = { timestampValue: created.timestampValue }
      }
    }
    if (sortDateValue !== null) {
      fields.sortDate = sortDateValue
      updateMask.push('sortDate')
    }
    // If sortDateValue stays null (createdAt missing -- shouldn't
    // happen post-Phase-2 but defensive), we just leave sortDate
    // untouched. Better than writing a garbage value.
  }

  // Attachment (always present on this endpoint) + updatedBy.
  fields.attachment = attachment
  updateMask.push('attachment')
  fields.updatedBy  = { stringValue: callerUid }
  updateMask.push('updatedBy')

  return { fields, updateMask }
}

export async function bookingFileUpdate(
  callerUid:          string,
  req:                BookingFileUpdateRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ ok: true }> {
  return withTokenRetry(() => doUpdate(callerUid, req, serviceAccountJson, bucket))
}

async function doUpdate(
  callerUid:          string,
  req:                BookingFileUpdateRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ ok: true }> {
  // Parse the patch body BEFORE entering the tx -- pure-local check,
  // no value in burning a tx retry on a malformed patch.
  const { patch, rawKeys } = parseBookingUpdateBody(req.patch)

  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  await runFirestoreTransaction(accessToken, projectId, async (tx) => {
    const currentDocFields = await authorizeBookingUpdateTx(
      tx, req.tripId, req.bookingId, callerUid, req.expectedCurrentPath,
    )

    // Consume intents inside the tx so markUsed commits atomically
    // with the booking doc patch. Mirrors expense-update's pattern.
    const { consumed, markUsedWrites } = await consumeEntityIntents(
      tx, req.intentIds, callerUid, accessToken, projectId, bucket,
      { tripId: req.tripId, entityType: 'booking', entityId: req.bookingId },
    )

    const primary = consumed.find(c => c.kind === 'full' || c.kind === 'pdf')
    if (!primary) {
      throw new BookingValidationError(
        'intentIds',
        'must include a full or pdf intent (primary attachment missing)',
      )
    }
    const thumb = consumed.find(c => c.kind === 'thumb')
    const attachmentValue = buildAttachmentMapValue('booking', primary, thumb)

    const { fields, updateMask } = encodeBookingUpdate(
      patch, rawKeys, callerUid, currentDocFields, attachmentValue,
    )

    const write: TxWrite = {
      document:        docResourceName(projectId, `trips/${req.tripId}/bookings/${req.bookingId}`),
      fields,
      updateMask,
      currentDocument: { exists: true },
      updateTransforms: [
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
      ],
    }
    // markUsed first so the whole set commits atomically. If the
    // booking patch hits commit-conflict (concurrent edit), intents
    // stay pending and a retry can re-consume them. No half-state.
    return {
      writes: [...markUsedWrites, write],
      result: undefined,
    }
  })

  return { ok: true }
}

// `ConsumedIntent` re-exported for downstream symmetry with wish-write /
// expense-write -- keeps the surface aligned if future code wants to
// share helpers.
export type { ConsumedIntent }
