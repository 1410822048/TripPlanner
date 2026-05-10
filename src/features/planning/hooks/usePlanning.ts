// src/features/planning/hooks/usePlanning.ts
// Realtime-backed via createRealtimeListHook — when a co-member ticks
// off "currency exchanged" or adds a packing item, you see it
// immediately. Mutations stay optimistic; the listener handles
// reconciliation (no onSettled invalidate needed).
//
// The toggleDone mutation is split out so the checkbox tap latency is
// as low as possible (no full-doc patch shape).
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getPlanItemsByTrip,
  subscribeToPlanItems,
  createPlanItem,
  updatePlanItem,
  togglePlanItemDone,
  deletePlanItem,
} from '../services/planningService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { tempId } from '@/utils/tempId'
import { patchListCache, rollbackListCache } from '@/utils/queryCache'
import type { CreatePlanItemInput, PlanItem } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { toast } from '@/shared/toast'

export const planningKeys = {
  all: (tripId: string) => ['planning', tripId] as const,
}

export const usePlanning = createRealtimeListHook<PlanItem>({
  queryKeyFactory: planningKeys.all,
  initialFetch:    getPlanItemsByTrip,
  subscribe:       subscribeToPlanItems,
  source:          'usePlanning',
})

export function useCreatePlanItem(tripId: string) {
  const qc = useQueryClient()
  const key = planningKeys.all(tripId)
  return useMutation({
    mutationFn: ({ input, createdBy }: { input: CreatePlanItemInput; createdBy: string }) =>
      createPlanItem(tripId, input, createdBy),
    onMutate: ({ input, createdBy }) =>
      patchListCache<PlanItem>(qc, key, prev => [
        {
          id: tempId(),
          tripId,
          ...input,
          done: false,
          createdBy,
          createdAt: MOCK_TIMESTAMP,
          updatedAt: MOCK_TIMESTAMP,
        },
        ...prev,
      ]),
    onError: (err, _vars, ctx) => {
      rollbackListCache<PlanItem>(qc, key, ctx)
      toast.mutationError(err, '追加')
    },
  })
}

export function useUpdatePlanItem(tripId: string) {
  const qc = useQueryClient()
  const key = planningKeys.all(tripId)
  return useMutation({
    mutationFn: ({ itemId, updates }: { itemId: string; updates: Partial<CreatePlanItemInput> }) =>
      updatePlanItem(tripId, itemId, updates),
    onMutate: ({ itemId, updates }) =>
      patchListCache<PlanItem>(qc, key, prev =>
        prev.map(p => p.id === itemId ? { ...p, ...updates, updatedAt: MOCK_TIMESTAMP } : p),
      ),
    onError: (err, _vars, ctx) => {
      rollbackListCache<PlanItem>(qc, key, ctx)
      toast.mutationError(err, '更新')
    },
  })
}

/**
 * Toggle done. Optimistic so the checkbox flips immediately. The
 * snapshot listener will deliver the server-confirmed state; the
 * optimistic patch is exact (toggling is idempotent + per-doc) so no
 * extra reconciliation needed.
 */
export function useTogglePlanItem(tripId: string) {
  const qc = useQueryClient()
  const key = planningKeys.all(tripId)
  return useMutation({
    mutationFn: ({ itemId, uid, done }: { itemId: string; uid: string; done: boolean }) =>
      togglePlanItemDone(tripId, itemId, uid, done),
    onMutate: ({ itemId, uid, done }) =>
      patchListCache<PlanItem>(qc, key, prev =>
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
      rollbackListCache<PlanItem>(qc, key, ctx)
      toast.error('更新に失敗しました')
    },
  })
}

export function useDeletePlanItem(tripId: string) {
  const qc = useQueryClient()
  const key = planningKeys.all(tripId)
  return useMutation({
    mutationFn: (itemId: string) => deletePlanItem(tripId, itemId),
    onMutate: (itemId) =>
      patchListCache<PlanItem>(qc, key, prev => prev.filter(p => p.id !== itemId)),
    onError: (err, _vars, ctx) => {
      rollbackListCache<PlanItem>(qc, key, ctx)
      toast.mutationError(err, '削除')
    },
  })
}
