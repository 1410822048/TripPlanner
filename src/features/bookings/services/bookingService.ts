// src/features/bookings/services/bookingService.ts
// Bookings = the trip's confirmation hub: flights, hotels, trains, etc.
//
// File lifecycle: the Worker is the authoritative writer for booking
// `coverImage` / `document` on BOTH create and update. When the caller
// supplies a file:
//   - createBooking → POST /booking-file-create. Worker authzs
//     membership, mints + consumes the upload intents, AND writes the
//     booking doc (file field populated, sortDate stamped) in a single
//     Firestore transaction. The client never calls setDoc on this
//     path. Eliminates the old doc-first "blank booking row → file
//     lands ~200ms later" listener flicker AND removes the
//     partial-failure rollback dance that the Phase 3.6 doc-first flow
//     needed when uploadAttachment rejected after setDoc had landed.
//   - updateBooking → POST /booking-file-update. Worker writes text
//     patch + file field + sortDate (when checkIn changed) atomically.
//     Detach and text-only edits still go through client updateDoc with
//     role-specific deleteField() sentinels -- rules permit removal but
//     block arbitrary writes.
//
// Without a file the client setDoc / updateDoc paths are unchanged --
// text-only bookings skip the Worker round-trip.
//
// `getMyHotelBookings` + `subscribeToMyHotelBookings` are NOT factoried
// through createTripScopedListServices because they run a different
// query shape (collectionGroup + `type == 'hotel'` filter, no trip
// scope) — PastLodgingPage uses them to span every trip in one round-trip.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError, breadcrumb } from '@/services/sentry'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { parseListSnapshot } from '@/services/parseListSnapshot'
import { subscribeToCollection } from '@/services/realtimeQuery'
import { createTripScopedListServices } from '@/services/tripScopedList'
import { validateUpdateOrThrow } from '@/services/validateUpdate'
import { BookingDocSchema, UpdateBookingSchema, type Booking, type BookingAttachment, type CreateBookingInput, type UpdateBookingInput } from '@/types/booking'
import { stripEmpty } from '@/utils/stripEmpty'
import { auditCreate, auditUpdate } from '@/utils/audit'
import { getTripMemberIds } from '@/services/tripMemberIds'
import { bumpTripActivity } from '@/services/tripActivity'
import { compressImage } from '@/utils/image'
import { mintAndUploadEntityIntents } from '@/services/uploadIntentEntity'
import {
  requireWorkerWriteBase, preflightIdToken, workerFetch,
} from '@/services/workerBase'
import { bookingAttachmentPaths, purgeBookingAttachments } from './bookingStorage'
import { safePurgeWithEnqueueFallback } from '@/services/orphanPurge'

/** 100 is well above the realistic per-trip count (10-30) — truncation
 *  fires Sentry so we know when reality stretches the assumption. */
const LIST_LIMIT = 100

/** Optional text fields the user can clear from the edit form. Both
 *  write paths must translate the form's `undefined` (cleared) into the
 *  branch-appropriate delete sentinel:
 *    - client SDK path: `deleteField()`
 *    - Worker REST path: `''` (Worker's CLEARABLE_BOOKING_FIELDS allowlist
 *      maps empty-string to an updateMask field-deletion).
 *  Keep this list in lockstep with `CLEARABLE_BOOKING_FIELDS` in
 *  workers/ocr/src/booking-write.ts -- drift on either side means
 *  cleared fields persist in the doc after a Worker-path edit. */
const CLEARABLE_TEXT_FIELDS = [
  'confirmationCode', 'provider', 'checkIn', 'checkOut', 'address', 'link', 'note',
] as const

export interface BookingAttachmentChanges {
  coverImage: File | null | undefined
  document:   File | null | undefined
}

export interface BookingExistingAttachments {
  coverImage?: BookingAttachment
  document?:   BookingAttachment
}

type BookingAttachmentRole = keyof BookingAttachmentChanges

function hasNewBookingFile(files: BookingAttachmentChanges): boolean {
  return files.coverImage instanceof File || files.document instanceof File
}

function touchedRoleFiles(files: BookingAttachmentChanges): BookingAttachmentRole[] {
  return (['coverImage', 'document'] as const).filter(role => files[role] !== undefined)
}

