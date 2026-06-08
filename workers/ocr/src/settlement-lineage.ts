// workers/ocr/src/settlement-lineage.ts
// Pure settlement-lineage domain for the settlement-write endpoint:
// "which expenses / items did this settlement's amount draw down (the
// DISPLAY sources), and which expenses must be LOCKED because editing
// them would re-open the settled net". No Firestore REST shapes, no tx,
// no network, no FX — just source-unit accounting over already-decoded
// pair expenses + settlements. Split out of settlement-write.ts (boundary
// extraction) so it unit-tests directly (test/settlement-lineage.spec.ts)
// and the orchestrator imports a named domain rather than inlining the
// consume/collapse math next to auth + tx plumbing.
//
// The orchestrator decodes Firestore docs into PairExpenseForSettlement
// (REST → domain) and passes them here; this module never touches FsValue.
// Per-line attribution (materializeExpenseSplitContributions) is the only
// non-trivial dependency, and it is itself a pure @tripmate package fn.
import {
  SETTLEMENT_EPS,
  type CoreExpense,
  type CoreSettlement,
}                                          from '@tripmate/settlement-core'
import {
  materializeExpenseSplitContributions,
  type MaterializeAdjustment,
  type MaterializeItem,
}                                          from '@tripmate/expense-materialize'

/** A pair expense decoded far enough for lineage: the settlement-core
 *  CoreExpense (amountMinor / paidBy / splits) PLUS the per-line item /
 *  adjustment detail the attribution pass needs and the id / title /
 *  createdAtMs the source-unit ordering + display use. Produced by the
 *  orchestrator's decodePairExpenseForSettlement; this module is its
 *  only consumer. */
export interface PairExpenseForSettlement extends CoreExpense {
  id:          string
  title:       string
  createdAtMs: number
  items?:      Array<MaterializeItem & { name: string }>
  adjustments: Array<MaterializeAdjustment & { label: string }>
}

/** A single "this settlement drew ¥X down from expense E (optionally item
 *  I)" record — the DISPLAY lineage stored on the settlement doc as
 *  appliedSources. */
export interface SettlementAppliedSource {
  expenseId:    string
  expenseTitle: string
  itemId?:      string
  itemName?:    string
  amountMinor:  number
}

/** A consumable source unit: an applied-source plus the ordering keys and
 *  the running `remainingMinor` that consumeSourceUnits decrements
 *  IN-PLACE as prior settlements (and reverse-offset cancellation) draw it
 *  down. The mutation is load-bearing — buildSettlementLineage consumes
 *  the SAME forward/reverse arrays across multiple passes. */
interface SettlementSourceUnit extends SettlementAppliedSource {
  createdAtMs:    number
  order:          number
  remainingMinor: number
}

export interface SettlementLineage {
  /** Forward-direction sources consumed by the settlement amount — the
   *  DISPLAY lineage (「清算の元になった費用」). Capped for storage by the
   *  caller (MAX_APPLIED_SOURCES). */
  appliedSources: SettlementAppliedSource[]
  /** Every expense whose edit would change the NET this settlement cleared:
   *  the forward sources PLUS the reverse-direction expenses whose remaining
   *  debt offset the forward gross to produce that net (and the forward
   *  units they cancelled). This is the LOCK set — stored as the
   *  settlement's appliedExpenseIds and written into each expense's
   *  settlementLockIds. A forward-only set would leave a reverse offset
   *  expense editable by a non-owner, who could then re-open the settled
   *  balance (e.g. B paid 100→A, A paid 80→B, net A→B 20: editing A's 80
   *  expense changes the 20). */
  lockExpenseIds: string[]
}

/** Every uid that participates in an expense (payer + split members + item
 *  assignees), de-duped in first-seen order. Feeds the per-line
 *  materializer's `members` roster. */
