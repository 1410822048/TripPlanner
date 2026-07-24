// src/features/schedule/services/scheduleService.ts
// Read pair (get + subscribe) is factoried via createTripScopedListServices;
// only the write side is hand-written because each entity has too much
// per-collection variation to share.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { createTripScopedListServices } from '@/services/tripScopedList'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { validateUpdateOrThrow } from '@/services/validateUpdate'
import { auditCreate, auditUpdate } from '@/utils/audit'
import { getTripMemberIds } from '@/services/tripMemberIds'
import { bumpTripActivity } from '@/services/tripActivity'
import { ScheduleDocSchema, UpdateScheduleSchema, type Schedule, type CreateScheduleInput, type UpdateScheduleInput } from '@/types/schedule'

/** Defensive cap — schedules can run higher per trip (multi-day with
 *  multiple stops per day) so 200 vs bookings' 100. */
const LIST_LIMIT = 200

function scheduleFromDoc(d: QueryDocumentSnapshot): Schedule {
  return firestoreDocFromSchema(ScheduleDocSchema, d, 'scheduleFromDoc') as Schedule
}

function sameLocation(left: Schedule['location'], right: CreateScheduleInput['location']): boolean {
  if (left === right) return true
  if (!left || !right || left.status !== right.status) return false
  if (left.status === 'unresolved' && right.status === 'unresolved') {
    return left.query === right.query
  }
  if (left.status !== 'resolved' || right.status !== 'resolved') return false
  const a = left.place
  const b = right.place
  return a.provider === b.provider
    && a.providerPlaceId === b.providerPlaceId
    && a.name === b.name
    && a.address === b.address
    && a.lat === b.lat
    && a.lng === b.lng
    && a.timeZone === b.timeZone
    && a.countryCode === b.countryCode
}

/** Build the smallest Firestore patch from the form snapshot. Explicit
 * `undefined` values mean "delete this optional field" and are materialized
 * as deleteField() at the service boundary. */
export function buildScheduleUpdate(current: Schedule, next: CreateScheduleInput): UpdateScheduleInput {
  const patch: UpdateScheduleInput = {}
  if (current.title !== next.title) patch.title = next.title
  if (current.date !== next.date) patch.date = next.date
  if (current.startTime !== next.startTime) patch.startTime = next.startTime
  if (current.timeMode !== next.timeMode) patch.timeMode = next.timeMode
  if (current.durationMinutes !== next.durationMinutes) patch.durationMinutes = next.durationMinutes
  if (current.category !== next.category) patch.category = next.category
  if (current.description !== next.description) patch.description = next.description
  if (current.estimatedCostMinor !== next.estimatedCostMinor) patch.estimatedCostMinor = next.estimatedCostMinor
  if (!sameLocation(current.location, next.location)) patch.location = next.location
  return patch
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
    routeRevision: null,
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
  const constraintFields = ['date', 'location', 'durationMinutes', 'startTime', 'timeMode'] as const
  const clearsOptimization = constraintFields.some(field => field in validated)
  if ('routeRevision' in validated && validated.routeRevision != null) {
    throw new Error('routeRevision is Worker-owned')
  }
  const { db, doc, updateDoc, deleteField, serverTimestamp } = await getFirebase()
  const writePatch: Record<string, unknown> = { ...validated }
  const clearableFields = ['description', 'estimatedCostMinor', 'location', 'startTime'] as const
  for (const field of clearableFields) {
    if (field in validated && validated[field] === undefined) {
      writePatch[field] = deleteField()
    }
  }
  await updateDoc(doc(db, ...P.schedule(tripId, scheduleId)), {
    ...writePatch,
    ...(clearsOptimization ? { routeRevision: null } : {}),
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
