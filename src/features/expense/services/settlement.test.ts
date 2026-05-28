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
    const { balances, pairwise } = computeBalancesFull(expenses, MEMBERS, settlements)
    expect(balances.find(b => b.memberId === 'm1')!.net).toBe(40)
    expect(balances.find(b => b.memberId === 'm2')!.net).toBe(-40)

    const suggestions = computeSettlements(pairwise)
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
      // Second settlement was over-cap at its own recording time (applied
      // had already consumed available debt) → OVERPAYMENT.
      { fromUserId: 'm2', toUserId: 'm1', amount: 10, settlementId: 's_m2_m1_50_b', reason: 'OVERPAYMENT' },
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
    const { balances, pairwise } = computeBalancesFull(expenses, MEMBERS)
    expect(balances.find(b => b.memberId === 'm1')!.net).toBe(10)
    expect(balances.find(b => b.memberId === 'm2')!.net).toBe(-10)

    const suggestions = computeSettlements(pairwise)
    expect(suggestions).toEqual([{ fromId: 'm2', toId: 'm1', amount: 10 }])
  })

  it('zero-sum cross debt produces no edge and no suggestion', () => {
    // m1 pays 100 (split 50/50 with m2) AND m2 pays 100 (split 50/50 with m1)
    // — both owe each other 50. Net out completely.
    const expenses = [
      mkExpense('m1', 100, [['m1', 50], ['m2', 50]], '_a'),
      mkExpense('m2', 100, [['m1', 50], ['m2', 50]], '_b'),
    ]
    const { balances, pairwise } = computeBalancesFull(expenses, MEMBERS)
    expect(balances.find(b => b.memberId === 'm1')!.net).toBe(0)
    expect(balances.find(b => b.memberId === 'm2')!.net).toBe(0)
    expect(computeSettlements(pairwise)).toEqual([])
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
      // Gross existed at recording (30) but settlement (50) exceeded it.
      { fromUserId: 'm2', toUserId: 'm1', amount: 20, settlementId: 's_m2_m1_50', reason: 'OVERPAYMENT' },
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
    //
    // Empty `expenses` fixture simulates a legacy HARD-deleted expense
    // (no soft-delete tombstone). At settlement recording time the
    // chronological replay sees gross == 0 → classifier returns UNKNOWN
    // (can't distinguish from genuine overpayment). The phase-2
    // EXPENSE_DELETED reason requires the deletedAt tombstone to be
    // present; see the soft-delete test below.
    const settlements = [mkSettlement('m2', 'm1', 50)]
    const { balances, orphans } = computeBalancesFull([], MEMBERS, settlements)
    expect(orphans).toEqual([
      { fromUserId: 'm2', toUserId: 'm1', amount: 50, settlementId: 's_m2_m1_50', reason: 'UNKNOWN' },
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
      // m2 had gross 20 at recording, paid 30 → OVERPAYMENT.
      { fromUserId: 'm2', toUserId: 'm1', amount: 10, settlementId: 's_m2_m1_30', reason: 'OVERPAYMENT' },
      // m3 had no gross at all on this pair → UNKNOWN (could be either
      // overpayment-to-the-wrong-person or a legacy hard-deleted expense).
      { fromUserId: 'm3', toUserId: 'm1', amount: 15, settlementId: 's_m3_m1_15', reason: 'UNKNOWN' },
    ])
  })

  it('two settlements on the same pair each with leftover → two orphan entries', () => {
    // No debt at all; both settlements are fully orphaned. The point
    // here is we get TWO entries (with their respective settlementIds),
    // not one aggregated "from m2 to m1, amount 80". Both classify as
    // UNKNOWN because there's never any gross to know whether they were
    // intended against (since-deleted) expenses or just overpaid.
    const settlements = [
      mkSettlement('m2', 'm1', 30, '_a'),
      mkSettlement('m2', 'm1', 50, '_b'),
    ]
    const { orphans } = computeBalancesFull([], MEMBERS, settlements)
    expect(orphans).toEqual([
      { fromUserId: 'm2', toUserId: 'm1', amount: 30, settlementId: 's_m2_m1_30_a', reason: 'UNKNOWN' },
      { fromUserId: 'm2', toUserId: 'm1', amount: 50, settlementId: 's_m2_m1_50_b', reason: 'UNKNOWN' },
    ])
  })
})

// ─── Chronological determinism ────────────────────────────────────

