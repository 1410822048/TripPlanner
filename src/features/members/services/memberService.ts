// src/features/members/services/memberService.ts
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError } from '@/services/sentry'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { parseListSnapshot } from '@/services/parseListSnapshot'
import { subscribeToCollection } from '@/services/realtimeQuery'
import { removeMemberFromTripBookings } from '@/services/memberSync'
import { MemberDocSchema, type Member } from '@/types'

function memberFromDoc(d: QueryDocumentSnapshot): Member {
  return firestoreDocFromSchema(MemberDocSchema, d, 'memberFromDoc')
}

export async function getMembersByTrip(tripId: string, uid: string): Promise<Member[]> {
  const { db, collection, query, where, orderBy, getDocs } = await getFirebase()
  const q = query(
    collection(db, ...P.members(tripId)),
    where('memberIds', 'array-contains', uid),
    orderBy('joinedAt'),
  )
  const snap = await getDocs(q)
  return parseListSnapshot(snap, memberFromDoc)
}

/**
 * Realtime variant — pushes Member[] when someone joins via invite or
 * the owner kicks a member. No LIST_LIMIT: trip member counts are
 * bounded by social reality (~20).
 */
export const subscribeToMembers = (
  tripId: string,
  uid:    string,
  onData: (data: Member[]) => void,
  onError: (e: Error) => void,
) => subscribeToCollection<Member>({
  buildQuery: ({ db, collection, query, where, orderBy }) => query(
    collection(db, ...P.members(tripId)),
    where('memberIds', 'array-contains', uid),
    orderBy('joinedAt'),
  ),
  fromDoc: memberFromDoc,
  source:  'subscribeToMembers',
}, onData, onError)

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
