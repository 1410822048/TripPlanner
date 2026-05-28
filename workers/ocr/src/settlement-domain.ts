// workers/ocr/src/settlement-domain.ts
// Pair-level settlement math, Worker-side.
//
// Mirrors steps 1-4 of `computeBalancesFull` in
// `src/features/expense/services/settlement.ts`. Scope kept tight:
// the Worker only needs the normalized remaining debt edge for a
// SINGLE pair (`pairwise[fromUid][toUid]`) to gate
// `settlement.amount <= remaining`. The per-member `net` /
// chronological orphan-reason replay live on the client (display-time
// concerns; the Worker doesn't display anything).
//
// Why duplicated instead of imported from `src/...`:
//   1. The Worker runs on Cloudflare's V8 isolate; importing from
//      `../../src` cross-package would drag in the TanStack / Firebase
//      SDK fans that the Worker can't bundle.
//   2. Keeping them separate but cross-checked is the design tradeoff
//      — every meaningful fixture case lives in BOTH this module's
//      test (`settlement-domain.test.ts`) AND the client's
//      (`settlement.test.ts`), so any drift in semantics fails one
//      side of the cross-check first.
//
// The hardrule that lives only in the Worker: settlement.amount must
// be <= pairwise[fromUid][toUid] at the moment of create. firestore.rules
// cannot express this (would require reading + summing across other
// docs), so the gate would otherwise be client-only and bypassable.

/** Per the algorithm comment in settlement.ts: |fwd - bwd| <= EPS
 *  collapses to "no edge". Same constant on purpose so cross-check
 *  fixtures agree on the rounding boundary. */
const EPS = 0.5

/** Minimal expense shape the math needs. Caller decodes from
 *  Firestore (settlement-write.ts) and pre-filters out soft-deleted
 *  rows (`deletedAt != null`) before passing in — the math is "active
 *  state at this moment", deleted expenses don't contribute to gross.
 *  Phase-2 chronological replay lives on the client; the Worker only
 *  cares about the current debt picture for the create-time gate. */
export interface DomainExpense {
  amount: number
  paidBy: string
  splits: Array<{ memberId: string; amount: number }>
}

/** Minimal settlement shape. `createdAtMs` is the millisecond epoch
 *  used for deterministic ordering — Worker reads it off the Firestore
 *  `createdAt` Timestamp. Ordering matters: "earlier settlement
 *  consumes available debt first, later settlement sees less"; without
 *  sort the per-settlement leftover would jitter across reads and
 *  the create-gate would be non-deterministic. */
export interface DomainSettlement {
  fromUid:     string
  toUid:       string
  amount:      number
  createdAtMs: number
}

/** Same input self-defense as the client (`isExpenseSettlementSafe`).
 *  Identical filter logic so dirty docs that somehow slipped past
 *  Worker validation produce identical "skip" behaviour on both sides
 *  of the cross-check, instead of one side seeing a NaN-poisoned
 *  pairwise and the other not. */
function isExpenseSettlementSafe(e: DomainExpense): boolean {
  if (!Number.isFinite(e.amount) || e.amount < 0) return false
  if (typeof e.paidBy !== 'string' || e.paidBy === '') return false
  if (!Array.isArray(e.splits)) return false
  for (const s of e.splits) {
    if (typeof s.memberId !== 'string' || s.memberId === '') return false
    if (!Number.isFinite(s.amount) || s.amount < 0) return false
  }
  return true
}

function isSettlementSafe(s: DomainSettlement): boolean {
  if (!Number.isFinite(s.amount) || s.amount <= 0) return false
  if (typeof s.fromUid !== 'string' || s.fromUid === '') return false
  if (typeof s.toUid   !== 'string' || s.toUid   === '') return false
  if (s.fromUid === s.toUid) return false
  return true
}

function ensureSlot<T>(
  record: Record<string, Record<string, T>>,
  key:    string,
): Record<string, T> {
  return record[key] ?? (record[key] = {})
}

