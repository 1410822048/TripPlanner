// src/features/bookings/services/bookingService.ts
// Bookings = the trip's confirmation hub: flights, hotels, trains, etc.
// Phase 2 shipped full CRUD + a single file attachment per booking via
// Firebase Storage. Phase 3.6 flips the create flow to doc-first: the
// booking lands in Firestore WITHOUT an attachment, then the Worker
// patches `attachment` atomically with the intent markUsed writes when
// /upload-finalize fires. Same pattern as wish covers, which were
// already doc-first since Phase 3.0.
//
// Why doc-first: Phase 3.6 makes the Worker the authoritative writer
// for `attachment` -- firestore.rules locks the field to "unchanged
// OR deleteField" on the client side (Commit 3, shipped). The Worker
// reads the entity doc inside /upload-finalize's tx to verify it
// still exists, the caller is still owner/editor, and -- crucially
// -- that the doc's current primary path matches the caller's
// expectedCurrentPath (stale-finalize guard). All three checks need
// the doc to exist BEFORE finalize fires, hence doc-first.
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

/**
 * Thrown by `createBooking` when the doc-first flow can't fully unwind
 * after the attachment step failed. The booking doc landed in Firestore
 * (and possibly a blob too), the rollback `deleteDoc` failed (network
 * blip, rate limit, etc.), and the caller needs to know the booking
 * persists so it can `invalidateQueries` and reconcile the cache with
 * reality. Without this typed signal, callers can't distinguish
 * "fully failed -- safe to retry" from "partially failed -- retry
 * will duplicate" and a re-press of save would land a second booking.
 *
 * Mirrors WishCreatePartialError; both doc-first creates need it.
 */
export class BookingCreatePartialError extends Error {
  readonly bookingId: string
  readonly cause:     unknown
  constructor(bookingId: string, cause: unknown) {
    super('Booking doc was created but attachment step + rollback both failed')
    this.name      = 'BookingCreatePartialError'
    this.bookingId = bookingId
    this.cause     = cause
  }
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
 * Create a booking. Doc-first ordering (Phase 3.6): setDoc the booking
 * WITHOUT attachment, then upload + finalize so the Worker patches
 * `attachment` directly. All-or-nothing semantics: if the attachment
 * step fails after setDoc succeeded, the booking doc is rolled back
 * (deleteDoc) before throwing. Without this, the realtime listener
 * would have already pushed the just-setDoc'd booking into TanStack
 * cache; the mutation's onError rollback only undoes its OWN
 * optimistic patch, not the listener-driven cache insert. Net effect
 * was: "save failed" toast + the new booking visible in the list +
 * the user re-pressing save creating a DUPLICATE.
 *
 * If BOTH the attachment step AND the rollback deleteDoc fail,
 * throws `BookingCreatePartialError(bookingId)` so the mutation hook
 * can invalidateQueries and reconcile cache with reality. Mirrors
 * WishCreatePartialError -- same partial-failure shape.
 *
 * Orphan blob cleanup on attachment failure is handled by the
 * Worker's intent-expiry cron + orphan-storage-scan -- no client-
 * side purge ladder. The intents stay 'pending' on finalize failure
 * (Worker tx rolled back) and get reaped on their 30-min expiry. On
 * uploadToIntent failure mid-batch, any uploaded-but-orphan blobs
 * get reaped by storage-scan when they age past the grace window.
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
  const [{ db, collection, doc, setDoc, deleteDoc, serverTimestamp, Timestamp }, memberIds] = await Promise.all([
    getFirebase(),
    getTripMemberIds(tripId),
  ])
  const checkInTs = checkInToTimestamp(input.checkIn, Timestamp)
  const ref = doc(collection(db, ...P.bookings(tripId)))

  const payload: Record<string, unknown> = {
    ...stripEmpty(input),
    tripId,
    ...auditCreate(createdBy, serverTimestamp()),
    sortDate:  checkInTs ?? serverTimestamp(),
    memberIds,
  }

  await setDoc(ref, payload)

  if (file) {
    try {
      // First-attach: expectedCurrentPath = null (booking doc has no
      // attachment field yet by virtue of doc-first). Worker patches
      // booking.attachment atomically with the intent markUsed writes.
      await uploadAttachment(tripId, ref.id, file, null)
    } catch (e) {
      captureError(e, { source: 'createBooking/uploadAttachment', tripId, bookingId: ref.id })
      // All-or-nothing cleanup: roll the booking doc back so the
      // caller's mutation can rollback cleanly. Orphan blob (if any
      // landed in Storage before finalize aborted) is reclaimed by
      // the Worker's storage-scan cron -- no client-side purge here
      // because the Worker is the only writer for `attachment` and
      // a finalize abort leaves nothing for us to safePurge against.
      let docRollbackOk = true
      try {
        await deleteDoc(ref)
      } catch (cleanupErr) {
        captureError(cleanupErr, { source: 'createBooking/rollback-doc', tripId, bookingId: ref.id })
        docRollbackOk = false
      }
      if (!docRollbackOk) {
        throw new BookingCreatePartialError(ref.id, e)
      }
      throw e
    }
  }

  void bumpTripActivity(tripId, 'bookings', createdBy)
  return ref.id
}

/**
 * Update a booking. `attachment` is tri-state:
 *   undefined → no attachment change (text-only edit)
 *   null      → clear attachment (Firestore deleteField + Storage purge)
 *   File      → replace (Worker uploads → patches → client purges old)
 *
 * Phase 3.6 split-write ordering:
 *   1. Text patch via updateDoc (sortDate / cleared optionals /
 *      attachment: deleteField() for the null detach case).
 *      Attachment-replace does NOT include `attachment` here -- the
 *      Worker is the only writer for that field on replace.
 *   2. If attachment is a File: uploadAttachment(..., existing?.filePath).
 *      Worker patches `attachment` + updatedBy + updatedAt in its own
 *      tx. expectedCurrentPath catches a concurrent Tab B replace
 *      (409 stale-finalize → throw).
 *   3. On combined success: purge the OLD blob (if any).
 *
 * Failure semantics:
 *   - Step 1 rejects → throw; doc unchanged, no upload tried.
 *   - Step 2 rejects → throw; text-only edits already saved, attachment
 *     unchanged. User can retry; the text fields will be re-written
 *     idempotently (same form state) and only the upload retries.
 *   - Step 1 + 2 both succeed → purge OLD via safePurge/_purges ladder.
 *
 * The previous "upload NEW first → updateDoc with attachment → purge
 * OLD or NEW depending on outcome" pattern was correct when the client
 * owned `attachment`. Phase 3.6 makes the Worker authoritative for
 * that field, so the client can no longer rollback NEW by purging the
 * blob -- the doc already references it. Sequencing text → attachment
 * sidesteps the "what to do when text save fails after attachment
 * Worker-write" question entirely.
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

  // Detach via deleteField in the text patch -- firestore.rules
  // (Commit 3) will still permit this because `attachment` may be
  // either unchanged OR removed by the client. Replace is Worker-only.
  if (attachment === null) {
    patch.attachment = deleteField()
  }

  await updateDoc(doc(db, ...P.booking(tripId, bookingId)), patch)

  if (attachment instanceof File) {
    // Replace flow: Worker patches `attachment` (and bumps updatedBy /
    // updatedAt again). expectedCurrentPath catches Tab B drift.
    await uploadAttachment(tripId, bookingId, attachment, existing?.filePath ?? null)
  }

  // Success path -- safe to drop the old blob now. Either we cleared
  // the field (attachment=null) or replaced it (File case). Full
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
