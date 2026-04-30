// src/features/schedule/services/scheduleService.ts
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError } from '@/services/sentry'
import { ScheduleDocSchema, UpdateScheduleSchema, type Schedule, type CreateScheduleInput, type UpdateScheduleInput } from '@/types'

/** Defensive cap — see bookingService for rationale. Schedules can run
 *  higher per trip (multi-day with multiple stops per day) so 200. */
const LIST_LIMIT = 200

/** 驗證一份 Firestore doc 是否符合 Schedule schema；失敗時丟出錯誤以利觀測 */
function scheduleFromDoc(d: QueryDocumentSnapshot): Schedule {
  const parsed = ScheduleDocSchema.safeParse(d.data())
  if (!parsed.success) {
    captureError(parsed.error, { source: 'scheduleFromDoc', docId: d.id })
    throw new Error(`Schedule ${d.id} failed schema validation`)
  }
  return { id: d.id, ...parsed.data }
}

// ─── Read ─────────────────────────────────────────────────────────
export async function getSchedulesByTrip(tripId: string): Promise<Schedule[]> {
  const { db, collection, query, orderBy, limit, getDocs } = await getFirebase()
  const q = query(
    collection(db, ...P.schedules(tripId)),
    orderBy('date'),
    orderBy('order'),
    limit(LIST_LIMIT),
  )
  const snap = await getDocs(q)
  if (snap.size >= LIST_LIMIT) {
    captureError(new Error(`getSchedulesByTrip truncated at ${LIST_LIMIT}`), { tripId })
  }
  return snap.docs.map(scheduleFromDoc)
}

// ─── Write ────────────────────────────────────────────────────────
export async function createSchedule(
  tripId: string,
  input: CreateScheduleInput,
  createdBy: string,
  order: number,
): Promise<string> {
  const { db, collection, addDoc, serverTimestamp } = await getFirebase()
  const ref = await addDoc(collection(db, ...P.schedules(tripId)), {
    ...input,
    tripId,
    order,
    createdBy,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return ref.id
}

export async function updateSchedule(
  tripId: string,
  scheduleId: string,
  updates: UpdateScheduleInput,
): Promise<void> {
  // Defense-in-depth: see updateExpense for rationale.
  const parsed = UpdateScheduleSchema.safeParse(updates)
  if (!parsed.success) {
    captureError(parsed.error, { source: 'updateSchedule', tripId, scheduleId })
    throw new Error('Update payload failed validation')
  }
  const { db, doc, updateDoc, serverTimestamp } = await getFirebase()
  await updateDoc(doc(db, ...P.schedule(tripId, scheduleId)), { ...parsed.data, updatedAt: serverTimestamp() })
}

export async function deleteSchedule(
  tripId: string,
  scheduleId: string,
): Promise<void> {
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.schedule(tripId, scheduleId)))
}
