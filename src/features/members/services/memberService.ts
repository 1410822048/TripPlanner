// src/features/members/services/memberService.ts
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { parseListSnapshot } from '@/services/parseListSnapshot'
import { subscribeToCollection } from '@/services/realtimeQuery'
import { requireWorkerWriteBase, preflightIdToken, workerFetch } from '@/services/workerBase'
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
 * Remove a member through the Worker. The Worker owns owner authz,
 * self/owner guards, trip.memberIds strip, subcollection ACL cleanup,
 * and final member doc delete as one convergent flow.
 */
export async function removeMember(tripId: string, memberId: string): Promise<void> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()
  await workerFetch(workerBase, idToken, '/member-remove', {
    tripId,
    memberUid: memberId,
  })
}

/**
 * Update a member's role through the Worker. Only editor/viewer transitions
 * are allowed; ownership transfer remains intentionally out of scope.
 */
export async function updateMemberRole(
  tripId: string,
  memberId: string,
  role: 'editor' | 'viewer',
): Promise<void> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()
  await workerFetch(workerBase, idToken, '/member-role-update', {
    tripId,
    memberUid: memberId,
    role,
  })
}
