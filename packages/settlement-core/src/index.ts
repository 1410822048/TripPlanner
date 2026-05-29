// @tripmate/settlement-core — single source of truth for the
// pairwise-debt domain primitives shared between the React client and
// the Cloudflare Worker.
//
// Scope is deliberately narrow: pairwise remaining + pair-safe apply +
// canonical pair-key + EPS. UI-only logic (orphan-reason chronological
// replay, ghost members, suggestion ordering) stays in the client;
// Worker-only logic (Firestore REST decode, transactions, auth) stays
// in the Worker. The core only handles plain data in / plain data out
// — no Firebase, no Firestore Timestamp, no async, no side effects.
//
// Money domain: every `amountMinor` here is integer minor units, per
// the money refactor. The math is integer-friendly but doesn't enforce
// Number.isInteger — callers (client / Worker) already validate at
// their Zod boundaries; the SETTLEMENT_EPS is kept defensively for
// any pre-refactor rounding residue that hasn't been flushed yet.
//
// Why this exists:
//   Before this package, `src/features/expense/services/settlement.ts`
//   and `workers/ocr/src/settlement-domain.ts` carried mirrored copies
//   of the pairwise math + an 8-fixture cross-check suite to detect
//   drift. Two independent impls catching divergence in CI was the
//   safety mechanism. Collapsing them into one shared implementation
//   removes the drift surface entirely — the cross-check fixtures live
//   here once and exercise the canonical function.

// ─── Public types ─────────────────────────────────────────────────

/** Minimum expense shape the math needs. Callers (client / Worker) adapt
 *  their richer entity types into this. `splits[].memberId == paidBy`
 *  rows are no-op (self-debt) and stripped during gross accumulation.
 *  Soft-deleted expenses MUST be pre-filtered by the caller — the math
 *  represents "active state at this moment" and is unaware of the
 *  `deletedAt` field. */
export interface CoreExpense {
  amountMinor: number
  paidBy:      string
  splits:      Array<{ memberId: string; amountMinor: number }>
}

/** Minimum settlement shape. `createdAtMs` is the millisecond epoch used
 *  for deterministic ordering — "earlier settlement consumes available
 *  debt first, later settlement sees less". Without this ordering the
 *  per-settlement leftover would jitter across reads and the Worker
 *  create-gate would be non-deterministic. Callers convert from their
 *  native timestamp shape:
 *    - client:  `record.createdAt.toMillis()`
 *    - Worker:  decoded from Firestore REST `timestampValue` → epoch ms */
export interface CoreSettlement {
  fromUid:     string
  toUid:       string
  amountMinor: number
  createdAtMs: number
}

// ─── Public constants ─────────────────────────────────────────────

/** Rounding epsilon for "no debt" / "edges collapse" decisions. Anything
 *  with absolute value ≤ EPS is treated as zero. Post-money-refactor all
 *  amounts are integer minor units, so this is mostly defensive — kept
 *  the same value on both sides of the trust boundary as the invariant
 *  that lets the Worker create-gate (`amount <= remaining`) agree with
 *  the client UI suggestion list to the cent. */
export const SETTLEMENT_EPS = 0.5

/** Canonical, order-independent identifier for an unordered pair of
 *  uids. Used by step 4 normalize to dedupe pair visits, and exported
 *  so the Worker per-pair lock doc can key on the same string the math
 *  uses (no second source of truth for "what's a pair").
 *
 *  Encoding: length-prefix `${lo.length}:${lo}:${hi.length}:${hi}` —
 *  collision-proof for any string content, because length boundaries
 *  are unambiguous regardless of what characters the ids contain. A
 *  naive `${lo}|${hi}` would collide when an id itself contains the
 *  separator (e.g. `{a|b, c}` vs `{a, b|c}` both flatten to `a|b|c`).
 *  Worker pair-lock doc ids use the same shape so this key is the
 *  single source of truth across math + storage. */
export function canonicalPairKey(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return `${lo.length}:${lo}:${hi.length}:${hi}`
}

// ─── Public guards ────────────────────────────────────────────────

/** Sanity gate: settlement is safe to feed into the cap loop iff
 *  amountMinor is finite + strictly positive, both uids are non-empty
 *  strings, and the pair isn't self-debt. Caller passes the FULL
 *  settlement list and the math filters internally; exporting the guard
 *  lets the Worker reject malformed settlements with a 400 BEFORE running
 *  the math, so the surface produces the same accept/reject decision
 *  either way. */
export function isSettlementSafe(s: CoreSettlement): boolean {
  if (!Number.isFinite(s.amountMinor) || s.amountMinor <= 0) return false
  if (typeof s.fromUid !== 'string' || s.fromUid === '')     return false
  if (typeof s.toUid   !== 'string' || s.toUid   === '')     return false
  if (s.fromUid === s.toUid)                                 return false
  return true
}

// ─── Internal helpers ─────────────────────────────────────────────

/** Lazy-create `record[key]` as an empty sub-map and return it for
 *  in-place writes. Replaces the repeated `record[k] ?? (record[k] = {})`
 *  fallback-assign idiom across the gross/applied/remaining/normalized
 *  pairwise maps. */
function ensureSlot<T>(
  record: Record<string, Record<string, T>>,
  key:    string,
): Record<string, T> {
  return record[key] ?? (record[key] = {})
}

/** Same self-defense as `isSettlementSafe` for expenses. Worker write
 *  validation enforces these constraints on the create path, but the
 *  settlement engine is downstream of a SEPARATE trust boundary — a
 *  doc that predates Worker validation, a manual Firestore Console
 *  edit, or a future Worker bug could otherwise inject NaN/Infinity
 *  into the gross[][] tables and propagate "NaN ¥" through every
 *  settlement card. Internal: callers don't need the predicate, they
 *  just pass raw lists and the math filters silently. */
