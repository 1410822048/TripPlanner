// Settlement lineage — "which expenses / items did this settlement's amount
// draw down (the DISPLAY sources), and which expenses must be LOCKED because
// editing them would re-open the settled net".
//
// Shared by the Worker (authoritative: written onto the settlement doc as
// appliedSources / lockedExpenses) and the client (preview: the payment
// suggestion shows which expenses each leg will clear). One implementation,
// so the preview cannot drift from what the Worker records.
//
// Per-item attribution needs the receipt materializer, which lives in
// @tripmate/expense-materialize. It is injected (`attribute`) rather than
// imported so this package stays dependency-free; both callers already
// depend on the materializer and bind it once.
import { SETTLEMENT_EPS, type CoreExpense, type CoreSettlement } from './index'

/** An expense decoded far enough for lineage: the CoreExpense the pair math
 *  uses plus id / title / createdAtMs for ordering + display, and the item
 *  names for per-item sources. Callers extend it with whatever their
 *  `attribute` callback needs (items' allocations, adjustments). */
export interface LineageExpense extends CoreExpense {
  id:          string
  title:       string
  createdAtMs: number
  items?:      Array<{ id: string; name: string }>
}

/** `memberId`'s share of `expense`, broken down per receipt item. Throws (or
 *  returns a breakdown that does not add up to the stored split) when the
 *  items can't be reconciled — the expense then contributes one
 *  expense-level source instead. */
export type ItemAttribution<E extends LineageExpense> =
  (expense: E, memberId: string) => Array<{ itemId: string; amountMinor: number }>

/** "This settlement drew ¥X down from expense E (optionally item I)". */
export interface SettlementAppliedSource {
  expenseId:    string
  expenseTitle: string
  itemId?:      string
  itemName?:    string
  amountMinor:  number
}

/** A consumable unit: an applied-source plus ordering keys and the running
 *  `remainingMinor` that consumeSourceUnits decrements IN-PLACE. The
 *  mutation is load-bearing — buildSettlementLineage runs several consume
 *  passes over the same arrays. */
export interface SettlementSourceUnit extends SettlementAppliedSource {
  createdAtMs:    number
  order:          number
  remainingMinor: number
}

export interface SettlementLineage {
  /** Forward-direction sources consumed by the settlement amount. */
  appliedSources: SettlementAppliedSource[]
  /** Every expense whose edit would change the NET this settlement cleared:
   *  the forward sources PLUS the reverse-direction expenses that offset the
   *  forward gross (and the forward units they cancelled). A forward-only
   *  set would leave a reverse offset expense editable by a non-owner, who
   *  could then re-open the settled balance (B paid 100→A, A paid 80→B,
   *  net A→B 20: editing A's 80 expense changes the 20). */
  lockExpenseIds: string[]
}

/** Consumable source units for "fromUid owes toUid": every expense paid by
 *  `toUid` where `fromUid` has a positive split, per item when attribution
 *  reconciles exactly with the stored split, else one expense-level unit.
 *  Sorted by (createdAt, expenseId, order, itemId) so consumption is
 *  deterministic and chronological. */
export function sourceUnitsForDirection<E extends LineageExpense>(
  expenses:  E[],
  fromUid:   string,
  toUid:     string,
  attribute: ItemAttribution<E>,
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
        const contributions = attribute(expense, fromUid).filter(c => c.amountMinor > SETTLEMENT_EPS)
        const contributionTotal = contributions.reduce((sum, c) => sum + c.amountMinor, 0)
        if (contributionTotal === pairSplitMinor) {
          const itemById = new Map(items.map(item => [item.id, item]))
          contributions.forEach((c, i) => {
            units.push({
              expenseId:      expense.id,
              expenseTitle:   expense.title,
              itemId:         c.itemId,
              itemName:       itemById.get(c.itemId)?.name ?? c.itemId,
              amountMinor:    c.amountMinor,
              remainingMinor: c.amountMinor,
              createdAtMs:    expense.createdAtMs,
              order:          i,
            })
          })
          continue
        }
      } catch {
        // Attribution is audit metadata; the debt math already used the
        // stored splits. Fall back to an expense-level source.
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
 *  `remainingMinor` and returning the consumed slices. */
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

/** Merge sources sharing (expenseId, itemId) into one entry. */
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

/** A settlement's DISPLAY sources + LOCK set for (fromUid → toUid,
 *  amountMinor), given the pair's ACTIVE expenses and the pair's prior
 *  settlements (both directions; others are ignored). Prior settlements
 *  consume units first, in createdAt order, so a partial settlement draws
 *  from the oldest still-open sources. */
export function buildSettlementLineage<E extends LineageExpense>(
  expenses:    E[],
  settlements: CoreSettlement[],
  fromUid:     string,
  toUid:       string,
  amountMinor: number,
  attribute:   ItemAttribution<E>,
): SettlementLineage {
  const forward = sourceUnitsForDirection(expenses, fromUid, toUid, attribute)
  const reverse = sourceUnitsForDirection(expenses, toUid, fromUid, attribute)

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

  // Reverse-direction debt still open offsets the forward gross to produce
  // the net this settlement clears, so those expenses (and the forward units
  // they cancel) are part of the settled balance and must lock too.
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

/** Display sources one settlement doc keeps, across all of its legs. A
 *  route is ONE doc (≤ 1 MiB): at ≤ ~1.4 KB per source (100-char title,
 *  200-char item name, ids) this budget keeps the doc well below the limit
 *  together with the ≤ 500-expense lock set. Locks never depend on it —
 *  lockedExpenses is always complete; only the display list is trimmed, and
 *  the UI shows the untraced remainder of a leg as such. */
export const MAX_ROUTE_APPLIED_SOURCES = 400

/** Trim each leg's display sources to a shared `budget`, max-min fair: the
 *  largest per-leg quota q with Σ min(len, q) ≤ budget, then one more each,
 *  in leg order, for legs still cut short. Every leg keeps its OLDEST
 *  sources (the lineage order), and a leg that fits is never trimmed.
 *  Deterministic, so the client preview equals what the Worker records. */
export function capRouteSources<T>(perLeg: ReadonlyArray<readonly T[]>, budget = MAX_ROUTE_APPLIED_SOURCES): T[][] {
  const used = (q: number) => perLeg.reduce((sum, list) => sum + Math.min(list.length, q), 0)
  let lo = 0
  let hi = perLeg.reduce((max, list) => Math.max(max, list.length), 0)
  if (used(hi) <= budget) return perLeg.map(list => [...list])
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (used(mid) <= budget) lo = mid
    else hi = mid - 1
  }
  let spare = budget - used(lo)
  return perLeg.map(list => {
    let take = Math.min(list.length, lo)
    if (spare > 0 && list.length > lo) { take++; spare-- }
    return list.slice(0, take)
  })
}
