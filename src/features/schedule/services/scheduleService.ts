// src/features/schedule/services/scheduleService.ts
// Read pair (get + subscribe) is factoried via createTripScopedListServices;
// only the write side is hand-written because each entity has too much
// per-collection variation to share.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { createTripScopedListServices } from '@/services/tripScopedList'
import { validateUpdateOrThrow } from '@/services/validateUpdate'
import { auditCreate, auditUpdate } from '@/utils/audit'
import { getTripMemberIds } from '@/services/tripMemberIds'
import { bumpTripActivity } from '@/services/tripActivity'
import { ScheduleDocSchema, UpdateScheduleSchema, type Schedule, type CreateScheduleInput, type UpdateScheduleInput } from '@/types'

/** Defensive cap — schedules can run higher per trip (multi-day with
 *  multiple stops per day) so 200 vs bookings' 100. */
const LIST_LIMIT = 200

function scheduleFromDoc(d: QueryDocumentSnapshot): Schedule {
  return firestoreDocFromSchema(ScheduleDocSchema, d, 'scheduleFromDoc')
}

// ─── Read ─────────────────────────────────────────────────────────
// uid is required: list queries must `where('memberIds', 'array-contains',
// uid)` to align with the same-doc list rule. The factory enforces this.
const listServices = createTripScopedListServices<Schedule>({
  path:    P.schedules,
  fromDoc: scheduleFromDoc,
  orderBy: [['date'], ['order']],
  limit:   LIST_LIMIT,
  source:  'schedules',
})

export const getSchedulesByTrip = listServices.fetch
export const subscribeToSchedules = listServices.subscribe

// ─── Write ────────────────────────────────────────────────────────
export async function createSchedule(
  tripId: string,
  input: CreateScheduleInput,
  createdBy: string,
  order: number,
): Promise<string> {
  const [{ db, collection, addDoc, serverTimestamp }, memberIds] = await Promise.all([
    getFirebase(),
    getTripMemberIds(tripId),
  ])
  const ref = await addDoc(collection(db, ...P.schedules(tripId)), {
    ...input,
    tripId,
    order,
    memberIds,
    ...auditCreate(createdBy, serverTimestamp()),
  })
  void bumpTripActivity(tripId, 'schedule', createdBy)
  return ref.id
}

export async function updateSchedule(
  tripId: string,
  scheduleId: string,
  updates: UpdateScheduleInput,
  options: { uid: string },
): Promise<void> {
  const { uid } = options
  const validated = validateUpdateOrThrow(UpdateScheduleSchema, updates, {
    source: 'updateSchedule', tripId, scheduleId,
  })
  const { db, doc, updateDoc, serverTimestamp } = await getFirebase()
  await updateDoc(doc(db, ...P.schedule(tripId, scheduleId)), {
    ...validated,
    ...auditUpdate(uid, serverTimestamp()),
  })
  void bumpTripActivity(tripId, 'schedule', uid)
}

export async function deleteSchedule(
  tripId: string,
  scheduleId: string,
  uid: string,
): Promise<void> {
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.schedule(tripId, scheduleId)))
  void bumpTripActivity(tripId, 'schedule', uid)
}