/**
 * Step-4 normalized remaining debt edges. `pairwise[from][to] =
 * amount` is the outstanding pair debt after settlement application
 * and opposite-direction cancellation. Identical algorithm to
 * `computeBalancesFull` in the client; the cross-check tests
 * (`settlement-domain.test.ts` + `settlement.test.ts`) enforce
 * fixture-for-fixture equality.
 *
 * Inputs:
 *   - `expenses`: caller pre-filters out soft-deleted (the Worker
 *     read query applies `deletedAt IS_NULL` so this filter is
 *     belt-and-suspenders here).
 *   - `settlements`: caller passes the FULL settlement list, this
 *     function does the sort. The client (Phase 2) sorts internally
 *     for the same reason — leaving sort to the caller is a stable
 *     way to introduce non-determinism.
 */
export function computePairwiseRemaining(
  expensesRaw:    DomainExpense[],
  settlementsRaw: DomainSettlement[],
): Record<string, Record<string, number>> {
  const expenses    = expensesRaw.filter(isExpenseSettlementSafe)
  const settlements = settlementsRaw.filter(isSettlementSafe)

  // Step 1: gross[from][to] from expenses.
  const gross: Record<string, Record<string, number>> = {}
  const addGross = (from: string, to: string, amount: number) => {
    if (from === to) return
    const slot = ensureSlot(gross, from)
    slot[to] = (slot[to] ?? 0) + amount
  }
  for (const e of expenses) {
    for (const s of e.splits) {
      addGross(s.memberId, e.paidBy, s.amount)
    }
  }

  // Step 2: settlements cap at gross per pair, sorted by createdAtMs
  // so "earlier first" is deterministic (and identical to the client).
  const sortedSettlements = [...settlements].sort((a, b) => a.createdAtMs - b.createdAtMs)
  const applied: Record<string, Record<string, number>> = {}
  for (const st of sortedSettlements) {
    const debt = gross[st.fromUid]?.[st.toUid] ?? 0
    const appliedSlot = ensureSlot(applied, st.fromUid)
    const already = appliedSlot[st.toUid] ?? 0
    const usable = Math.min(st.amount, Math.max(0, debt - already))
    appliedSlot[st.toUid] = already + usable
    // Leftover (orphan) is tracked on the client side; Worker doesn't
    // need it for the create gate. The create gate uses pairwise
    // remaining (post-normalize) only.
  }

  // Step 3: remaining = max(0, gross - applied)
  const remaining: Record<string, Record<string, number>> = {}
  for (const from of Object.keys(gross)) {
    const grossRow = gross[from]!
    for (const to of Object.keys(grossRow)) {
      const rest = Math.max(0, (grossRow[to] ?? 0) - (applied[from]?.[to] ?? 0))
      if (rest > EPS) ensureSlot(remaining, from)[to] = rest
    }
  }

  // Step 4: normalize opposite-direction edges. Same pair-key
  // construction as the client (lexicographic) so the surviving
  // direction is deterministic.
  const normalized: Record<string, Record<string, number>> = {}
  const seenPair = new Set<string>()
  for (const from of Object.keys(remaining)) {
    for (const to of Object.keys(remaining[from]!)) {
      const key = from < to ? `${from}|${to}` : `${to}|${from}`
      if (seenPair.has(key)) continue
      seenPair.add(key)
      const fwd = remaining[from]?.[to] ?? 0
      const bwd = remaining[to]?.[from] ?? 0
      if (fwd - bwd > EPS) ensureSlot(normalized, from)[to] = fwd - bwd
      else if (bwd - fwd > EPS) ensureSlot(normalized, to)[from] = bwd - fwd
    }
  }
  return normalized
}

/** Convenience: extract pair remaining safely. Returns 0 when the pair
 *  has no normalized edge (no debt or both-sides cancelled). The
 *  Worker gate compares `req.amount` against this. */
export function pairRemaining(
  pairwise: Record<string, Record<string, number>>,
  fromUid:  string,
  toUid:    string,
): number {
  return pairwise[fromUid]?.[toUid] ?? 0
}

export { EPS as SETTLEMENT_EPS }
