import { describe, expect, it } from 'vitest'
import { buildSettlementLineage, type LineageExpense } from './index'

// The Worker's spec (workers/ocr/test/settlement-lineage.spec.ts) covers the
// materializer-bound behaviour in depth; these pin what the shared core
// itself owns: the injected attribution, and partial legs drawing from the
// oldest still-open sources.

interface Fixture extends LineageExpense {
  byMember?: Record<string, Array<{ itemId: string; amountMinor: number }>>
}

const expense = (over: Partial<Fixture> & Pick<Fixture, 'id' | 'paidBy' | 'splits'>): Fixture => ({
  amountMinor: over.splits.reduce((s, x) => s + x.amountMinor, 0),
  title:       over.id,
  createdAtMs: 0,
  ...over,
})

const attribute = (e: Fixture, memberId: string) => {
  const out = e.byMember?.[memberId]
  if (!out) throw new Error('no items')
  return out
}

describe('buildSettlementLineage (shared core)', () => {
  it('uses the injected per-item attribution when it reconciles', () => {
    const e = expense({
      id: 'e1', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 300 }],
      items: [{ id: 'i1', name: '拉麵' }, { id: 'i2', name: '啤酒' }],
      byMember: { A: [{ itemId: 'i1', amountMinor: 200 }, { itemId: 'i2', amountMinor: 100 }] },
    })
    const lineage = buildSettlementLineage([e], [], 'A', 'B', 300, attribute)
    expect(lineage.appliedSources).toEqual([
      { expenseId: 'e1', expenseTitle: 'e1', itemId: 'i1', itemName: '拉麵', amountMinor: 200 },
      { expenseId: 'e1', expenseTitle: 'e1', itemId: 'i2', itemName: '啤酒', amountMinor: 100 },
    ])
  })

  it('falls back to one expense-level source when attribution throws or does not add up', () => {
    const throws = expense({ id: 'e1', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 300 }], items: [{ id: 'i1', name: 'x' }] })
    const mismatched = expense({
      id: 'e2', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 100 }], createdAtMs: 1,
      items: [{ id: 'i1', name: 'x' }], byMember: { A: [{ itemId: 'i1', amountMinor: 99 }] },
    })
    const lineage = buildSettlementLineage([throws, mismatched], [], 'A', 'B', 400, attribute)
    expect(lineage.appliedSources).toEqual([
      { expenseId: 'e1', expenseTitle: 'e1', amountMinor: 300 },
      { expenseId: 'e2', expenseTitle: 'e2', amountMinor: 100 },
    ])
  })

  it('a partial leg draws from the oldest source prior settlements left open', () => {
    const e1 = expense({ id: 'e1', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 300 }], createdAtMs: 1 })
    const e2 = expense({ id: 'e2', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 500 }], createdAtMs: 2 })
    const prior = [{ fromUid: 'A', toUid: 'B', amountMinor: 200, createdAtMs: 3 }]
    const lineage = buildSettlementLineage([e1, e2], prior, 'A', 'B', 250, attribute)
    expect(lineage.appliedSources).toEqual([
      { expenseId: 'e1', expenseTitle: 'e1', amountMinor: 100 },
      { expenseId: 'e2', expenseTitle: 'e2', amountMinor: 150 },
    ])
    expect(lineage.lockExpenseIds.sort()).toEqual(['e1', 'e2'])
  })
})
