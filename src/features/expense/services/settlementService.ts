// src/features/expense/services/settlementService.ts
// Realtime read + Worker-authoritative write for
// trips/{tripId}/settlements/{id}. See src/types/settlement.ts for the
// entity model and why this is treated as a reverse-expense by
// computeBalances.
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
// core invariant `amountMinor == Worker-computed pair-remaining` can't be
// expressed in firestore.rules (no array reduce / cross-doc sum in CEL).
// The Worker re-derives gross → applied → remaining inside a single tx,
// writes amountMinor = remaining (Phase 4.1 ledger truth — full clear of
// the suggested debt, both TRIP and FOREIGN modes), guards concurrent
// same-pair creates with a per-pair lock doc, and fail-closes on read-cap
// truncation. See workers/ocr/src/settlement-write.ts.
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
  type CreateTripSettlementInput,
  type CreateForeignSettlementInput,
  SettlementDocSchema,
} from '@/types/settlement'

/**
 * Variables required to record a settlement. Discriminated by `mode`
 * (carried on the embedded `CreateXxxSettlementInput`):
 *
 *   - The base `CreateTripSettlementInput` / `CreateForeignSettlementInput`
 *     carries intent plus `expectedRemainingMinor`. The amount is not a
 *     ledger input; Worker uses it only to reject stale confirmations
 *     when the pair balance changed after the sheet opened.
 *   - `settlementId` — minted at the call site (see ExpensePage.tsx) so
 *     the optimistic cache row, the Worker request, and the resulting
 *     Firestore doc all share one id. Memory:
 *     [[settlement-id-hoist-load-bearing]] — moving id-minting back
 *     into the service breaks the realtime listener's atomic row swap.
 *   - `optimistic` — page-derived preview values for the optimistic
 *     cache row only. NEVER sent on the wire; the Worker derives its
 *     own authoritative canonical from pair-remaining. Branch-specific
 *     shape (see `OptimisticTripPatch` / `OptimisticForeignPatch`):
 *     FOREIGN MUST carry `sourceAmountMinor`, TRIP MUST NOT — type-
 *     level rule keeps callers from inserting a foreign row with an
 *     undefined source-side display.
 */
/** Conservative pending lock set for the optimistic-create window: ids of
 *  the pair's debt expenses (both directions), computed by the page. The
 *  Worker computes the precise lock set (forward sources ∪ reverse offset)
 *  and writes each expense's settlementLockIds, but until that commit + the
 *  expense listener propagate, ExpensePage's readonly union reads THIS off
 *  the optimistic settlement row so a non-owner can't briefly edit a source
 *  expense (which would then 403 on save). Over-approximation is safe — the
 *  realtime listener swaps in the server's exact appliedExpenseIds.
 *
 *  Top-level (not inside `optimistic`) on purpose: nesting it in the
 *  discriminated TRIP/FOREIGN `optimistic` would force a per-mode narrow at
 *  the mutate call-site. Here the page just spreads `{ ...submit,
 *  pendingAppliedExpenseIds }` purely. */
type WithPendingLock = { pendingAppliedExpenseIds?: string[] }

export type CreateTripSettlementVariables = CreateTripSettlementInput & WithPendingLock & {
  settlementId: string
  optimistic:   OptimisticTripPatch
}

export type CreateForeignSettlementVariables = CreateForeignSettlementInput & WithPendingLock & {
  settlementId: string
  optimistic:   OptimisticForeignPatch
}

export type CreateSettlementVariables =
  | CreateTripSettlementVariables
  | CreateForeignSettlementVariables

/**
 * Page-derived preview for the optimistic patch row. Phase 4.1 ledger
 * truth: `amountMinor` is ALWAYS `suggestion.amountMinor` (= pair-
 * remaining) for BOTH modes, because Worker also writes
 * `amountMinor = remaining`. FX is decoupled — it only populates the
 * source-side display.
 *
 *   - TRIP mode:    `amountMinor = suggestion.amountMinor`,
 *                   `currency    = tripCurrency`.
 *                   `sourceAmountMinor` is FORBIDDEN at the type level
 *                   (`?: never`) — there is no foreign source to display.
 *   - FOREIGN mode: `amountMinor = suggestion.amountMinor` (same as TRIP),
 *                   `currency    = tripCurrency`,
 *                   `sourceAmountMinor = useFxPreview's
 *                   estimateSourceMinorAtMostTargetHalfEven(suggestion)`
 *                   (display + audit only, NOT a ledger input). REQUIRED
 *                   — without it the optimistic foreign row would render
 *                   "undefined" in the source-side column until the
 *                   listener swap landed.
 *
 * The realtime listener swap replaces this row with the server's once
 * the commit lands. amountMinor will match exactly (both sides write
 * remaining); foreign sourceAmountMinor may diverge by 1-2 minor units
 * if the Worker's FX rate freshness differs from the client preview.
 */
