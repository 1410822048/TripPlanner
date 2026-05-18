// src/features/bookings/services/bookingService.ts
// Bookings = the trip's confirmation hub: flights, hotels, trains, etc.
// Phase 2 ships full CRUD + a single file attachment per booking via
// Firebase Storage. Each booking owns its own folder under
// `trips/{tripId}/bookings/{bookingId}/` so adding a multi-file mode later
// won't require a path migration.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError } from '@/services/sentry'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { parseListSnapshot } from '@/services/parseListSnapshot'
import { subscribeToCollection } from '@/services/realtimeQuery'
import { BookingDocSchema, UpdateBookingSchema, type Booking, type CreateBookingInput, type UpdateBookingInput } from '@/types'
import { stripEmpty } from '@/utils/stripEmpty'
import { auditCreate, auditUpdate } from '@/utils/audit'
import { getTripMemberIds } from '@/services/tripMemberIds'
import { bumpTripActivity } from '@/services/tripActivity'
import { uploadAttachment, purgeAttachments } from './bookingStorage'

/**
 * Defensive cap on list queries. Set well above the realistic per-trip
 * count (10-30 bookings) so day-to-day usage never hits it; if Sentry
 * reports a truncation event the user has stretched the assumption far
 * enough that we should add a real "load more" UI. See M1 in the code
 * review for the long-term plan.
 */
const LIST_LIMIT = 100

/**
 * Parse a Firestore doc into a Booking; throw on schema drift so callers
 * (and the route-level ErrorBoundary) see the bad doc loudly rather than
 * silently dropping it from the list. Mirrors expenseFromDoc /
 * scheduleFromDoc behaviour for cross-service consistency.
 */
function bookingFromDoc(d: QueryDocumentSnapshot): Booking {
  return firestoreDocFromSchema(BookingDocSchema, d, 'bookingFromDoc') as Booking
}

// ─── Read ─────────────────────────────────────────────────────────

/**
 * Fetch every booking for a trip, newest first. Sort key prefers `checkIn`
 * (the user-meaningful date — flight departure, hotel check-in) and falls
 * back to `createdAt` for bookings without a date set yet. Done client-side
 * because Firestore can't orderBy a field that's optional / sometimes-null
 * without a composite index per category, which isn't worth the cost.
 */
export async function getBookingsByTrip(tripId: string, uid: string): Promise<Booking[]> {
  const { db, collection, query, where, orderBy, limit, getDocs } = await getFirebase()
  const snap = await getDocs(query(
    collection(db, ...P.bookings(tripId)),
    where('memberIds', 'array-contains', uid),
    orderBy('sortDate', 'desc'),
    limit(LIST_LIMIT),
  ))
  if (snap.size >= LIST_LIMIT) {
    captureError(new Error(`getBookingsByTrip truncated at ${LIST_LIMIT}`), { tripId })
  }
  // Server-sorted via the sortDate index — no client-side sort needed.
  // Bookings created before the sortDate migration won't appear here;
  // they need a one-time backfill (see scripts/backfill-bookings.md).
  return parseListSnapshot(snap, bookingFromDoc)
}

/**
 * Realtime variant of getBookingsByTrip — same sortDate-desc query
 * pushed via onSnapshot so the bookings list reflects co-member
 * changes live.
 */
export const subscribeToBookings = (
  tripId: string,
  uid:    string,
  onData: (data: Booking[]) => void,
  onError: (e: Error) => void,
) => subscribeToCollection<Booking>({
  buildQuery: ({ db, collection, query, where, orderBy, limit }) => query(
    collection(db, ...P.bookings(tripId)),
    where('memberIds', 'array-contains', uid),
    orderBy('sortDate', 'desc'),
    limit(LIST_LIMIT),
  ),
  fromDoc: bookingFromDoc,
  source:  'subscribeToBookings',
  limit:   LIST_LIMIT,
}, onData, onError)

/**
 * Single-user "every hotel booking across every trip I'm a member of",
 * used by PastLodgingPage. Replaces the previous N-trip fan-out
 * (useQueries calling getHotelBookingsByTrip per trip) with a single
 * collection-group query — O(1) Firestore round-trips regardless of
 * trip count.
 *
 * Requires the denormalised `memberIds` array on each booking; see
 * Booking type for the sync contract. Bookings created before the
 * memberIds migration won't appear (backfill task).
 */
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