async function mintBookingFileIntents(args: {
  tripId: string
  bookingId: string
  role: BookingAttachmentRole
  file: File
  mode: 'create' | 'update'
}) {
  const { tripId, bookingId, role, file, mode } = args
  if (role === 'coverImage' && !file.type.startsWith('image/')) {
    throw new Error('カバー画像には画像ファイルを選択してください。')
  }
  const compressed = await compressImage(file)
  return mintAndUploadEntityIntents({
    tripId, entityType: 'booking', entityId: bookingId, compressed, mode,
  })
}

async function prepareBookingFileUploads(args: {
  tripId: string
  bookingId: string
  files: BookingAttachmentChanges
  mode: 'create' | 'update'
}): Promise<{
  attachments: Partial<Record<BookingAttachmentRole, string[]>>
  traceId?: string
}> {
  const { tripId, bookingId, files, mode } = args
  const entries = await Promise.all((['coverImage', 'document'] as const).map(async role => {
    const file = files[role]
    if (!(file instanceof File)) return null
    const upload = await mintBookingFileIntents({ tripId, bookingId, role, file, mode })
    return [role, upload] as const
  }))
  const attachments: Partial<Record<BookingAttachmentRole, string[]>> = {}
  let traceId: string | undefined
  for (const entry of entries) {
    if (!entry) continue
    const [role, upload] = entry
    attachments[role] = upload.intentIds
    traceId ??= upload.traceId
  }
  return { attachments, traceId }
}

function changedExistingAttachments(
  files:    BookingAttachmentChanges,
  existing: BookingExistingAttachments,
): BookingAttachment[] {
  const out: BookingAttachment[] = []
  if (files.coverImage !== undefined && existing.coverImage) out.push(existing.coverImage)
  if (files.document !== undefined && existing.document) out.push(existing.document)
  return out
}

function bookingFromDoc(d: QueryDocumentSnapshot): Booking {
  return firestoreDocFromSchema(BookingDocSchema, d, 'bookingFromDoc') as Booking
}

// ─── Read (per-trip) ──────────────────────────────────────────────
// `sortDate` is always populated (falls back to createdAt on create) so
// orderBy doesn't silently drop docs the way `checkIn` would for the
// "no checkIn yet" case.
const listServices = createTripScopedListServices<Booking>({
  path:    P.bookings,
  fromDoc: bookingFromDoc,
  orderBy: [['sortDate', 'desc']],
  limit:   LIST_LIMIT,
  source:  'bookings',
})

export const getBookingsByTrip = listServices.fetch
export const subscribeToBookings = listServices.subscribe

// ─── Read (cross-trip hotel scope) ────────────────────────────────
// PastLodgingPage's cross-trip lodging history. Single collection-group
// query gated on the denormalised memberIds array; bookings created
// before the memberIds migration won't appear (backfill task).

export async function getMyHotelBookings(uid: string): Promise<Booking[]> {
  const { db, collectionGroup, query, where, orderBy, limit, getDocs } = await getFirebase()
  const snap = await getDocs(query(
    collectionGroup(db, 'bookings'),
    where('memberIds', 'array-contains', uid),
    where('type', '==', 'hotel'),
    orderBy('sortDate', 'desc'),
    limit(LIST_LIMIT),
  ))
  if (snap.size >= LIST_LIMIT) {
    captureError(new Error(`getMyHotelBookings truncated at ${LIST_LIMIT}`), { uid })
  }
  return parseListSnapshot(snap, bookingFromDoc)
}

export const subscribeToMyHotelBookings = (
  uid:    string,
  onData: (data: Booking[]) => void,
  onError: (e: Error) => void,
) => subscribeToCollection<Booking>({
  buildQuery: ({ db, collectionGroup, query, where, orderBy, limit }) => query(
    collectionGroup(db, 'bookings'),
    where('memberIds', 'array-contains', uid),
    where('type', '==', 'hotel'),
    orderBy('sortDate', 'desc'),
    limit(LIST_LIMIT),
  ),
  fromDoc: bookingFromDoc,
  source:  'subscribeToMyHotelBookings',
  limit:   LIST_LIMIT,
}, onData, onError)

