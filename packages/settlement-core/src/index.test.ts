// Canonical fixture suite for the pairwise-remaining algorithm.
//
// Before this package existed, an 8-fixture table lived in two places —
// `workers/ocr/test/settlement-domain.spec.ts` (Worker) and
// `src/features/expense/services/settlement.test.ts` cross-check block
// (client) — running on independent implementations to catch drift.
//
// With the math collapsed into one shared function, this suite is the
// SINGLE place those fixtures live. The client/Worker adapter commits
// (2 and 3) delete their respective mirrors, so any future change to
// `computePairwiseRemaining` either passes these fixtures or fails them
// — there's no longer a divergent second impl to drift against.
//
// Coverage rationale — each fixture exercises one semantic corner:
//   1. empty                       — degenerate-input safety
//   2. single-pair-debt-only       — basic gross → remaining → normalize passthrough
//   3. opposite-direction-normalize — step 4 picks the larger direction
//   4. eps-collapse                — |fwd - bwd| ≤ EPS collapses to no edge
//   5. settlement-fully-pays       — applied cap exactly equals gross
//   6. settlement-partial          — partial applied, remaining survives
//   7. overpay-capped              — settlement > gross, applied caps at gross (leftover ignored here)
//   8. three-way-normalize         — multi-pair normalize in one trip

import { describe, it, expect } from 'vitest'
import {
  SETTLEMENT_EPS,
  canonicalPairKey,
  isSettlementSafe,
  pairRemaining,
  computePairwiseRemaining,
  type CoreExpense,
  type CoreSettlement,
} from './index'

interface PairwiseFixture {
  name:        string
  expenses:    CoreExpense[]
  settlements: CoreSettlement[]
  expected:    Record<string, Record<string, number>>
}

const PAIRWISE_FIXTURES: PairwiseFixture[] = [
  {
    name:        '1. empty inputs produce empty pairwise',
    expenses:    [],
    settlements: [],
    expected:    {},
  },
  {
    name: '2. single-pair debt (B owes A 100) survives normalize as-is',
    expenses: [
      { paidBy: 'A', amount: 100, splits: [{ memberId: 'B', amount: 100 }] },
    ],
    settlements: [],
    expected:    { B: { A: 100 } },
  },
  {
    name: '3. opposite-direction debts normalize to net winner',
    // A pays for B (B owes A 30); B pays for A (A owes B 50)
    // → A owes B net 20.
    expenses: [
      { paidBy: 'A', amount: 30, splits: [{ memberId: 'B', amount: 30 }] },
      { paidBy: 'B', amount: 50, splits: [{ memberId: 'A', amount: 50 }] },
    ],
    settlements: [],
    expected:    { A: { B: 20 } },
  },
  {
    name: '4. equal opposite debts collapse via EPS (no edge)',
    // Both directions = 25 → |fwd - bwd| = 0 ≤ EPS, no surviving edge.
    expenses: [
      { paidBy: 'A', amount: 25, splits: [{ memberId: 'B', amount: 25 }] },
      { paidBy: 'B', amount: 25, splits: [{ memberId: 'A', amount: 25 }] },
    ],
    settlements: [],
    expected:    {},
  },
  {
    name: '5. settlement fully pays single pair → no remaining edge',
    expenses: [
      { paidBy: 'A', amount: 100, splits: [{ memberId: 'B', amount: 100 }] },
    ],
    settlements: [
      { fromUid: 'B', toUid: 'A', amount: 100, createdAtMs: 1 },
    ],
    expected: {},
  },
  {
    name: '6. settlement partially pays → remaining survives',
    expenses: [
      { paidBy: 'A', amount: 100, splits: [{ memberId: 'B', amount: 100 }] },
    ],
    settlements: [
      { fromUid: 'B', toUid: 'A', amount: 40, createdAtMs: 1 },
    ],
    expected: { B: { A: 60 } },
  },
  {
    name: '7. overpay caps at gross → no remaining edge (leftover ignored here)',
    expenses: [
      { paidBy: 'A', amount: 50, splits: [{ memberId: 'B', amount: 50 }] },
    ],
    settlements: [
      { fromUid: 'B', toUid: 'A', amount: 80, createdAtMs: 1 },
    ],
    expected: {},
  },
  {
    name: '8. three-member trip with overlap → 3 normalized edges',
    // A pays 90 split [B 30, C 30, A 30] → gross[B][A]=30, gross[C][A]=30
    // B pays 60 split [A 20, C 20, B 20] → gross[A][B]=20, gross[C][B]=20
    // Pair (A,B): fwd=20, bwd=30 → B→A=10
    // Pair (A,C): fwd=0,  bwd=30 → C→A=30
    // Pair (B,C): fwd=0,  bwd=20 → C→B=20
    expenses: [
      {
        paidBy: 'A',
        amount: 90,
        splits: [
          { memberId: 'B', amount: 30 },
          { memberId: 'C', amount: 30 },
          { memberId: 'A', amount: 30 },
        ],
      },
      {
        paidBy: 'B',
        amount: 60,
        splits: [
          { memberId: 'A', amount: 20 },
          { memberId: 'C', amount: 20 },
          { memberId: 'B', amount: 20 },
        ],
      },
    ],
    settlements: [],
    expected: {
      B: { A: 10 },
      C: { A: 30, B: 20 },
    },
  },
]

describe('computePairwiseRemaining (canonical fixtures)', () => {
  for (const fx of PAIRWISE_FIXTURES) {
    it(fx.name, () => {
      const actual = computePairwiseRemaining(fx.expenses, fx.settlements)
      expect(actual).toEqual(fx.expected)
    })
  }
})

