// src/services/memberSync.ts
// Coordinator for "when membership changes, propagate the diff to all
// downstream entities that have denormalised member fields". Currently
// only bookings.memberIds — but new entities that need cross-trip
// collection-group queries would slot in here.
//
// Located in src/services/ (not in any feature folder) because both
// `members` and `trips/invites` import it. Putting it inside either
// feature would imply that feature owned the cross-cutting sync, which
// it doesn't — sync is genuinely a horizontal concern. Same neighbourhood
// as firebase.ts and sentry.ts: app-level utilities consumed by features.
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'

/**
 * Append a uid to `memberIds` on every booking under a trip. Called
 * after an invitee accepts and a new member doc lands, so the
 * collection-group hotel query (PastLodgingPage) includes their data
 * immediately rather than after manual refresh.
 *
 * arrayUnion is idempotent — re-running on a uid that's already present
 * is a no-op, which makes this safe to retry. Batched in chunks of 500
 * (Firestore batch limit) for trips with many bookings.
 */
export async function addMemberToTripBookings(
  tripId: string,
  uid: string,
): Promise<void> {
  const { db, collection, getDocs, writeBatch, arrayUnion } = await getFirebase()
  const snap = await getDocs(collection(db, ...P.bookings(tripId)))
  if (snap.empty) return
  for (let i = 0; i < snap.docs.length; i += 500) {
    const chunk = snap.docs.slice(i, i + 500)
    const batch = writeBatch(db)
    chunk.forEach(d => batch.update(d.ref, { memberIds: arrayUnion(uid) }))
    await batch.commit()
  }
}

/**
 * Strip a uid from `memberIds` across the trip's bookings. Called after
 * the owner removes a member so that uid disappears from collection-
 * group results. arrayRemove is idempotent; same chunking as add.
 */
export async function removeMemberFromTripBookings(
  tripId: string,
  uid: string,
): Promise<void> {
  const { db, collection, getDocs, writeBatch, arrayRemove } = await getFirebase()
  const snap = await getDocs(collection(db, ...P.bookings(tripId)))
  if (snap.empty) return
  for (let i = 0; i < snap.docs.length; i += 500) {
    const chunk = snap.docs.slice(i, i + 500)
    const batch = writeBatch(db)
    chunk.forEach(d => batch.update(d.ref, { memberIds: arrayRemove(uid) }))
    await batch.commit()
  }
}