// ─── sortDate helper ──────────────────────────────────────────────

/**
 * Convert a checkIn string ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm') to a
 * Firestore Timestamp. Returns null for missing / unparseable so the
 * caller can fall back to serverTimestamp().
 *
 * Separate `sortDate` (not orderBy('checkIn')) because checkIn is
 * optional and Firestore's orderBy silently EXCLUDES docs missing the
 * field — a half-filled booking would disappear from the list.
 *
 * Mirrors `parseCheckInIso` in workers/ocr/src/booking-write.ts; both
 * paths share the same `sortDate = checkInTs ?? createdAt` invariant.
 */
function checkInToTimestamp(
  checkIn: string | undefined,
  Timestamp: typeof import('firebase/firestore').Timestamp,
) {
  if (!checkIn) return null
  const d = new Date(checkIn)
  if (Number.isNaN(d.getTime())) return null
  return Timestamp.fromDate(d)
}

// ─── Write ────────────────────────────────────────────────────────

/**
 * Create a booking.
 *
 * WITHOUT file: client setDoc. firestore.rules permit a booking create
 * when file fields are absent. memberIds + sortDate are
 * stamped client-side (sortDate = checkInTs ?? serverTimestamp()).
 *
 * WITH file: upload-first → POST /booking-file-create. The Worker
 * authzs + mints + consumes intents AND writes the booking doc
 * (file field populated, sortDate stamped) in a single Firestore
 * transaction. The realtime listener sees the booking for the first
 * time WITH its file, so the UX is "card materializes with file"
 * instead of the pre-3.7 "blank card → file lands ~200ms later"
 * flicker.
 *
 * No partial-state recovery needed: the Worker tx is atomic. If it
 * rejects or times out, no doc was written, so the realtime listener
 * never fires and the optimistic-rollback in the mutation hook cleans
 * the temp row with no orphan to reconcile. Uploaded blobs (if any)
 * get reaped by the Worker's intent-expiry + storage-scan cron.
 */
export async function createBooking(
  tripId: string,
  input: CreateBookingInput,
  files: BookingAttachmentChanges,
  createdBy: string,
): Promise<string> {
  const { db, collection, doc } = await getFirebase()
  // Mint the bookingId client-side so the Worker can consume intents
  // bound to a known entityId AND the optimistic-cache temp-row
  // replacement has a stable target.
  const ref = doc(collection(db, ...P.bookings(tripId)))

  if (hasNewBookingFile(files)) {
    // ── Upload-first + Worker-authoritative create ───────────────
    const workerBase = requireWorkerWriteBase()
    const idToken    = await preflightIdToken()
    const { attachments, traceId: uploadTraceId } = await prepareBookingFileUploads({
      tripId, bookingId: ref.id, files, mode: 'create',
    })
    const traceId = uploadTraceId ?? crypto.randomUUID()
    breadcrumb({
      category: 'upload',
      message:  'entity-write',
      data:     { traceId, endpoint: '/booking-file-create', tripId, bookingId: ref.id, roles: Object.keys(attachments) },
    })
    await workerFetch(workerBase, idToken, '/booking-file-create', {
      tripId,
      bookingId: ref.id,
      // Worker re-validates body via BookingValidationError; stripEmpty
      // matches the no-file setDoc payload semantics (no '' / null
      // fields polluting the doc).
      booking:   stripEmpty(input),
      attachments,
    }, { traceId })
  } else {
    // ── Text-only client setDoc ──────────────────────────────────
    const [{ setDoc, serverTimestamp, Timestamp }, memberIds] = await Promise.all([
      getFirebase(),
      getTripMemberIds(tripId),
    ])
    const checkInTs = checkInToTimestamp(input.checkIn, Timestamp)
    await setDoc(ref, {
      ...stripEmpty(input),
      tripId,
      ...auditCreate(createdBy, serverTimestamp()),
      sortDate:  checkInTs ?? serverTimestamp(),
      memberIds,
    })
  }

  void bumpTripActivity(tripId, 'bookings', createdBy)
  return ref.id
}