interface OptimisticPatchBase {
  amountMinor: number
  currency:    string
}

export interface OptimisticTripPatch extends OptimisticPatchBase {
  /** Forbidden in TRIP mode: there is no foreign source amount to
   *  display. `?: never` makes a callsite that smuggles one a compile
   *  error rather than a silent runtime no-op. */
  sourceAmountMinor?: never
}

export interface OptimisticForeignPatch extends OptimisticPatchBase {
  /** Required in FOREIGN mode: the receiver's source-currency receipt
   *  amount, computed by useFxPreview's atMost inverse. Persisted
   *  alongside the ledger amountMinor for display + audit; NEVER a
   *  ledger input (Worker re-derives authoritatively at tx time). */
  sourceAmountMinor: number
}

export type OptimisticSettlementPatch = OptimisticTripPatch | OptimisticForeignPatch

/** Defensive cap — long trips with many splits accumulate settlement
 *  records over time. 200 covers a 14-day group trip with margin. */
const LIST_LIMIT = 200

function settlementFromDoc(d: QueryDocumentSnapshot): SettlementRecord {
  return firestoreDocFromSchema(SettlementDocSchema, d, 'settlementFromDoc')
}

export async function getSettlementsByTrip(tripId: string): Promise<SettlementRecord[]> {
  const { db, collection, query, where, orderBy, limit, getDocs } = await getFirebase()
  const q = query(
    collection(db, ...P.settlements(tripId)),
    where('deletedAt', '==', null),
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
  buildQuery: ({ db, collection, query, where, orderBy, limit }) => query(
    collection(db, ...P.settlements(tripId)),
    where('deletedAt', '==', null),
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
 * -- not accepted from the client.
 *
 * Phase 4.1 rearchitecture (2026-06-02): the payload is a
 * stale-confirmed intent. `expectedRemainingMinor` is only the UI's
 * view of the remaining debt when the sheet opened; Worker recomputes
 * pair-remaining inside the tx, rejects stale confirmations, and writes
 * `amountMinor = remaining` for BOTH modes — 「済み」 always clears the
 * entire suggested debt. FOREIGN additionally inverse-derives
 * `sourceAmountMinor` via at-most policy for display/audit (persisted
 * alongside `fxSnapshot.convertedAmountMinor`, which is the FX forward
 * result and may be ≤ amountMinor by a few minor units due to half-even
 * rounding plateaus — intentionally decoupled from the ledger).
 *
 * The entire OVERPAY class is eliminated by construction because there's
 * no client-supplied amount to be too large; the partial-clear class
 * (FX rounding leaving a few-yen tail) is eliminated because the ledger
 * always consumes remaining, regardless of FX artifacts.
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

  // Wire body shape is a thin pass-through of the discriminated input.
  // `expectedRemainingMinor` is a stale-confirmation guard only; Worker
  // still derives canonical amountMinor from pair-remaining in its tx.
  if (vars.mode === 'TRIP_CURRENCY') {
    await workerFetch(workerBase, idToken, '/settlement-create', {
      mode:                   'TRIP_CURRENCY' as const,
      tripId,
      settlementId:           vars.settlementId,
      fromUid:                vars.fromUid,
      toUid:                  vars.toUid,
      expectedRemainingMinor: vars.expectedRemainingMinor,
      ...(vars.note ? { note: vars.note } : {}),
    })
    return
  }
  await workerFetch(workerBase, idToken, '/settlement-create', {
    mode:                   'FOREIGN_CURRENCY' as const,
    tripId,
    settlementId:           vars.settlementId,
    fromUid:                vars.fromUid,
    toUid:                  vars.toUid,
    expectedRemainingMinor: vars.expectedRemainingMinor,
    sourceCurrency:         vars.sourceCurrency,
    settledOn:              vars.settledOn,
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
