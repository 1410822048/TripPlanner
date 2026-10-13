// src/features/expense/services/settlementService.ts
// Realtime read + Worker-authoritative write for
// trips/{tripId}/settlements/{id}. See src/types/settlement.ts for the
// entity model: a settlement is a route whose legs clear debt edges
// (from → to) in the debt-edge ledger computed by computeBalancesFull.
//
// Reads (list + onSnapshot) stay on the Firebase SDK -- persistentLocalCache
// covers offline + cross-tab and there's no domain invariant that needs
// admin authority on read. Both queries filter `deletedAt == null` at the
// query level (not an in-memory .filter() after fetch) -- cancelled
// settlements must genuinely leave the raw list for useSettlements'
// feature-local tombstone overlay to clear. The overlay only prunes an id
// once it is absent from the raw cache.
//
// Writes (create + delete) go through the Cloudflare Worker because the
// core invariant "every leg ≤ the Worker-computed remaining of its edge"
// can't be expressed in firestore.rules (no array reduce / cross-doc sum in
// CEL). The Worker re-derives gross → applied → remaining inside a single
// tx, CAS-checks every leg, guards concurrent creates over the same pair
// with a per-pair lock doc, and fail-closes on read-cap truncation. See
// workers/ocr/src/settlement-route-write.ts.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { parseServerListSnapshot } from '@/services/parseListSnapshot'
import { P } from '@/services/paths'
import { subscribeToCollection, type ListSnapshotMetadata } from '@/services/realtimeQuery'
import {
  requireWorkerWriteBase, preflightIdToken, workerFetch,
} from '@/services/workerBase'
import { canonicalRouteLegs, type SettlementRoute } from '@tripmate/settlement-core'
import { type LockedExpense, type SettlementRecord, SettlementDocSchema } from '@/types/settlement'

/**
 * Variables for recording a settlement — always a route; a plain pair
 * settlement is simply a one-leg route.
 *
 *   - `routeId` is minted at the call site (crypto.randomUUID) so the
 *     optimistic row, the Worker request and the Firestore doc share one
 *     id (the doc id). Memory: [[settlement-id-hoist-load-bearing]].
 *   - `route` is a proposal planned on the client's ledger. Every leg's
 *     `expectedRemainingMinor` is the Worker's per-edge CAS; the Worker
 *     re-validates the shape and every amount against its own ledger.
 *   - `foreign` (TRANSFER only): the currency the receiver actually got,
 *     with the rate they confirmed (FX CAS → 409 FX_RATE_CHANGED).
 *   - `optimistic` is for the overlay rows only and never crosses the wire.
 */
export interface CreateSettlementRouteVariables {
  routeId: string
  route:   SettlementRoute
  note?:   string
  foreign?: {
    sourceCurrency: string
    settledOn:      string
    expectedFxRate: { rateDecimal: string; rateDate: string }
  }
  optimistic: {
    currency:           string
    /** Who the Worker will stamp as settledBy (the caller). */
    settledBy:          string
    ownerRecorded?:     boolean
    /** FOREIGN only: the receiver-side source amount the sheet derived. */
    sourceAmountMinor?: number
    /** A conservative superset of the expenses the route will lock (both
     *  directions of every leg's pair), so a non-owner can't edit one in
     *  the window before the Worker's exact lock set lands. */
    pendingLocks: LockedExpense[]
  }
}

/** Defensive cap on ACTIVE settlement docs (one per recorded payment /
 *  offset). Matches the Worker's SETTLEMENT_READ_LIMIT: past it the ledger
 *  can't be read completely on either side. */
export const SETTLEMENT_LIST_LIMIT = 500
const LIST_LIMIT = SETTLEMENT_LIST_LIMIT

function settlementFromDoc(d: QueryDocumentSnapshot): SettlementRecord {
  return firestoreDocFromSchema(SettlementDocSchema, d, 'settlementFromDoc')
}

async function readSettlements(tripId: string): Promise<SettlementRecord[]> {
  const { db, collection, query, where, orderBy, limit, getDocsFromServer } = await getFirebase()
  const q = query(
    collection(db, ...P.settlements(tripId)),
    where('deletedAt', '==', null),
    orderBy('createdAt', 'desc'),
    limit(LIST_LIMIT + 1),
  )
  const snap = await getDocsFromServer(q)
  return parseServerListSnapshot(snap, settlementFromDoc, LIST_LIMIT)
}

export function getSettlementsByTrip(tripId: string): Promise<SettlementRecord[]> {
  return readSettlements(tripId)
}

/** Server-only read, used to settle an ambiguous write. `getDocs` can be
 *  answered from Firestore's local cache, which is exactly the state we
 *  are trying to check against. */
export function getSettlementsByTripFromServer(tripId: string): Promise<SettlementRecord[]> {
  return readSettlements(tripId)
}

export const subscribeToSettlements = (
  tripId: string,
  onData: (rows: SettlementRecord[], metadata?: ListSnapshotMetadata) => void,
  onError: (e: Error) => void,
) => subscribeToCollection<SettlementRecord>({
  buildQuery: ({ db, collection, query, where, orderBy, limit }) => query(
    collection(db, ...P.settlements(tripId)),
    where('deletedAt', '==', null),
    orderBy('createdAt', 'desc'),
    limit(LIST_LIMIT + 1),
  ),
  fromDoc: settlementFromDoc,
  source:  'subscribeToSettlements',
  limit:   LIST_LIMIT,
  requireComplete: true,
}, onData, onError)

/**
 * Record a settlement. The Worker is the authority: it re-checks the
 * route's shape, authorizes the caller (receiver / offset participant /
 * owner for departed members), CAS-checks every leg against its own ledger,
 * derives lineage and locks, and writes the one doc in one transaction.
 * workerFetch does not retry: 5xx / AbortError → WorkerAmbiguous, 4xx →
 * WorkerRejected. A retry with the same routeId is idempotent on the Worker.
 */
export async function createSettlementRoute(
  tripId: string,
  vars:   CreateSettlementRouteVariables,
): Promise<void> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()
  const { route } = vars
  const legs = canonicalRouteLegs(route.legs).map(l => ({
    fromUid:                l.fromUid,
    toUid:                  l.toUid,
    amountMinor:            l.amountMinor,
    expectedRemainingMinor: l.expectedRemainingMinor,
  }))
  await workerFetch(workerBase, idToken, '/settlement-route-create', {
    tripId,
    routeId: vars.routeId,
    legs,
    ...(route.kind === 'TRANSFER'
      ? {
          kind:        'TRANSFER' as const,
          payerUid:    route.payerUid,
          receiverUid: route.receiverUid,
          amountMinor: route.amountMinor,
          ...(vars.foreign ?? {}),
        }
      : { kind: 'OFFSET' as const }),
    ...(vars.note ? { note: vars.note } : {}),
  })
}

/**
 * Cancel a settlement — the whole route. Worker enforces recorder-or-owner
 * gating; missing-doc is treated as success (idempotent) so a double-tap
 * from optimistic UI doesn't surface a 404.
 */
export async function deleteSettlement(tripId: string, id: string): Promise<void> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()
  await workerFetch(workerBase, idToken, '/settlement-delete', {
    tripId, settlementId: id,
  })
}

export const settlementKeys = {
  // uid is part of the key so a signed-out / switched account cannot inherit
  // the previous user's in-flight optimistic state on a shared device.
  all: (tripId: string, uid?: string) => ['settlements', tripId, uid ?? ''] as const,
}
