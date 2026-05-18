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
import { useUid } from '@/hooks/useAuth'
import { tempId } from '@/utils/tempId'
import { patchListCache, rollbackListCache } from '@/utils/queryCache'
import { auditCreateMock, auditUpdateMock } from '@/utils/audit'
import type { CreatePlanItemInput, PlanItem } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import type { MutationMeta, MutationOptions } from '@/services/queryClient'

export const planningKeys = {
  all: (tripId: string, uid?: string) => ['planning', tripId, uid ?? ''] as const,
}

export const usePlanning = createRealtimeListHook<PlanItem>({
  queryKeyFactory: planningKeys.all,
  initialFetch:    (tripId, uid) => getPlanItemsByTrip(tripId, uid!),
  subscribe:       (tripId, uid, onData, onError) => subscribeToPlanItems(tripId, uid!, onData, onError),
  source:          'usePlanning',
  requiresUid:     true,
})

export function useCreatePlanItem(tripId: string, options?: MutationOptions) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = planningKeys.all(tripId, uid)
  return useMutation({
    mutationFn: ({ input, createdBy }: { input: CreatePlanItemInput; createdBy: string }) =>
      createPlanItem(tripId, input, createdBy),
    meta: { action: '追加', silent: options?.silent } satisfies MutationMeta,
    onMutate: ({ input, createdBy }) =>
      patchListCache<PlanItem>(qc, key, prev => [
        { id: tempId(), tripId, memberIds: [createdBy], ...input, done: false, ...auditCreateMock(createdBy) },
        ...prev,
      ]),
    onError: (_err, _vars, ctx) => {
      rollbackListCache<PlanItem>(qc, key, ctx)
    },
  })
}

export function useUpdatePlanItem(tripId: string, options?: MutationOptions) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = planningKeys.all(tripId, uid)
  return useMutation({
    mutationFn: ({ itemId, updates, uid }: { itemId: string; updates: Partial<CreatePlanItemInput>; uid: string }) =>
      updatePlanItem(tripId, itemId, updates, { uid }),
    meta: { action: '更新', silent: options?.silent } satisfies MutationMeta,
    onMutate: ({ itemId, updates, uid }) =>
      patchListCache<PlanItem>(qc, key, prev =>
        prev.map(p => p.id === itemId ? { ...p, ...updates, ...auditUpdateMock(uid) } : p),
      ),
    onError: (_err, _vars, ctx) => {
      rollbackListCache<PlanItem>(qc, key, ctx)
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
  const uid = useUid()
  const key = planningKeys.all(tripId, uid)
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
              ...auditUpdateMock(uid),
            }
          : p,
        ),
      ),
    meta: { action: '更新' } satisfies MutationMeta,
    onError: (_err, _vars, ctx) => {
      rollbackListCache<PlanItem>(qc, key, ctx)
    },
  })
}

export function useDeletePlanItem(tripId: string) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = planningKeys.all(tripId, uid)
  return useMutation({
    mutationFn: (itemId: string) => deletePlanItem(tripId, itemId, uid!),
    meta: { action: '削除' } satisfies MutationMeta,
    onMutate: (itemId) =>
      patchListCache<PlanItem>(qc, key, prev => prev.filter(p => p.id !== itemId)),
    onError: (_err, _vars, ctx) => {
      rollbackListCache<PlanItem>(qc, key, ctx)
    },
  })
}
