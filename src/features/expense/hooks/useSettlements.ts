// src/features/expense/hooks/useSettlements.ts
// Realtime list + mutations for settlement records. Used by
// SettlementSummary to filter out resolved transfers from the suggestion
// list and(future)to surface a history strip.
//
// realtime listener pushes new / deleted docs into the same cache via
// setQueryData — no onSuccess invalidate needed. Errors are routed
// through the global MutationCache.onError(see services/queryClient.ts);
// per-hook onError isn't necessary unless we need cache rollback.
import { useMutation } from '@tanstack/react-query'
import {
  getSettlementsByTrip,
  subscribeToSettlements,
  createSettlement,
  deleteSettlement,
  settlementKeys,
} from '../services/settlementService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import type { SettlementRecord, CreateSettlementInput } from '@/types/settlement'
import { MUTATION_ACTION, type MutationMeta } from '@/services/queryClient'

export { settlementKeys }

export const useSettlements = createRealtimeListHook<SettlementRecord>({
  queryKeyFactory: settlementKeys.all,
  initialFetch:    getSettlementsByTrip,
  subscribe:       (tripId, _uid, onData, onError) => subscribeToSettlements(tripId, onData, onError),
  source:          'useSettlements',
})

export function useCreateSettlement(tripId: string) {
  return useMutation({
    mutationFn: ({ input, settledBy }: { input: CreateSettlementInput; settledBy: string }) =>
      createSettlement(tripId, input, settledBy),
    meta: { action: MUTATION_ACTION.RECORD_SETTLEMENT } satisfies MutationMeta,
  })
}

export function useDeleteSettlement(tripId: string) {
  return useMutation({
    mutationFn: (id: string) => deleteSettlement(tripId, id),
    meta: { action: MUTATION_ACTION.CANCEL_SETTLEMENT } satisfies MutationMeta,
  })
}
