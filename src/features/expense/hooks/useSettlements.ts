// src/features/expense/hooks/useSettlements.ts
// Realtime list + mutations for settlement records. Create uses the shared
// trip-list mutation factory; delete owns a feature-local tombstone overlay
// because settlement cancellation is the only Worker-authoritative delete
// that needs read-time hiding instead of raw-cache shrinking.
import { useEffect, useSyncExternalStore } from 'react'
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseQueryResult,
} from '@tanstack/react-query'
import {
  getSettlementsByTrip,
  subscribeToSettlements,
  createSettlement,
  deleteSettlement,
  settlementKeys,
  type CreateSettlementVariables,
} from '../services/settlementService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import {
  AMBIGUOUS_RECONCILE_DELAY_MS,
  isWorkerAmbiguousError,
  useTripListMutation,
} from '@/hooks/useTripListMutation'
import { useUid } from '@/hooks/useAuth'
import { mockTimestampNow } from '@/mocks/utils'
import type { SettlementRecord } from '@/types/settlement'
import { MUTATION_ACTION, type MutationMeta } from '@/services/queryClient'
import {
  SETTLEMENT_DELETE_RETRY_DELAY_MS,
  addSettlementTombstone,
  filterSettlementTombstones,
  pruneSettlementTombstones,
  removeSettlementTombstone,
  settlementTombstoneVersion,
  subscribeSettlementTombstones,
} from './settlementTombstones'

const useSettlementsRaw = createRealtimeListHook<SettlementRecord>({
  queryKeyFactory: settlementKeys.all,
  initialFetch:    getSettlementsByTrip,
  subscribe:       (tripId, _uid, onData, onError) => subscribeToSettlements(tripId, onData, onError),
  source:          'useSettlements',
})

export function useSettlements(tripId: string | undefined): UseQueryResult<SettlementRecord[]> {
  const result = useSettlementsRaw(tripId)

  const tombstoneVersion = useSyncExternalStore(
    cb => (tripId ? subscribeSettlementTombstones(tripId, cb) : () => {}),
    () => (tripId ? settlementTombstoneVersion(tripId) : 0),
    () => 0,
  )

  useEffect(() => {
    if (!tripId || !result.data) return
    pruneSettlementTombstones(tripId, result.data)
  }, [tripId, result.data])

  if (!tripId || !result.data) return result
  const filtered = filterSettlementTombstones(tripId, result.data, tombstoneVersion)
  return (filtered === result.data ? result : { ...result, data: filtered }) as UseQueryResult<SettlementRecord[]>
}

export function useCreateSettlement(tripId: string) {
  return useTripListMutation<SettlementRecord, CreateSettlementVariables>({
    tripId,
    keyFactory: settlementKeys.all,
    mutate:     vars => createSettlement(tripId, vars),
    // Optimistic insert: realtime listener will replace this row with the
    // server-issued one once the Worker commits. The id is identical on both
    // sides, so the replacement is atomic.
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
            deletedAt:   null,
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
            deletedAt:         null,
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

function scheduleSettlementDeleteReconcile(
  qc:           QueryClient,
  key:          QueryKey,
  tripId:       string,
  settlementId: string,
  delayMs = AMBIGUOUS_RECONCILE_DELAY_MS,
): void {
  const timer = setTimeout(() => {
    void qc.invalidateQueries({ queryKey: key })
      .then(() => {
        const fresh = qc.getQueryData<SettlementRecord[]>(key)
        if (!fresh) {
          removeSettlementTombstone(tripId, settlementId)
          return
        }
        if (fresh.some(s => s.id === settlementId)) {
          removeSettlementTombstone(tripId, settlementId)
        }
      })
      .catch(() => {
        removeSettlementTombstone(tripId, settlementId)
      })
  }, delayMs)
  const nodeTimer = timer as unknown as { unref?: () => void }
  nodeTimer.unref?.()
}

function scheduleSettlementDeleteRetryThenReconcile(
  qc:           QueryClient,
  key:          QueryKey,
  tripId:       string,
  settlementId: string,
): void {
  const timer = setTimeout(() => {
    void deleteSettlement(tripId, settlementId)
      .then(() => {
        // Confirmed or idempotent already-gone. Keep the tombstone hidden;
        // the realtime snapshot will prune it once server truth drops the id.
      })
      .catch(() => {
        // Any retry failure cannot prove the original ambiguous write failed.
        // Wait for the settle window, then decide against server truth.
        scheduleSettlementDeleteReconcile(qc, key, tripId, settlementId)
      })
  }, SETTLEMENT_DELETE_RETRY_DELAY_MS)
  const nodeTimer = timer as unknown as { unref?: () => void }
  nodeTimer.unref?.()
}

export function useDeleteSettlement(tripId: string) {
  const qc  = useQueryClient()
  const uid = useUid()
  const key = settlementKeys.all(tripId)

  return useMutation({
    mutationFn: ({ settlementId }: { settlementId: string }) => {
      if (!uid) {
        throw new Error(`useDeleteSettlement[${MUTATION_ACTION.CANCEL_SETTLEMENT}]: uid is undefined`)
      }
      return deleteSettlement(tripId, settlementId)
    },
    meta: { action: MUTATION_ACTION.CANCEL_SETTLEMENT } satisfies MutationMeta,
    onMutate: ({ settlementId }) => {
      addSettlementTombstone(tripId, settlementId)
    },
    onError: (err, { settlementId }) => {
      if (!isWorkerAmbiguousError(err)) {
        removeSettlementTombstone(tripId, settlementId)
        return
      }
      scheduleSettlementDeleteRetryThenReconcile(qc, key, tripId, settlementId)
    },
  })
}
