// src/features/trips/services/tripService.ts
import type { User } from 'firebase/auth'
import { getFirebase, getFirebaseStorage } from '@/services/firebase'
import { P, TRIP_SUBCOLLECTIONS } from '@/services/paths'
import { toLocalMidnightTimestamp } from '@/utils/dates'
import { captureError } from '@/services/sentry'
import { CreateTripSchema, UpdateTripSchema, TripDocSchema, type CreateTripInput, type UpdateTripInput, type Trip } from '@/types'

/** Defensive cap on the trips-per-user query. Real users don't have 50+
 *  active trips; if Sentry reports a hit, the actual scaling pain is here
 *  and we should add proper pagination + a "browse trips" UI. */
const TRIPS_LIMIT = 50

/**
 * Stage 1 of "fetch all my trips": a single collection-group query on
 * /members filtered by `userId == uid`. Returns just the trip ids the user
 * belongs to. Exposed as a separate service so callers that need the ids
 * earlier than the full Trip[] (e.g. AccountPage's per-trip member fan-out)
 * can fire off downstream queries in parallel with stage 2 below.
 */
export async function getMyTripIds(uid: string): Promise<string[]> {
  const { db, collectionGroup, query, where, limit, getDocs } = await getFirebase()
  const memberSnap = await getDocs(
    query(collectionGroup(db, 'members'), where('userId', '==', uid), limit(TRIPS_LIMIT)),
  )
  if (memberSnap.size >= TRIPS_LIMIT) {
    captureError(new Error(`getMyTripIds truncated at ${TRIPS_LIMIT}`), { uid })
  }
  return Array.from(new Set(
    memberSnap.docs
      .map(d => d.ref.parent.parent?.id)
      .filter((id): id is string => !!id),
  ))
}

/**
 * Stage 2: parallel `getDoc` per trip id, gated by the /trips/{id} `get`
 * rule (accepts any member regardless of role). Orphan ids (parent trip
 * missing) are filtered out. Each doc is validated through TripDocSchema
 * so downstream code can trust the shape.
 *
 * NOTE: A previous version tried to batch this with
 *   `where(documentId(), 'in', chunkedIds)`
 * to reduce round-trips. That refactor was reverted because the `in`
 * query routes through the /trips LIST rule (`ownerId == uid`), which
 * rejects the whole query if the user is a non-owner member of ANY trip
 * in the chunk — producing a 403 across the user's entire trip fetch.
 * Per-doc getDoc goes through the GET rule (`isMember`) and works for
 * every role. The N getDoc round-trips are acceptable because trips
 * per user is small (cap TRIPS_LIMIT = 50, real usage <10).
 */
export async function getTripsByIds(tripIds: string[]): Promise<Trip[]> {
  if (tripIds.length === 0) return []
  const { db, doc, getDoc } = await getFirebase()
  const tripDocs = await Promise.all(
    tripIds.map(id => getDoc(doc(db, ...P.trip(id)))),
  )
  return tripDocs
    .filter(d => d.exists())
    .flatMap(d => {
      const parsed = TripDocSchema.safeParse(d.data())
      if (!parsed.success) {
        captureError(parsed.error, { source: 'getTripsByIds', docId: d.id })
        return []
      }
      return [{ id: d.id, ...parsed.data } as Trip]
    })
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
}

/**
 * Fetch every trip the user belongs to — owner OR editor OR viewer.
 * Composes getMyTripIds + getTripsByIds so the staged services stay reusable
 * (AccountPage opts into the staged form to parallelise its member fan-out).
 *
 * Read cost: 1 query + N getDoc, where N is the number of trips the user is
 * a member of. For typical users (N < 20) this is well within budget and
 * avoids the list-rule constraint that prohibits per-doc exists() checks.
 */
export async function getMyTrips(uid: string): Promise<Trip[]> {
  const tripIds = await getMyTripIds(uid)
  return getTripsByIds(tripIds)
}

/**
 * Batch-create a trip + owner member doc. Matches firestore.rules:
 *   - trips/{id}.ownerId == uid()
 *   - trips/{id}/members/{uid}.userId == uid() && role == 'owner'
 * The two writes land atomically, so the member self-bootstrap required
 * by rules can't be skipped by a partial failure.
 */
export async function createTrip(input: CreateTripInput, user: User): Promise<Trip> {
  const data = CreateTripSchema.parse(input)
  const { db, doc, collection, writeBatch, Timestamp, serverTimestamp } = await getFirebase()

  const tripRef   = doc(collection(db, ...P.trips()))
  const memberRef = doc(db, ...P.member(tripRef.id, user.uid))

  const startTs = toLocalMidnightTimestamp(data.startDate, Timestamp)
  const endTs   = toLocalMidnightTimestamp(data.endDate,   Timestamp)
  const icon    = data.icon ?? '✈️'

  const tripPayload = {
    title:       data.title,
    destination: data.destination,
    icon,
    startDate:   startTs,
    endDate:     endTs,
    currency:    data.currency,
    ownerId:     user.uid,
    createdAt:   serverTimestamp(),
    updatedAt:   serverTimestamp(),
  }

  const memberPayload: Record<string, unknown> = {
    tripId:      tripRef.id,
    userId:      user.uid,
    displayName: user.displayName ?? 'Me',
    role:        'owner',
    joinedAt:    serverTimestamp(),
  }
  // avatarUrl omitted when null — ignoreUndefinedProperties strips undefined;
  // explicit branch keeps the payload tight.
  if (user.photoURL) memberPayload.avatarUrl = user.photoURL

  const batch = writeBatch(db)
  batch.set(tripRef,   tripPayload)
  batch.set(memberRef, memberPayload)
  await batch.commit()

  // Local Timestamp as a sentinel for createdAt/updatedAt — the real server
  // values arrive on the next read via useMyTrips / getDoc.
  const nowTs = Timestamp.now()
  return {
    id:          tripRef.id,
    title:       data.title,
    destination: data.destination,
    icon,
    startDate:   startTs,
    endDate:     endTs,
    currency:    data.currency,
    ownerId:     user.uid,
    createdAt:   nowTs,
    updatedAt:   nowTs,
  }
}

