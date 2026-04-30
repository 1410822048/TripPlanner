// src/features/members/services/memberService.ts
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError } from '@/services/sentry'
import { removeMemberFromTripBookings } from '@/services/memberSync'
import { MemberDocSchema, type Member } from '@/types'

function memberFromDoc(d: QueryDocumentSnapshot): Member {
  const parsed = MemberDocSchema.safeParse(d.data())
  if (!parsed.success) {
    captureError(parsed.error, { source: 'memberFromDoc', docId: d.id })
    throw new Error(`Member ${d.id} failed schema validation`)
  }
  return { id: d.id, ...parsed.data }
}

export async function getMembersByTrip(tripId: string): Promise<Member[]> {
  const { db, collection, query, orderBy, getDocs } = await getFirebase()
  const q = query(
    collection(db, ...P.members(tripId)),
    orderBy('joinedAt'),
  )
  const snap = await getDocs(q)
  return snap.docs.map(memberFromDoc)
}

/**
 * Remove a member from a trip. Rule-gated to trip owner; attempting to kick
 * oneself is not prevented at the client layer (UI hides the button for the
 * acting owner's own row), and the delete rule does not re-check that, but
 * the resulting state is valid — a trip without any members is recoverable
 * by the orphan cleanup during the next owner-initiated delete cascade.
 *
 * Also strips the removed uid from every booking's denormalised
 * `memberIds` array so the kicked member no longer sees this trip's
 * hotel bookings via the collection-group query in PastLodgingPage. Sync
 * runs after the member doc delete; the rule is gated on isTripOwner
 * regardless, so write perms remain after deletion. Sync failure is
 * logged to Sentry but doesn't roll back the member removal — leaving
 * the doc deleted is the safer state.
 */
export async function removeMember(tripId: string, memberId: string): Promise<void> {
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.member(tripId, memberId)))
  try {
    await removeMemberFromTripBookings(tripId, memberId)
  } catch (e) {
    captureError(e, { source: 'removeMember/syncBookings', tripId, memberId })
  }
}

/**
 * Update a member's role. Owner-only (firestore.rules: `allow update: if
 * isTripOwner(tripId)`). Only editor/viewer transitions are allowed at the
 * service layer; promoting to owner would need additional ownership-transfer
 * logic (out of scope — single-owner invariant).
 */
export async function updateMemberRole(
  tripId: string,
  memberId: string,
  role: 'editor' | 'viewer',
): Promise<void> {
  const { db, doc, updateDoc } = await getFirebase()
  await updateDoc(doc(db, ...P.member(tripId, memberId)), { role })
}
