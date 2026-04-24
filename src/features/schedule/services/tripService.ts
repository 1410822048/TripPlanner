// src/features/schedule/services/tripService.ts
import type { User } from 'firebase/auth'
import { getFirebase } from '@/services/firebase'
import { P, TRIP_SUBCOLLECTIONS } from '@/services/paths'
import { toLocalMidnightTimestamp } from '@/utils/dates'
import { CreateTripSchema, TripDocSchema, type CreateTripInput, type Trip } from '@/types'

/**
 * Fetch every trip the user belongs to — owner OR editor OR viewer.
 *
 * Implementation: one collection-group query on /members filtered by userId
 * returns a member doc per trip the user belongs to. We then fan out to each
 * parent trip doc via getDoc (each call is gated by the /trips/{id} `get`
 * rule which accepts any member). Orphan member docs (parent trip missing)
 * are filtered out. Each trip doc is validated through TripDocSchema before
 * being handed upstream — the service's output is "already-verified" so
 * downstream code doesn't need to re-check shape.
 *
 * Read cost: 1 query + N getDoc, where N is the number of trips the user is
 * a member of. For typical users (N < 20) this is well within budget and
 * avoids the list-rule constraint that prohibits per-doc exists() checks.
 */
export async function getMyTrips(uid: string): Promise<Trip[]> {
  const { db, collectionGroup, query, where, getDocs, doc, getDoc } = await getFirebase()

  const memberSnap = await getDocs(
    query(collectionGroup(db, 'members'), where('userId', '==', uid)),
  )
  if (memberSnap.empty) return []

  const tripIds = Array.from(new Set(
    memberSnap.docs
      .map(d => d.ref.parent.parent?.id)
      .filter((id): id is string => !!id),
  ))

  const tripDocs = await Promise.all(
    tripIds.map(id => getDoc(doc(db, ...P.trip(id)))),
  )

  return tripDocs
    .filter(d => d.exists())
    .flatMap(d => {
      const parsed = TripDocSchema.safeParse(d.data())
      if (!parsed.success) {
        console.error(`[tripService] invalid trip doc ${d.id}:`, parsed.error.issues)
        return []
      }
      return [{ id: d.id, ...parsed.data } as Trip]
    })
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
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
  updates: Partial<CreateTripInput>,
): Promise<void> {
  const { db, doc, updateDoc, serverTimestamp, Timestamp } = await getFirebase()
  const patch: Record<string, unknown> = { updatedAt: serverTimestamp() }
  if (updates.title       !== undefined) patch.title       = updates.title
  if (updates.destination !== undefined) patch.destination = updates.destination
  if (updates.icon        !== undefined) patch.icon        = updates.icon
  if (updates.currency    !== undefined) patch.currency    = updates.currency
  if (updates.startDate) patch.startDate = toLocalMidnightTimestamp(updates.startDate, Timestamp)
  if (updates.endDate)   patch.endDate   = toLocalMidnightTimestamp(updates.endDate,   Timestamp)
  await updateDoc(doc(db, ...P.trip(tripId)), patch)
}

/**
 * Cascade-delete a trip and every subcollection doc that lives under it.
 * Firestore does not auto-cascade subcollections, so we fan out by hand.
 *
 * Subcollection order is defined by TRIP_SUBCOLLECTIONS in paths.ts — see
 * that file for the load-bearing reason `members` must be last. Writes are
 * chunked to the 500-op batch cap; we re-fetch after each chunk because
 * getDocs returns a bounded snapshot.
 *
 * Error handling: each subcollection step wraps its error with the name
 * that failed so the UI (or a retrying owner) can see exactly where the
 * cascade stopped — e.g. a rules-dependency bug that revokes write perm
 * mid-cascade would otherwise surface as a bare "permission-denied". The
 * trip doc itself is only deleted after every subcollection is empty.
 */
export async function deleteTrip(tripId: string): Promise<void> {
  const { db, collection, doc, getDocs, writeBatch, deleteDoc } = await getFirebase()

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
