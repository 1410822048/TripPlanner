import { describe, it, expect } from 'vitest'
import {
  computeBalances,
  computeBalancesFull,
  computeSettlements,
  expandWithGhosts,
  ghostMember,
} from './settlement'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'
import type { Expense } from '@/types'
import type { SettlementRecord } from '@/types/settlement'
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
  idSuffix = '',
): Expense {
  return {
    id: `e_${paidBy}_${amount}${idSuffix}`,
    tripId: 'demo',
    title: 't',
    amount,
    currency: 'JPY',
    category: 'food',
    paidBy,
    splits: splits.map(([memberId, amount]) => ({ memberId, amount })),
    date: '2026-05-01',
    memberIds: ['m1', 'm2', 'm3'],
    createdBy: 'u',
    updatedBy: 'u',
    createdAt: TS,
    updatedAt: TS,
  }
}

function mkSettlement(
  fromUid: string,
  toUid:   string,
  amount:  number,
  idSuffix = '',
): SettlementRecord {
  return {
    id: `s_${fromUid}_${toUid}_${amount}${idSuffix}`,
    tripId: 'demo',
    fromUid,
    toUid,
    amount,
    currency: 'JPY',
    settledBy: toUid,
    createdAt: TS,
  }
}

// ─── Existing coverage (regression) ───────────────────────────────

describe('computeBalances', () => {
  it('tallies paid and owed per member (expenses only)', () => {
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
    const expenses = [
      mkExpense('ghost', 500, [['m1', 300], ['phantom', 200]]),
    ]
    const r = computeBalances(expenses, MEMBERS)
    expect(r.map(b => b.memberId)).toEqual(['m1', 'm2', 'm3', 'ghost', 'phantom'])
    expect(r.find(b => b.memberId === 'm1')!.owed).toBe(300)
    expect(r.find(b => b.memberId === 'ghost')!.paid).toBe(500)
    expect(r.find(b => b.memberId === 'phantom')!.owed).toBe(200)
    expect(r.reduce((s, b) => s + b.net, 0)).toBe(0)
  })

  it('returns zero rows when there are no expenses', () => {
    expect(computeBalances([], MEMBERS)).toEqual([
      { memberId: 'm1', paid: 0, owed: 0, net: 0 },
      { memberId: 'm2', paid: 0, owed: 0, net: 0 },
      { memberId: 'm3', paid: 0, owed: 0, net: 0 },
    ])
  })
})

// ─── Settlement basics ────────────────────────────────────────────

describe('computeBalances + settlements', () => {
  it('a single settlement that exactly matches the debt zeros both nets', () => {
    const expenses = [mkExpense('m1', 100, [['m1', 50], ['m2', 50]])]
    const settlements = [mkSettlement('m2', 'm1', 50)]
    const { balances, orphans } = computeBalancesFull(expenses, MEMBERS, settlements)
    expect(orphans).toEqual([])
    const m1 = balances.find(b => b.memberId === 'm1')!
    const m2 = balances.find(b => b.memberId === 'm2')!
    expect(m1).toMatchObject({ paid: 100, owed: 50, net: 0 })
    expect(m2).toMatchObject({ paid: 0,   owed: 50, net: 0 })
  })

  it('paid / owed are derived from expenses only — settlements never inflate them', () => {
    // Old algorithm bug: settlement amount got added to paid (for sender)
    // and owed (for receiver), making "立替 / 分担" display read 2x of
    // reality for any pair that had settled. Debt-edge model fixes this.
    const expenses = [mkExpense('m1', 100, [['m1', 50], ['m2', 50]])]
    const settlements = [mkSettlement('m2', 'm1', 50)]
    const r = computeBalances(expenses, MEMBERS, settlements)
    expect(r.find(b => b.memberId === 'm1')!.paid).toBe(100)  // not 150
    expect(r.find(b => b.memberId === 'm1')!.owed).toBe(50)   // not 100
    expect(r.find(b => b.memberId === 'm2')!.paid).toBe(0)    // not 50
    expect(r.find(b => b.memberId === 'm2')!.owed).toBe(50)   // not 50 + extras
  })
})

// ─── Multiple settlements per pair ────────────────────────────────

