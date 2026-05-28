// src/features/expense/hooks/useSettlements.ts
// Realtime list + mutations for settlement records. Used by
// SettlementSummary to filter out resolved transfers from the suggestion
// list and(future)to surface a history strip.
//
// realtime listener pushes new / deleted docs into the same cache via
// setQueryData — no onSuccess invalidate needed. Create goes optimistic
// through useTripListMutation: onMutate inserts a row keyed by the
// client-minted settlementId; the realtime listener then replaces it
// atomically once the Worker commits (same id, no temp-id swap).
// Errors are routed through the global MutationCache.onError(see
// services/queryClient.ts);per-hook onError isn't necessary unless we
// need cache rollback (useTripListMutation does that already).
import {
  getSettlementsByTrip,
  subscribeToSettlements,
  createSettlement,
  deleteSettlement,
  settlementKeys,
  type CreateSettlementVariables,
} from '../services/settlementService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { useTripListMutation } from '@/hooks/useTripListMutation'
import { mockTimestampNow } from '@/mocks/utils'
import type { SettlementRecord } from '@/types/settlement'
import { MUTATION_ACTION } from '@/services/queryClient'

export { settlementKeys }

export const useSettlements = createRealtimeListHook<SettlementRecord>({
  queryKeyFactory: settlementKeys.all,
  initialFetch:    getSettlementsByTrip,
  subscribe:       (tripId, _uid, onData, onError) => subscribeToSettlements(tripId, onData, onError),
  source:          'useSettlements',
})

export function useCreateSettlement(tripId: string) {
  return useTripListMutation<SettlementRecord, CreateSettlementVariables>({
    tripId,
    keyFactory: settlementKeys.all,
    mutate:     vars => createSettlement(tripId, vars),
    // Optimistic insert: realtime listener will replace this row with the
    // server-issued one once the Worker commits. The id is identical on
    // both sides (client-minted via crypto.randomUUID at the call site),
    // so the replacement is atomic — no flicker, no temp-id reconciliation.
    //
    // `settledBy` mirrors the Worker's token-derived value. Under the UI
    // invariant (only the receiver renders the 済み button), the caller
    // IS toUid, so `settledBy: vars.toUid` matches what the server will
    // write. amount is rounded to match what gets sent to the Worker.
    patch: (prev, vars) => [
      {
        id:         vars.settlementId,
        tripId,
        fromUid:    vars.fromUid,
        toUid:      vars.toUid,
        amount:     Math.round(vars.amount),
        currency:   vars.currency,
        settledBy:  vars.toUid,
        ...(vars.note ? { note: vars.note } : {}),
        createdAt:  mockTimestampNow(),
      },
      ...prev,
    ],
    action: MUTATION_ACTION.RECORD_SETTLEMENT,
  })
}

export function useDeleteSettlement(tripId: string) {
  return useTripListMutation<SettlementRecord, { settlementId: string }>({
    tripId,
    keyFactory: settlementKeys.all,
    mutate:     ({ settlementId }) => deleteSettlement(tripId, settlementId),
    // Optimistic remove: 「清算済み記録」row vanishes instantly and the
    // matching 「支払い提案」row reappears with its green 済み button
    // (computeBalancesFull recomputes from the filtered list — applied
    // debt drops, remaining debt comes back, suggestion re-emerges).
    // Worker rejection (403 non-recorder, 410 already gone) rolls back
    // via useTripListMutation's onError, restoring the row.
    patch: (prev, { settlementId }) => prev.filter(s => s.id !== settlementId),
    action: MUTATION_ACTION.CANCEL_SETTLEMENT,
  })
}
