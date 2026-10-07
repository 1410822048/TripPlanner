// src/features/expense/services/settlementOrphanReason.ts
// Orphan-reason classification — the UI explanation layer on top of the
// debt-edge settlement math, split out of settlement.ts. NOT core debt
// accounting: it answers "WHY is this settlement unmatched?" via a
// chronological replay over (expense create/delete + settlement) events,
// so SettlementSummary can show a reason-specific warning banner.
//
// Standalone by design — imports only @tripmate/settlement-core + types,
// never settlement.ts, so there's no import cycle (settlement.ts imports
// buildOrphanReasonMap / classifyOrphan from here). It keeps its own tiny
// `ensureSlot` copy rather than sharing settlement.ts's: a 4-line generic
// helper isn't worth a cross-import or a shared micro-module.
import { SETTLEMENT_EPS } from '@tripmate/settlement-core'
import type { Expense } from '@/types'
import type { SettlementRecord } from '@/types/settlement'

/**
 * Reason this settlement is orphan. Classified by chronological replay
 * over expense create/delete events plus settlements (phase-2 work).
 *
 *   OVERPAYMENT     — at settlement.createdAt, the settlement amount
 *                     already exceeded available debt. Pure case: the
 *                     full leftover was excess from day one.
 *   EXPENSE_DELETED — at settlement.createdAt, the settlement fit
 *                     within available debt. Pure case: orphan exists
 *                     entirely because a subsequent soft-delete
 *                     reduced gross after the fact.
 *   MIXED           — settlement was partly over at recording AND a
 *                     subsequent delete shrunk what was within. Both
 *                     causes contribute to the leftover; the per-row
 *                     amount can't be cleanly attributed to one.
 *   EXPENSE_CHANGED — an expense involving this pair was EDITED after the
 *                     settlement was recorded (owner may edit settlement-
 *                     locked expenses). The replay only knows each
 *                     expense's CURRENT splits, so it can't reconstruct
 *                     the debt as it stood at recording; without this
 *                     reason such cases were mislabelled OVERPAYMENT —
 *                     which the Worker (amount = remaining) can no longer
 *                     actually produce.
 *   UNKNOWN         — at settlement.createdAt, no expense was recorded
 *                     on this pair (gross == 0). Defensive should-
 *                     never-happen guard: with `allow delete: if false`
 *                     on expenses and the Worker trip-cascade deleting
 *                     settlements alongside their expenses, there's
 *                     no remaining path that produces this state for
 *                     data-at-rest. Kept as a catch-all so future
 *                     unexpected admin writes / data corruption surface
 *                     visibly instead of silently masquerading as a
 *                     different reason.
 */
export type OrphanReason = 'OVERPAYMENT' | 'EXPENSE_DELETED' | 'EXPENSE_CHANGED' | 'MIXED' | 'UNKNOWN'

/** Lazy-create `record[key]` as an empty sub-map and return it for in-place
 *  writes. Local copy of settlement.ts's helper — see the file header for
 *  why it's duplicated rather than shared. */
function ensureSlot<T>(
  record: Record<string, Record<string, T>>,
  key:    string,
): Record<string, T> {
  return record[key] ?? (record[key] = {})
}

/**
 * Per-settlement state captured at its recording time by the
 * chronological replay. Combined with the FINAL leftover (computed
 * by the main forward-cap loop) to derive each orphan's `reason`.
 *
 *   atRecording      'NO_EXPENSE' | 'WITHIN' | 'OVER'
 *                    NO_EXPENSE — no expense on this pair at recording
 *                                 (defensive should-never-happen guard;
 *                                 see OrphanReason: UNKNOWN doc)
 *                    WITHIN     — settlement fit available debt at recording
 *                    OVER       — settlement exceeded available debt
 *   overpayment      amount that exceeded available at recording (≥0).
 *                    0 when atRecording != 'OVER'.
 */
interface SettlementReplayInfo {
  atRecording: 'NO_EXPENSE' | 'WITHIN' | 'OVER'
  overpayment: number
  /** A live expense involving either party was updated after recording. */
  editedAfter?: boolean
  /** An expense involving either party was soft-deleted after recording. */
  deletedAfter?: boolean
  /** Lineage-based facts, only for settlements carrying the Worker's
   *  `appliedExpenseIds` / `appliedSources`: the exact expenses the
   *  settlement was applied against. Authoritative over the replay. */
  lineageDeleted?: boolean
  lineageEdited?:  boolean
}

/** Expenses a settlement was applied against, from its Worker lineage. */
function lineageExpenseIds(st: SettlementRecord): string[] {
  if (st.appliedExpenseIds && st.appliedExpenseIds.length > 0) return st.appliedExpenseIds
  return [...new Set((st.appliedSources ?? []).map(s => s.expenseId))]
}

function involves(e: Expense, a: string, b: string): boolean {
  if (e.paidBy === a || e.paidBy === b) return true
  return e.splits.some(sp => sp.memberId === a || sp.memberId === b)
}

/**
 * Chronological replay over (expense create/delete + settlement) events.
 * Returns per-settlement replay state used by the main loop to classify
 * each orphan reason -- including MIXED, when both at-recording
 * overpayment AND a subsequent soft-delete contributed to the leftover.
 *
 * Within the same timestamp: expense_create < expense_delete <
 * settlement, so a settlement recorded at the same ms as an expense
 * create sees the expense as already-applied.
 */
