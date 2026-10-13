import { describe, expect, it } from 'vitest'
import { buildSettlementLineage, capRouteSources, collapseAppliedSources, type LineageExpense } from './index'

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

describe('buildSettlementLineage — lock set and edge cases', () => {
  it('a net settlement locks the reverse-direction expense that offset it', () => {
    // B paid 100 for A, A paid 80 for B: net A→B 20. Editing the 80 would
    // change the settled 20, so it locks too.
    const fwd = expense({ id: 'fwd', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 100 }], createdAtMs: 1 })
    const rev = expense({ id: 'rev', paidBy: 'A', splits: [{ memberId: 'B', amountMinor: 80 }], createdAtMs: 2 })
    const lineage = buildSettlementLineage([fwd, rev], [], 'A', 'B', 20, attribute)
    expect(lineage.appliedSources).toEqual([{ expenseId: 'fwd', expenseTitle: 'fwd', amountMinor: 20 }])
    expect(lineage.lockExpenseIds.sort()).toEqual(['fwd', 'rev'])
  })

  it('prior reverse settlements reduce the offset; malformed priors are ignored', () => {
    const fwd = expense({ id: 'fwd', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 100 }] })
    const rev = expense({ id: 'rev', paidBy: 'A', splits: [{ memberId: 'B', amountMinor: 80 }] })
    const priors = [
      { fromUid: 'B', toUid: 'A', amountMinor: 80, createdAtMs: 1 },   // reverse fully settled
      { fromUid: 'A', toUid: 'A', amountMinor: 5, createdAtMs: 2 },    // self: ignored
      { fromUid: 'A', toUid: 'B', amountMinor: Number.NaN, createdAtMs: 3 }, // malformed: ignored
      { fromUid: 'X', toUid: 'Y', amountMinor: 9, createdAtMs: 4 },    // other pair: ignored
    ]
    const lineage = buildSettlementLineage([fwd, rev], priors, 'A', 'B', 100, attribute)
    expect(lineage.appliedSources).toEqual([{ expenseId: 'fwd', expenseTitle: 'fwd', amountMinor: 100 }])
    expect(lineage.lockExpenseIds).toEqual(['fwd'])
  })

  it('consumes nothing for a non-finite or non-positive amount, and merges repeat sources', () => {
    const e = expense({ id: 'e', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 10 }, { memberId: 'A', amountMinor: 5 }] })
    expect(buildSettlementLineage([e], [], 'A', 'B', Number.POSITIVE_INFINITY, attribute).appliedSources).toEqual([])
    expect(buildSettlementLineage([e], [], 'A', 'B', 0, attribute).appliedSources).toEqual([])
    expect(collapseAppliedSources([
      { expenseId: 'e', expenseTitle: 'e', amountMinor: 3 },
      { expenseId: 'e', expenseTitle: 'e', amountMinor: 4 },
      { expenseId: 'e', expenseTitle: 'e', itemId: 'i', itemName: 'i', amountMinor: 1 },
    ])).toEqual([
      { expenseId: 'e', expenseTitle: 'e', amountMinor: 7 },
      { expenseId: 'e', expenseTitle: 'e', itemId: 'i', itemName: 'i', amountMinor: 1 },
    ])
  })

  it('names an item by id when the item record is gone', () => {
    const e = expense({
      id: 'e', paidBy: 'B', splits: [{ memberId: 'A', amountMinor: 50 }],
      items: [{ id: 'other', name: 'x' }], byMember: { A: [{ itemId: 'ghost-item', amountMinor: 50 }] },
    })
    expect(buildSettlementLineage([e], [], 'A', 'B', 50, attribute).appliedSources)
      .toEqual([{ expenseId: 'e', expenseTitle: 'e', itemId: 'ghost-item', itemName: 'ghost-item', amountMinor: 50 }])
  })
})

describe('capRouteSources', () => {
  const list = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`)

  it('keeps everything that fits', () => {
    const legs = [list(3, 'a'), list(0, 'b'), list(2, 'c')]
    expect(capRouteSources(legs, 5)).toEqual(legs)
  })

  it('shares the budget max-min fairly, oldest sources first, small legs untouched', () => {
    const capped = capRouteSources([list(10, 'a'), list(2, 'b'), list(10, 'c')], 9)
    expect(capped).toEqual([['a0', 'a1', 'a2', 'a3'], ['b0', 'b1'], ['c0', 'c1', 'c2']])
  })

  it('fills the budget exactly, keeps prefixes and never lets one trimmed leg get 2+ more than another (property)', () => {
    let seed = 7
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    for (let round = 0; round < 300; round++) {
      const legs = Array.from({ length: 1 + Math.floor(rand() * 45) }, (_, i) => list(Math.floor(rand() * 120), `${i}:`))
      const budget = Math.floor(rand() * 500)
      const capped = capRouteSources(legs, budget)
      const total = legs.reduce((s, l) => s + l.length, 0)
      expect(capped.reduce((s, l) => s + l.length, 0)).toBe(Math.min(total, budget))
      capped.forEach((l, i) => expect(l).toEqual(legs[i]!.slice(0, l.length)))
      const trimmed = capped.filter((l, i) => l.length < legs[i]!.length).map(l => l.length)
      if (trimmed.length === 0) continue
      const floor = Math.min(...trimmed)
      expect(Math.max(...trimmed) - floor).toBeLessThanOrEqual(1)
      // A leg kept whole never holds more than a trimmed one was allowed.
      capped.forEach((l, i) => { if (l.length === legs[i]!.length) expect(l.length).toBeLessThanOrEqual(floor + 1) })
    }
  })
})