// Helper for tests that need distinct createdAt values. Spreads
// MOCK_TIMESTAMP and casts back to the branded Timestamp type —
// computeBalancesFull only reads `toMillis()`, the rest of the shape
// is structural.
function tsAt(ms: number): typeof TS {
  return {
    ...TS,
    toMillis: () => ms,
    toDate:   () => new Date(ms),
    seconds:  Math.floor(ms / 1000),
  } as unknown as typeof TS
}

describe('chronological settlement attribution', () => {
  it('later settlement bears the orphan when total exceeds gross (chronological cap)', () => {
    // m2 owes m1 100. Two settlements: 60 (earlier) + 50 (later).
    // Earlier consumes 60 of available 100; later applies 40 (cap),
    // leftover 10 → orphan attributed to the LATER settlement, deterministically.
    const expenses = [mkExpense('m1', 200, [['m1', 100], ['m2', 100]])]
    const earlier: SettlementRecord = { ...mkSettlement('m2', 'm1', 60, '_early'), createdAt: tsAt(1000) }
    const later:   SettlementRecord = { ...mkSettlement('m2', 'm1', 50, '_late'),  createdAt: tsAt(2000) }
    const { orphans } = computeBalancesFull(expenses, MEMBERS, [earlier, later])
    expect(orphans).toEqual([
      { fromUserId: 'm2', toUserId: 'm1', amount: 10, settlementId: 's_m2_m1_50_late', reason: 'OVERPAYMENT' },
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
      { fromUserId: 'm2', toUserId: 'm1', amount: 10, settlementId: 's_m2_m1_50_late', reason: 'OVERPAYMENT' },
    ])
  })
})

// ─── Phase-2: orphan reason classification via chronological replay ─