/**
 * Update a booking. Each file role is tri-state:
 *   undefined → no file change (text-only edit)
 *   null      → clear file (Firestore deleteField + Storage purge)
 *   File      → replace (Worker writes text+file atomically →
 *               client purges old blob)
 *
 * WITH NEW FILE: single Worker round-trip to /booking-file-update.
 *   Worker writes validated text patch + file field + sortDate (when
 *   checkIn changed) atomically. expectedCurrentPaths catch a
 *   concurrent Tab B replace (409 stale-replace → throw). On success
 *   the old blob is dropped via the safePurge ladder.
 *
 * DETACH and TEXT-ONLY: client updateDoc with the text patch +
 *   role-specific deleteField(). Worker not involved -- rules permit
 *   removing file fields client-side but block arbitrary writes.
 *
 * sortDate recomputation is client-side on the no-file path: when
 *   checkIn changed, either copy the parsed Timestamp or fall back to
 *   the doc's createdAt (one extra getDoc on the rare cleared-checkIn
 *   branch). On the Worker path, the Worker handles sortDate inside
 *   its tx using the already-loaded current doc -- no extra read.
 */
export async function updateBooking(
  tripId: string,
  bookingId: string,
  updates: UpdateBookingInput,
  options: {
    uid:      string
    files:    BookingAttachmentChanges
    existing: BookingExistingAttachments
  },
): Promise<void> {
  const { uid, files, existing } = options
  const validated = validateUpdateOrThrow(UpdateBookingSchema, updates, {
    source: 'updateBooking', tripId, bookingId,
  })

  if (hasNewBookingFile(files)) {
    // ── Worker-authoritative replace: text + attachment atomic ────
    const workerBase = requireWorkerWriteBase()
    const idToken    = await preflightIdToken()
    const { attachments, traceId: uploadTraceId } = await prepareBookingFileUploads({
      tripId, bookingId, files, mode: 'update',
    })
    const traceId = uploadTraceId ?? crypto.randomUUID()
    // Normalize cleared CLEARABLE fields from `undefined` to `''` before
    // JSON.stringify. The form builds payloads with `field: undefined`
    // for cleared inputs; JSON.stringify silently drops undefined keys,
    // and Worker `encodeBookingUpdate` gates deletion on key PRESENCE
    // (`rawKeys.has(k)`), so an absent key is a no-op and the stale
    // value stays in the doc. `''` survives serialization and trips the
    // Worker's empty-string-as-deleteField allowlist. Symmetric with the
    // no-file SDK branch below, which translates the same undefined into
    // a deleteField() sentinel.
    const patchForWorker: Record<string, unknown> = { ...validated }
    for (const k of CLEARABLE_TEXT_FIELDS) {
      if (k in validated && validated[k] === undefined) {
        patchForWorker[k] = ''
      }
    }
    breadcrumb({
      category: 'upload',
      message:  'entity-write',
      data:     { traceId, endpoint: '/booking-file-update', tripId, bookingId, roles: Object.keys(attachments) },
    })
    const touched = touchedRoleFiles(files)
    const expectedCurrentPaths: Partial<Record<BookingAttachmentRole, string | null>> = {}
    for (const role of touched) {
      expectedCurrentPaths[role] = existing[role]?.filePath ?? null
    }
    const clearAttachments = touched.filter(role => files[role] === null)
    await workerFetch(workerBase, idToken, '/booking-file-update', {
      tripId,
      bookingId,
      // Worker stamps updatedBy + updatedAt itself; client only sends
      // validated text fields (empty strings translated to deleteField
      // semantics inside the Worker, matching the no-file path).
      patch: patchForWorker,
      attachments,
      ...(clearAttachments.length > 0 ? { clearAttachments } : {}),
      expectedCurrentPaths,
    }, { traceId })
    const oldAttachments = changedExistingAttachments(files, existing)
    const oldPaths = bookingAttachmentPaths(...oldAttachments)
    if (oldPaths.length > 0) {
      await safePurgeWithEnqueueFallback({
        purge: () => purgeBookingAttachments(...oldAttachments),
        enqueue: {
          tripId, collection: 'bookings', entityId: bookingId,
          paths: oldPaths,
          source: 'updateBooking/purge-old-attachment',
        },
        sentry: { source: 'updateBooking/purge-old-attachment', tripId, bookingId },
      })
    }
    void bumpTripActivity(tripId, 'bookings', uid)
    return
  }

  // ── Client text/detach path (no new file) ──────────────────────
  const { db, doc, updateDoc, getDoc, deleteField, serverTimestamp, Timestamp } = await getFirebase()
  const patch: Record<string, unknown> = {
    ...stripEmpty(validated),
    ...auditUpdate(uid, serverTimestamp()),
  }

  // Erase optional text fields the user cleared in the form.
  for (const k of CLEARABLE_TEXT_FIELDS) {
    if (k in validated && (validated[k] === undefined || validated[k] === '')) {
      patch[k] = deleteField()
    }
  }

  // Recompute sortDate when checkIn changes so the booking re-sorts.
  // Clearing checkIn falls back to the doc's createdAt — requires one
  // getDoc read but only on this rare path.
  if ('checkIn' in validated) {
    const checkInTs = checkInToTimestamp(validated.checkIn, Timestamp)
    if (checkInTs) {
      patch.sortDate = checkInTs
    } else {
      const snap = await getDoc(doc(db, ...P.booking(tripId, bookingId)))
      const created = snap.data()?.createdAt
      patch.sortDate = created ?? serverTimestamp()
    }
  }

  // Detach via deleteField -- firestore.rules permit role fields
  // unchanged OR removed by the client. Replace is Worker-only.
  for (const role of touchedRoleFiles(files)) {
    if (files[role] === null) patch[role] = deleteField()
  }

  await updateDoc(doc(db, ...P.booking(tripId, bookingId)), patch)

  // Detach success path: drop the old blob via the durability ladder.
  const oldAttachments = changedExistingAttachments(files, existing)
  const oldPaths = bookingAttachmentPaths(...oldAttachments)
  if (oldPaths.length > 0) {
    await safePurgeWithEnqueueFallback({
      purge: () => purgeBookingAttachments(...oldAttachments),
      enqueue: {
        tripId, collection: 'bookings', entityId: bookingId,
        paths: oldPaths,
        source: 'updateBooking/purge-old-attachment',
      },
      sentry: { source: 'updateBooking/purge-old-attachment', tripId, bookingId },
    })
  }
  void bumpTripActivity(tripId, 'bookings', uid)
}