export function buildOrphanReasonMap(
  expenses:    Expense[],
  settlements: SettlementRecord[],
): Map<string, SettlementReplayInfo> {
  type Event =
    | { type: 'expense_create'; ts: number; expense: Expense }
    | { type: 'expense_delete'; ts: number; expense: Expense }
    | { type: 'settlement';     ts: number; settlement: SettlementRecord }

  const events: Event[] = []
  for (const e of expenses) {
    const cMs = e.createdAt?.toMillis?.() ?? 0
    events.push({ type: 'expense_create', ts: cMs, expense: e })
    if (e.deletedAt) {
      const dMs = e.deletedAt.toMillis?.() ?? 0
      events.push({ type: 'expense_delete', ts: dMs, expense: e })
    }
  }
  for (const st of settlements) {
    const stMs = st.createdAt?.toMillis?.() ?? 0
    events.push({ type: 'settlement', ts: stMs, settlement: st })
  }
  const TYPE_ORDER: Record<Event['type'], number> = {
    expense_create: 0, expense_delete: 1, settlement: 2,
  }
  events.sort((a, b) => a.ts - b.ts || TYPE_ORDER[a.type] - TYPE_ORDER[b.type])

  const pairGrossT:   Record<string, Record<string, number>> = {}
  const pairAppliedT: Record<string, Record<string, number>> = {}
  const out = new Map<string, SettlementReplayInfo>()
  const expenseById = new Map(expenses.map(e => [e.id, e]))

  for (const ev of events) {
    if (ev.type === 'expense_create' || ev.type === 'expense_delete') {
      const e    = ev.expense
      const sign = ev.type === 'expense_create' ? +1 : -1
      for (const split of e.splits) {
        if (split.memberId === e.paidBy) continue
        const slot = ensureSlot(pairGrossT, split.memberId)
        slot[e.paidBy] = (slot[e.paidBy] ?? 0) + sign * split.amountMinor
      }
      continue
    }
    const st = ev.settlement
    if (st.fromUid === st.toUid) continue
    const grossT     = pairGrossT[st.fromUid]?.[st.toUid] ?? 0
    const appliedT   = pairAppliedT[st.fromUid]?.[st.toUid] ?? 0
    const availableT = Math.max(0, grossT - appliedT)
    const usableT    = Math.min(st.amountMinor, availableT)
    ensureSlot(pairAppliedT, st.fromUid)[st.toUid] = appliedT + usableT

    let atRecording: SettlementReplayInfo['atRecording']
    let overpayment = 0
    if (grossT < SETTLEMENT_EPS) {
      atRecording = 'NO_EXPENSE'
    } else if (st.amountMinor - availableT > SETTLEMENT_EPS) {
      atRecording = 'OVER'
      overpayment = st.amountMinor - availableT
    } else {
      atRecording = 'WITHIN'
    }
    let editedAfter  = false
    let deletedAfter = false
    for (const e of expenses) {
      if (!involves(e, st.fromUid, st.toUid)) continue
      if (e.deletedAt) {
        if ((e.deletedAt.toMillis?.() ?? 0) > ev.ts) deletedAfter = true
      } else {
        // updatedAt > createdAt: the doc was actually edited (not just
        // created after the settlement, which the replay already models).
        const uMs = e.updatedAt?.toMillis?.() ?? 0
        const cMs = e.createdAt?.toMillis?.() ?? 0
        if (uMs > ev.ts && uMs > cMs) editedAfter = true
      }
    }
    // Lineage (Worker-written since settlement lineage shipped) names the
    // exact expenses this settlement cleared, so it can tell "edited away"
    // and "deleted" apart even when an edit removed the pair from the
    // expense entirely — something the current-splits replay cannot see.
    let lineageDeleted = false
    let lineageEdited  = false
    for (const id of lineageExpenseIds(st)) {
      const e = expenseById.get(id)
      if (!e) { lineageDeleted = true; continue }
      if (e.deletedAt) {
        if ((e.deletedAt.toMillis?.() ?? 0) > ev.ts) lineageDeleted = true
        continue
      }
      const uMs = e.updatedAt?.toMillis?.() ?? 0
      const cMs = e.createdAt?.toMillis?.() ?? 0
      if (uMs > ev.ts && uMs > cMs) lineageEdited = true
    }
    out.set(st.id, { atRecording, overpayment, editedAfter, deletedAfter, lineageDeleted, lineageEdited })
  }
  return out
}

/**
 * Derive the orphan reason from at-recording state + final leftover.
 * The mixed case (partly OVER at recording, partly EXPENSE_DELETED
 * later) is detected when leftover EXCEEDS the recording-time
 * overpayment by more than SETTLEMENT_EPS -- the excess can only come
 * from a subsequent delete shrinking the gross that the settlement was
 * actively consuming.
 */
export function classifyOrphan(info: SettlementReplayInfo | undefined, leftover: number): OrphanReason {
  if (!info) return 'UNKNOWN'
  // Lineage first: it knows which expenses this settlement actually cleared.
  if (info.lineageDeleted) return 'EXPENSE_DELETED'
  if (info.lineageEdited)  return 'EXPENSE_CHANGED'
  // A later edit invalidates the replay's view of the debt at recording
  // (it only sees current splits). A later delete on a WITHIN settlement
  // still explains the leftover on its own, so that keeps its reason.
  if (info.editedAfter && !(info.atRecording === 'WITHIN' && info.deletedAfter)) {
    return 'EXPENSE_CHANGED'
  }
  if (info.atRecording === 'NO_EXPENSE')                 return 'UNKNOWN'
  if (info.atRecording === 'WITHIN')                     return 'EXPENSE_DELETED'
  // atRecording === 'OVER'
  if (leftover - info.overpayment > SETTLEMENT_EPS)      return 'MIXED'
  return 'OVERPAYMENT'
}
