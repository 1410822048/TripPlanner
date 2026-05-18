// src/features/schedule/hooks/useSchedules.ts
// useSchedules is realtime-backed: the initial getDocs populates the
// cache, then a Firestore onSnapshot listener pushes subsequent changes
// (other members adding / editing schedules) into the cache live.
//
// Mutations remain optimistic for instant local feedback. The listener
// delivers the authoritative server state shortly after the write
// commits, reconciling whatever the optimistic patch did. Rollback
// path on failure is unchanged.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getSchedulesByTrip,
  subscribeToSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
} from '../services/scheduleService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { useUid } from '@/hooks/useAuth'
import { tempId } from '@/utils/tempId'
import { patchListCache, rollbackListCache } from '@/utils/queryCache'
import { auditCreateMock, auditUpdateMock } from '@/utils/audit'
import type { CreateScheduleInput, Schedule } from '@/types'
import type { MutationMeta, MutationOptions } from '@/services/queryClient'

export const scheduleKeys = {
  all: (tripId: string, uid?: string) => ['schedules', tripId, uid ?? ''] as const,
}

export const useSchedules = createRealtimeListHook<Schedule>({
  queryKeyFactory: scheduleKeys.all,
  initialFetch:    (tripId, uid) => getSchedulesByTrip(tripId, uid!),
  subscribe:       (tripId, uid, onData, onError) => subscribeToSchedules(tripId, uid!, onData, onError),
  source:          'useSchedules',
  requiresUid:     true,
})

export function useCreateSchedule(tripId: string, options?: MutationOptions) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = scheduleKeys.all(tripId, uid)
  // Next order = max+1 within the same day, computed from the React Query cache
  // so we avoid an extra Firestore query per create. Delete-gaps are safe (max+1
  // skips the gap). Concurrent creates by two users still race — acceptable for v1.
  const nextOrderForDate = (date: string): number => {
    const cached = qc.getQueryData<Schedule[]>(key) ?? []
    return cached.filter(s => s.date === date)
      .reduce((m, s) => Math.max(m, s.order), -1) + 1
  }
  return useMutation({
    mutationFn: ({ input, userId }: { input: CreateScheduleInput; userId: string }) =>
      createSchedule(tripId, input, userId, nextOrderForDate(input.date)),
    meta: { action: '行程の追加', silent: options?.silent } satisfies MutationMeta,
    onMutate: ({ input, userId }) =>
      patchListCache<Schedule>(qc, key, prev => {
        const sameDay = prev.filter(s => s.date === input.date)
        const nextOrder = sameDay.reduce((m, s) => Math.max(m, s.order), -1) + 1
        const optimistic: Schedule = {
          id:    tempId(),
          tripId,
          order: nextOrder,
          memberIds: [userId],
          ...auditCreateMock(userId),
          ...input,
        }
        return [...prev, optimistic]
      }),
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Schedule>(qc, key, ctx)
    },
  })
}

export function useUpdateSchedule(tripId: string, options?: MutationOptions) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = scheduleKeys.all(tripId, uid)
  return useMutation({
    mutationFn: ({ scheduleId, updates, uid }: { scheduleId: string; updates: Partial<CreateScheduleInput>; uid: string }) =>
      updateSchedule(tripId, scheduleId, updates, { uid }),
    meta: { action: '更新', silent: options?.silent } satisfies MutationMeta,
    onMutate: ({ scheduleId, updates, uid }) =>
      patchListCache<Schedule>(qc, key, prev =>
        prev.map(s => s.id === scheduleId ? { ...s, ...updates, ...auditUpdateMock(uid) } : s),
      ),
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Schedule>(qc, key, ctx)
    },
  })
}

export function useDeleteSchedule(tripId: string) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = scheduleKeys.all(tripId, uid)
  return useMutation({
    mutationFn: (scheduleId: string) => deleteSchedule(tripId, scheduleId, uid!),
    meta: { action: '削除' } satisfies MutationMeta,
    onMutate: scheduleId =>
      patchListCache<Schedule>(qc, key, prev => prev.filter(s => s.id !== scheduleId)),
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Schedule>(qc, key, ctx)
    },
  })
}