describe('orphan reason classification (phase-2)', () => {
  it('EXPENSE_DELETED: settlement was within available debt at recording, expense soft-deleted after', () => {
    // Timeline:
    //   t=1000: expense created (m1 paid 100, split 50/50 → m2 owes m1 50)
    //   t=2000: settlement m2→m1 for 50 (fully matches the debt)
    //   t=3000: expense soft-deleted
    // At t=2000 the settlement was valid (gross=50, amount=50 → within).
    // At final state, gross=0 (expense deleted) and settlement still
    // recorded → leftover 50 → EXPENSE_DELETED.
    const expense = {
      ...mkExpense('m1', 100, [['m1', 50], ['m2', 50]]),
      createdAt: tsAt(1000),
      deletedAt: tsAt(3000),
    }
    const settlement = { ...mkSettlement('m2', 'm1', 50), createdAt: tsAt(2000) }
    const { orphans, balances } = computeBalancesFull([expense], MEMBERS, [settlement])
    expect(orphans).toEqual([
      { fromUserId: 'm2', toUserId: 'm1', amount: 50, settlementId: 's_m2_m1_50', reason: 'EXPENSE_DELETED' },
    ])
    // Soft-deleted expense must NOT count toward paid / owed / net.
    expect(balances.find(b => b.memberId === 'm1')!.paid).toBe(0)
    expect(balances.find(b => b.memberId === 'm2')!.owed).toBe(0)
    for (const b of balances) expect(b.net).toBe(0)
  })

  it('OVERPAYMENT distinguished from EXPENSE_DELETED when expense existed at recording', () => {
    // m2 owed m1 30 (expense gross=30). Settlement of 50 recorded while
    // the expense was still alive — classifier sees gross>0 + over →
    // OVERPAYMENT, NOT UNKNOWN. The pre-phase-2 test "expense fully
    // deleted but settlement remains" hits UNKNOWN because no expense
    // record exists at all (legacy hard-delete).
    const expense = {
      ...mkExpense('m1', 60, [['m1', 30], ['m2', 30]]),
      createdAt: tsAt(1000),
    }
    const settlement = { ...mkSettlement('m2', 'm1', 50), createdAt: tsAt(2000) }
    const { orphans } = computeBalancesFull([expense], MEMBERS, [settlement])
    expect(orphans).toEqual([
      { fromUserId: 'm2', toUserId: 'm1', amount: 20, settlementId: 's_m2_m1_50', reason: 'OVERPAYMENT' },
    ])
  })

  it('soft-deleted expense is excluded from paid / owed / gross (matches UI display)', () => {
    // No settlements, just two expenses one of which is soft-deleted.
    // paid / owed / gross should reflect only the active expense.
    const alive = mkExpense('m1', 100, [['m1', 50], ['m2', 50]], '_alive')
    const dead  = {
      ...mkExpense('m1', 200, [['m1', 100], ['m2', 100]], '_dead'),
      deletedAt: tsAt(5000),
    }
    const { balances } = computeBalancesFull([alive, dead], MEMBERS)
    expect(balances.find(b => b.memberId === 'm1')!.paid).toBe(100)  // only alive
    expect(balances.find(b => b.memberId === 'm2')!.owed).toBe(50)
    expect(balances.find(b => b.memberId === 'm2')!.net).toBe(-50)   // owes m1 50
  })

  it('MIXED: settlement was partly over at recording AND a later delete shrunk what was within', () => {
    // The motivating scenario:
    //   t=1000: expense gross[m2][m1] = 50
    //   t=2000: settlement m2→m1 = 70 (over at recording by 20; 50 of it
    //           was within available at that moment)
    //   t=3000: expense soft-deleted, gross drops to 0
    //   final:  leftover = 70 (50 was eaten by delete, 20 was always over)
    // Pre-MIXED logic would tag the whole 70 as OVERPAYMENT -- wrong,
    // because most of it became orphan only because of the later delete.
    const expense = {
      ...mkExpense('m1', 100, [['m1', 50], ['m2', 50]]),
      createdAt: tsAt(1000),
      deletedAt: tsAt(3000),
    }
    const settlement = { ...mkSettlement('m2', 'm1', 70), createdAt: tsAt(2000) }
    const { orphans } = computeBalancesFull([expense], MEMBERS, [settlement])
    expect(orphans).toEqual([
      { fromUserId: 'm2', toUserId: 'm1', amount: 70, settlementId: 's_m2_m1_70', reason: 'MIXED' },
    ])
  })

  it('pure OVERPAYMENT stays OVERPAYMENT (no later delete) -- regression guard for MIXED logic', () => {
    // Same recording-time overpayment as the MIXED scenario, but NO
    // subsequent delete: leftover equals overpayment-at-recording, so
    // the classifier picks OVERPAYMENT, not MIXED.
    const expense = {
      ...mkExpense('m1', 60, [['m1', 30], ['m2', 30]]),
      createdAt: tsAt(1000),
    }
    const settlement = { ...mkSettlement('m2', 'm1', 50), createdAt: tsAt(2000) }
    const { orphans } = computeBalancesFull([expense], MEMBERS, [settlement])
    expect(orphans[0]!.reason).toBe('OVERPAYMENT')
  })

  it('multiple settlements with mixed reasons in one trip', () => {
    // Real-world mixed scenario:
    //   - m2→m1 fits an existing expense at recording (then expense deleted) → EXPENSE_DELETED
    //   - m3→m1 has no expense on this pair at all → UNKNOWN
    //   - m2→m3 over-cap at recording (some expense existed but smaller) → OVERPAYMENT
    const exp1 = {
      ...mkExpense('m1', 100, [['m1', 50], ['m2', 50]], '_for_m2'),
      createdAt: tsAt(1000),
      deletedAt: tsAt(5000),
    }
    const exp2 = {
      ...mkExpense('m3', 20, [['m2', 10], ['m3', 10]], '_for_m2m3'),
      createdAt: tsAt(1500),
    }
    const stExpDeleted = { ...mkSettlement('m2', 'm1', 50, '_a'), createdAt: tsAt(2000) }
    const stUnknown    = { ...mkSettlement('m3', 'm1', 30, '_b'), createdAt: tsAt(2500) }
    const stOver       = { ...mkSettlement('m2', 'm3', 25, '_c'), createdAt: tsAt(3000) }
    const { orphans } = computeBalancesFull(
      [exp1, exp2],
      MEMBERS,
      [stExpDeleted, stUnknown, stOver],
    )
    // Sort for stable assertion since orphans order is by createdAt sort.
    const byId = Object.fromEntries(orphans.map(o => [o.settlementId, o.reason]))
    expect(byId['s_m2_m1_50_a']).toBe('EXPENSE_DELETED')
    expect(byId['s_m3_m1_30_b']).toBe('UNKNOWN')
    expect(byId['s_m2_m3_25_c']).toBe('OVERPAYMENT')
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
  it('produces one transfer per non-zero pair edge (here all debtors point at m1)', () => {
    const expenses = [mkExpense('m1', 3000, [['m1', 1000], ['m2', 1000], ['m3', 1000]])]
    const { pairwise } = computeBalancesFull(expenses, MEMBERS)
    const s = computeSettlements(pairwise)
    expect(s).toEqual([
      { fromId: 'm2', toId: 'm1', amount: 1000 },
      { fromId: 'm3', toId: 'm1', amount: 1000 },
    ])
  })

  it('chain debts surface as separate pair suggestions (not collapsed via net)', () => {
    // m1 paid 3000 (split 1000 each) → m2, m3 each owe m1 1000.
    // m3 paid 900 (split 300 each)   → m1, m2 each owe m3 300.
    //
    // Pair-based output keeps each real debt edge explicit:
    //   m2 → m1 = 1000   (untouched)
    //   m3 → m1 =  700   (= 1000 - 300 after pair (m1,m3) normalize)
    //   m2 → m3 =  300   (untouched — no reverse edge)
    //
    // Net-greedy would have collapsed m3's flow into a single m3→m1=400
    // and m2's into m2→m1=1300, losing the m2→m3 fact entirely. Pair-
    // based keeps Worker-verifiable semantics: every suggested transfer
    // maps to a real (fromUid, toUid) debt edge.
    const expenses = [
      mkExpense('m1', 3000, [['m1', 1000], ['m2', 1000], ['m3', 1000]]),
      mkExpense('m3', 900,  [['m1', 300],  ['m2', 300],  ['m3', 300]]),
    ]
    const { pairwise } = computeBalancesFull(expenses, MEMBERS)
    const s = computeSettlements(pairwise)
    expect(s).toEqual([
      { fromId: 'm2', toId: 'm1', amount: 1000 },
      { fromId: 'm2', toId: 'm3', amount: 300 },
      { fromId: 'm3', toId: 'm1', amount: 700 },
    ])
    // Net-flow invariant still holds: out - in == member.net (just routed
    // through more edges).
    const { balances } = computeBalancesFull(expenses, MEMBERS)
    const outFor = (id: string) => s.filter(t => t.fromId === id).reduce((x, t) => x + t.amount, 0)
    const inFor  = (id: string) => s.filter(t => t.toId   === id).reduce((x, t) => x + t.amount, 0)
    for (const b of balances) {
      expect(outFor(b.memberId) - inFor(b.memberId)).toBe(-b.net)
    }
  })

  it('skips pairs within the epsilon threshold (no spam 0/1 円 transfers)', () => {
    const expenses = [
      mkExpense('m1', 300, [['m1', 100], ['m2', 100], ['m3', 100]]),
      mkExpense('m2', 300, [['m1', 100], ['m2', 100], ['m3', 100]]),
      mkExpense('m3', 300, [['m1', 100], ['m2', 100], ['m3', 100]]),
    ]
    const { pairwise } = computeBalancesFull(expenses, MEMBERS)
    expect(computeSettlements(pairwise)).toEqual([])
  })

  it('balanced 3-person cycle: pair-normalize cancels every edge, no suggestion', () => {
    // Each person paid 30, split equally — every pair has a matching
    // reverse edge of equal magnitude, normalize wipes them all out.
    // Pair-based and net-based agree here because the cycle is balanced.
    const expenses = [
      mkExpense('m1', 30, [['m1', 10], ['m2', 10], ['m3', 10]], '_a'),
      mkExpense('m2', 30, [['m1', 10], ['m2', 10], ['m3', 10]], '_b'),
      mkExpense('m3', 30, [['m1', 10], ['m2', 10], ['m3', 10]], '_c'),
    ]
    const { pairwise } = computeBalancesFull(expenses, MEMBERS)
    expect(computeSettlements(pairwise)).toEqual([])
  })

  it('unbalanced 3-person cycle (A owes B, B owes C, C owes A): pair-based emits 3 transfers', () => {
    // Pure directed cycle without offsetting edges — net is zero for
    // everyone, but pair-based surfaces all three real debts. This is
    // the deliberate tradeoff: more transfers but every suggestion
    // maps to a verifiable pair debt that the Worker can validate.
    // Net-based greedy would suggest zero (and miss the real obligations).
    const expenses = [
      // m1 paid 10, only m2 owed back → m2 → m1 = 10
      mkExpense('m1', 10, [['m2', 10]], '_a'),
      // m2 paid 10, only m3 owed back → m3 → m2 = 10
      mkExpense('m2', 10, [['m3', 10]], '_b'),
      // m3 paid 10, only m1 owed back → m1 → m3 = 10
      mkExpense('m3', 10, [['m1', 10]], '_c'),
    ]
    const { balances, pairwise } = computeBalancesFull(expenses, MEMBERS)
    // Every net is zero, yet:
    for (const b of balances) expect(b.net).toBe(0)
    expect(computeSettlements(pairwise)).toEqual([
      { fromId: 'm1', toId: 'm3', amount: 10 },
      { fromId: 'm2', toId: 'm1', amount: 10 },
      { fromId: 'm3', toId: 'm2', amount: 10 },
    ])
  })
})
