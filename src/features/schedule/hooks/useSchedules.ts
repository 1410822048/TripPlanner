// src/features/schedule/hooks/useSchedules.ts
// All mutations use optimistic updates: cache is patched in `onMutate`, rolled
// back in `onError` (also surfacing a toast), and reconciled via invalidate
// in `onSettled`. This keeps UI snappy on spotty travel Wi-Fi — the alternative
// (wait for round-trip) freezes the modal for 300-1500ms.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getSchedulesByTrip,
  createSchedule,
  updateSchedule,
  deleteSchedule,
} from '../services/scheduleService'
import type { CreateScheduleInput, Schedule } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { toast } from '@/shared/toast'

export const scheduleKeys = {
  all: (tripId: string) => ['schedules', tripId] as const,
}

function tempId() { return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }

/** Snapshot + write helper; returns rollback context for onError. */
function patchCache(
  qc: ReturnType<typeof useQueryClient>,
  tripId: string,
  fn: (prev: Schedule[]) => Schedule[],
): { prev: Schedule[] | undefined } {
  const key  = scheduleKeys.all(tripId)
  const prev = qc.getQueryData<Schedule[]>(key)
  qc.setQueryData<Schedule[]>(key, fn(prev ?? []))
  return { prev }
}

export function useSchedules(tripId: string | undefined) {
  return useQuery({
    queryKey: scheduleKeys.all(tripId ?? ''),
    queryFn:  () => getSchedulesByTrip(tripId!),
    enabled:  !!tripId,
  })
}

export function useCreateSchedule(tripId: string) {
  const qc = useQueryClient()
  // Next order = max+1 within the same day, computed from the React Query cache
  // so we avoid an extra Firestore query per create. Delete-gaps are safe (max+1
  // skips the gap). Concurrent creates by two users still race — acceptable for v1.
  const nextOrderForDate = (date: string): number => {
    const cached = qc.getQueryData<Schedule[]>(scheduleKeys.all(tripId)) ?? []
    return cached.filter(s => s.date === date)
      .reduce((m, s) => Math.max(m, s.order), -1) + 1
  }
  return useMutation({
    mutationFn: ({ input, userId }: { input: CreateScheduleInput; userId: string }) =>
      createSchedule(tripId, input, userId, nextOrderForDate(input.date)),
    onMutate: ({ input, userId }) => {
      return patchCache(qc, tripId, prev => {
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
      })
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(scheduleKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `行程の追加に失敗：${err.message}` : '行程の追加に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: scheduleKeys.all(tripId) }),
  })
}

export function useUpdateSchedule(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ scheduleId, updates }: { scheduleId: string; updates: Partial<CreateScheduleInput> }) =>
      updateSchedule(tripId, scheduleId, updates),
    onMutate: ({ scheduleId, updates }) =>
      patchCache(qc, tripId, prev =>
        prev.map(s => s.id === scheduleId ? { ...s, ...updates, updatedAt: MOCK_TIMESTAMP } : s),
      ),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(scheduleKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `更新に失敗：${err.message}` : '更新に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: scheduleKeys.all(tripId) }),
  })
}

export function useDeleteSchedule(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (scheduleId: string) => deleteSchedule(tripId, scheduleId),
    onMutate: scheduleId =>
      patchCache(qc, tripId, prev => prev.filter(s => s.id !== scheduleId)),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(scheduleKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `削除に失敗：${err.message}` : '削除に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: scheduleKeys.all(tripId) }),
  })
}