describe('multiple settlements per pair', () => {
  it('sums multiple partial settlements toward the same pair', () => {
    // m2 owes m1 a total of 100, paid back in three chunks
    const expenses = [mkExpense('m1', 200, [['m1', 100], ['m2', 100]])]
    const settlements = [
      mkSettlement('m2', 'm1', 40, '_a'),
      mkSettlement('m2', 'm1', 30, '_b'),
      mkSettlement('m2', 'm1', 30, '_c'),
    ]
    const { balances, orphans } = computeBalancesFull(expenses, MEMBERS, settlements)
    expect(orphans).toEqual([])
    expect(balances.find(b => b.memberId === 'm1')!.net).toBe(0)
    expect(balances.find(b => b.memberId === 'm2')!.net).toBe(0)
  })

  it('partial settlements leave the remaining debt for the suggestion list', () => {
    // m2 owes m1 100, settled 60 → 40 outstanding
    const expenses = [mkExpense('m1', 200, [['m1', 100], ['m2', 100]])]
    const settlements = [mkSettlement('m2', 'm1', 60)]
    const { balances } = computeBalancesFull(expenses, MEMBERS, settlements)
    expect(balances.find(b => b.memberId === 'm1')!.net).toBe(40)
    expect(balances.find(b => b.memberId === 'm2')!.net).toBe(-40)

    const suggestions = computeSettlements(balances)
    expect(suggestions).toEqual([{ fromId: 'm2', toId: 'm1', amount: 40 }])
  })

  it('once-overshooting last settlement of a chain produces an orphan', () => {
    // m2 owes m1 100. Pays 60, then 50 (total 110, 10 too many).
    // Chronological processing means the later '_b' settlement bears
    // the leftover; the earlier '_a' fully consumes 60 of available 100.
    const expenses = [mkExpense('m1', 200, [['m1', 100], ['m2', 100]])]
    const settlements = [
      mkSettlement('m2', 'm1', 60, '_a'),
      mkSettlement('m2', 'm1', 50, '_b'),
    ]
    const { balances, orphans } = computeBalancesFull(expenses, MEMBERS, settlements)
    expect(balances.find(b => b.memberId === 'm1')!.net).toBe(0)
    expect(balances.find(b => b.memberId === 'm2')!.net).toBe(0)
    expect(orphans).toEqual([
      { fromUserId: 'm2', toUserId: 'm1', amount: 10, settlementId: 's_m2_m1_50_b' },
    ])
  })
})

// ─── Cross debt + normalize ──────────────────────────────────────

describe('cross-debt normalization', () => {
  it('normalises opposite-direction edges to the net direction', () => {
    // Two expenses crossing the same pair:
    //   m1 paid 100, split m1:50 m2:50 → m2 owes m1 50
    //   m2 paid 80,  split m1:40 m2:40 → m1 owes m2 40
    // Without normalize: 2 edges (50 and 40). With normalize: m2 owes m1 10.
    const expenses = [
      mkExpense('m1', 100, [['m1', 50], ['m2', 50]], '_a'),
      mkExpense('m2', 80,  [['m1', 40], ['m2', 40]], '_b'),
    ]
    const { balances } = computeBalancesFull(expenses, MEMBERS)
    expect(balances.find(b => b.memberId === 'm1')!.net).toBe(10)
    expect(balances.find(b => b.memberId === 'm2')!.net).toBe(-10)

    const suggestions = computeSettlements(balances)
    expect(suggestions).toEqual([{ fromId: 'm2', toId: 'm1', amount: 10 }])
  })

  it('zero-sum cross debt produces no edge and no suggestion', () => {
    // m1 pays 100 (split 50/50 with m2) AND m2 pays 100 (split 50/50 with m1)
    // — both owe each other 50. Net out completely.
    const expenses = [
      mkExpense('m1', 100, [['m1', 50], ['m2', 50]], '_a'),
      mkExpense('m2', 100, [['m1', 50], ['m2', 50]], '_b'),
    ]
    const { balances } = computeBalancesFull(expenses, MEMBERS)
    expect(balances.find(b => b.memberId === 'm1')!.net).toBe(0)
    expect(balances.find(b => b.memberId === 'm2')!.net).toBe(0)
    expect(computeSettlements(balances)).toEqual([])
  })

  it('settlement on the normalised direction settles the pair fully', () => {
    // Same as the first cross-debt test: net m2 → m1 = 10. m2 settles 10.
    const expenses = [
      mkExpense('m1', 100, [['m1', 50], ['m2', 50]], '_a'),
      mkExpense('m2', 80,  [['m1', 40], ['m2', 40]], '_b'),
    ]
    // NOTE: settlement still applies to the underlying gross edge m2→m1.
    // The reverse edge m1→m2 (40) remains as orphan-free debt because
    // there's no settlement record consuming it. Normalize then cancels
    // it against remaining gross m2→m1 (= 50 − 50 = 0).
    //   - gross[m2][m1] = 50,  applied 50 → remaining[m2][m1] = 0
    //   - gross[m1][m2] = 40,  applied 0  → remaining[m1][m2] = 40
    //   - normalize: m1 owes m2 40
    const settlements = [mkSettlement('m2', 'm1', 50)]
    const { balances, orphans } = computeBalancesFull(expenses, MEMBERS, settlements)
    expect(orphans).toEqual([])
    expect(balances.find(b => b.memberId === 'm1')!.net).toBe(-40)
    expect(balances.find(b => b.memberId === 'm2')!.net).toBe(40)
  })
})

