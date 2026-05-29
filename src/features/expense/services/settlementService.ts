// src/features/expense/services/settlementService.ts
// Realtime read + Worker-authoritative write for
// trips/{tripId}/settlements/{id}. See src/types/settlement.ts for the
// entity model and why this is treated as a reverse-expense by
// computeBalances.
//
// Reads (list + onSnapshot) stay on the Firebase SDK -- persistentLocalCache
// covers offline + cross-tab and there's no domain invariant that needs
// admin authority on read.
//
// Writes (create + delete) go through the Cloudflare Worker because the
// core invariant `amountMinor <= pairwise[fromUid][toUid]` can't be expressed
// in firestore.rules (no array reduce / cross-doc sum in CEL). The
// Worker re-derives gross → applied → remaining inside a single tx,
// guards concurrent same-pair creates with a per-pair lock doc, and
// fail-closes on read-cap truncation. See workers/ocr/src/settlement-write.ts.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { parseListSnapshot } from '@/services/parseListSnapshot'
import { captureError } from '@/services/sentry'
import { P } from '@/services/paths'
import { subscribeToCollection } from '@/services/realtimeQuery'
import {
  requireWorkerWriteBase, preflightIdToken, workerFetch,
} from '@/services/workerBase'
import {
  type SettlementRecord,
  type CreateSettlementInput,
  SettlementDocSchema,
} from '@/types/settlement'

/**
 * Variables required to record a settlement. `settlementId` is minted
 * at the call site (not inside the service) so the optimistic cache
 * row, the Worker request, and the resulting Firestore doc all share
 * the same id. This also means a future "retry" CTA passing the same
 * variables stays idempotent at the Worker (payload-exact match on
 * `currentDocument.exists=false`) instead of becoming a new write.
 */
export type CreateSettlementVariables = CreateSettlementInput & {
  settlementId: string
}

/** Defensive cap — long trips with many splits accumulate settlement
 *  records over time. 200 covers a 14-day group trip with margin. */
const LIST_LIMIT = 200

function settlementFromDoc(d: QueryDocumentSnapshot): SettlementRecord {
  return firestoreDocFromSchema(SettlementDocSchema, d, 'settlementFromDoc')
}

export async function getSettlementsByTrip(tripId: string): Promise<SettlementRecord[]> {
  const { db, collection, query, orderBy, limit, getDocs } = await getFirebase()
  const q = query(
    collection(db, ...P.settlements(tripId)),
    orderBy('createdAt', 'desc'),
    limit(LIST_LIMIT),
  )
  const snap = await getDocs(q)
  if (snap.size >= LIST_LIMIT) {
    captureError(new Error(`getSettlementsByTrip truncated at ${LIST_LIMIT}`), { tripId })
  }
  return parseListSnapshot(snap, settlementFromDoc)
}

export const subscribeToSettlements = (
  tripId: string,
  onData: (rows: SettlementRecord[]) => void,
  onError: (e: Error) => void,
) => subscribeToCollection<SettlementRecord>({
  buildQuery: ({ db, collection, query, orderBy, limit }) => query(
    collection(db, ...P.settlements(tripId)),
    orderBy('createdAt', 'desc'),
    limit(LIST_LIMIT),
  ),
  fromDoc: settlementFromDoc,
  source:  'subscribeToSettlements',
  limit:   LIST_LIMIT,
}, onData, onError)

/**
 * Record a settlement (X paid Y back). The Worker enforces the
 * receiver-only invariant (`toUid` must equal the caller's uid) so
 * `settledBy` is derived server-side from the verified Firebase token
 * -- not accepted from the client. `amountMinor` arrives already as an
 * integer minor-unit value (the caller derives it via parseMoneyToMinor
 * at the form boundary), matching the Worker's `z.number().int()` schema.
 *
 * `vars.settlementId` is minted at the call site (see
 * CreateSettlementVariables) so the Worker's `currentDocument.exists
 * = false` precondition gives genuine create-only semantics: any
 * future replay of the same payload (e.g. a user-clicked retry CTA
 * reusing the same mutation variables) reaches the existing-doc
 * payload-match check inside the Worker tx and returns idempotently
 * without a duplicate write. workerFetch itself does NOT retry —
 * 5xx / AbortError throw WorkerAmbiguous, 4xx throw WorkerRejected.
 *
 * No Storage side effect to roll back, so we don't need the
 * expense/booking-style WorkerRejected vs WorkerAmbiguous fork: any
 * error surfaces through the global MutationCache.onError → toast.
 */
export async function createSettlement(
  tripId: string,
  vars:   CreateSettlementVariables,
): Promise<void> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()

  await workerFetch(workerBase, idToken, '/settlement-create', {
    tripId,
    settlementId: vars.settlementId,
    fromUid:      vars.fromUid,
    toUid:        vars.toUid,
    amountMinor:  vars.amountMinor,
    currency:     vars.currency,
    ...(vars.note ? { note: vars.note } : {}),
  })
}

/**
 * Delete a settlement. Worker enforces recorder-or-owner gating
 * (matches the existing rule); missing-doc is treated as success
 * (idempotent) so a double-tap from optimistic UI doesn't surface
 * a 404.
 */
export async function deleteSettlement(tripId: string, id: string): Promise<void> {
  const workerBase = requireWorkerWriteBase()
  const idToken    = await preflightIdToken()
  await workerFetch(workerBase, idToken, '/settlement-delete', {
    tripId, settlementId: id,
  })
}

export const settlementKeys = {
  all: (tripId: string, _uid?: string) => ['settlements', tripId] as const,
}
