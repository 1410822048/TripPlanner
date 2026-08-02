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
const ROUTE_CONSTRAINT_FIELDS = ['date', 'location', 'durationMinutes', 'startTime', 'timeMode'] as const

export function invalidatesRouteOptimization(updates: UpdateScheduleInput): boolean {
  return ROUTE_CONSTRAINT_FIELDS.some(field => field in updates)
}

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

/**
 * Does `stored` already reflect this update? The optimistic overlay drops
 * an op once server truth agrees, so this has to mirror `updateSchedule`
 * exactly: cleared optional fields land as absent rather than empty,
 * `location` compares by value, and a route-invalidating edit also nulls
 * the optimization columns. Keeping it beside the write is the point —
 * split them and the overlay silently waits for a value that never comes.
 */
export function scheduleUpdateApplied(stored: Schedule, updates: UpdateScheduleInput): boolean {
  for (const [field, value] of Object.entries(updates)) {
    if (field === 'location') {
      if (!sameLocation(stored.location, value as CreateScheduleInput['location'])) return false
      continue
    }
    const current = stored[field as keyof Schedule]
    if (value === undefined ? current !== undefined : current !== value) return false
  }
  return !invalidatesRouteOptimization(updates) || stored.routeRevision === null
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
export const getSchedulesByTripFromServer = listServices.fetchFromServer
export const subscribeToSchedules = listServices.subscribe

// ─── Write ────────────────────────────────────────────────────────
/** `scheduleId` is minted by the caller so the optimistic row and the
 *  stored doc share one id from the start. */
export async function createSchedule(
  tripId: string,
  input: CreateScheduleInput,
  createdBy: string,
  order: number,
  scheduleId: string,
): Promise<string> {
  const [{ db, doc, setDoc, serverTimestamp }, memberIds] = await Promise.all([
    getFirebase(),
    getTripMemberIds(tripId),
  ])
  const ref = doc(db, ...P.schedule(tripId, scheduleId))
  await setDoc(ref, {
    ...input,
    routeRevision: null,
    travelToNext: null,
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
  const clearsOptimization = invalidatesRouteOptimization(validated)
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
    ...(clearsOptimization ? { routeRevision: null, travelToNext: null } : {}),
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
