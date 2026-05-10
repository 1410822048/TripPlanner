import { describe, it, expect } from 'vitest'
import { computeBalances, computeSettlements, expandWithGhosts, ghostMember } from './settlement'
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

  it('appends ghost rows for paidBy / split ids missing from members', () => {
    // Scenario: an ex-member ('ghost') paid 500, splitting between a
    // current member (m1: 300) and another ex-member ('phantom': 200).
    // Both unknown ids must produce balance rows so the totals
    // reconcile — otherwise settlement math breaks.
    const expenses = [
      mkExpense('ghost', 500, [['m1', 300], ['phantom', 200]]),
    ]
    const r = computeBalances(expenses, MEMBERS)

    // Active members first, ghosts at the tail in first-seen order.
    expect(r.map(b => b.memberId)).toEqual(['m1', 'm2', 'm3', 'ghost', 'phantom'])
    expect(r.find(b => b.memberId === 'm1')!.owed).toBe(300)
    expect(r.find(b => b.memberId === 'ghost')!.paid).toBe(500)
    expect(r.find(b => b.memberId === 'phantom')!.owed).toBe(200)

    // Critical invariant: sum(net) ≈ 0. Without ghost rows this would
    // fail (the +500 paidBy 'ghost' would be silently dropped).
    const totalNet = r.reduce((s, b) => s + b.net, 0)
    expect(totalNet).toBe(0)
  })

  it('returns zero rows when there are no expenses', () => {
    expect(computeBalances([], MEMBERS)).toEqual([
      { memberId: 'm1', paid: 0, owed: 0, net: 0 },
      { memberId: 'm2', paid: 0, owed: 0, net: 0 },
      { memberId: 'm3', paid: 0, owed: 0, net: 0 },
    ])
  })
})

describe('expandWithGhosts', () => {
  it('returns the input unchanged when every uid is a known member', () => {
    const expenses = [mkExpense('m1', 300, [['m1', 100], ['m2', 100], ['m3', 100]])]
    expect(expandWithGhosts(MEMBERS, expenses)).toBe(MEMBERS)  // referential identity
  })

  it('appends one ghost per unknown uid (deduped, first-seen order)', () => {
    const expenses = [
      mkExpense('ghost', 500, [['m1', 300], ['phantom', 200]]),
      mkExpense('ghost', 200, [['ghost', 200]]),  // dup — must not produce a 2nd ghost row
    ]
    const r = expandWithGhosts(MEMBERS, expenses)
    expect(r.length).toBe(MEMBERS.length + 2)
    expect(r.slice(0, 3)).toEqual(MEMBERS)
    expect(r.slice(3).map(m => m.id)).toEqual(['ghost', 'phantom'])
    // Ghost rows are flagged so UI can render them differently.
    expect(r[3]!.isGhost).toBe(true)
    expect(r[4]!.isGhost).toBe(true)
  })
})

describe('ghostMember', () => {
  it('produces a TripMember-shaped placeholder with isGhost set', () => {
    const g = ghostMember('left-the-trip')
    expect(g.id).toBe('left-the-trip')
    expect(g.isGhost).toBe(true)
    expect(typeof g.label).toBe('string')
    expect(typeof g.color).toBe('string')
    expect(typeof g.bg).toBe('string')
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
