// src/features/planning/hooks/usePlanning.ts
// Same optimistic-update pattern as useBookings / useWishes. The
// toggleDone mutation is split out so the checkbox tap latency is as
// low as possible (no full-doc patch shape).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getPlanItemsByTrip,
  createPlanItem,
  updatePlanItem,
  togglePlanItemDone,
  deletePlanItem,
} from '../services/planningService'
import type { CreatePlanItemInput, PlanItem } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { toast } from '@/shared/toast'

export const planningKeys = {
  all: (tripId: string) => ['planning', tripId] as const,
}

function tempId() { return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }

function patchCache(
  qc: ReturnType<typeof useQueryClient>,
  tripId: string,
  fn: (prev: PlanItem[]) => PlanItem[],
): { prev: PlanItem[] | undefined } {
  const key  = planningKeys.all(tripId)
  const prev = qc.getQueryData<PlanItem[]>(key)
  qc.setQueryData<PlanItem[]>(key, fn(prev ?? []))
  return { prev }
}

export function usePlanning(tripId: string | undefined) {
  return useQuery({
    queryKey: planningKeys.all(tripId ?? ''),
    queryFn:  () => getPlanItemsByTrip(tripId!),
    enabled:  !!tripId,
  })
}

export function useCreatePlanItem(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ input, createdBy }: { input: CreatePlanItemInput; createdBy: string }) =>
      createPlanItem(tripId, input, createdBy),
    onMutate: ({ input, createdBy }) =>
      patchCache(qc, tripId, prev => {
        const optimistic: PlanItem = {
          id: tempId(),
          tripId,
          ...input,
          done: false,
          createdBy,
          createdAt: MOCK_TIMESTAMP,
          updatedAt: MOCK_TIMESTAMP,
        }
        return [optimistic, ...prev]
      }),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(planningKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `追加に失敗：${err.message}` : '追加に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: planningKeys.all(tripId) }),
  })
}

export function useUpdatePlanItem(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ itemId, updates }: { itemId: string; updates: Partial<CreatePlanItemInput> }) =>
      updatePlanItem(tripId, itemId, updates),
    onMutate: ({ itemId, updates }) =>
      patchCache(qc, tripId, prev =>
        prev.map(p => p.id === itemId ? { ...p, ...updates, updatedAt: MOCK_TIMESTAMP } : p),
      ),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(planningKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `更新に失敗：${err.message}` : '更新に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: planningKeys.all(tripId) }),
  })
}

/**
 * Toggle done. Optimistic so the checkbox flips immediately. We don't
 * invalidate on settle for the speed-critical happy path; on error we
 * roll back the optimistic patch.
 */
export function useTogglePlanItem(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ itemId, uid, done }: { itemId: string; uid: string; done: boolean }) =>
      togglePlanItemDone(tripId, itemId, uid, done),
    onMutate: ({ itemId, uid, done }) =>
      patchCache(qc, tripId, prev =>
        prev.map(p => p.id === itemId
          ? {
              ...p,
              done,
              doneBy: done ? uid           : undefined,
              doneAt: done ? MOCK_TIMESTAMP : undefined,
            }
          : p,
        ),
      ),
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(planningKeys.all(tripId), ctx.prev)
      toast.error('更新に失敗しました')
    },
    // No onSettled invalidate: the optimistic patch is exact (toggling
    // is idempotent + per-doc). Skipping the refetch keeps the UI snappy.
  })
}

export function useDeletePlanItem(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (itemId: string) => deletePlanItem(tripId, itemId),
    onMutate: (itemId) =>
      patchCache(qc, tripId, prev => prev.filter(p => p.id !== itemId)),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(planningKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `削除に失敗：${err.message}` : '削除に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: planningKeys.all(tripId) }),
  })
}
