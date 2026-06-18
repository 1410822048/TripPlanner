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

export const useSettlements = createRealtimeListHook<SettlementRecord>({
  queryKeyFactory: settlementKeys.all,
  initialFetch:    getSettlementsByTrip,
  subscribe:       (tripId, _uid, onData, onError) => subscribeToSettlements(tripId, onData, onError),
  source:          'useSettlements',
  // Worker-authoritative delete → opt into the optimistic-delete overlay so
  // a lagging snapshot can't flicker a just-deleted record back in. See
  // useDeleteSettlement below + utils/listTombstones.
  tombstoneIdOf:   s => s.id,
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
    // write.
    //
    // Phase 4.1 rearchitecture: vars carry NO client-supplied amount on
    // the wire. The page mints `vars.optimistic.amountMinor =
    // suggestion.amountMinor` (= pair-remaining) for BOTH modes —
    // exactly what the Worker will write, since amountMinor ≡ remaining
    // is the ledger truth. Foreign mode additionally derives
    // `optimistic.sourceAmountMinor` via `useFxPreview` for the source-
    // side display only (Worker re-derives authoritatively).
    //
    // The realtime listener swap is atomic and amountMinor matches by
    // construction; foreign sourceAmountMinor may shift by 1-2 minor
    // units if Worker's fresh FX rate differs from the cached client
    // rate (~100-300ms typical window).
    //
    // fxSnapshot is intentionally omitted from the optimistic row: the
    // SettlementDocSchema superRefine requires all-or-none FX group on
    // *parse*, but the TanStack cache doesn't re-validate writes, and
    // computeBalancesFull only reads amountMinor / currency / from /
    // to / createdAt — the source-side display fields are sufficient
    // for the history row's optimistic render.
    patch: (prev, vars) => [
      vars.mode === 'TRIP_CURRENCY'
        ? {
            id:          vars.settlementId,
            tripId,
            fromUid:     vars.fromUid,
            toUid:       vars.toUid,
            amountMinor: vars.optimistic.amountMinor,
            currency:    vars.optimistic.currency,
            settledBy:   vars.toUid,
            // Conservative pending lock lineage so ExpensePage's readonly
            // union locks the source expenses during the optimistic window
            // (before the Worker writes settlementLockIds + the expense
            // listener fires). Listener swap replaces it with the exact set.
            ...(vars.pendingAppliedExpenseIds ? { appliedExpenseIds: vars.pendingAppliedExpenseIds } : {}),
            ...(vars.note ? { note: vars.note } : {}),
            createdAt:   mockTimestampNow(),
          }
        : {
            id:                vars.settlementId,
            tripId,
            fromUid:           vars.fromUid,
            toUid:             vars.toUid,
            amountMinor:       vars.optimistic.amountMinor,
            currency:          vars.optimistic.currency,
            settledBy:         vars.toUid,
            sourceCurrency:    vars.sourceCurrency,
            sourceAmountMinor: vars.optimistic.sourceAmountMinor,
            settledOn:         vars.settledOn,
            ...(vars.pendingAppliedExpenseIds ? { appliedExpenseIds: vars.pendingAppliedExpenseIds } : {}),
            ...(vars.note ? { note: vars.note } : {}),
            createdAt:         mockTimestampNow(),
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
    // Optimistic remove via the tombstone OVERLAY (not a raw-cache patch):
    // 「清算済み記録」row vanishes instantly and the matching 「支払い提案」
    // row reappears with its green 済み button (computeBalancesFull
    // recomputes from the select-filtered list — applied debt drops,
    // remaining debt comes back, suggestion re-emerges). Crucially the raw
    // cache is NOT shrunk, so a Firestore snapshot still mid-flight at
    // delete time can't overwrite the removal and flicker the row back; the
    // listener prunes the tombstone once the server confirms the delete.
    // Worker rejection (403 non-recorder, 409 stale) removes the tombstone
    // via useTripListMutation's onError, restoring the row.
    tombstone: ({ settlementId }) => [settlementId],
    // settlement-delete is Worker-IDEMPOTENT (missing doc → ok, see
    // settlement-write.ts), so an ambiguous failure (lost response / 5xx) is
    // safe to retry once in the background before the 3s reconcile fallback.
    // Opt-in here ONLY — never on non-idempotent create/update.
    retryAmbiguous: ({ settlementId }) => deleteSettlement(tripId, settlementId),
    action: MUTATION_ACTION.CANCEL_SETTLEMENT,
  })
}
