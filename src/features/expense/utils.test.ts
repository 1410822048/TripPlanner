import { describe, it, expect } from 'vitest'
import { splitEqually, splitSummary } from './utils'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'
import type { Expense } from '@/types'

function mkExpense(splits: Array<{ memberId: string; amount: number }>): Expense {
  return {
    id: 'e1', tripId: 'demo', title: 't', amount: splits.reduce((s, x) => s + x.amount, 0),
    currency: 'JPY', category: 'food', paidBy: 'm1', splits,
    date: '2026-05-01', createdBy: 'u', createdAt: TS, updatedAt: TS,
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
