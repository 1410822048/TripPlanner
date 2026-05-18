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
import { BookingDocSchema, UpdateBookingSchema, type Booking, type CreateBookingInput, type UpdateBookingInput } from '@/types'
import { stripEmpty } from '@/utils/stripEmpty'
import { auditCreate, auditUpdate } from '@/utils/audit'
import { getTripMemberIds } from '@/services/tripMemberIds'
import { bumpTripActivity } from '@/services/tripActivity'
import { uploadAttachment, purgeAttachments } from './bookingStorage'

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
 * Create a booking. Single-shot via mint-id-first when a file is
 * provided: doc-ref minted client-side, uploadAttachment runs first
 * using the pre-minted id as the Storage folder, then setDoc writes
 * everything in one shot. Upload-before-doc is safe because Storage
 * rules gate on canWriteFiles(tripId) without checking doc existence;
 * upload failure leaves no doc behind to clean up.
 */
export async function createBooking(
  tripId: string,
  input: CreateBookingInput,
  file: File | null,
  createdBy: string,
): Promise<string> {
  const { db, collection, doc, setDoc, serverTimestamp, Timestamp } = await getFirebase()
  const checkInTs = checkInToTimestamp(input.checkIn, Timestamp)
  const memberIds = await getTripMemberIds(tripId)
  const ref = doc(collection(db, ...P.bookings(tripId)))

  let attachmentMeta: Awaited<ReturnType<typeof uploadAttachment>> | null = null
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
  if (attachmentMeta) {
    payload.fileUrl   = attachmentMeta.fileUrl
    payload.filePath  = attachmentMeta.filePath
    payload.fileType  = attachmentMeta.fileType
    if (attachmentMeta.thumbUrl)  payload.thumbUrl  = attachmentMeta.thumbUrl
    if (attachmentMeta.thumbPath) payload.thumbPath = attachmentMeta.thumbPath
  }
  await setDoc(ref, payload)
  void bumpTripActivity(tripId, 'bookings', createdBy)
  return ref.id
}

/**
 * Update a booking. `attachment` is tri-state:
 *   undefined → no attachment change (text-only edit)
 *   null      → clear attachment (deletes storage objects)
 *   File      → replace (deletes old, uploads new)
 */
export async function updateBooking(
  tripId: string,
  bookingId: string,
  updates: UpdateBookingInput,
  options: {
    uid:        string
    attachment: File | null | undefined
    existing:   { filePath?: string; thumbPath?: string }
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

  if (attachment === null) {
    await purgeAttachments(existing)
    patch.fileUrl   = deleteField()
    patch.filePath  = deleteField()
    patch.thumbUrl  = deleteField()
    patch.thumbPath = deleteField()
    patch.fileType  = deleteField()
  } else if (attachment instanceof File) {
    await purgeAttachments(existing)
    const meta = await uploadAttachment(tripId, bookingId, attachment)
    patch.fileUrl   = meta.fileUrl
    patch.filePath  = meta.filePath
    patch.thumbUrl  = meta.thumbUrl  ?? deleteField()
    patch.thumbPath = meta.thumbPath ?? deleteField()
    patch.fileType  = meta.fileType
  }

  await updateDoc(doc(db, ...P.booking(tripId, bookingId)), patch)
  void bumpTripActivity(tripId, 'bookings', uid)
}

/**
 * Delete a booking + its attachment. Storage delete runs first; if it
 * fails the doc is kept so the orphaned object can still be reached
 * via the doc path on retry. deleteAttachment tolerates not-found.
 */
export async function deleteBooking(
  tripId: string,
  bookingId: string,
  uid: string,
  paths: { filePath?: string; thumbPath?: string },
): Promise<void> {
  await purgeAttachments(paths)
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.booking(tripId, bookingId)))
  void bumpTripActivity(tripId, 'bookings', uid)
}
