// src/features/expense/hooks/useSettlements.ts
// Realtime list + mutations for settlement records, and the first entity on
// the read-time overlay: the query cache holds server truth, optimistic
// state is replayed over it by `settlementOverlay`.
//
// Settlement writes are Worker-authoritative, so both mutations can come
// back ambiguous — the request may or may not have committed. That is why
// confirmation reads the server rather than trusting a timer.
import { useMutation } from '@tanstack/react-query'
import {
  getSettlementsByTrip,
  getSettlementsByTripFromServer,
  subscribeToSettlements,
  createSettlement,
  deleteSettlement,
  settlementKeys,
  type CreateSettlementVariables,
} from '../services/settlementService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { createListOverlay, type OverlayHandle } from '@/hooks/listOverlay'
import { isWorkerAmbiguousError, useTripListMutation } from '@/hooks/useTripListMutation'
import { useUid } from '@/hooks/useAuth'
import { mockTimestampNow } from '@/mocks/utils'
import type { SettlementRecord } from '@/types/settlement'
import { MUTATION_ACTION, type MutationMeta } from '@/services/queryClient'

/** Delete is idempotent, so an ambiguous failure is worth one cheap retry
 *  before falling back to reading server truth. Comfortably shorter than
 *  the overlay's grace window so the retry always resolves first. */
export const SETTLEMENT_DELETE_RETRY_DELAY_MS = 700

export const settlementOverlay = createListOverlay<SettlementRecord>({
  insert: 'head',
  source: 'settlements',
})

export const useSettlements = createRealtimeListHook<SettlementRecord>({
  queryKeyFactory: settlementKeys.all,
  initialFetch:    getSettlementsByTrip,
  subscribe:       (tripId, _uid, onData, onError) => subscribeToSettlements(tripId, onData, onError),
  source:          'useSettlements',
  requiresUid:     true,
  overlay:         settlementOverlay,
})

/** The optimistic row. Its id is minted by the caller and is the same one
 *  the Worker writes, so once server truth carries it the overlay yields
 *  and this row is replaced wholesale — mock timestamps included. */
function optimisticSettlementRow(
  tripId: string,
  vars:   CreateSettlementVariables,
): SettlementRecord {
  const shared = {
    id:          vars.settlementId,
    tripId,
    fromUid:     vars.fromUid,
    toUid:       vars.toUid,
    amountMinor: vars.optimistic.amountMinor,
    currency:    vars.optimistic.currency,
    settledBy:   vars.toUid,
    deletedAt:   null,
    ...(vars.pendingAppliedExpenseIds ? { appliedExpenseIds: vars.pendingAppliedExpenseIds } : {}),
    ...(vars.note ? { note: vars.note } : {}),
    createdAt:   mockTimestampNow(),
  }
  return (vars.mode === 'TRIP_CURRENCY' ? shared : {
    ...shared,
    sourceCurrency:    vars.sourceCurrency,
    sourceAmountMinor: vars.optimistic.sourceAmountMinor,
    settledOn:         vars.settledOn,
  }) as SettlementRecord
}

export function useCreateSettlement(tripId: string) {
  return useTripListMutation<SettlementRecord, CreateSettlementVariables>({
    tripId,
    keyFactory: settlementKeys.all,
    mutate:     vars => createSettlement(tripId, vars),
    overlay: {
      controller: settlementOverlay,
      op: vars => ({
        kind: 'create',
        row:  optimisticSettlementRow(tripId, vars),
        confirms: base => base.some(s => s.id === vars.settlementId),
        authoritativeFetch: () => getSettlementsByTripFromServer(tripId),
      }),
    },
    action: MUTATION_ACTION.RECORD_SETTLEMENT,
  })
}

/** One retry of the idempotent delete, then let server truth decide.
 *  A retry failure still cannot prove the original write failed, so it
 *  hands over to the ambiguous path rather than restoring the row. */
function scheduleDeleteRetry(handle: OverlayHandle, tripId: string, settlementId: string): void {
  const timer = setTimeout(() => {
    void deleteSettlement(tripId, settlementId)
      .then(() => settlementOverlay.markSucceeded(handle))
      .catch(() => settlementOverlay.markAmbiguous(handle))
  }, SETTLEMENT_DELETE_RETRY_DELAY_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

export function useDeleteSettlement(tripId: string) {
  const uid = useUid()
  const key = settlementKeys.all(tripId, uid)

  return useMutation({
    mutationFn: ({ settlementId }: { settlementId: string }) => {
      if (!uid) {
        throw new Error(`useDeleteSettlement[${MUTATION_ACTION.CANCEL_SETTLEMENT}]: uid is undefined`)
      }
      return deleteSettlement(tripId, settlementId)
    },
    meta: { action: MUTATION_ACTION.CANCEL_SETTLEMENT } satisfies MutationMeta,
    onMutate: ({ settlementId }) => ({
      handle: settlementOverlay.add(key, {
        kind: 'remove',
        id:   settlementId,
        confirms: base => !base.some(s => s.id === settlementId),
        authoritativeFetch: () => getSettlementsByTripFromServer(tripId),
        // If we can't reach the server, show the row again. A settlement
        // that looks cancelled but isn't invites the user to record the
        // payment twice; a stale visible row is corrected by the next
        // snapshot.
        whenUnconfirmable: 'drop',
      }),
    }),
    onSuccess: (_data, _vars, ctx) => {
      settlementOverlay.markSucceeded(ctx.handle)
    },
    onError: (err, _vars, ctx) => {
      const handle = ctx?.handle
      if (!handle) return
      if (!isWorkerAmbiguousError(err)) {
        settlementOverlay.drop(handle)
        return
      }
      scheduleDeleteRetry(handle, tripId, _vars.settlementId)
    },
  })
}