function isExpenseSettlementSafe(e: CoreExpense): boolean {
  if (!Number.isFinite(e.amountMinor) || e.amountMinor < 0) return false
  if (typeof e.paidBy !== 'string' || e.paidBy === '')      return false
  if (!Array.isArray(e.splits))                             return false
  for (const s of e.splits) {
    if (typeof s.memberId !== 'string' || s.memberId === '')   return false
    if (!Number.isFinite(s.amountMinor) || s.amountMinor < 0)  return false
  }
  return true
}

// ─── Public algorithm ─────────────────────────────────────────────

/**
 * Step-4 normalized remaining debt edges:
 * `pairwise[from][to] = amountMinor` represents the real outstanding pair
 * debt after settlement application AND opposite-direction cancellation.
 *
 * Used by:
 *   - client `computeBalancesFull` to drive the SettlementSummary
 *     suggestion list (each edge → one suggested transfer)
 *   - Worker `/settlement-create` to gate `amount <= remaining[from][to]`
 *
 * Both sides reading the same edges out of the same function is what
 * makes "UI suggestion matches Worker accept" hold without a separate
 * cross-check fixture suite.
 *
 * Algorithm:
 *   1. gross[from][to] = Σ split.amountMinor where split.memberId = from
 *                        and expense.paidBy = to (self-debt stripped).
 *   2. settlements sorted by createdAtMs, then capped at gross per
 *      pair: applied += min(amountMinor, max(0, gross - already_applied)).
 *      The leftover (overflow) is NOT returned here — the client owns
 *      orphan-reason classification via its chronological replay.
 *   3. remaining = max(0, gross - applied) per directed edge.
 *   4. normalize: for each unordered pair (a, b), only the larger-
 *      direction edge survives with the difference; collapses when
 *      |fwd - bwd| ≤ EPS.
 *
 * Complexity: O(E·S + N²) where E = active expenses, S = avg splits/
 * expense, N = participants. Trip-scale (E ≤ 200, S ≤ 6, N ≤ 8) is
 * sub-millisecond.
 */
export function computePairwiseRemaining(
  expensesRaw:    CoreExpense[],
  settlementsRaw: CoreSettlement[],
): Record<string, Record<string, number>> {
  const expenses    = expensesRaw.filter(isExpenseSettlementSafe)
  const settlements = settlementsRaw.filter(isSettlementSafe)

  // Step 1: gross
  const gross: Record<string, Record<string, number>> = {}
  for (const e of expenses) {
    for (const s of e.splits) {
      if (s.memberId === e.paidBy) continue
      const slot = ensureSlot(gross, s.memberId)
      slot[e.paidBy] = (slot[e.paidBy] ?? 0) + s.amountMinor
    }
  }

  // Step 2: settlements cap at gross per pair, ordered by createdAtMs.
  // Stable sort: ties preserve input order, so callers can break ties
  // by passing settlements in a deterministic order (Firestore queries
  // sort by createdAt-then-id; that secondary key flows through here
  // implicitly via Array.prototype.sort's stability).
  const sortedSettlements = [...settlements].sort((a, b) => a.createdAtMs - b.createdAtMs)
  const applied: Record<string, Record<string, number>> = {}
  for (const st of sortedSettlements) {
    const debt        = gross[st.fromUid]?.[st.toUid] ?? 0
    const appliedSlot = ensureSlot(applied, st.fromUid)
    const already     = appliedSlot[st.toUid] ?? 0
    const usable      = Math.min(st.amountMinor, Math.max(0, debt - already))
    appliedSlot[st.toUid] = already + usable
  }

  // Step 3: remaining = max(0, gross - applied), drop ≤ EPS edges
  const remaining: Record<string, Record<string, number>> = {}
  for (const from of Object.keys(gross)) {
    const grossRow = gross[from]!
    for (const to of Object.keys(grossRow)) {
      const rest = Math.max(0, (grossRow[to] ?? 0) - (applied[from]?.[to] ?? 0))
      if (rest > SETTLEMENT_EPS) ensureSlot(remaining, from)[to] = rest
    }
  }

  // Step 4: normalize opposite-direction edges using canonicalPairKey
  // so each unordered pair is visited once. The surviving direction is
  // the larger one; |fwd - bwd| ≤ EPS collapses to no edge.
  const normalized: Record<string, Record<string, number>> = {}
  const seenPair = new Set<string>()
  for (const from of Object.keys(remaining)) {
    for (const to of Object.keys(remaining[from]!)) {
      const key = canonicalPairKey(from, to)
      if (seenPair.has(key)) continue
      seenPair.add(key)
      const fwd = remaining[from]?.[to] ?? 0
      const bwd = remaining[to]?.[from] ?? 0
      if      (fwd - bwd > SETTLEMENT_EPS) ensureSlot(normalized, from)[to] = fwd - bwd
      else if (bwd - fwd > SETTLEMENT_EPS) ensureSlot(normalized, to)[from] = bwd - fwd
    }
  }
  return normalized
}

/** Convenience accessor: returns the directed remaining debt amount for
 *  the (fromUid → toUid) edge, or 0 when the pair has no normalized
 *  edge (no debt or both-sides cancelled). The Worker settlement-create
 *  gate compares `req.amountMinor` against this; the client suggestion
 *  list reads it per-row to format the proposed transfer. */
export function pairRemaining(
  pairwise: Record<string, Record<string, number>>,
  fromUid:  string,
  toUid:    string,
): number {
  return pairwise[fromUid]?.[toUid] ?? 0
}
