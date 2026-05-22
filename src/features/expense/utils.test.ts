import { describe, it, expect } from 'vitest'
import { splitEqually, splitSummary, splitsFromItems } from './utils'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'
import type { Expense } from '@/types'

function mkExpense(splits: Array<{ memberId: string; amount: number }>): Expense {
  return {
    id: 'e1', tripId: 'demo', title: 't', amount: splits.reduce((s, x) => s + x.amount, 0),
    currency: 'JPY', category: 'food', paidBy: 'm1', splits,
    date: '2026-05-01', memberIds: ['m1', 'm2', 'm3', 'm4'], createdBy: 'u', updatedBy: 'u', createdAt: TS, updatedAt: TS,
  }
}

describe('splitEqually', () => {
  it('splits evenly when divisible', () => {
    const r = splitEqually(1000, ['a', 'b', 'c', 'd'])
    expect(r.map(s => s.amount)).toEqual([250, 250, 250, 250])
    expect(r.reduce((s, x) => s + x.amount, 0)).toBe(1000)
  })

  it('distributes remainder to earliest members so sum === total', () => {
    // 1001 / 4 = 250.25 → base 250, remainder 1
    const r = splitEqually(1001, ['a', 'b', 'c', 'd'])
    expect(r.map(s => s.amount)).toEqual([251, 250, 250, 250])
    expect(r.reduce((s, x) => s + x.amount, 0)).toBe(1001)
  })

  it('rounds non-integer totals before splitting', () => {
    // Float input shouldn't drift sum — this guards the pre-Phase-2 regression.
    const r = splitEqually(100.7, ['a', 'b', 'c'])
    // Math.round(100.7) = 101; 101/3 → base 33, rem 2
    expect(r.map(s => s.amount)).toEqual([34, 34, 33])
    expect(r.reduce((s, x) => s + x.amount, 0)).toBe(101)
  })

  it('returns empty when total is 0 or no members', () => {
    expect(splitEqually(0, ['a'])).toEqual([])
    expect(splitEqually(100, [])).toEqual([])
  })

  it('sum always equals total across many inputs', () => {
    for (const total of [1, 7, 100, 333, 1000, 9_999]) {
      for (const n of [1, 2, 3, 4, 5, 7]) {
        const ids = Array.from({ length: n }, (_, i) => `m${i}`)
        const r = splitEqually(total, ids)
        expect(r.reduce((s, x) => s + x.amount, 0)).toBe(total)
      }
    }
  })

  it('handles negative totals — discount / cashback lines', () => {
    // -6 / 2 → each -3
    const r = splitEqually(-6, ['a', 'b'])
    expect(r.map(s => s.amount)).toEqual([-3, -3])
    expect(r.reduce((s, x) => s + x.amount, 0)).toBe(-6)
  })

  it('distributes negative remainder correctly', () => {
    // -7 / 2 → base 3, rem 1 → [-4, -3], sum -7 (NOT JS's naive Math.floor(-7/2) = -4 trap)
    const r = splitEqually(-7, ['a', 'b'])
    expect(r.map(s => s.amount)).toEqual([-4, -3])
    expect(r.reduce((s, x) => s + x.amount, 0)).toBe(-7)
  })
})

describe('splitsFromItems', () => {
  it('aggregates per-member shares across multiple items', () => {
    // Realistic receipt: A & B share a meal, plus a shared discount
    const r = splitsFromItems([
      { name: 'Donut',     amount:  118, assignees: ['A']       },
      { name: 'Bread',     amount:  110, assignees: ['A']       },
      { name: 'Coffee',    amount:  100, assignees: ['B']       },
      { name: 'Cashback',  amount:   -6, assignees: ['A', 'B']  },
    ])
    const byId = Object.fromEntries(r.map(s => [s.memberId, s.amount]))
    // A: 118 + 110 + (-3) = 225
    // B: 100 + (-3) = 97
    expect(byId.A).toBe(225)
    expect(byId.B).toBe(97)
    expect(r.reduce((s, x) => s + x.amount, 0)).toBe(322)
  })

  it('skips items with no assignees (form blocks save before reaching here)', () => {
    const r = splitsFromItems([
      { name: 'Orphan', amount: 50, assignees: [] },
      { name: 'Real',   amount: 100, assignees: ['A'] },
    ])
    expect(r).toEqual([{ memberId: 'A', amount: 100 }])
  })
})

