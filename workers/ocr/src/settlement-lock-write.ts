// workers/ocr/src/settlement-lock-write.ts
// Pair-contention + expense-lock domain for the settlement-write endpoints.
// Two concerns live here because they share the same contention model and
// the same create/delete symmetry obligation:
//
//   1. The per-unordered-pair LOCK doc (pairKey / pairLockPath /
//      buildLockWrite) that serializes concurrent same-pair create/delete.
//   2. The per-expense settlementLockIds REFERENCE SET — the materialized
//      union that makes `settlementLockIds.length > 0` the single source of
//      truth for the post-settlement edit lock. buildExpenseSettlementLockWrites
//      ADDS this settlement's id on create; buildExpenseUnlockWrites REMOVES
//      it on delete. Keeping both builders in one module makes the
//      create/delete symmetry auditable in one place (delete must release
//      exactly what create locked), which the lock spec pins.
//
// Split out of settlement-write.ts (boundary extraction). Pure write/string
// builders — no tx I/O, no network. The orchestrator does the in-tx reads
// (pair lock + applied expenses) and hands the decoded docs here.
import {
  docResourceName,
  type TxWrite,
  type TxReadDoc,
}                                          from './firestore-tx'
import { type FsValue }                    from './firestore'

// ─── Pair-key / Pair-lock path ────────────────────────────────────

/** Deterministic unordered pair key for the pair-LOCK doc id. Settlement
 *  docs themselves are read by (fromUid,toUid) equality, NOT by a stored
 *  pairKey field — see the read fan-out in doCreate for why that's the
 *  migration-safe choice. The lock serializes same-pair create/delete so
 *  two concurrent creates on the same pair conflict on a shared doc.
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
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return `${lo.length}:${lo}:${hi.length}:${hi}`
}
export function pairLockPath(tripId: string, a: string, b: string): string {
  return `trips/${tripId}/settlementPairLocks/${pairKey(a, b)}`
}

/** Build the lock-doc write that "touches" the pair guard. Same shape
 *  for create + delete: stamp the latest settlement id + REQUEST_TIME.
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

export function encodeStringArray(values: string[]): FsValue {
  return {
    arrayValue: {
      values: values.map(value => ({ stringValue: value })),
    },
  }
}

export function decodeStringArrayField(fields: Record<string, FsValue> | undefined, key: string): string[] {
  const arr = (fields?.[key] as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  return arr
    .map(v => (v as { stringValue?: string }).stringValue)
    .filter((s): s is string => typeof s === 'string')
}

// ─── Expense settlementLockIds writes (create + delete symmetry) ──

/** Add `settlementId` to each applied expense's `settlementLockIds`
 *  reference set (materialized union). `settlementLockIds.length > 0` is
 *  the single source of truth for the post-settlement edit lock. The
 *  applied expenses are already in the create tx's read/conflict set, so
 *  a concurrent settlement touching the SAME shared expense aborts + retries
 *  — making this read-modify-write race-safe (no lost update). Cross-pair
 *  correct: an expense shared by >2 people accumulates one id per
 *  referencing settlement and stays locked until the last is removed. */
export function buildExpenseSettlementLockWrites(
  projectId:      string,
  tripId:         string,
  expenseIds:     string[],
  settlementId:   string,
  currentLockIds: Map<string, string[]>,
): TxWrite[] {
  return expenseIds.map(expenseId => {
    const existing = currentLockIds.get(expenseId) ?? []
    const next = existing.includes(settlementId) ? existing : [...existing, settlementId]
    return {
      document:        docResourceName(projectId, `trips/${tripId}/expenses/${expenseId}`),
      fields:          { settlementLockIds: encodeStringArray(next) },
      updateMask:      ['settlementLockIds'],
      currentDocument: { exists: true },
    }
  })
}

/** Release `settlementId` from every applied expense's `settlementLockIds`
 *  reference set — the delete-side mirror of buildExpenseSettlementLockWrites.
 *  The orchestrator reads each applied expense IN-TX (so a concurrent
 *  settlement create/delete on the same expense conflicts + retries — no
 *  lost update) and passes the read docs here, positionally aligned with
 *  `expenseIds`. An expense stays locked while OTHER settlements still
 *  reference it (their ids remain in the set) — cross-pair correct with NO
 *  global ARRAY_CONTAINS scan, because each settlement only ever owns its
 *  own id. */
export function buildExpenseUnlockWrites(
  projectId:         string,
  tripId:            string,
  settlementId:      string,
  expenseIds:        string[],
  lockedExpenseDocs: TxReadDoc[],
): TxWrite[] {
  const writes: TxWrite[] = []
  for (let i = 0; i < expenseIds.length; i++) {
    const doc = lockedExpenseDocs[i]
    if (!doc || !doc.exists) continue   // expense already gone (e.g. cascade) — nothing to unlock
    const existing = decodeStringArrayField(doc.fields, 'settlementLockIds')
    if (!existing.includes(settlementId)) continue   // not referenced — leave untouched
    writes.push({
      document:        docResourceName(projectId, `trips/${tripId}/expenses/${expenseIds[i]}`),
      fields:          { settlementLockIds: encodeStringArray(existing.filter(id => id !== settlementId)) },
      updateMask:      ['settlementLockIds'],
      // exists:true so a transform onto a concurrently-deleted expense
      // can't resurrect it as a stub; 412 → retry → the exists check above
      // then skips it.
      currentDocument: { exists: true },
    })
  }
  return writes
}
