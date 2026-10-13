// workers/ocr/src/settlement-lock-write.ts
// Pair-contention helpers for the settlement endpoints: the per-unordered-
// pair LOCK doc (pairKey / pairLockPath / buildLockWrite) that a route
// create / cancel reads and writes for every edge it touches, so two
// writes over the same pair conflict in Firestore and one retries against
// the other's result. Also the settlementLockIds reference-set codec; the
// per-expense lock writes themselves are built in settlement-route-write.ts
// (one per expense, holding route ids). Pure builders — no tx I/O.
import {
  docResourceName,
  type TxWrite,
}                                          from './firestore-tx'
import { encodeStringArray, readStringArray } from './firestore'
import { canonicalPairKey }                 from '@tripmate/settlement-core'

// ─── Pair-key / Pair-lock path ────────────────────────────────────

/** Deterministic unordered pair key for the pair-LOCK doc id. The lock
 *  serializes create/cancel over the same pair: two routes are different
 *  docs, so without a shared doc they would not conflict in Firestore.
 *
 *  Direction-agnostic via lexicographic min/max ordering (A→B and B→A
 *  share the same key). Storage is bounded (one lock doc per
 *  participating pair).
 *
 *  Encoding: `<lo.length>:<lo>:<hi.length>:<hi>`. Firebase Auth UIDs
 *  use the base64url alphabet `[A-Za-z0-9_-]`, so a naive
 *  `${lo}_${hi}` (or `${lo}__${hi}`) would not be injective:
 *  `{a, b_c}` and `{a_b, c}` both collapse to `a_b_c`. Length prefixes
 *  make every key trivially parseable back to (lo, hi), so collision
 *  is impossible. Worst-case symptom of a collision would be false
 *  contention (unrelated pair serializes through the same lock and
 *  one tx retries) -- not overpay or auth bypass -- but we'd rather
 *  not leave that on the floor for a future reviewer to re-discover.
 *  `:` is a legal Firestore doc-id character (only `/` is banned). */
export function pairKey(a: string, b: string): string {
  // Single definition in settlement-core so client and Worker can never
  // disagree on which lock doc a pair maps to.
  return canonicalPairKey(a, b)
}
export function pairLockPath(tripId: string, a: string, b: string): string {
  return `trips/${tripId}/settlementPairLocks/${pairKey(a, b)}`
}

/** Build the lock-doc write that "touches" the pair guard. Same shape
 *  for create + delete: stamp the latest route id + REQUEST_TIME.
 *  No `currentDocument` precondition -- the doc is lazily created on
 *  the first settlement for the pair and persists thereafter (cascade
 *  is responsible for cleanup). */
export function buildLockWrite(projectId: string, lockPath: string, settlementId: string): TxWrite {
  return {
    document: docResourceName(projectId, lockPath),
    fields:   {
      lastSettlementId: { stringValue: settlementId },
    },
    updateTransforms: [
      { fieldPath: 'lastSettlementAt', setToServerValue: 'REQUEST_TIME' },
    ],
  }
}

// ─── settlementLockIds reference-set (de/encode) ──────────────────

// Shared REST codecs; the lock-specific names stay as aliases for callers.
export { encodeStringArray }
export const decodeStringArrayField = readStringArray
