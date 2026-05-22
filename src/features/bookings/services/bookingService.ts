// src/features/bookings/services/bookingService.ts
// Bookings = the trip's confirmation hub: flights, hotels, trains, etc.
// Phase 2 ships full CRUD + a single file attachment per booking via
// Firebase Storage. Each booking owns its own folder under
// `trips/{tripId}/bookings/{bookingId}/`.
//
// `getMyHotelBookings` + `subscribeToMyHotelBookings` are NOT factoried
// through createTripScopedListServices because they run a different
// query shape (collectionGroup + `type == 'hotel'` filter, no trip
// scope) — PastLodgingPage uses them to span every trip in one round-trip.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError } from '@/services/sentry'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { parseListSnapshot } from '@/services/parseListSnapshot'
import { subscribeToCollection } from '@/services/realtimeQuery'
import { createTripScopedListServices } from '@/services/tripScopedList'
import { validateUpdateOrThrow } from '@/services/validateUpdate'
import { BookingDocSchema, UpdateBookingSchema, type Booking, type BookingAttachment, type CreateBookingInput, type UpdateBookingInput } from '@/types'
import { stripEmpty } from '@/utils/stripEmpty'
import { auditCreate, auditUpdate } from '@/utils/audit'
import { getTripMemberIds } from '@/services/tripMemberIds'
import { bumpTripActivity } from '@/services/tripActivity'
import { uploadAttachment, purgeAttachments } from './bookingStorage'
import { safePurgeWithEnqueueFallback } from '@/services/orphanPurge'

/** 100 is well above the realistic per-trip count (10-30) — truncation
 *  fires Sentry so we know when reality stretches the assumption. */
const LIST_LIMIT = 100

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
 * Create a booking. Mint id client-side so the Storage path is known
 * up front, upload (to a UNIQUE path courtesy of uploadAttachment's
 * shortId suffix), then setDoc. If setDoc fails we purge the orphan
 * blob — Storage rules gate on canWriteFiles(tripId) without checking
 * doc existence, so an upload-before-doc model is safe in principle,
 * but a half-finished create still leaves stranded bytes (PII!) that
 * the trip-cascade Worker only catches on full trip delete. Best-
 * effort rollback closes that gap; cleanup failures still surface to
 * Sentry so a pattern of orphan-blob leakage doesn't go unnoticed.
 */
export async function createBooking(
  tripId: string,
  input: CreateBookingInput,
  file: File | null,
  createdBy: string,
): Promise<string> {
  // Parallelise the Firebase SDK warm-up + member-id read. getFirebase()
  // is cached after first boot so its await is usually instant, but the
  // shape matches the other 4 entity services (expense / schedule /
  // planning / wish) — keeps the pattern uniform across the service layer.
  const [{ db, collection, doc, setDoc, serverTimestamp, Timestamp }, memberIds] = await Promise.all([
    getFirebase(),
    getTripMemberIds(tripId),
  ])
  const checkInTs = checkInToTimestamp(input.checkIn, Timestamp)
  const ref = doc(collection(db, ...P.bookings(tripId)))

  let attachmentMeta: BookingAttachment | null = null
  if (file) {
    try {
      attachmentMeta = await uploadAttachment(tripId, ref.id, file)
    } catch (e) {
      captureError(e, { source: 'createBooking/uploadAttachment', tripId, bookingId: ref.id })
      throw e
    }
  }

  const payload: Record<string, unknown> = {
    ...stripEmpty(input),
    tripId,
    ...auditCreate(createdBy, serverTimestamp()),
    sortDate:  checkInTs ?? serverTimestamp(),
    memberIds,
  }
  if (attachmentMeta) payload.attachment = attachmentMeta

  try {
    await setDoc(ref, payload)
  } catch (e) {
    if (attachmentMeta) {
      await safePurgeWithEnqueueFallback({
        purge: () => purgeAttachments(attachmentMeta),
        enqueue: {
          tripId, collection: 'bookings', entityId: ref.id,
          paths: [attachmentMeta.filePath, attachmentMeta.thumbPath].filter(Boolean) as string[],
          source: 'createBooking/rollback-attachment',
        },
        sentry: { source: 'createBooking/rollback-attachment', tripId, bookingId: ref.id },
      })
    }
    throw e
  }
  void bumpTripActivity(tripId, 'bookings', createdBy)
  return ref.id
}