function membersForExpense(expense: PairExpenseForSettlement): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (uid: string) => {
    if (!uid || seen.has(uid)) return
    seen.add(uid)
    out.push(uid)
  }
  add(expense.paidBy)
  for (const split of expense.splits) add(split.memberId)
  for (const item of expense.items ?? []) {
    for (const uid of item.assignees) add(uid)
  }
  return out
}

/** Build the consumable source units for the (toUid paid → fromUid owes)
 *  direction. Each expense paidBy `toUid` where `fromUid` has a positive
 *  split contributes either per-item units (when item attribution
 *  reconciles exactly to the persisted pair split) or one expense-level
 *  unit (fallback). Sorted by (createdAt, expenseId, order, itemId) so
 *  consume order is deterministic and matches the chronological intent. */
export function sourceUnitsForDirection(
  expenses: PairExpenseForSettlement[],
  fromUid:  string,
  toUid:    string,
): SettlementSourceUnit[] {
  const units: SettlementSourceUnit[] = []
  for (const expense of expenses) {
    if (expense.paidBy !== toUid) continue
    const pairSplitMinor = expense.splits
      .filter(split => split.memberId === fromUid)
      .reduce((sum, split) => sum + split.amountMinor, 0)
    if (!Number.isFinite(pairSplitMinor) || pairSplitMinor <= SETTLEMENT_EPS) continue

    const items = expense.items ?? []
    if (items.length > 0) {
      try {
        const contributions = materializeExpenseSplitContributions({
          items: items.map(item => ({
            id:          item.id,
            amountMinor: item.amountMinor,
            assignees:   item.assignees,
          })),
          adjustments: expense.adjustments.map(adj => {
            const out: MaterializeAdjustment = {
              id:          adj.id,
              kind:        adj.kind,
              scope:       adj.scope,
              amountMinor: adj.amountMinor,
            }
            if (adj.targetItemId !== undefined) out.targetItemId = adj.targetItemId
            return out
          }),
          members: membersForExpense(expense),
        }).filter(c => c.memberId === fromUid && c.amountMinor > SETTLEMENT_EPS)

        const contributionTotal = contributions.reduce((sum, c) => sum + c.amountMinor, 0)
        if (contributionTotal === pairSplitMinor) {
          const itemById = new Map(items.map(item => [item.id, item]))
          contributions.forEach((c, i) => {
            const item = itemById.get(c.itemId)
            units.push({
              expenseId:      expense.id,
              expenseTitle:   expense.title,
              itemId:         c.itemId,
              itemName:       item?.name ?? c.itemId,
              amountMinor:    c.amountMinor,
              remainingMinor: c.amountMinor,
              createdAtMs:    expense.createdAtMs,
              order:          i,
            })
          })
          continue
        }
      } catch {
        // Attribution is best-effort audit metadata; no-overpay math has
        // already used the persisted splits. Fall back to expense-level
        // lineage instead of rejecting a valid settlement.
      }
    }

    units.push({
      expenseId:      expense.id,
      expenseTitle:   expense.title,
      amountMinor:    pairSplitMinor,
      remainingMinor: pairSplitMinor,
      createdAtMs:    expense.createdAtMs,
      order:          0,
    })
  }

  return units.sort((a, b) =>
    a.createdAtMs - b.createdAtMs
    || a.expenseId.localeCompare(b.expenseId)
    || a.order - b.order
    || (a.itemId ?? '').localeCompare(b.itemId ?? ''),
  )
}

/** Draw `amountMinor` down across `units` in order, mutating each unit's
 *  `remainingMinor` IN-PLACE and returning the consumed slices as
 *  applied-sources. The in-place mutation lets buildSettlementLineage run
 *  several consume passes over the SAME array (prior settlements, then
 *  reverse-offset, then the new amount) without re-deriving units. */