// ─── Orphan cases ─────────────────────────────────────────────────

describe('orphan settlements', () => {
  it('overpayment: settlement amount exceeds gross debt → orphan', () => {
    // m2 owes m1 30, but pays back 50 (10 too much, but caused by editing
    // an expense down after the settlement was recorded, say).
    const expenses = [mkExpense('m1', 60, [['m1', 30], ['m2', 30]])]
    const settlements = [mkSettlement('m2', 'm1', 50)]
    const { balances, orphans } = computeBalancesFull(expenses, MEMBERS, settlements)
    expect(orphans).toEqual([
      { fromUserId: 'm2', toUserId: 'm1', amount: 20, settlementId: 's_m2_m1_50' },
    ])
    // Critical: the overpayment does NOT flip m1 into a debtor position.
    // Net is at most "0 on this pair" — no reverse-debt creation.
    expect(balances.find(b => b.memberId === 'm1')!.net).toBe(0)
    expect(balances.find(b => b.memberId === 'm2')!.net).toBe(0)
  })

  it('expense fully deleted but settlement remains → all orphan, no reverse debt', () => {
    // This was THE bug: previously, deleting an expense after a settlement
    // had been recorded surfaced the settlement as reverse debt — the
    // settled-payer appeared to be owed money. Debt-edge model produces
    // all-zero balances with the settlement recorded as orphan.
    const settlements = [mkSettlement('m2', 'm1', 50)]
    const { balances, orphans } = computeBalancesFull([], MEMBERS, settlements)
    expect(orphans).toEqual([
      { fromUserId: 'm2', toUserId: 'm1', amount: 50, settlementId: 's_m2_m1_50' },
    ])
    for (const b of balances) {
      expect(b.net).toBe(0)
    }
  })

  it('one orphan entry per leftover settlement (not per pair)', () => {
    // Two pairs each have an orphan; we surface one entry per
    // settlement so the UI can target a specific record for delete.
    const expenses = [mkExpense('m1', 40, [['m1', 20], ['m2', 20]])]
    const settlements = [
      mkSettlement('m2', 'm1', 30),  // m2 owes m1 20, paid 30 → orphan 10
      mkSettlement('m3', 'm1', 15),  // m3 owes m1 nothing → orphan 15
    ]
    const { orphans } = computeBalancesFull(expenses, MEMBERS, settlements)
    const sorted = [...orphans].sort((a, b) => a.fromUserId.localeCompare(b.fromUserId))
    expect(sorted).toEqual([
      { fromUserId: 'm2', toUserId: 'm1', amount: 10, settlementId: 's_m2_m1_30' },
      { fromUserId: 'm3', toUserId: 'm1', amount: 15, settlementId: 's_m3_m1_15' },
    ])
  })

  it('two settlements on the same pair each with leftover → two orphan entries', () => {
    // No debt at all; both settlements are fully orphaned. The point
    // here is we get TWO entries (with their respective settlementIds),
    // not one aggregated "from m2 to m1, amount 80".
    const settlements = [
      mkSettlement('m2', 'm1', 30, '_a'),
      mkSettlement('m2', 'm1', 50, '_b'),
    ]
    const { orphans } = computeBalancesFull([], MEMBERS, settlements)
    expect(orphans).toEqual([
      { fromUserId: 'm2', toUserId: 'm1', amount: 30, settlementId: 's_m2_m1_30_a' },
      { fromUserId: 'm2', toUserId: 'm1', amount: 50, settlementId: 's_m2_m1_50_b' },
    ])
  })
})

// ─── Chronological determinism ────────────────────────────────────

