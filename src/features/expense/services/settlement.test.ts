import { describe, it, expect } from 'vitest'
import { computeBalances, computeSettlements } from './settlement'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'

const MEMBERS: TripMember[] = [
  { id: 'm1', label: 'A', color: '#000', bg: '#fff' },
  { id: 'm2', label: 'B', color: '#000', bg: '#fff' },
  { id: 'm3', label: 'C', color: '#000', bg: '#fff' },
]

function mkExpense(
  paidBy: string,
  amount: number,
  splits: Array<[string, number]>,
): Expense {
  return {
    id: `e_${paidBy}_${amount}`, tripId: 'demo', title: 't', amount,
    currency: 'JPY', category: 'food', paidBy,
    splits: splits.map(([memberId, amount]) => ({ memberId, amount })),
    date: '2026-05-01', createdBy: 'u', createdAt: TS, updatedAt: TS,
  }
}

describe('computeBalances', () => {
  it('tallies paid and owed per member', () => {
    const expenses = [
      mkExpense('m1', 3000, [['m1', 1000], ['m2', 1000], ['m3', 1000]]),
      mkExpense('m2', 600,  [['m1', 300],  ['m2', 300]]),
    ]
    const r = computeBalances(expenses, MEMBERS)
    expect(r).toEqual([
      { memberId: 'm1', paid: 3000, owed: 1300, net:  1700 },
      { memberId: 'm2', paid: 600,  owed: 1300, net:  -700 },
      { memberId: 'm3', paid: 0,    owed: 1000, net: -1000 },
    ])
  })

  it('ignores paidBy / splits referencing unknown member ids', () => {
    const expenses = [
      mkExpense('ghost', 500, [['m1', 300], ['phantom', 200]]),
    ]
    const r = computeBalances(expenses, MEMBERS)
    expect(r.find(b => b.memberId === 'm1')?.owed).toBe(300)
    // Unknown ids are dropped — sum(net) does NOT balance here by design.
    expect(r.every(b => b.paid === 0)).toBe(true)
  })

  it('returns zero rows when there are no expenses', () => {
    expect(computeBalances([], MEMBERS)).toEqual([
      { memberId: 'm1', paid: 0, owed: 0, net: 0 },
      { memberId: 'm2', paid: 0, owed: 0, net: 0 },
      { memberId: 'm3', paid: 0, owed: 0, net: 0 },
    ])
  })
})

describe('computeSettlements', () => {
  it('produces at most N-1 transfers for N members with non-zero balance', () => {
    // m1 paid 3000 for all, everyone owes 1000
    const expenses = [mkExpense('m1', 3000, [['m1', 1000], ['m2', 1000], ['m3', 1000]])]
    const bal = computeBalances(expenses, MEMBERS)
    const s = computeSettlements(bal)
    expect(s.length).toBeLessThanOrEqual(2)
    // Every transfer flows to m1
    expect(s.every(t => t.toId === 'm1')).toBe(true)
    // And the sum settles m1's credit
    expect(s.reduce((sum, t) => sum + t.amount, 0)).toBe(2000)
  })

  it('each debtor outflow matches their net owed', () => {
    const expenses = [
      mkExpense('m1', 3000, [['m1', 1000], ['m2', 1000], ['m3', 1000]]),
      mkExpense('m3', 900,  [['m1', 300],  ['m2', 300],  ['m3', 300]]),
    ]
    // m1 net: paid 3000 - owed 1300 = +1700
    // m2 net: paid 0    - owed 1300 = -1300
    // m3 net: paid 900  - owed 1300 = -400
    const bal = computeBalances(expenses, MEMBERS)
    const s = computeSettlements(bal)

    const outFor = (id: string) => s.filter(t => t.fromId === id).reduce((x, t) => x + t.amount, 0)
    expect(outFor('m2')).toBe(1300)
    expect(outFor('m3')).toBe(400)
  })

  it('skips pairs within the epsilon threshold (no spam 0/1 円 transfers)', () => {
    // All equal → zero balances → zero settlements
    const expenses = [
      mkExpense('m1', 300, [['m1', 100], ['m2', 100], ['m3', 100]]),
      mkExpense('m2', 300, [['m1', 100], ['m2', 100], ['m3', 100]]),
      mkExpense('m3', 300, [['m1', 100], ['m2', 100], ['m3', 100]]),
    ]
    const bal = computeBalances(expenses, MEMBERS)
    expect(computeSettlements(bal)).toEqual([])
  })
})