export function consumeSourceUnits(units: SettlementSourceUnit[], amountMinor: number): SettlementAppliedSource[] {
  const consumed: SettlementAppliedSource[] = []
  if (!Number.isFinite(amountMinor)) return consumed
  let remaining = Math.round(amountMinor)
  if (remaining <= 0) return consumed

  for (const unit of units) {
    if (remaining <= 0) break
    if (unit.remainingMinor <= SETTLEMENT_EPS) continue
    const taken = Math.min(unit.remainingMinor, remaining)
    unit.remainingMinor -= taken
    remaining -= taken
    if (taken > SETTLEMENT_EPS) {
      const out: SettlementAppliedSource = {
        expenseId:    unit.expenseId,
        expenseTitle: unit.expenseTitle,
        amountMinor:  Math.round(taken),
      }
      if (unit.itemId !== undefined && unit.itemName !== undefined) {
        out.itemId = unit.itemId
        out.itemName = unit.itemName
      }
      consumed.push(out)
    }
  }
  return consumed
}

function sourceTotal(units: SettlementSourceUnit[]): number {
  return units.reduce((sum, unit) => sum + Math.max(0, unit.remainingMinor), 0)
}

/** Merge applied-sources that share the same (expenseId, itemId) so a
 *  settlement that draws from one expense across multiple consume passes
 *  shows up once with the summed amount. */
export function collapseAppliedSources(sources: SettlementAppliedSource[]): SettlementAppliedSource[] {
  const collapsed: SettlementAppliedSource[] = []
  const byKey = new Map<string, SettlementAppliedSource>()
  for (const source of sources) {
    const key = `${source.expenseId}\u0000${source.itemId ?? ''}`
    const existing = byKey.get(key)
    if (existing) {
      existing.amountMinor += source.amountMinor
      continue
    }
    const next = { ...source }
    byKey.set(key, next)
    collapsed.push(next)
  }
  return collapsed
}

/** Derive a settlement's DISPLAY sources + LOCK set from the pair's active
 *  expenses + prior settlements. Pure: callers decode the Firestore docs
 *  first. See SettlementLineage for why the lock set is a superset of the
 *  display sources (reverse-offset expenses must lock too). */
export function buildSettlementLineage(
  expenses:    PairExpenseForSettlement[],
  settlements: CoreSettlement[],
  fromUid:     string,
  toUid:       string,
  amountMinor: number,
): SettlementLineage {
  const forward = sourceUnitsForDirection(expenses, fromUid, toUid)
  const reverse = sourceUnitsForDirection(expenses, toUid, fromUid)

  const sortedSettlements = [...settlements].sort((a, b) => a.createdAtMs - b.createdAtMs)
  for (const settlement of sortedSettlements) {
    if (!Number.isFinite(settlement.amountMinor) || settlement.amountMinor <= SETTLEMENT_EPS) continue
    if (settlement.fromUid === settlement.toUid) continue
    if (settlement.fromUid === fromUid && settlement.toUid === toUid) {
      consumeSourceUnits(forward, settlement.amountMinor)
    } else if (settlement.fromUid === toUid && settlement.toUid === fromUid) {
      consumeSourceUnits(reverse, settlement.amountMinor)
    }
  }

  const lockIds = new Set<string>()

  // Reverse-direction expenses with remaining debt offset the forward gross
  // to produce the net this settlement clears. They (and the forward units
  // they cancel) are part of the settled balance, so they must be locked
  // even though they are NOT forward "sources" — otherwise editing the
  // reverse expense silently re-opens the debt.
  const reverseRemaining = sourceTotal(reverse)
  if (reverseRemaining > SETTLEMENT_EPS) {
    for (const unit of reverse) {
      if (unit.remainingMinor > SETTLEMENT_EPS) lockIds.add(unit.expenseId)
    }
    for (const offset of consumeSourceUnits(forward, reverseRemaining)) {
      lockIds.add(offset.expenseId)
    }
  }

  const appliedSources = collapseAppliedSources(consumeSourceUnits(forward, amountMinor))
  for (const source of appliedSources) lockIds.add(source.expenseId)

  return { appliedSources, lockExpenseIds: [...lockIds] }
}
