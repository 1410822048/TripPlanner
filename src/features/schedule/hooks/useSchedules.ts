// src/features/schedule/hooks/useSchedules.ts
// Realtime-backed: initial getDocs primes the cache, onSnapshot pushes
// subsequent changes (other members adding / editing schedules) live.
// Mutations remain optimistic for instant local feedback.
import {
  getSchedulesByTrip,
  getSchedulesByTripFromServer,
  subscribeToSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  invalidatesRouteOptimization,
  scheduleUpdateApplied,
} from '../services/scheduleService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { createListOverlay } from '@/hooks/listOverlay'
import { useTripListMutation } from '@/hooks/useTripListMutation'
import { auditCreateMock } from '@/utils/audit'
import type { CreateScheduleInput, Schedule } from '@/types'
import { MUTATION_ACTION, type MutationOptions } from '@/services/queryClient'

const scheduleKeys = {
  all: (tripId: string, uid?: string) => ['schedules', tripId, uid ?? ''] as const,
}

export const scheduleOverlay = createListOverlay<Schedule>({
  // The list is ordered by (date, order), so a new row is placed by its
  // fields rather than by where the overlay puts it.
  insert: 'tail',
  source: 'schedules',
})

export const useSchedules = createRealtimeListHook<Schedule>({
  queryKeyFactory: scheduleKeys.all,
  initialFetch:    (tripId, uid) => getSchedulesByTrip(tripId, uid),
  subscribe:       (tripId, uid, onData, onError) => subscribeToSchedules(tripId, uid, onData, onError),
  source:          'useSchedules',
  requiresUid:     true,
  overlay:         scheduleOverlay,
})

/**
 * Next per-day `order` = max(order in same date) + 1.
 *
 * Call this once, at the call site, and pass the result in: it must be
 * computed from the list the user is actually looking at, which already
 * includes pending optimistic rows. The previous version computed it twice
 * — once for the optimistic row and once inside the mutation — and because
 * `onMutate` is awaited before `mutationFn`, the second read saw the first
 * row and persisted `order + 1`, leaving a gap on every create.
 *
 * Concurrent creates by two users still race; gaps from delete are
 * harmless since only the relative order matters.
 */
export function nextScheduleOrder(schedules: Schedule[], date: string): number {
  return schedules.filter(s => s.date === date)
    .reduce((m, s) => Math.max(m, s.order), -1) + 1
}

const serverRead = (tripId: string, uid: string | undefined) =>
  () => getSchedulesByTripFromServer(tripId, uid ?? '')

export function useCreateSchedule(tripId: string, options?: MutationOptions) {
  return useTripListMutation<Schedule, {
    scheduleId: string
    input:      CreateScheduleInput
    createdBy:  string
    order:      number
  }>({
    tripId,
    keyFactory: scheduleKeys.all,
    mutate:     ({ scheduleId, input, createdBy, order }) =>
      createSchedule(tripId, input, createdBy, order, scheduleId),
    overlay: {
      controller: scheduleOverlay,
      op: ({ scheduleId, input, createdBy, order }, { uid }) => ({
        kind: 'create',
        row: {
          id: scheduleId, tripId, order, memberIds: [createdBy], ...input,
          routeRevision: null, travelToNext: null, ...auditCreateMock(createdBy),
        } as Schedule,
        confirms: base => base.some(s => s.id === scheduleId),
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
    action:     MUTATION_ACTION.CREATE_SCHEDULE,
    silent:     options?.silent,
  })
}

export function useUpdateSchedule(tripId: string, options?: MutationOptions) {
  return useTripListMutation<Schedule, {
    scheduleId: string
    updates:    Partial<CreateScheduleInput>
    uid:        string
  }>({
    tripId,
    keyFactory: scheduleKeys.all,
    mutate:     ({ scheduleId, updates, uid }) => updateSchedule(tripId, scheduleId, updates, { uid }),
    overlay: {
      controller: scheduleOverlay,
      op: ({ scheduleId, updates }, { uid }) => ({
        kind: 'patch',
        id:   scheduleId,
        // No audit fields: their server values are unknowable client-side,
        // so applying them would leave the op permanently unconfirmable.
        apply: row => ({
          ...row,
          ...updates,
          ...(invalidatesRouteOptimization(updates)
            ? { routeRevision: null, travelToNext: null }
            : {}),
        }),
        // The service owns what the stored row ends up looking like —
        // cleared fields become absent, location compares by value.
        confirms: base => {
          const stored = base.find(s => s.id === scheduleId)
          return !!stored && scheduleUpdateApplied(stored, updates)
        },
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
    action:     MUTATION_ACTION.UPDATE,
    silent:     options?.silent,
  })
}

export function useDeleteSchedule(tripId: string) {
  return useTripListMutation<Schedule, string>({
    tripId,
    keyFactory: scheduleKeys.all,
    mutate:     (scheduleId, { uid }) => deleteSchedule(tripId, scheduleId, uid),
    overlay: {
      controller: scheduleOverlay,
      // Variables here are the bare id, not an object.
      op: (scheduleId, { uid }) => ({
        kind: 'remove',
        id:   scheduleId,
        confirms: base => !base.some(s => s.id === scheduleId),
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
    action:     MUTATION_ACTION.DELETE,
  })
}
