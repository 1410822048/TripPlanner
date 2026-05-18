// src/features/trips/services/tripCascade.ts
// Trip cascade-delete — Firestore doesn't auto-cascade subcollections,
// so we fan out by hand. Lives in its own file because the logic is
// substantial (~80 LOC), the failure-mode handling is intricate (each
// step's error message tells the caller exactly where the cascade
// stopped so retries can resume), and it pulls in Storage cleanup
// which the rest of tripService.ts doesn't touch.
//
// Order of operations matters:
//   1. Storage objects under `trips/{tripId}/` — must run while caller
//      is still a member, because storage.rules dereference Firestore
//      `members/{uid}` on every write.
//   2. Firestore subcollections in TRIP_SUBCOLLECTIONS order, with
//      `members` last (canWrite() rules dereference members/{uid};
//      deleting it earlier would revoke perms for the remaining steps).
//   3. The trip doc itself.
//
// Each step throws with the location it failed at, so the caller / UI
// can show a precise message and a retry resumes naturally —
// purgeStorageFolder is idempotent (already-deleted files don't appear
// in listAll), and the Firestore subcollection loops are convergent.
import { getFirebase, getFirebaseStorage } from '@/services/firebase'
import { P, TRIP_SUBCOLLECTIONS, type TripSubcollection } from '@/services/paths'

/** Subcollections whose list rule is gated by same-doc memberIds —
 *  i.e. the query MUST include `where('memberIds', 'array-contains', uid)`
 *  to be accepted. `invites` (gated by isTripOwner, no memberIds field)
 *  and `settlements` (gated by exists(memberPath), no memberIds field)
 *  fall through to unfiltered listing. */
const MEMBER_IDS_GATED: ReadonlySet<TripSubcollection> = new Set([
  'schedules', 'expenses', 'wishes', 'bookings', 'planning', 'members',
])

/**
 * Recursively delete every Storage object under a prefix. Used during
 * the trip cascade to purge booking attachments before Firestore is
 * touched.
 *
 * `listAll()` is fine for the app's depth (trip → bookings → file):
 * each level has O(20) entries at most. If a trip ever grows past
 * Firebase's listAll cap (1000 items), this needs pagination via
 * list({maxResults}).
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
 * See module header for ordering rationale and retry semantics.
 *
 * `uid` is the caller's uid — required to satisfy the same-doc list
 * rules on memberIds-gated subcollections. The caller must be the trip
 * owner (rule-enforced); owners are always in memberIds, so the filter
 * is a no-op on results but mandatory for Firestore query validation.
 */
export async function deleteTrip(tripId: string, uid: string): Promise<void> {
  const { db, collection, doc, query, where, getDocs, writeBatch, deleteDoc } = await getFirebase()

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
        const colRef = collection(db, ...P.subcollection(tripId, name))
        const listQuery = MEMBER_IDS_GATED.has(name)
          ? query(colRef, where('memberIds', 'array-contains', uid))
          : colRef
        const snap = await getDocs(listQuery)
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