/**
 * Realtime variant of getMyHotelBookings — collection-group listener
 * across every trip the user is in, filtered to hotel bookings via
 * the denormalised `memberIds` array. Fires when a co-traveller adds
 * / edits / deletes a hotel booking on any shared trip, so the
 * cross-trip lodging history stays current.
 */
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

/**
 * Convert a checkIn string ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm') to a
 * Firestore Timestamp suitable for sortDate. Returns null for missing /
 * unparseable values so the caller can fall back to serverTimestamp().
 *
 * Why a separate sortDate field instead of orderBy('checkIn'): checkIn is
 * optional (some bookings only have createdAt). Firestore's orderBy(field)
 * silently EXCLUDES docs missing the field, so a half-filled booking
 * would disappear from the list. sortDate is always populated → safe to
 * orderBy without losing rows.
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
 * everything in one shot. Saves the previous addDoc → updateDoc
 * round-trip (~150-300ms p50 on attachment-bearing creates).
 *
 * Upload-before-doc ordering is safe: Storage rules gate on
 * canWriteFiles(tripId) without checking the doc's existence. If the
 * upload fails, the doc was never written → no orphan to clean up.
 */
export async function createBooking(
  tripId: string,
  input: CreateBookingInput,
  file: File | null,
  createdBy: string,
): Promise<string> {
  const { db, collection, doc, setDoc, serverTimestamp, Timestamp } = await getFirebase()
  // sortDate: prefer the user-meaningful checkIn; fall back to
  // serverTimestamp() so we always have an indexable value.
  const checkInTs = checkInToTimestamp(input.checkIn, Timestamp)
  // memberIds: snapshot the trip's member roster so collection-group
  // queries (PastLodgingPage) can find this booking without per-trip
  // fan-out. Synced on member add/remove via inviteService /
  // memberService.
  const memberIds = await getTripMemberIds(tripId)
  const ref = doc(collection(db, ...P.bookings(tripId)))

  let attachmentMeta: Awaited<ReturnType<typeof uploadAttachment>> | null = null
  if (file) {
    try {
      attachmentMeta = await uploadAttachment(tripId, ref.id, file)
    } catch (e) {
      // Upload-before-doc means a failure leaves nothing behind — the
      // doc was never written, so there's nothing to roll back.
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
 * Update a booking. The `attachment` arg is tri-state:
 *   - `undefined` → no attachment change (text-only edit)
 *   - `null`      → clear attachment (deletes the storage object)
 *   - `File`      → replace (deletes the old object, uploads the new)
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
  // Defense-in-depth: see updateExpense for rationale.
  const parsed = UpdateBookingSchema.safeParse(updates)
  if (!parsed.success) {
    captureError(parsed.error, { source: 'updateBooking', tripId, bookingId })
    throw new Error('Update payload failed validation')
  }
  const validated = parsed.data
  const { db, doc, updateDoc, getDoc, deleteField, serverTimestamp, Timestamp } = await getFirebase()
  const patch: Record<string, unknown> = {
    ...stripEmpty(validated),
    ...auditUpdate(uid, serverTimestamp()),
  }

  // Erase optional text fields the user cleared in the form. Without
  // deleteField() the existing values would persist on the doc.
  for (const k of ['confirmationCode', 'provider', 'checkIn', 'checkOut', 'address', 'note'] as const) {
    if (k in validated && (validated[k] === undefined || validated[k] === '')) {
      patch[k] = deleteField()
    }
  }

  // sortDate: recompute when checkIn changes so the booking re-sorts to
  // its new chronological position. When checkIn is cleared, fall back to
  // the doc's existing createdAt — requires a read but only on this rare
  // path. New checkIn → just convert; serverTimestamp() catches the
  // weird "checkIn-cleared on a brand-new doc" edge case.
  if ('checkIn' in validated) {
    const checkInTs = checkInToTimestamp(validated.checkIn, Timestamp)
    if (checkInTs) {
      patch.sortDate = checkInTs
    } else {
      const docRef = doc(db, ...P.booking(tripId, bookingId))
      const snap = await getDoc(docRef)
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
 * Delete a booking and its attachment (if any). Storage delete runs first;
 * if it fails the doc is kept so the orphaned object can still be reached
 * via the doc path on retry. Storage-side "object not found" is tolerated
 * by deleteAttachment().
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

