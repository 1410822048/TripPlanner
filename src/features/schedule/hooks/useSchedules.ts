// src/features/schedule/hooks/useSchedules.ts
// Realtime-backed: initial getDocs primes the cache, onSnapshot pushes
// subsequent changes (other members adding / editing schedules) live.
// Mutations remain optimistic for instant local feedback.
import {
  getSchedulesByTrip,
  subscribeToSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
} from '../services/scheduleService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { useTripListMutation } from '@/hooks/useTripListMutation'
import { tempId } from '@/utils/tempId'
import { auditCreateMock, auditUpdateMock } from '@/utils/audit'
import type { CreateScheduleInput, Schedule } from '@/types'
import { MUTATION_ACTION, type MutationOptions } from '@/services/queryClient'

const scheduleKeys = {
  all: (tripId: string, uid?: string) => ['schedules', tripId, uid ?? ''] as const,
}

export const useSchedules = createRealtimeListHook<Schedule>({
  queryKeyFactory: scheduleKeys.all,
  initialFetch:    (tripId, uid) => getSchedulesByTrip(tripId, uid),
  subscribe:       (tripId, uid, onData, onError) => subscribeToSchedules(tripId, uid, onData, onError),
  source:          'useSchedules',
  requiresUid:     true,
})

/** Next per-day `order` = max(snapshot.order in same date) + 1. Concurrent
 *  creates by two users still race — acceptable for v1; gaps from delete
 *  are harmless. */
function nextOrderInDay(snapshot: Schedule[], date: string): number {
  return snapshot.filter(s => s.date === date)
    .reduce((m, s) => Math.max(m, s.order), -1) + 1
}

export function useCreateSchedule(tripId: string, options?: MutationOptions) {
  return useTripListMutation<Schedule, { input: CreateScheduleInput; createdBy: string }>({
    tripId,
    keyFactory: scheduleKeys.all,
    mutate:     ({ input, createdBy }, { snapshot }) =>
      createSchedule(tripId, input, createdBy, nextOrderInDay(snapshot, input.date)),
    patch:      (prev, { input, createdBy }) => [
      ...prev,
      {
        id:        tempId(),
        tripId,
        order:     nextOrderInDay(prev, input.date),
        memberIds: [createdBy],
        ...auditCreateMock(createdBy),
        ...input,
      },
    ],
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
    patch:      (prev, { scheduleId, updates, uid }) =>
      prev.map(s => s.id === scheduleId ? { ...s, ...updates, ...auditUpdateMock(uid) } : s),
    action:     MUTATION_ACTION.UPDATE,
    silent:     options?.silent,
  })
}

export function useDeleteSchedule(tripId: string) {
  return useTripListMutation<Schedule, string>({
    tripId,
    keyFactory: scheduleKeys.all,
    mutate:     (scheduleId, { uid }) => deleteSchedule(tripId, scheduleId, uid),
    patch:      (prev, scheduleId) => prev.filter(s => s.id !== scheduleId),
    action:     MUTATION_ACTION.DELETE,
  })
}
