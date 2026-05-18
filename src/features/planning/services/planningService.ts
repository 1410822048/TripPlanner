// src/features/planning/services/planningService.ts
// Pre-trip planning checklist — collaborative to-do list grouped by
// category. Any member can add / edit / toggle / delete (the list is
// inherently shared; gating it would just slow group prep). Sorted by
// createdAt so newer items appear at the top of their section.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError } from '@/services/sentry'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { parseListSnapshot } from '@/services/parseListSnapshot'
import { subscribeToCollection } from '@/services/realtimeQuery'
import { stripEmpty } from '@/utils/stripEmpty'
import { auditCreate, auditUpdate } from '@/utils/audit'
import { getTripMemberIds } from '@/services/tripMemberIds'
import { bumpTripActivity } from '@/services/tripActivity'
import {
  PlanItemDocSchema,
  UpdatePlanItemSchema,
  type PlanItem,
  type CreatePlanItemInput,
  type UpdatePlanItemInput,
} from '@/types'

const LIST_LIMIT = 200

function planItemFromDoc(d: QueryDocumentSnapshot): PlanItem {
  return firestoreDocFromSchema(PlanItemDocSchema, d, 'planItemFromDoc')
}

// ─── Read ─────────────────────────────────────────────────────────

export async function getPlanItemsByTrip(tripId: string, uid: string): Promise<PlanItem[]> {
  const { db, collection, query, where, orderBy, limit, getDocs } = await getFirebase()
  const snap = await getDocs(query(
    collection(db, ...P.planning(tripId)),
    where('memberIds', 'array-contains', uid),
    orderBy('createdAt', 'desc'),
    limit(LIST_LIMIT),
  ))
  if (snap.size >= LIST_LIMIT) {
    captureError(new Error(`getPlanItemsByTrip truncated at ${LIST_LIMIT}`), { tripId })
  }
  return parseListSnapshot(snap, planItemFromDoc)
}

/** Realtime variant of getPlanItemsByTrip — onSnapshot push of PlanItem[]. */
export const subscribeToPlanItems = (
  tripId: string,
  uid:    string,
  onData: (data: PlanItem[]) => void,
  onError: (e: Error) => void,
) => subscribeToCollection<PlanItem>({
  buildQuery: ({ db, collection, query, where, orderBy, limit }) => query(
    collection(db, ...P.planning(tripId)),
    where('memberIds', 'array-contains', uid),
    orderBy('createdAt', 'desc'),
    limit(LIST_LIMIT),
  ),
  fromDoc: planItemFromDoc,
  source:  'subscribeToPlanItems',
  limit:   LIST_LIMIT,
}, onData, onError)

// ─── Write ────────────────────────────────────────────────────────

export async function createPlanItem(
  tripId: string,
  input: CreatePlanItemInput,
  createdBy: string,
): Promise<string> {
  const [{ db, collection, addDoc, serverTimestamp }, memberIds] = await Promise.all([
    getFirebase(),
    getTripMemberIds(tripId),
  ])
  const ref = await addDoc(collection(db, ...P.planning(tripId)), {
    ...stripEmpty(input),
    tripId,
    done: false,
    memberIds,
    ...auditCreate(createdBy, serverTimestamp()),
  })
  void bumpTripActivity(tripId, 'planning', createdBy)
  return ref.id
}

export async function updatePlanItem(
  tripId: string,
  itemId: string,
  updates: UpdatePlanItemInput,
  options: { uid: string },
): Promise<void> {
  const { uid } = options
  // Defense-in-depth: see updateExpense for rationale.
  const parsed = UpdatePlanItemSchema.safeParse(updates)
  if (!parsed.success) {
    captureError(parsed.error, { source: 'updatePlanItem', tripId, itemId })
    throw new Error('Update payload failed validation')
  }
  const validated = parsed.data
  const { db, doc, updateDoc, deleteField, serverTimestamp } = await getFirebase()
  const patch: Record<string, unknown> = {
    ...stripEmpty(validated),
    ...auditUpdate(uid, serverTimestamp()),
  }
  // Erase optional fields the user cleared in the form.
  if ('note' in validated && (validated.note === undefined || validated.note === '')) {
    patch.note = deleteField()
  }
  await updateDoc(doc(db, ...P.planItem(tripId, itemId)), patch)
  void bumpTripActivity(tripId, 'planning', uid)
}

/**
 * Toggle done state. Stamps doneBy + doneAt for accountability — useful
 * when multiple members are checking different items in parallel.
 * Clearing back to undone wipes those stamps so the row visually
 * "resets" (otherwise users would see ghostly metadata on undone rows).
 */
export async function togglePlanItemDone(
  tripId: string,
  itemId: string,
  uid: string,
  done: boolean,
): Promise<void> {
  const { db, doc, updateDoc, deleteField, serverTimestamp } = await getFirebase()
  await updateDoc(doc(db, ...P.planItem(tripId, itemId)), done
    ? {
        done:   true,
        doneBy: uid,
        doneAt: serverTimestamp(),
        ...auditUpdate(uid, serverTimestamp()),
      }
    : {
        done:   false,
        doneBy: deleteField(),
        doneAt: deleteField(),
        ...auditUpdate(uid, serverTimestamp()),
      })
  void bumpTripActivity(tripId, 'planning', uid)
}

export async function deletePlanItem(tripId: string, itemId: string, uid: string): Promise<void> {
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.planItem(tripId, itemId)))
  void bumpTripActivity(tripId, 'planning', uid)
}

