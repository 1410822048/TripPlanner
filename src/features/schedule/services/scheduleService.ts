// src/features/schedule/services/scheduleService.ts
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { captureError } from '@/services/sentry'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { parseListSnapshot } from '@/services/parseListSnapshot'
import { subscribeToCollection } from '@/services/realtimeQuery'
import { auditCreate, auditUpdate } from '@/utils/audit'
import { getTripMemberIds } from '@/services/tripMemberIds'
import { bumpTripActivity } from '@/services/tripActivity'
import { ScheduleDocSchema, UpdateScheduleSchema, type Schedule, type CreateScheduleInput, type UpdateScheduleInput } from '@/types'

/** Defensive cap — see bookingService for rationale. Schedules can run
 *  higher per trip (multi-day with multiple stops per day) so 200. */
const LIST_LIMIT = 200

/** 驗證一份 Firestore doc 是否符合 Schedule schema；失敗時丟出錯誤以利觀測 */
function scheduleFromDoc(d: QueryDocumentSnapshot): Schedule {
  return firestoreDocFromSchema(ScheduleDocSchema, d, 'scheduleFromDoc')
}

// ─── Read ─────────────────────────────────────────────────────────
// uid is required: list queries must `where('memberIds', 'array-contains',
// uid)` to align with the same-doc list rule (`allow list: if uid in
// resource.data.memberIds`). Firestore validates rule-query alignment at
// query time, so the filter is mandatory — even for an owner whose docs
// all already contain their uid.
export async function getSchedulesByTrip(tripId: string, uid: string): Promise<Schedule[]> {
  const { db, collection, query, where, orderBy, limit, getDocs } = await getFirebase()
  const q = query(
    collection(db, ...P.schedules(tripId)),
    where('memberIds', 'array-contains', uid),
    orderBy('date'),
    orderBy('order'),
    limit(LIST_LIMIT),
  )
  const snap = await getDocs(q)
  if (snap.size >= LIST_LIMIT) {
    captureError(new Error(`getSchedulesByTrip truncated at ${LIST_LIMIT}`), { tripId })
  }
  return parseListSnapshot(snap, scheduleFromDoc)
}

/**
 * Realtime variant of getSchedulesByTrip — onSnapshot listener pushing
 * Schedule[] shaped identically to the one-shot fetcher above.
 */
export const subscribeToSchedules = (
  tripId: string,
  uid:    string,
  onData: (data: Schedule[]) => void,
  onError: (e: Error) => void,
) => subscribeToCollection<Schedule>({
  buildQuery: ({ db, collection, query, where, orderBy, limit }) => query(
    collection(db, ...P.schedules(tripId)),
    where('memberIds', 'array-contains', uid),
    orderBy('date'),
    orderBy('order'),
    limit(LIST_LIMIT),
  ),
  fromDoc: scheduleFromDoc,
  source:  'subscribeToSchedules',
  limit:   LIST_LIMIT,
}, onData, onError)

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
  // Defense-in-depth: see updateExpense for rationale.
  const parsed = UpdateScheduleSchema.safeParse(updates)
  if (!parsed.success) {
    captureError(parsed.error, { source: 'updateSchedule', tripId, scheduleId })
    throw new Error('Update payload failed validation')
  }
  const { db, doc, updateDoc, serverTimestamp } = await getFirebase()
  await updateDoc(doc(db, ...P.schedule(tripId, scheduleId)), {
    ...parsed.data,
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