/**
 * Update a booking. `attachment` is tri-state:
 *   undefined → no attachment change (text-only edit)
 *   null      → clear attachment (Firestore field-delete + Storage purge)
 *   File      → replace (upload new → updateDoc → purge old)
 *
 * Attachment ordering matches expenseService.updateExpense:
 *   1. Upload the NEW blob first (to a UNIQUE path courtesy of
 *      uploadAttachment's shortId suffix), then the field-delete /
 *      replace patch.
 *   2. updateDoc → on success the OLD blob is safe to purge.
 *   3. On updateDoc failure the NEW blob (if any) is rolled back; the
 *      OLD blob is untouched, so the user can re-attempt with the same
 *      form data.
 *
 * Two invariants gated by ordering + uniqueness:
 *   - updateDoc reject → new blob purged, old blob intact, doc still
 *     points at old (no broken link).
 *   - Same-mime replacement → old/new paths differ because of shortId,
 *     so the post-updateDoc purge only targets the genuinely-old blob.
 *     Without the unique suffix Storage upload would overwrite then the
 *     purge would delete the just-written blob.
 */
export async function updateBooking(
  tripId: string,
  bookingId: string,
  updates: UpdateBookingInput,
  options: {
    uid:        string
    attachment: File | null | undefined
    existing:   BookingAttachment | undefined
  },
): Promise<void> {
  const { uid, attachment, existing } = options
  const validated = validateUpdateOrThrow(UpdateBookingSchema, updates, {
    source: 'updateBooking', tripId, bookingId,
  })
  const { db, doc, updateDoc, getDoc, deleteField, serverTimestamp, Timestamp } = await getFirebase()
  const patch: Record<string, unknown> = {
    ...stripEmpty(validated),
    ...auditUpdate(uid, serverTimestamp()),
  }

  // Erase optional text fields the user cleared in the form.
  for (const k of ['confirmationCode', 'provider', 'checkIn', 'checkOut', 'address', 'note'] as const) {
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

  let newAttachment: BookingAttachment | null = null
  if (attachment === null) {
    patch.attachment = deleteField()
  } else if (attachment instanceof File) {
    newAttachment = await uploadAttachment(tripId, bookingId, attachment)
    patch.attachment = newAttachment
  }

  try {
    await updateDoc(doc(db, ...P.booking(tripId, bookingId)), patch)
  } catch (e) {
    if (newAttachment) {
      await safePurgeWithEnqueueFallback({
        purge: () => purgeAttachments(newAttachment),
        enqueue: {
          tripId, collection: 'bookings', entityId: bookingId,
          paths: [newAttachment.filePath, newAttachment.thumbPath].filter(Boolean) as string[],
          source: 'updateBooking/rollback-new-attachment',
        },
        sentry: { source: 'updateBooking/rollback-new-attachment', tripId, bookingId },
      })
    }
    throw e
  }

  // Success path -- safe to drop the old blob now. Either we cleared
  // the field (attachment=null) or we replaced it (File case). Full
  // durability ladder: in-process retry → enqueue to _purges →
  // Sentry only if both steps fail. See expense counterpart.
  if (existing && (attachment === null || attachment instanceof File)) {
    await safePurgeWithEnqueueFallback({
      purge: () => purgeAttachments(existing),
      enqueue: {
        tripId, collection: 'bookings', entityId: bookingId,
        paths: [existing.filePath, existing.thumbPath].filter(Boolean) as string[],
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
 * Create/update rollback paths intentionally do NOT use strict mode
 * — their original error already propagates, and the residual blob
 * is captured to Sentry.
 */
export async function deleteBooking(
  tripId: string,
  bookingId: string,
  uid: string,
  attachment: BookingAttachment | undefined,
): Promise<void> {
  if (attachment) {
    const result = await safePurgeWithEnqueueFallback({
      purge: () => purgeAttachments(attachment),
      enqueue: {
        tripId, collection: 'bookings', entityId: bookingId,
        paths: [attachment.filePath, attachment.thumbPath].filter(Boolean) as string[],
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