describe('splitSummary', () => {
  it('reports N人均等 when all N members share equally', () => {
    const e = mkExpense([
      { memberId: 'm1', amount: 1000 },
      { memberId: 'm2', amount: 1000 },
      { memberId: 'm3', amount: 1000 },
      { memberId: 'm4', amount: 1000 },
    ])
    expect(splitSummary(e, 4)).toBe('4人均等')
  })

  it('tolerates ±1 rounding residual as equal split', () => {
    // Remainder from splitEqually(1001, 3) = [334, 334, 333]
    const e = mkExpense([
      { memberId: 'm1', amount: 334 },
      { memberId: 'm2', amount: 334 },
      { memberId: 'm3', amount: 333 },
    ])
    expect(splitSummary(e, 3)).toBe('3人均等')
  })

  it('reports 人で均等 when subset of members split equally', () => {
    const e = mkExpense([
      { memberId: 'm1', amount: 500 },
      { memberId: 'm2', amount: 500 },
    ])
    expect(splitSummary(e, 4)).toBe('2人で均等')
  })

  it('reports カスタム分担 when amounts diverge beyond ±1', () => {
    const e = mkExpense([
      { memberId: 'm1', amount: 700 },
      { memberId: 'm2', amount: 300 },
    ])
    expect(splitSummary(e, 2)).toBe('カスタム分担')
  })

  it('returns — when every split is zero', () => {
    const e = mkExpense([
      { memberId: 'm1', amount: 0 },
      { memberId: 'm2', amount: 0 },
    ])
    expect(splitSummary(e, 2)).toBe('—')
  })
})

// ─── Client ↔ Worker parity ────────────────────────────────────────
// The Worker's expense validation has its own copy of splitsFromItems
// (workers/ocr/src/expense-validate.ts: splitsFromItemsMirror) used to
// detect items↔splits attribution corruption on raw POSTs. The two
// implementations MUST agree bit-for-bit — drift would either let
// real attacks through (Worker too lenient) or reject legit client
// payloads (Worker too strict).
//
// This test imports both and feeds them the same corpus. If a future
// change to one isn't mirrored in the other, this test fails loudly
// + cites the divergent input. The corpus covers the edge cases that
// matter for the algorithm:
//   - exact division (no remainder)
//   - integer remainder distribution
//   - negative line (discount)
//   - multiple items aggregating per-member
//   - zero-amount item (no-op)
//   - zero assignees on an item (no-op)

import { splitsFromItemsMirror } from '../../../workers/ocr/src/expense-validate'

describe('client/worker splitsFromItems parity', () => {
  const fixtures: { name: string; items: { name?: string; amount: number; assignees: string[] }[] }[] = [
    { name: 'exact division (300/300/300)', items: [
      { amount: 900, assignees: ['a', 'b', 'c'] },
    ]},
    { name: 'integer remainder (¥1 / 3 → [1,0,0])', items: [
      { amount: 1, assignees: ['a', 'b', 'c'] },
    ]},
    { name: 'USD $10 / 3 → [4, 3, 3] (app integer convention)', items: [
      { amount: 10, assignees: ['a', 'b', 'c'] },
    ]},
    { name: 'multi-item aggregating across members', items: [
      { amount: 600, assignees: ['a', 'b'] },
      { amount: 300, assignees: ['b', 'c'] },
    ]},
    { name: 'negative discount line', items: [
      { amount:  1500, assignees: ['a', 'b'] },
      { amount: -600,  assignees: ['a', 'b'] },
    ]},
    { name: 'zero-amount item (no-op)', items: [
      { amount: 0,   assignees: ['a', 'b', 'c'] },
      { amount: 100, assignees: ['a', 'b'] },
    ]},
    { name: 'empty assignees on an item (skipped)', items: [
      { amount: 100, assignees: [] },
      { amount: 200, assignees: ['a', 'b'] },
    ]},
    { name: 'single assignee gets full amount', items: [
      { amount: 1000, assignees: ['solo'] },
    ]},
    { name: 'fractional input is rounded (app integer convention)', items: [
      { amount: 100.7, assignees: ['a', 'b', 'c'] },  // Math.round → 101 → [34, 34, 33]? actually [34, 34, 33] for 101/3
    ]},
  ]

  for (const fx of fixtures) {
    it(`agrees on: ${fx.name}`, () => {
      // Client: array of {memberId, amount}. Convert to Map for comparison.
      const clientArr = splitsFromItems(fx.items as unknown as Parameters<typeof splitsFromItems>[0])
      const clientMap = new Map(clientArr.map(s => [s.memberId, s.amount]))
      const workerMap = splitsFromItemsMirror(fx.items)
      expect(workerMap).toEqual(clientMap)
    })
  }
})