/**
 * Delete a booking + its attachment. The doc deletion is the critical
 * write -- attachment cleanup routes through the same orphan-purge
 * ladder as create/update flows: in-process retry → `_purges` queue
 * → cron verify-before-delete. Matches `wishService.deleteWish` and
 * closes the asymmetry where booking previously called bare
 * `purgeAttachments` and silently dropped any permanent failure.
 *
 * Strict-cleanup gate (destructive-delete only): if BOTH purge AND
 * `_purges` enqueue rejected, abort BEFORE deleting the doc. Without
 * the doc, the attachment.path → blob binding vanishes from every
 * future cleanup attempt (cron has nothing to verify against, trip
 * cascade only sees `trips/{tripId}/...` blobs but won't catch a
 * mid-cleanup orphan whose path was only known to the deleted doc).
 * Throwing here lets the mutation rollback the optimistic patch so
 * the row reappears and a human-driven retry has a chance.
 */
export async function deleteBooking(
  tripId: string,
  bookingId: string,
  uid: string,
  attachments: BookingExistingAttachments,
): Promise<void> {
  const paths = bookingAttachmentPaths(
    attachments.coverImage,
    attachments.document,
  )
  if (paths.length > 0) {
    const result = await safePurgeWithEnqueueFallback({
      purge: () => purgeBookingAttachments(
        attachments.coverImage,
        attachments.document,
      ),
      enqueue: {
        tripId, collection: 'bookings', entityId: bookingId,
        paths,
        source: 'deleteBooking/attachment',
      },
      sentry: { source: 'deleteBooking/attachment', tripId, bookingId },
    })
    if (result === 'unrecoverable') {
      throw new Error(
        '添付ファイルの削除に失敗し、再試行キューへの登録もできませんでした。' +
        'しばらくしてから再度お試しください。',
      )
    }
  }
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.booking(tripId, bookingId)))
  void bumpTripActivity(tripId, 'bookings', uid)
}
