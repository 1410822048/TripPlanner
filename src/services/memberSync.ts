// src/services/memberSync.ts
// Cascading membership-removal sync. When the trip owner removes a
// member, the denormalised `memberIds: string[]` on every trip-scoped
// doc has to drop that uid — otherwise the read rules
// (`allow read: if request.auth.uid in resource.data.memberIds`) would
// keep letting the removed user listen in.
//
// Sync covers:
//   - The trip doc itself
//   - All 5 entity subcollections (schedules, expenses, bookings,
//     wishes, planning)
//   - All member docs (each carries the full roster so the members-
//     list rule can use same-doc check, no exists() cross-doc read)
//
// Writes are arrayRemove → idempotent + atomic-per-doc → safe to retry.
// Chunked in batches of 500 (Firestore batch cap) for trips with many
// entity docs.
//
// The ADD direction now lives server-side: the OCR Cloudflare Worker's
// /cascade-member endpoint uses an admin service account to arrayUnion
// the invitee's uid across all docs (bypassing the same-doc list rule
// that blocks the invitee themselves). See workers/ocr/src/cascade.ts.
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import type { TripSubcollection } from '@/services/paths'

/** Trip-scoped subcollections that carry a denormalised memberIds[].
 *  Invites and settlements deliberately omitted:
 *   - invites: rule-gated by isTripOwner reading the trip doc; the
 *     token itself is the access secret, no memberIds needed
 *   - settlements: small bounded set, rule-gated by isMember which
 *     we're keeping as cross-doc for the rare settlement path
 *     (premature optimisation otherwise). */
const ENTITY_SUBCOLLECTIONS: TripSubcollection[] = [
  'schedules',
  'expenses',
  'bookings',
  'wishes',
  'planning',
]

/**
 * Strip `uid` from memberIds across every trip-scoped doc. Called by
 * memberService.removeMember (owner action) so the removed user's
 * reads start failing immediately via the same-doc rule check.
 */
export async function removeMemberFromTripBookings(
  tripId: string,
  uid:    string,
): Promise<void> {
  const { db, doc, collection, query, where, getDocs, writeBatch, arrayRemove } = await getFirebase()
  const mutation = arrayRemove(uid)

  // 1) Trip doc — ownerSyncRemove rule path lets the owner caller
  //    strip the uid from memberIds.
  const tripBatch = writeBatch(db)
  tripBatch.update(doc(db, ...P.trip(tripId)), { memberIds: mutation })
  await tripBatch.commit()

  // 2) Per-doc cascade. The list query needs to satisfy the same-doc
  //    rule (`uid in resource.data.memberIds`) — owner is in every
  //    doc, so listing succeeds.
  await cascadeCollection(P.members(tripId))
  for (const name of ENTITY_SUBCOLLECTIONS) {
    await cascadeCollection(P.subcollection(tripId, name))
  }

  async function cascadeCollection(
    path: readonly [string, ...string[]],
  ): Promise<void> {
    const snap = await getDocs(query(
      collection(db, ...path),
      where('memberIds', 'array-contains', uid),
    ))
    if (snap.empty) return
    for (let i = 0; i < snap.docs.length; i += 500) {
      const chunk = snap.docs.slice(i, i + 500)
      const batch = writeBatch(db)
      chunk.forEach(d => batch.update(d.ref, { memberIds: mutation }))
      await batch.commit()
    }
  }
}
