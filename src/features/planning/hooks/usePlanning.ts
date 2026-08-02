// src/features/planning/hooks/usePlanning.ts
// Realtime-backed — when a co-member ticks off a packing item, you see
// it immediately. Optimistic state is an overlay replayed over server
// truth (see hooks/listOverlay.ts), not a cache patch.
//
// `toggleDone` is split out so checkbox-tap latency stays minimal
// (no full-doc patch shape).
import {
  getPlanItemsByTrip,
  getPlanItemsByTripFromServer,
  subscribeToPlanItems,
  createPlanItem,
  updatePlanItem,
  togglePlanItemDone,
  deletePlanItem,
} from '../services/planningService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { createListOverlay } from '@/hooks/listOverlay'
import { useTripListMutation } from '@/hooks/useTripListMutation'
import { auditCreateMock } from '@/utils/audit'
import type { CreatePlanItemInput, PlanItem } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { MUTATION_ACTION, type MutationOptions } from '@/services/queryClient'

const planningKeys = {
  all: (tripId: string, uid?: string) => ['planning', tripId, uid ?? ''] as const,
}

export const planningOverlay = createListOverlay<PlanItem>({
  insert: 'head',
  source: 'planning',
})

export const usePlanning = createRealtimeListHook<PlanItem>({
  queryKeyFactory: planningKeys.all,
  initialFetch:    (tripId, uid) => getPlanItemsByTrip(tripId, uid),
  subscribe:       (tripId, uid, onData, onError) => subscribeToPlanItems(tripId, uid, onData, onError),
  source:          'usePlanning',
  requiresUid:     true,
  overlay:         planningOverlay,
})

const serverRead = (tripId: string, uid: string | undefined) =>
  () => getPlanItemsByTripFromServer(tripId, uid ?? '')

/**
 * `updatePlanItem` runs the payload through `stripEmpty` and turns a
 * cleared `note` into a `deleteField()`, so the stored row ends up with
 * the key absent rather than empty. Normalising both the reducer and its
 * `confirms` through here keeps them describing the same end state —
 * otherwise the overlay would wait for a value the server will never
 * write, and expire on its grace timer instead.
 */
function normalizePlanUpdates(updates: Partial<CreatePlanItemInput>): Partial<PlanItem> {
  const out: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(updates)) {
    out[field] = value === '' ? undefined : value
  }
  return out as Partial<PlanItem>
}

export function useCreatePlanItem(tripId: string, options?: MutationOptions) {
  return useTripListMutation<PlanItem, { itemId: string; input: CreatePlanItemInput; createdBy: string }>({
    tripId,
    keyFactory: planningKeys.all,
    mutate:     ({ itemId, input, createdBy }) => createPlanItem(tripId, input, createdBy, itemId),
    overlay: {
      controller: planningOverlay,
      op: ({ itemId, input, createdBy }, { uid }) => ({
        kind: 'create',
        // Mock audit timestamps are fine here and only here: on upsert the
        // server row wins outright, so nothing has to match them.
        row: {
          id: itemId, tripId, memberIds: [createdBy], ...input,
          completedBy: {}, ...auditCreateMock(createdBy),
        } as PlanItem,
        confirms: base => base.some(p => p.id === itemId),
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
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
    overlay: {
      controller: planningOverlay,
      op: ({ itemId, updates }, { uid }) => {
        const patch = normalizePlanUpdates(updates)
        return {
          kind: 'patch',
          id:   itemId,
          // Audit fields are deliberately absent: their server values are
          // unknowable client-side, so applying them would leave the op
          // permanently unconfirmable.
          apply: row => ({ ...row, ...patch }),
          confirms: base => {
            const stored = base.find(p => p.id === itemId)
            return !!stored && Object.entries(patch).every(
              ([field, value]) => stored[field as keyof PlanItem] === value,
            )
          },
          authoritativeFetch: serverRead(tripId, uid),
        }
      },
    },
    action:     MUTATION_ACTION.UPDATE,
    silent:     options?.silent,
  })
}

/** Optimistic self-completion flip. Toggling is idempotent + scoped to
 *  completedBy[uid], so co-member progress does not conflict. */
export function useTogglePlanItem(tripId: string) {
  return useTripListMutation<PlanItem, { itemId: string; uid: string; done: boolean }>({
    tripId,
    keyFactory: planningKeys.all,
    mutate:     ({ itemId, uid, done }) => togglePlanItemDone(tripId, itemId, uid, done),
    overlay: {
      controller: planningOverlay,
      op: ({ itemId, uid, done }) => ({
        kind: 'patch',
        id:   itemId,
        // A reducer, not a snapshot of completedBy: it is replayed over
        // whatever base has arrived, so a co-member's completion landing
        // mid-flight survives instead of being overwritten by our copy.
        apply: row => {
          const completedBy = { ...row.completedBy }
          if (done) completedBy[uid] = MOCK_TIMESTAMP
          else delete completedBy[uid]
          return { ...row, completedBy }
        },
        confirms: base => {
          const stored = base.find(p => p.id === itemId)
          return !!stored && (stored.completedBy[uid] != null) === done
        },
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
    action:     MUTATION_ACTION.UPDATE,
  })
}

export function useDeletePlanItem(tripId: string) {
  return useTripListMutation<PlanItem, string>({
    tripId,
    keyFactory: planningKeys.all,
    mutate:     (itemId, { uid }) => deletePlanItem(tripId, itemId, uid),
    overlay: {
      controller: planningOverlay,
      // Variables here are the bare id, not an object.
      op: (itemId, { uid }) => ({
        kind: 'remove',
        id:   itemId,
        confirms: base => !base.some(p => p.id === itemId),
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
    action:     MUTATION_ACTION.DELETE,
  })
}
