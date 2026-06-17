// Pure unit tests for settlement-lineage.ts.
//
// These exercise the source-unit accounting directly with plain domain
// fixtures — no Firestore REST shapes, no tx mock, no FX. The endpoint
// wiring (decode → buildSettlementLineage → encode appliedSources /
// appliedExpenseIds) is covered by settlement-write.spec.ts; this file
// pins the DOMAIN invariants the orchestrator relies on:
//   - consumeSourceUnits draws down + mutates remainingMinor in place
//   - collapseAppliedSources merges by (expenseId, itemId), not naively
//   - sourceUnitsForDirection: direction filter, per-item vs fallback, sort
//   - buildSettlementLineage: lockExpenseIds ⊇ appliedSources, and a net
//     settlement locks its REVERSE offset expense too (the invariant that
//     stops a non-owner re-opening a settled balance by editing the
//     reverse-direction expense).
import { describe, it, expect } from 'vitest'
import {
  buildSettlementLineage,
  sourceUnitsForDirection,
  consumeSourceUnits,
  collapseAppliedSources,
  type PairExpenseForSettlement,
  type SettlementAppliedSource,
} from '../src/settlement-lineage'
import type { CoreSettlement } from '@tripmate/settlement-core'

// ─── Fixture builders ─────────────────────────────────────────────

function expense(over: {
  id:          string
  paidBy:      string
  splits:      Array<{ memberId: string; amountMinor: number }>
  title?:      string
  createdAtMs?: number
  items?:      PairExpenseForSettlement['items']
  adjustments?: PairExpenseForSettlement['adjustments']
}): PairExpenseForSettlement {
  return {
    amountMinor: over.splits.reduce((s, x) => s + x.amountMinor, 0),
    paidBy:      over.paidBy,
    splits:      over.splits,
    id:          over.id,
    title:       over.title ?? over.id,
    createdAtMs: over.createdAtMs ?? 0,
    items:       over.items,
    adjustments: over.adjustments ?? [],
  }
}

function settlement(over: {
  fromUid: string
  toUid:   string
  amountMinor: number
  createdAtMs?: number
}): CoreSettlement {
  return {
    fromUid:     over.fromUid,
    toUid:       over.toUid,
    amountMinor: over.amountMinor,
    createdAtMs: over.createdAtMs ?? 0,
  }
}

// A bare source unit literal — consumeSourceUnits takes the (unexported)
// SettlementSourceUnit shape, structurally satisfied by this object.
function unit(over: {
  expenseId: string
  remainingMinor: number
  expenseTitle?: string
  amountMinor?: number
  itemId?: string
  itemName?: string
  createdAtMs?: number
  order?: number
}) {
  return {
    expenseId:      over.expenseId,
    expenseTitle:   over.expenseTitle ?? over.expenseId,
    amountMinor:    over.amountMinor ?? over.remainingMinor,
    remainingMinor: over.remainingMinor,
    createdAtMs:    over.createdAtMs ?? 0,
    order:          over.order ?? 0,
    ...(over.itemId   !== undefined ? { itemId: over.itemId } : {}),
    ...(over.itemName !== undefined ? { itemName: over.itemName } : {}),
  }
}

// ─── consumeSourceUnits ───────────────────────────────────────────

describe('consumeSourceUnits', () => {
  it('draws the amount down and mutates remainingMinor in place', () => {
    const units = [unit({ expenseId: 'e1', remainingMinor: 100 })]
    const applied = consumeSourceUnits(units, 30)
    expect(applied).toEqual([{ expenseId: 'e1', expenseTitle: 'e1', amountMinor: 30 }])
    expect(units[0].remainingMinor).toBe(70)   // in-place mutation is load-bearing
  })

  it('consumes across units in order, partially draining the last', () => {
    const units = [
      unit({ expenseId: 'e1', remainingMinor: 40 }),
      unit({ expenseId: 'e2', remainingMinor: 40 }),
    ]
    const applied = consumeSourceUnits(units, 50)
    expect(applied).toEqual([
      { expenseId: 'e1', expenseTitle: 'e1', amountMinor: 40 },
      { expenseId: 'e2', expenseTitle: 'e2', amountMinor: 10 },
    ])
    expect(units[0].remainingMinor).toBe(0)
    expect(units[1].remainingMinor).toBe(30)
  })

  it('skips already-drained units and returns [] for non-positive / non-finite amounts', () => {
    expect(consumeSourceUnits([unit({ expenseId: 'e1', remainingMinor: 0 })], 10)).toEqual([])
    expect(consumeSourceUnits([unit({ expenseId: 'e1', remainingMinor: 100 })], 0)).toEqual([])
    expect(consumeSourceUnits([unit({ expenseId: 'e1', remainingMinor: 100 })], Number.NaN)).toEqual([])
  })

  it('carries itemId/itemName only when both are present on the unit', () => {
    const withItem = consumeSourceUnits(
      [unit({ expenseId: 'e1', remainingMinor: 50, itemId: 'i1', itemName: 'Coffee' })],
      50,
    )
    expect(withItem[0]).toEqual({
      expenseId: 'e1', expenseTitle: 'e1', amountMinor: 50, itemId: 'i1', itemName: 'Coffee',
    })
    const noItem = consumeSourceUnits([unit({ expenseId: 'e1', remainingMinor: 50 })], 50)
    expect(noItem[0]).not.toHaveProperty('itemId')
    expect(noItem[0]).not.toHaveProperty('itemName')
  })
})

// ─── collapseAppliedSources ───────────────────────────────────────

