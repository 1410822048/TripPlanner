// src/features/planning/hooks/usePlanning.ts
// Realtime-backed — when a co-member ticks off a packing item, you see
// it immediately. Mutations stay optimistic; listener reconciles.
//
// `toggleDone` is split out so checkbox-tap latency stays minimal
// (no full-doc patch shape).
import {
  getPlanItemsByTrip,
  subscribeToPlanItems,
  createPlanItem,
  updatePlanItem,
  togglePlanItemDone,
  deletePlanItem,
} from '../services/planningService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { useTripListMutation } from '@/hooks/useTripListMutation'
import { tempId } from '@/utils/tempId'
import { auditCreateMock, auditUpdateMock } from '@/utils/audit'
import type { CreatePlanItemInput, PlanItem } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { MUTATION_ACTION, type MutationOptions } from '@/services/queryClient'

export const planningKeys = {
  all: (tripId: string, uid?: string) => ['planning', tripId, uid ?? ''] as const,
}

export const usePlanning = createRealtimeListHook<PlanItem>({
  queryKeyFactory: planningKeys.all,
  initialFetch:    (tripId, uid) => getPlanItemsByTrip(tripId, uid),
  subscribe:       (tripId, uid, onData, onError) => subscribeToPlanItems(tripId, uid, onData, onError),
  source:          'usePlanning',
  requiresUid:     true,
})

export function useCreatePlanItem(tripId: string, options?: MutationOptions) {
  return useTripListMutation<PlanItem, { input: CreatePlanItemInput; createdBy: string }>({
    tripId,
    keyFactory: planningKeys.all,
    mutate:     ({ input, createdBy }) => createPlanItem(tripId, input, createdBy),
    patch:      (prev, { input, createdBy }) => [
      { id: tempId(), tripId, memberIds: [createdBy], ...input, done: false, ...auditCreateMock(createdBy) },
      ...prev,
    ],
    action:     MUTATION_ACTION.CREATE_PLAN,
    silent:     options?.silent,
  })
}

export function useUpdatePlanItem(tripId: string, options?: MutationOptions) {
  return useTripListMutation<PlanItem, {
    itemId:  string
    updates: Partial<CreatePlanItemInput>
    uid:     string
  }>({
    tripId,
    keyFactory: planningKeys.all,
    mutate:     ({ itemId, updates, uid }) => updatePlanItem(tripId, itemId, updates, { uid }),
    patch:      (prev, { itemId, updates, uid }) =>
      prev.map(p => p.id === itemId ? { ...p, ...updates, ...auditUpdateMock(uid) } : p),
    action:     MUTATION_ACTION.UPDATE,
    silent:     options?.silent,
  })
}

/** Optimistic checkbox flip. Toggling is idempotent + per-doc, so the
 *  listener's eventual server-state delivery doesn't conflict. */
export function useTogglePlanItem(tripId: string) {
  return useTripListMutation<PlanItem, { itemId: string; uid: string; done: boolean }>({
    tripId,
    keyFactory: planningKeys.all,
    mutate:     ({ itemId, uid, done }) => togglePlanItemDone(tripId, itemId, uid, done),
    patch:      (prev, { itemId, uid, done }) =>
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
    action:     MUTATION_ACTION.UPDATE,
  })
}

export function useDeletePlanItem(tripId: string) {
  return useTripListMutation<PlanItem, string>({
    tripId,
    keyFactory: planningKeys.all,
    mutate:     (itemId, { uid }) => deletePlanItem(tripId, itemId, uid),
    patch:      (prev, itemId) => prev.filter(p => p.id !== itemId),
    action:     MUTATION_ACTION.DELETE,
  })
}
