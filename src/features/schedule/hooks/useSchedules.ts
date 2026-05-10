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
import { tempId } from '@/utils/tempId'
import { patchListCache, rollbackListCache } from '@/utils/queryCache'
import type { CreateScheduleInput, Schedule } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { toast } from '@/shared/toast'

export const scheduleKeys = {
  all: (tripId: string) => ['schedules', tripId] as const,
}

export const useSchedules = createRealtimeListHook<Schedule>({
  queryKeyFactory: scheduleKeys.all,
  initialFetch:    getSchedulesByTrip,
  subscribe:       subscribeToSchedules,
  source:          'useSchedules',
})

export function useCreateSchedule(tripId: string) {
  const qc = useQueryClient()
  const key = scheduleKeys.all(tripId)
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
    onMutate: ({ input, userId }) =>
      patchListCache<Schedule>(qc, key, prev => {
        const sameDay = prev.filter(s => s.date === input.date)
        const nextOrder = sameDay.reduce((m, s) => Math.max(m, s.order), -1) + 1
        const optimistic: Schedule = {
          id:        tempId(),
          tripId,
          order:     nextOrder,
          createdBy: userId,
          createdAt: MOCK_TIMESTAMP,
          updatedAt: MOCK_TIMESTAMP,
          ...input,
        }
        return [...prev, optimistic]
      }),
    onError: (err, _vars, ctx) => {
      rollbackListCache<Schedule>(qc, key, ctx)
      toast.mutationError(err, '行程の追加')
    },
  })
}

export function useUpdateSchedule(tripId: string) {
  const qc = useQueryClient()
  const key = scheduleKeys.all(tripId)
  return useMutation({
    mutationFn: ({ scheduleId, updates }: { scheduleId: string; updates: Partial<CreateScheduleInput> }) =>
      updateSchedule(tripId, scheduleId, updates),
    onMutate: ({ scheduleId, updates }) =>
      patchListCache<Schedule>(qc, key, prev =>
        prev.map(s => s.id === scheduleId ? { ...s, ...updates, updatedAt: MOCK_TIMESTAMP } : s),
      ),
    onError: (err, _vars, ctx) => {
      rollbackListCache<Schedule>(qc, key, ctx)
      toast.mutationError(err, '更新')
    },
  })
}

export function useDeleteSchedule(tripId: string) {
  const qc = useQueryClient()
  const key = scheduleKeys.all(tripId)
  return useMutation({
    mutationFn: (scheduleId: string) => deleteSchedule(tripId, scheduleId),
    onMutate: scheduleId =>
      patchListCache<Schedule>(qc, key, prev => prev.filter(s => s.id !== scheduleId)),
    onError: (err, _vars, ctx) => {
      rollbackListCache<Schedule>(qc, key, ctx)
      toast.mutationError(err, '削除')
    },
  })
}
