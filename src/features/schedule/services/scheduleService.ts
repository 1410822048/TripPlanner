// src/features/schedule/services/scheduleService.ts
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { ScheduleDocSchema, type Schedule, type CreateScheduleInput } from '@/types'

/** 驗證一份 Firestore doc 是否符合 Schedule schema；失敗時丟出錯誤以利觀測 */
function scheduleFromDoc(d: QueryDocumentSnapshot): Schedule {
  const parsed = ScheduleDocSchema.safeParse(d.data())
  if (!parsed.success) {
    console.error(`[scheduleService] invalid schedule doc ${d.id}:`, parsed.error.issues)
    throw new Error(`Schedule ${d.id} failed schema validation`)
  }
  return { id: d.id, ...parsed.data }
}

// ─── Read ─────────────────────────────────────────────────────────
export async function getSchedulesByTrip(tripId: string): Promise<Schedule[]> {
  const { db, collection, query, orderBy, getDocs } = await getFirebase()
  const q = query(
    collection(db, ...P.schedules(tripId)),
    orderBy('date'),
    orderBy('order'),
  )
  const snap = await getDocs(q)
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
  updates: Partial<CreateScheduleInput>,
): Promise<void> {
  const { db, doc, updateDoc, serverTimestamp } = await getFirebase()
  await updateDoc(doc(db, ...P.schedule(tripId, scheduleId)), { ...updates, updatedAt: serverTimestamp() })
}

export async function deleteSchedule(
  tripId: string,
  scheduleId: string,
): Promise<void> {
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.schedule(tripId, scheduleId)))
}