describe('canonicalPairKey', () => {
  it('is order-independent', () => {
    expect(canonicalPairKey('A', 'B')).toBe(canonicalPairKey('B', 'A'))
  })

  it('sorts lexicographically and length-prefixes both halves', () => {
    expect(canonicalPairKey('A', 'B')).toBe('1:A:1:B')
    expect(canonicalPairKey('zzz', 'aaa')).toBe('3:aaa:3:zzz')
  })

  it('handles equal ids (degenerate but stable)', () => {
    // Self-debt is stripped by the math, but the key function itself
    // should still be total — callers that build per-pair lock docs
    // shouldn't crash on equal uids.
    expect(canonicalPairKey('x', 'x')).toBe('1:x:1:x')
  })

  it('does not collide when an id contains the separator', () => {
    // {a|b, c} and {a, b|c} are different unordered pairs, but a naive
    // `${lo}|${hi}` encoding flattens both to "a|b|c". Length-prefix
    // makes the boundaries unambiguous regardless of content. Firebase
    // uids are restricted ASCII, but the math is type-agnostic about
    // its string keys (test ids, ghost member ids, future id sources)
    // so the key MUST be collision-proof for any string.
    expect(canonicalPairKey('a|b', 'c'))
      .not.toBe(canonicalPairKey('a', 'b|c'))
  })

  it('does not collide when an id contains the length-prefix separator', () => {
    // Same logic for the new `:` separator — an id like "a:b" should
    // not produce the same key as the pair {a, b}.
    expect(canonicalPairKey('a:b', 'c'))
      .not.toBe(canonicalPairKey('a', 'b:c'))
  })
})

describe('isSettlementSafe', () => {
  const ok: CoreSettlement = { fromUid: 'a', toUid: 'b', amount: 10, createdAtMs: 1 }

  it('accepts a well-formed settlement', () => {
    expect(isSettlementSafe(ok)).toBe(true)
  })

  it('rejects non-finite or non-positive amount', () => {
    expect(isSettlementSafe({ ...ok, amount: 0 })).toBe(false)
    expect(isSettlementSafe({ ...ok, amount: -1 })).toBe(false)
    expect(isSettlementSafe({ ...ok, amount: NaN })).toBe(false)
    expect(isSettlementSafe({ ...ok, amount: Infinity })).toBe(false)
  })

  it('rejects empty or non-string uids', () => {
    expect(isSettlementSafe({ ...ok, fromUid: '' })).toBe(false)
    expect(isSettlementSafe({ ...ok, toUid:   '' })).toBe(false)
    expect(isSettlementSafe({ ...ok, fromUid: 123 as unknown as string })).toBe(false)
  })

  it('rejects self-debt (fromUid === toUid)', () => {
    expect(isSettlementSafe({ ...ok, fromUid: 'a', toUid: 'a' })).toBe(false)
  })
})

describe('pairRemaining', () => {
  const pairwise = { A: { B: 30 }, C: { D: 10 } }

  it('returns the directed remaining for an existing edge', () => {
    expect(pairRemaining(pairwise, 'A', 'B')).toBe(30)
  })

  it('returns 0 for missing fromUid', () => {
    expect(pairRemaining(pairwise, 'Z', 'B')).toBe(0)
  })

  it('returns 0 for missing toUid on existing fromUid', () => {
    expect(pairRemaining(pairwise, 'A', 'Z')).toBe(0)
  })

  it('does not return the reverse direction', () => {
    expect(pairRemaining(pairwise, 'B', 'A')).toBe(0)
  })
})

describe('SETTLEMENT_EPS', () => {
  it('is 0.5 — both pre-package impls used this exact value', () => {
    expect(SETTLEMENT_EPS).toBe(0.5)
  })
})

describe('input self-defense (silent filter)', () => {
  it('skips malformed expenses without throwing', () => {
    const ok: CoreExpense  = { paidBy: 'A', amount: 100, splits: [{ memberId: 'B', amount: 100 }] }
    const bad: CoreExpense = { paidBy: '', amount: NaN, splits: [] }
    const r = computePairwiseRemaining([ok, bad], [])
    expect(r).toEqual({ B: { A: 100 } })
  })

  it('skips malformed settlements without throwing', () => {
    const e: CoreExpense = { paidBy: 'A', amount: 100, splits: [{ memberId: 'B', amount: 100 }] }
    const bad: CoreSettlement = { fromUid: '', toUid: '', amount: -1, createdAtMs: 1 }
    const r = computePairwiseRemaining([e], [bad])
    // Bad settlement filtered → debt unchanged
    expect(r).toEqual({ B: { A: 100 } })
  })
})

describe('ordering determinism (createdAtMs sort)', () => {
  it('orders settlements by createdAtMs regardless of input order', () => {
    // 2-step settlement on the same pair: 40 then 80 (sum > gross 100,
    // so the LATER one absorbs the leftover). Input order shuffled.
    const expenses: CoreExpense[] = [
      { paidBy: 'A', amount: 100, splits: [{ memberId: 'B', amount: 100 }] },
    ]
    const first:  CoreSettlement = { fromUid: 'B', toUid: 'A', amount: 40, createdAtMs: 1 }
    const second: CoreSettlement = { fromUid: 'B', toUid: 'A', amount: 80, createdAtMs: 2 }

    const inOrder    = computePairwiseRemaining(expenses, [first, second])
    const outOfOrder = computePairwiseRemaining(expenses, [second, first])
    expect(inOrder).toEqual(outOfOrder)
    expect(inOrder).toEqual({})
  })
})
