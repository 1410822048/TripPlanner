// src/features/expense/hooks/useSettlements.ts
// Realtime list + mutations for settlement records, and the first entity on
// the read-time overlay: the query cache holds server truth, optimistic
// state is replayed over it by `settlementOverlay`.
//
// Settlement writes are Worker-authoritative, so both mutations can come
// back ambiguous — the request may or may not have committed. That is why
// confirmation reads the server rather than trusting a timer.
//
// Every record is a routed settlement (a plain pair settlement is a
// one-leg route), stored as one doc per leg. Both mutations therefore own
// one overlay op PER LEG, settled together — the Worker commits or cancels
// every leg of a route at once.
import { useMutation } from '@tanstack/react-query'
import { canonicalRouteLegs, routeLegId, routeParticipants } from '@tripmate/settlement-core'
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

/** The optimistic leg rows of a route: the same ids (routeLegId over
 *  canonical leg order) and the same `route` header the Worker writes, so
 *  once server truth carries them the overlay yields row by row. */
export function optimisticRouteRows(
  tripId: string,
  vars:   CreateSettlementRouteVariables,
): SettlementRecord[] {
  const { route, optimistic } = vars
  const legs = canonicalRouteLegs(route.legs)
  const createdAt = mockTimestampNow()
  const header: NonNullable<SettlementRecord['route']> = {
    id:              vars.routeId,
    legIndex:        0,
    legCount:        legs.length,
    kind:            route.kind,
    participantUids: routeParticipants(legs),
    ...(route.kind === 'TRANSFER'
      ? { payerUid: route.payerUid, receiverUid: route.receiverUid, amountMinor: route.amountMinor }
      : {}),
    ...(optimistic.ownerRecorded ? { ownerRecorded: true as const } : {}),
    ...(vars.note ? { note: vars.note } : {}),
    ...(vars.foreign && optimistic.sourceAmountMinor !== undefined
      ? { sourceCurrency: vars.foreign.sourceCurrency, sourceAmountMinor: optimistic.sourceAmountMinor, settledOn: vars.foreign.settledOn }
      : {}),
  }
  return legs.map((leg, i) => ({
    id:          routeLegId(vars.routeId, i),
    tripId,
    fromUid:     leg.fromUid,
    toUid:       leg.toUid,
    amountMinor: leg.amountMinor,
    currency:    optimistic.currency,
    settledBy:   optimistic.settledBy,
    deletedAt:   null,
    appliedExpenseIds: optimistic.pendingAppliedExpenseIds[i] ?? [],
    route:       { ...header, legIndex: i },
    createdAt,
  }))
}

/** Record a route. One create op per leg, all added before the request and
 *  settled together. Not useTripListMutation: that factory owns exactly one
 *  op per mutation. */
export function useCreateSettlementRoute(tripId: string) {
  const uid = useUid()
  const key = settlementKeys.all(tripId, uid)
  return useMutation({
    mutationFn: (vars: CreateSettlementRouteVariables & ReportInForm) => {
      if (!uid) throw new Error(`useCreateSettlementRoute[${MUTATION_ACTION.RECORD_SETTLEMENT}]: uid is undefined`)
      return createSettlementRoute(tripId, vars)
    },
    meta: { action: MUTATION_ACTION.RECORD_SETTLEMENT } satisfies MutationMeta,
    onMutate: vars => ({
      handles: optimisticRouteRows(tripId, vars).map(row => settlementOverlay.add(key, {
        kind: 'create',
        row,
        confirms: base => base.some(s => s.id === row.id),
        authoritativeFetch: () => getSettlementsByTripFromServer(tripId),
      })),
    }),
    onSuccess: (_data, _vars, ctx) => {
      for (const handle of ctx.handles) settlementOverlay.markSucceeded(handle)
    },
    onError: (err, _vars, ctx) => {
      // Definitive: nothing was written, drop every leg. Ambiguous: every
      // leg or none landed — hold them all until server truth decides.
      for (const handle of ctx?.handles ?? []) {
        if (isWorkerAmbiguousError(err)) settlementOverlay.markAmbiguous(handle)
        else settlementOverlay.drop(handle)
      }
    },
  })
}

/** One retry of the idempotent delete, then let server truth decide.
 *  A retry failure still cannot prove the original write failed, so it
 *  hands over to the ambiguous path rather than restoring the rows. */
function scheduleDeleteRetry(handles: OverlayHandle[], tripId: string, settlementId: string): void {
  const timer = setTimeout(() => {
    // The ops are gone when overlays were cleared (sign-out / account
    // switch) or they already settled: don't send the old account's delete
    // under whoever is signed in now.
    const live = handles.filter(h => settlementOverlay.getSnapshot(h.queryKeyHash).some(op => op.opId === h.opId))
    if (live.length === 0) return
    void deleteSettlement(tripId, settlementId)
      .then(() => { for (const h of live) settlementOverlay.markSucceeded(h) })
      .catch(() => { for (const h of live) settlementOverlay.markAmbiguous(h) })
  }, SETTLEMENT_DELETE_RETRY_DELAY_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

export function useDeleteSettlement(tripId: string) {
  const uid = useUid()
  const key = settlementKeys.all(tripId, uid)

  return useMutation({
    // `hideIds`: every row the cancel removes — all legs of a route (the
    // Worker cancels the whole route from any one leg id) — besides the
    // settlement named in the request.
    mutationFn: ({ settlementId }: { settlementId: string; hideIds?: string[] }) => {
      if (!uid) {
        throw new Error(`useDeleteSettlement[${MUTATION_ACTION.CANCEL_SETTLEMENT}]: uid is undefined`)
      }
      return deleteSettlement(tripId, settlementId)
    },
    meta: { action: MUTATION_ACTION.CANCEL_SETTLEMENT } satisfies MutationMeta,
    onMutate: ({ settlementId, hideIds }) => ({
      handles: [...new Set([settlementId, ...(hideIds ?? [])])].map(id => settlementOverlay.add(key, {
        kind: 'remove',
        id,
        confirms: base => !base.some(s => s.id === id),
        authoritativeFetch: () => getSettlementsByTripFromServer(tripId),
        // If we can't reach the server, show the rows again. A settlement
        // that looks cancelled but isn't invites the user to record the
        // payment twice; a stale visible row is corrected by the next
        // snapshot.
        whenUnconfirmable: 'drop',
      })),
    }),
    onSuccess: (_data, _vars, ctx) => {
      for (const handle of ctx.handles) settlementOverlay.markSucceeded(handle)
    },
    onError: (err, vars, ctx) => {
      const handles = ctx?.handles
      if (!handles) return
      if (!isWorkerAmbiguousError(err)) {
        for (const handle of handles) settlementOverlay.drop(handle)
        return
      }
      scheduleDeleteRetry(handles, tripId, vars.settlementId)
    },
  })
}