/**
 * Patch editable trip metadata. Only fields present in `updates` are written;
 * `ownerId` is immutable (rule-enforced) so never included. Date strings are
 * converted to local-midnight Timestamps to match createTrip.
 */
export async function updateTrip(
  tripId: string,
  updates: UpdateTripInput,
): Promise<void> {
  // Defense-in-depth: see updateExpense for rationale.
  const parsed = UpdateTripSchema.safeParse(updates)
  if (!parsed.success) {
    captureError(parsed.error, { source: 'updateTrip', tripId })
    throw new Error('Update payload failed validation')
  }
  const validated = parsed.data
  const { db, doc, updateDoc, serverTimestamp, Timestamp } = await getFirebase()
  const patch: Record<string, unknown> = { updatedAt: serverTimestamp() }
  if (validated.title       !== undefined) patch.title       = validated.title
  if (validated.destination !== undefined) patch.destination = validated.destination
  if (validated.icon        !== undefined) patch.icon        = validated.icon
  if (validated.currency    !== undefined) patch.currency    = validated.currency
  if (validated.startDate) patch.startDate = toLocalMidnightTimestamp(validated.startDate, Timestamp)
  if (validated.endDate)   patch.endDate   = toLocalMidnightTimestamp(validated.endDate,   Timestamp)
  await updateDoc(doc(db, ...P.trip(tripId)), patch)
}

/**
 * Recursively delete every Storage object under a prefix. Used during the
 * trip cascade to purge booking attachments before Firestore is touched.
 *
 * Why before Firestore: storage.rules gate writes on
 * `firestore.exists(.../members/{uid})`. Once the cascade deletes the
 * caller's member doc (last subcollection per TRIP_SUBCOLLECTIONS order),
 * any subsequent Storage delete would hit permission-denied. So Storage
 * cleanup runs first while the caller is still a member.
 *
 * `listAll()` is fine for our depth (trip → bookings → file): each level
 * has O(20) entries at most. If a trip ever grows past Firebase's listAll
 * cap (1000 items), this will need pagination via list({maxResults}).
 */
async function purgeStorageFolder(prefix: string): Promise<void> {
  const { storage, ref, listAll, deleteObject } = await getFirebaseStorage()
  const dir = ref(storage, prefix)
  const result = await listAll(dir)
  await Promise.all([
    ...result.items.map(item => deleteObject(item)),
    ...result.prefixes.map(p => purgeStorageFolder(p.fullPath)),
  ])
}

/**
 * Cascade-delete a trip and every subcollection doc that lives under it.
 * Firestore does not auto-cascade subcollections, so we fan out by hand.
 *
 * Order:
 *   1. Storage objects under `trips/{tripId}/` (must run while caller is
 *      still a member — see purgeStorageFolder for details).
 *   2. Firestore subcollections in TRIP_SUBCOLLECTIONS order. `members` is
 *      last because canWrite() rules dereference members/{uid}; deleting
 *      it earlier would revoke perms for the remaining steps.
 *   3. The trip doc itself.
 *
 * Writes are chunked to the 500-op batch cap; we re-fetch after each chunk
 * because getDocs returns a bounded snapshot.
 *
 * Error handling: each step wraps its error with the location that failed
 * so the UI (or a retrying owner) can see exactly where the cascade
 * stopped. A retry resumes naturally — purgeStorageFolder is idempotent
 * (already-deleted files don't appear in listAll), and the Firestore
 * subcollection loops are convergent.
 */
export async function deleteTrip(tripId: string): Promise<void> {
  const { db, collection, doc, getDocs, writeBatch, deleteDoc } = await getFirebase()

  try {
    await purgeStorageFolder(`trips/${tripId}`)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(
      `Trip ${tripId} cascade stopped during Storage cleanup: ${reason}. ` +
      `No Firestore data was deleted; retry the operation.`,
    )
  }

  for (const name of TRIP_SUBCOLLECTIONS) {
    try {
      for (;;) {
        const snap = await getDocs(collection(db, ...P.subcollection(tripId, name)))
        if (snap.empty) break
        const chunk = snap.docs.slice(0, 500)
        const batch = writeBatch(db)
        chunk.forEach(d => batch.delete(d.ref))
        await batch.commit()
        if (snap.docs.length <= 500) break
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      throw new Error(
        `Trip ${tripId} cascade stopped at subcollection '${name}': ${reason}. ` +
        `The trip doc itself was not deleted; retry the operation to continue cleanup.`,
      )
    }
  }

  try {
    await deleteDoc(doc(db, ...P.trip(tripId)))
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(
      `Trip ${tripId} subcollections were cleared but the trip doc delete failed: ${reason}. ` +
      `Retry to finalise deletion.`,
    )
  }
}
