// src/features/planning/services/planningService.ts
// Pre-trip planning checklist grouped by category. Item content is edited by
// writers, while every trip member can toggle their own completion state.
// Sorted by createdAt so newer items appear at the top of their section.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { createTripScopedListServices } from '@/services/tripScopedList'
import { validateUpdateOrThrow } from '@/services/validateUpdate'
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
} from '@/types/planning'

const LIST_LIMIT = 200

function planItemFromDoc(d: QueryDocumentSnapshot): PlanItem {
  return firestoreDocFromSchema(PlanItemDocSchema, d, 'planItemFromDoc')
}

// ─── Read ─────────────────────────────────────────────────────────
const listServices = createTripScopedListServices<PlanItem>({
  path:    P.planning,
  fromDoc: planItemFromDoc,
  orderBy: [['createdAt', 'desc']],
  limit:   LIST_LIMIT,
  source:  'planning',
})

export const getPlanItemsByTrip = listServices.fetch
export const subscribeToPlanItems = listServices.subscribe

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
    completedBy: {},
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
  const validated = validateUpdateOrThrow(UpdatePlanItemSchema, updates, {
    source: 'updatePlanItem', tripId, itemId,
  })
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
 * Toggle the caller's own completion state without touching any other
 * member's progress. FieldPath avoids treating a uid as a dotted path.
 */
export async function togglePlanItemDone(
  tripId: string,
  itemId: string,
  uid: string,
  done: boolean,
): Promise<void> {
  const { db, doc, updateDoc, deleteField, serverTimestamp, FieldPath } = await getFirebase()
  await updateDoc(
    doc(db, ...P.planItem(tripId, itemId)),
    new FieldPath('completedBy', uid),
    done ? serverTimestamp() : deleteField(),
    'updatedBy',
    uid,
    'updatedAt',
    serverTimestamp(),
  )
  void bumpTripActivity(tripId, 'planning', uid)
}

export async function deletePlanItem(tripId: string, itemId: string, uid: string): Promise<void> {
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.planItem(tripId, itemId)))
  void bumpTripActivity(tripId, 'planning', uid)
}
