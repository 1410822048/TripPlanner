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
import { stripEmpty } from '@/utils/stripEmpty'
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

export async function getPlanItemsByTrip(tripId: string): Promise<PlanItem[]> {
  const { db, collection, query, orderBy, limit, getDocs } = await getFirebase()
  const snap = await getDocs(query(
    collection(db, ...P.planning(tripId)),
    orderBy('createdAt', 'desc'),
    limit(LIST_LIMIT),
  ))
  if (snap.size >= LIST_LIMIT) {
    captureError(new Error(`getPlanItemsByTrip truncated at ${LIST_LIMIT}`), { tripId })
  }
  return snap.docs.map(planItemFromDoc)
}

// ─── Write ────────────────────────────────────────────────────────

export async function createPlanItem(
  tripId: string,
  input: CreatePlanItemInput,
  createdBy: string,
): Promise<string> {
  const { db, collection, addDoc, serverTimestamp } = await getFirebase()
  const ref = await addDoc(collection(db, ...P.planning(tripId)), {
    ...stripEmpty(input),
    tripId,
    done: false,
    createdBy,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return ref.id
}

export async function updatePlanItem(
  tripId: string,
  itemId: string,
  updates: UpdatePlanItemInput,
): Promise<void> {
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
    updatedAt: serverTimestamp(),
  }
  // Erase optional fields the user cleared in the form.
  if ('note' in validated && (validated.note === undefined || validated.note === '')) {
    patch.note = deleteField()
  }
  await updateDoc(doc(db, ...P.planItem(tripId, itemId)), patch)
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
        done:      true,
        doneBy:    uid,
        doneAt:    serverTimestamp(),
        updatedAt: serverTimestamp(),
      }
    : {
        done:      false,
        doneBy:    deleteField(),
        doneAt:    deleteField(),
        updatedAt: serverTimestamp(),
      })
}

export async function deletePlanItem(tripId: string, itemId: string): Promise<void> {
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.planItem(tripId, itemId)))
}

