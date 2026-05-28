// Cross-check fixtures for the pair-level settlement math.
//
// settlement-domain.ts (Worker side) and computeBalancesFull's `pairwise`
// step (client side, src/features/expense/services/settlement.ts) MUST
// produce identical pairwise edges for the same inputs. If they drift,
// the Worker create-gate (`amount <= pairwise[from][to]`) would reject
// settlements the client UI invited the user to record, or worse, accept
// settlements the client suggestion engine never offered.
//
// The two files keep an **identical 8-fixture table**. Each fixture is a
// pure object literal so a side-by-side diff makes any divergence
// obvious. Worker side asserts against `computePairwiseRemaining`;
// client side asserts against `computeBalancesFull(...).pairwise`.
//
// Coverage rationale -- each fixture exercises one semantic corner:
//   1. empty                       — degenerate-input safety
//   2. single-pair-debt-only       — basic gross → remaining → normalize passthrough
//   3. opposite-direction-normalize — step 4 picks the bigger direction
//   4. eps-collapse                — |fwd-bwd| ≤ EPS collapses to no edge
//   5. settlement-fully-pays       — applied cap exactly equals gross
//   6. settlement-partial          — partial applied, remaining survives
//   7. overpay-capped              — settlement > gross, applied caps at gross (no negative)
//   8. three-way-normalize         — multi-pair normalize in one trip
import { describe, it, expect } from 'vitest'
import {
  computePairwiseRemaining,
  type DomainExpense,
  type DomainSettlement,
} from '../src/settlement-domain'

// Same fixture shape as the client mirror. `_id` is for debugging only;
// neither algorithm reads it.
interface PairwiseFixture {
  name:        string
  expenses:    DomainExpense[]
  settlements: DomainSettlement[]
  expected:    Record<string, Record<string, number>>
}

export const PAIRWISE_FIXTURES: PairwiseFixture[] = [
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
    // Both directions = 25 → |fwd-bwd| = 0 ≤ EPS, no surviving edge.
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

describe('settlement-domain cross-check fixtures', () => {
  for (const fx of PAIRWISE_FIXTURES) {
    it(fx.name, () => {
      const actual = computePairwiseRemaining(fx.expenses, fx.settlements)
      expect(actual).toEqual(fx.expected)
    })
  }
})
