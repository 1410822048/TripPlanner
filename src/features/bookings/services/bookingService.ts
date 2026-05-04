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
import { BookingDocSchema, UpdateBookingSchema, type Booking, type CreateBookingInput, type UpdateBookingInput } from '@/types'
import { stripEmpty } from '@/utils/stripEmpty'
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
export async function getBookingsByTrip(tripId: string): Promise<Booking[]> {
  const { db, collection, query, orderBy, limit, getDocs } = await getFirebase()
  const snap = await getDocs(query(
    collection(db, ...P.bookings(tripId)),
    orderBy('sortDate', 'desc'),
    limit(LIST_LIMIT),
  ))
  if (snap.size >= LIST_LIMIT) {
    captureError(new Error(`getBookingsByTrip truncated at ${LIST_LIMIT}`), { tripId })
  }
  // Server-sorted via the sortDate index — no client-side sort needed.
  // Bookings created before the sortDate migration won't appear here;
  // they need a one-time backfill (see scripts/backfill-bookings.md).
  return snap.docs.map(bookingFromDoc)
}

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
  return snap.docs.map(bookingFromDoc)
}

/** Fetch the uid list for a trip's members. Used by createBooking to seed
 *  the booking's `memberIds` denormalisation. One extra read per create. */
async function getTripMemberIds(tripId: string): Promise<string[]> {
  const { db, collection, getDocs } = await getFirebase()
  const snap = await getDocs(collection(db, ...P.members(tripId)))
  return snap.docs.map(d => d.id)
}

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
 * Create a booking. If `file` is provided, the doc is created first to
 * obtain its id (used as the storage folder name), then the upload runs and
 * the doc is patched with the resulting URL. Two writes is acceptable —
 * the alternative would be to mint a UUID client-side, but Firestore's
 * server-side id generation pairs cleanly with the security model and the
 * cost difference is one extra round-trip.
 */
export async function createBooking(
  tripId: string,
  input: CreateBookingInput,
  file: File | null,
): Promise<string> {
  const { db, collection, addDoc, doc, updateDoc, serverTimestamp, Timestamp } = await getFirebase()
  // sortDate: prefer the user-meaningful checkIn; fall back to
  // serverTimestamp() so we always have an indexable value.
  const checkInTs = checkInToTimestamp(input.checkIn, Timestamp)
  // memberIds: snapshot the trip's member roster so collection-group
  // queries (PastLodgingPage) can find this booking without per-trip
  // fan-out. Synced on member add/remove via inviteService /
  // memberService.
  const memberIds = await getTripMemberIds(tripId)
  const ref = await addDoc(collection(db, ...P.bookings(tripId)), {
    ...stripEmpty(input),
    tripId,
    createdAt: serverTimestamp(),
    sortDate:  checkInTs ?? serverTimestamp(),
    memberIds,
  })
  if (file) {
    try {
      const meta = await uploadAttachment(tripId, ref.id, file)
      // updateDoc rejects undefined values when ignoreUndefinedProperties
      // isn't set per-call, so build the patch only with concrete values.
      const patch: Record<string, unknown> = {
        fileUrl:  meta.fileUrl,
        filePath: meta.filePath,
        fileType: meta.fileType,
      }
      if (meta.thumbUrl)  patch.thumbUrl  = meta.thumbUrl
      if (meta.thumbPath) patch.thumbPath = meta.thumbPath
      await updateDoc(doc(db, ...P.booking(tripId, ref.id)), patch)
    } catch (e) {
      // Upload failed but the doc exists. Leave the doc — user can retry the
      // upload via edit. Surfacing a partial success is better than rolling
      // back the whole booking and losing the typed metadata.
      captureError(e, { source: 'createBooking/uploadAttachment', tripId, bookingId: ref.id })
      throw e
    }
  }
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
  attachment: File | null | undefined,
  existing: { filePath?: string; thumbPath?: string },
): Promise<void> {
  // Defense-in-depth: see updateExpense for rationale.
  const parsed = UpdateBookingSchema.safeParse(updates)
  if (!parsed.success) {
    captureError(parsed.error, { source: 'updateBooking', tripId, bookingId })
    throw new Error('Update payload failed validation')
  }
  const validated = parsed.data
  const { db, doc, updateDoc, getDoc, deleteField, serverTimestamp, Timestamp } = await getFirebase()
  const patch: Record<string, unknown> = stripEmpty(validated)

  // Erase optional text fields the user cleared in the form. Without
  // deleteField() the existing values would persist on the doc.
  for (const k of ['confirmationCode', 'provider', 'checkIn', 'checkOut', 'note'] as const) {
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
  paths: { filePath?: string; thumbPath?: string },
): Promise<void> {
  await purgeAttachments(paths)
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.booking(tripId, bookingId)))
}

