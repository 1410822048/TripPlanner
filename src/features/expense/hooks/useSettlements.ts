// src/features/expense/hooks/useSettlements.ts
// Realtime list + mutations for settlement records, and the first entity on
// the read-time overlay: the query cache holds server truth, optimistic
// state is replayed over it by `settlementOverlay`.
//
// Settlement writes are Worker-authoritative, so both mutations can come
// back ambiguous — the request may or may not have committed. That is why
// confirmation reads the server rather than trusting a timer.
//
// Every record is a route (a plain pair settlement is a one-leg route)
// stored as ONE doc, so each mutation owns exactly one overlay op.
import { useMutation } from '@tanstack/react-query'
import { canonicalRouteLegs, routeParticipants } from '@tripmate/settlement-core'
import {
  getSettlementsByTrip,
  getSettlementsByTripFromServer,
  subscribeToSettlements,
  createSettlementRoute,
  deleteSettlement,
  settlementKeys,
  type CreateSettlementRouteVariables,
} from '../services/settlementService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { createListOverlay, type OverlayHandle } from '@/hooks/listOverlay'
import { isWorkerAmbiguousError } from '@/hooks/useTripListMutation'
import { useUid } from '@/hooks/useAuth'
import { mockTimestampNow } from '@/mocks/utils'
import type { SettlementRecord } from '@/types/settlement'
import { MUTATION_ACTION, type MutationMeta, type ReportInForm } from '@/services/queryClient'

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
  requireServerConfirmation: true,
  overlay:         settlementOverlay,
})

/** The optimistic row of a route: the same id (the doc id) and the same
 *  fields the Worker writes, minus what only the Worker derives (lineage,
 *  the FX snapshot). Once server truth carries the id the overlay yields. */
export function optimisticRouteRow(
  tripId: string,
  vars:   CreateSettlementRouteVariables,
): SettlementRecord {
  const { route, optimistic } = vars
  const legs = canonicalRouteLegs(route.legs)
  return {
    id:              vars.routeId,
    tripId,
    kind:            route.kind,
    currency:        optimistic.currency,
    participantUids: routeParticipants(legs),
    legs:            legs.map(leg => ({ fromUid: leg.fromUid, toUid: leg.toUid, amountMinor: leg.amountMinor })),
    ...(route.kind === 'TRANSFER'
      ? { payerUid: route.payerUid, receiverUid: route.receiverUid, amountMinor: route.amountMinor }
      : {}),
    ...(optimistic.ownerRecorded ? { ownerRecorded: true as const } : {}),
    ...(vars.note ? { note: vars.note } : {}),
    ...(vars.foreign && optimistic.sourceAmountMinor !== undefined
      ? { sourceCurrency: vars.foreign.sourceCurrency, sourceAmountMinor: optimistic.sourceAmountMinor, settledOn: vars.foreign.settledOn }
      : {}),
    lockedExpenses: optimistic.pendingLocks,
    settledBy:   optimistic.settledBy,
    createdAt:   mockTimestampNow(),
    deletedAt:   null,
  }
}

export function useCreateSettlementRoute(tripId: string) {
  const uid = useUid()
  const key = settlementKeys.all(tripId, uid)
  return useMutation({
    mutationFn: (vars: CreateSettlementRouteVariables & ReportInForm) => {
      if (!uid) throw new Error(`useCreateSettlementRoute[${MUTATION_ACTION.RECORD_SETTLEMENT}]: uid is undefined`)
      return createSettlementRoute(tripId, vars)
    },
    meta: { action: MUTATION_ACTION.RECORD_SETTLEMENT } satisfies MutationMeta,
    onMutate: vars => {
      const row = optimisticRouteRow(tripId, vars)
      return {
        handle: settlementOverlay.add(key, {
          kind: 'create',
          row,
          confirms: base => base.some(s => s.id === row.id),
          authoritativeFetch: () => getSettlementsByTripFromServer(tripId),
        }),
      }
    },
    onSuccess: (_data, _vars, ctx) => settlementOverlay.markSucceeded(ctx.handle),
    onError: (err, _vars, ctx) => {
      if (!ctx) return
      // Definitive: nothing was written. Ambiguous: hold the row until
      // server truth decides.
      if (isWorkerAmbiguousError(err)) settlementOverlay.markAmbiguous(ctx.handle)
      else settlementOverlay.drop(ctx.handle)
    },
  })
}

/** One retry of the idempotent delete, then let server truth decide.
 *  A retry failure still cannot prove the original write failed, so it
 *  hands over to the ambiguous path rather than restoring the rows. */
function scheduleDeleteRetry(handle: OverlayHandle, tripId: string, settlementId: string): void {
  const timer = setTimeout(() => {
    // The op is gone when overlays were cleared (sign-out / account switch)
    // or it already settled: don't send the old account's delete under
    // whoever is signed in now.
    if (!settlementOverlay.getSnapshot(handle.queryKeyHash).some(op => op.opId === handle.opId)) return
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
        id: settlementId,
        confirms: base => !base.some(s => s.id === settlementId),
        authoritativeFetch: () => getSettlementsByTripFromServer(tripId),
        // If we can't reach the server, show the row again. A settlement
        // that looks cancelled but isn't invites the user to record the
        // payment twice; a stale visible row is corrected by the next
        // snapshot.
        whenUnconfirmable: 'drop',
      }),
    }),
    onSuccess: (_data, _vars, ctx) => settlementOverlay.markSucceeded(ctx.handle),
    onError: (err, vars, ctx) => {
      if (!ctx) return
      if (!isWorkerAmbiguousError(err)) {
        settlementOverlay.drop(ctx.handle)
        return
      }
      scheduleDeleteRetry(ctx.handle, tripId, vars.settlementId)
    },
  })
}