describe('collapseAppliedSources', () => {
  const src = (over: Partial<SettlementAppliedSource> & { expenseId: string; amountMinor: number }): SettlementAppliedSource => ({
    expenseTitle: over.expenseId,
    ...over,
  })

  it('sums sources that share the same (expenseId, itemId)', () => {
    const out = collapseAppliedSources([
      src({ expenseId: 'e1', itemId: 'i1', itemName: 'A', amountMinor: 30 }),
      src({ expenseId: 'e1', itemId: 'i1', itemName: 'A', amountMinor: 20 }),
    ])
    expect(out).toEqual([{ expenseId: 'e1', expenseTitle: 'e1', itemId: 'i1', itemName: 'A', amountMinor: 50 }])
  })

  it('keeps different itemIds on the same expense separate', () => {
    const out = collapseAppliedSources([
      src({ expenseId: 'e1', itemId: 'i1', itemName: 'A', amountMinor: 30 }),
      src({ expenseId: 'e1', itemId: 'i2', itemName: 'B', amountMinor: 20 }),
    ])
    expect(out).toHaveLength(2)
  })

  it('does not merge an item-scoped source into an expense-level one', () => {
    const out = collapseAppliedSources([
      src({ expenseId: 'e1', amountMinor: 30 }),                       // expense-level (itemId undefined)
      src({ expenseId: 'e1', itemId: 'i1', itemName: 'A', amountMinor: 20 }),
    ])
    expect(out).toHaveLength(2)
  })
})

// ─── sourceUnitsForDirection ──────────────────────────────────────

describe('sourceUnitsForDirection', () => {
  it('only counts expenses the payee (toUid) actually paid, where the payer (fromUid) owes', () => {
    const expenses = [
      expense({ id: 'paid-by-B', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 50 }] }),
      expense({ id: 'paid-by-A', paidBy: 'A', splits: [{ memberId: 'B', amountMinor: 30 }] }),
    ]
    const units = sourceUnitsForDirection(expenses, 'A', 'B')
    expect(units.map(u => u.expenseId)).toEqual(['paid-by-B'])
    expect(units[0].amountMinor).toBe(50)
    expect(units[0].itemId).toBeUndefined()   // no items → expense-level fallback
  })

  it('produces per-item units when item attribution reconciles to the pair split', () => {
    const expenses = [
      expense({
        id:     'ei',
        paidBy: 'B',
        splits: [{ memberId: 'A', amountMinor: 100 }],
        items:  [{ id: 'i1', name: 'Coffee', amountMinor: 100, allocations: [{ memberId: 'A', shares: 1 }] }],
      }),
    ]
    const units = sourceUnitsForDirection(expenses, 'A', 'B')
    expect(units).toHaveLength(1)
    expect(units[0].itemId).toBe('i1')
    expect(units[0].itemName).toBe('Coffee')
    expect(units[0].amountMinor).toBe(100)
  })

  it('sorts by createdAt then expenseId for deterministic consume order', () => {
    const expenses = [
      expense({ id: 'z', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 10 }], createdAtMs: 1 }),
      expense({ id: 'a', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 10 }], createdAtMs: 1 }),
    ]
    expect(sourceUnitsForDirection(expenses, 'A', 'B').map(u => u.expenseId)).toEqual(['a', 'z'])
  })
})

// ─── buildSettlementLineage ───────────────────────────────────────

describe('buildSettlementLineage', () => {
  it('forward-only: appliedSources and lockExpenseIds are the consumed forward sources', () => {
    const expenses = [
      expense({ id: 'e100', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 100 }] }),
    ]
    const lineage = buildSettlementLineage(expenses, [], 'A', 'B', 100)
    expect(lineage.appliedSources).toEqual([
      { expenseId: 'e100', expenseTitle: 'e100', amountMinor: 100 },
    ])
    expect(lineage.lockExpenseIds).toEqual(['e100'])
  })

  it('LOCK invariant: a net settlement locks the REVERSE offset expense too, not just forward sources', () => {
    // B paid 100 → A owes B 100 (forward).  A paid 80 → B owes A 80 (reverse).
    // Net A→B = 20. Editing the ¥80 reverse expense would change that 20, so it
    // MUST be locked even though it is NOT a forward display source.
    const expenses = [
      expense({ id: 'fwd-100', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 100 }], createdAtMs: 1 }),
      expense({ id: 'rev-80',  paidBy: 'A', splits: [{ memberId: 'B', amountMinor: 80  }], createdAtMs: 2 }),
    ]
    const lineage = buildSettlementLineage(expenses, [], 'A', 'B', 20)

    // DISPLAY sources: only the forward expense, for the net 20.
    expect(lineage.appliedSources).toEqual([
      { expenseId: 'fwd-100', expenseTitle: 'fwd-100', amountMinor: 20 },
    ])
    // LOCK set: forward source ∪ reverse offset expense.
    expect([...lineage.lockExpenseIds].sort()).toEqual(['fwd-100', 'rev-80'])
  })

  it('prior same-direction settlements draw the forward units down before this amount', () => {
    const expenses = [
      expense({ id: 'e100', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 100 }], createdAtMs: 1 }),
    ]
    const prior: CoreSettlement[] = [settlement({ fromUid: 'A', toUid: 'B', amountMinor: 30, createdAtMs: 5 })]
    // 30 already cleared → only 70 of the ¥100 remains to attribute.
    const lineage = buildSettlementLineage(expenses, prior, 'A', 'B', 70)
    expect(lineage.appliedSources).toEqual([
      { expenseId: 'e100', expenseTitle: 'e100', amountMinor: 70 },
    ])
    expect(lineage.lockExpenseIds).toEqual(['e100'])
  })
})