describe('chronological settlement attribution', () => {
  // Helper for tests that need distinct createdAt values. We spread the
  // existing MOCK_TIMESTAMP and cast back to Timestamp because TS
  // doesn't narrow the result of an object spread to the original
  // branded type — only computeBalancesFull's `toMillis()` call is
  // sensitive to the value, the rest of the shape is structural.
  function tsAt(ms: number): typeof TS {
    return {
      ...TS,
      toMillis: () => ms,
      toDate:   () => new Date(ms),
      seconds:  Math.floor(ms / 1000),
    } as unknown as typeof TS
  }

  it('later settlement bears the orphan when total exceeds gross (chronological cap)', () => {
    // m2 owes m1 100. Two settlements: 60 (earlier) + 50 (later).
    // Earlier consumes 60 of available 100; later applies 40 (cap),
    // leftover 10 → orphan attributed to the LATER settlement, deterministically.
    const expenses = [mkExpense('m1', 200, [['m1', 100], ['m2', 100]])]
    const earlier: SettlementRecord = { ...mkSettlement('m2', 'm1', 60, '_early'), createdAt: tsAt(1000) }
    const later:   SettlementRecord = { ...mkSettlement('m2', 'm1', 50, '_late'),  createdAt: tsAt(2000) }
    const { orphans } = computeBalancesFull(expenses, MEMBERS, [earlier, later])
    expect(orphans).toEqual([
      { fromUserId: 'm2', toUserId: 'm1', amount: 10, settlementId: 's_m2_m1_50_late' },
    ])
  })

  it('orphan attribution is invariant to input array order (sorts by createdAt)', () => {
    // Same data as the previous test, but passed in REVERSE array order.
    // Because the algorithm sorts by createdAt first, the orphan still
    // lands on the chronologically-later settlement — Firestore's
    // arbitrary return order can't shift attribution between page loads.
    const expenses = [mkExpense('m1', 200, [['m1', 100], ['m2', 100]])]
    const earlier: SettlementRecord = { ...mkSettlement('m2', 'm1', 60, '_early'), createdAt: tsAt(1000) }
    const later:   SettlementRecord = { ...mkSettlement('m2', 'm1', 50, '_late'),  createdAt: tsAt(2000) }
    const { orphans } = computeBalancesFull(expenses, MEMBERS, [later, earlier])
    expect(orphans).toEqual([
      { fromUserId: 'm2', toUserId: 'm1', amount: 10, settlementId: 's_m2_m1_50_late' },
    ])
  })
})

// ─── Existing structural tests (must still pass) ──────────────────

describe('expandWithGhosts', () => {
  it('returns the input unchanged when every uid is a known member', () => {
    const expenses = [mkExpense('m1', 300, [['m1', 100], ['m2', 100], ['m3', 100]])]
    expect(expandWithGhosts(MEMBERS, expenses)).toBe(MEMBERS)
  })

  it('appends one ghost per unknown uid (deduped, first-seen order)', () => {
    const expenses = [
      mkExpense('ghost', 500, [['m1', 300], ['phantom', 200]]),
      mkExpense('ghost', 200, [['ghost', 200]]),
    ]
    const r = expandWithGhosts(MEMBERS, expenses)
    expect(r.length).toBe(MEMBERS.length + 2)
    expect(r.slice(0, 3)).toEqual(MEMBERS)
    expect(r.slice(3).map(m => m.id)).toEqual(['ghost', 'phantom'])
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
    const expenses = [mkExpense('m1', 3000, [['m1', 1000], ['m2', 1000], ['m3', 1000]])]
    const bal = computeBalances(expenses, MEMBERS)
    const s = computeSettlements(bal)
    expect(s.length).toBeLessThanOrEqual(2)
    expect(s.every(t => t.toId === 'm1')).toBe(true)
    expect(s.reduce((sum, t) => sum + t.amount, 0)).toBe(2000)
  })

  it('each debtor outflow matches their net owed', () => {
    const expenses = [
      mkExpense('m1', 3000, [['m1', 1000], ['m2', 1000], ['m3', 1000]]),
      mkExpense('m3', 900,  [['m1', 300],  ['m2', 300],  ['m3', 300]]),
    ]
    const bal = computeBalances(expenses, MEMBERS)
    const s = computeSettlements(bal)
    const outFor = (id: string) => s.filter(t => t.fromId === id).reduce((x, t) => x + t.amount, 0)
    expect(outFor('m2')).toBe(1300)
    expect(outFor('m3')).toBe(400)
  })

  it('skips pairs within the epsilon threshold (no spam 0/1 円 transfers)', () => {
    const expenses = [
      mkExpense('m1', 300, [['m1', 100], ['m2', 100], ['m3', 100]]),
      mkExpense('m2', 300, [['m1', 100], ['m2', 100], ['m3', 100]]),
      mkExpense('m3', 300, [['m1', 100], ['m2', 100], ['m3', 100]]),
    ]
    const bal = computeBalances(expenses, MEMBERS)
    expect(computeSettlements(bal)).toEqual([])
  })

  it('3-person cycle (A→B→C→A each 10): net-based suggestion correctly produces zero transfers', () => {
    // Each person paid 30, split equally — everyone's net is 0 but the
    // pairwise edges form a cycle. greedy via net (not pairwise) gives
    // the optimal answer: nothing needs to move.
    const expenses = [
      mkExpense('m1', 30, [['m1', 10], ['m2', 10], ['m3', 10]], '_a'),
      mkExpense('m2', 30, [['m1', 10], ['m2', 10], ['m3', 10]], '_b'),
      mkExpense('m3', 30, [['m1', 10], ['m2', 10], ['m3', 10]], '_c'),
    ]
    const bal = computeBalances(expenses, MEMBERS)
    expect(computeSettlements(bal)).toEqual([])
  })
})
