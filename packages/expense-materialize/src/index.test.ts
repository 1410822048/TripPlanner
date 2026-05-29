// Invariant suite for materializeExpenseSplits.
//
// Coverage rationale — each block exercises one semantic corner of
// the materializer contract documented in `index.ts`:
//   1. degenerate input shapes (no items, no adjustments)
//   2. plain item-only splits (Phase B regression baseline — the
//      old `splitsFromItems` behavior must survive)
//   3. ITEM-scope adjustment math (reduces target effective, then splits)
//   4. EXPENSE-scope proportional apportionment + rounding remainder
//   5. multi-adjustment ordering (ITEM applied first, then EXPENSE)
//   6. SURCHARGE/TAX/TIP kinds (positive sign branch of adjustmentSign)
//   7. TAX_EXEMPT / OTHER kinds default to -1
//   8. over-discount rejection (ITEM scope)
//   9. over-discount rejection (EXPENSE scope aggregate)
//  10. zero items + EXPENSE adjustment → EXPENSE_SCOPE_NO_WEIGHT
//  11. non-member assignee rejection
//  12. empty item assignees rejection
//  13. non-positive / non-integer item amount rejection
//  14. duplicate assignee per item rejection
//  15. UNKNOWN / invalid scope rejection
//  16. ADJUSTMENT_UNKNOWN_KIND rejection (runtime gate)
//  17. duplicate item id rejection
//  18. ITEM scope missing targetItemId
//  19. EXPENSE scope carrying targetItemId
//  20. target item id not found
//  21. non-positive / non-integer adjustment amount
//  23. canonicalizeSplits stability (member order independent)
//  24. determinism — same input ⇒ same output ⇒ same canonical string

import { describe, it, expect } from 'vitest'
import {
  materializeExpenseSplits,
  canonicalizeSplits,
  adjustmentSign,
  MaterializeError,
  type MaterializeInput,
  type MaterializeSplit,
} from './index'

// ─── Helpers ──────────────────────────────────────────────────────

const M = ['alice', 'bob', 'carol']

function input(partial: Partial<MaterializeInput>): MaterializeInput {
  return {
    items:       partial.items       ?? [],
    adjustments: partial.adjustments ?? [],
    members:     partial.members     ?? M,
  }
}

function expectThrows(fn: () => void, code: string): void {
  let err: unknown
  try { fn() } catch (e) { err = e }
  expect(err).toBeInstanceOf(MaterializeError)
  expect((err as MaterializeError).code).toBe(code)
}

// ─── Tests ────────────────────────────────────────────────────────

describe('materializeExpenseSplits — degenerate input', () => {
  it('returns [] for empty items, empty adjustments', () => {
    expect(materializeExpenseSplits(input({}))).toEqual([])
  })

  it('returns [] for zero members (no items can validate)', () => {
    expect(materializeExpenseSplits(input({ members: [] }))).toEqual([])
  })
})

describe('materializeExpenseSplits — item-only splits (Phase B baseline)', () => {
  it('splits a single equal item across all assignees', () => {
    const out = materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 300, assignees: ['alice', 'bob', 'carol'] }],
    }))
    expect(out).toEqual([
      { memberId: 'alice', amountMinor: 100 },
      { memberId: 'bob',   amountMinor: 100 },
      { memberId: 'carol', amountMinor: 100 },
    ])
  })

  it('distributes remainder to the first assignees deterministically', () => {
    const out = materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 100, assignees: ['alice', 'bob', 'carol'] }],
    }))
    // 100 / 3 = 34 + 33 + 33
    expect(out).toEqual([
      { memberId: 'alice', amountMinor: 34 },
      { memberId: 'bob',   amountMinor: 33 },
      { memberId: 'carol', amountMinor: 33 },
    ])
  })

  it('aggregates across multiple items', () => {
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amountMinor: 100, assignees: ['alice'] },
        { id: 'i2', amountMinor: 60,  assignees: ['alice', 'bob'] },
      ],
    }))
    expect(out).toEqual([
      { memberId: 'alice', amountMinor: 130 },
      { memberId: 'bob',   amountMinor: 30 },
    ])
  })

  it('omits members whose split totals zero', () => {
    const out = materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 50, assignees: ['alice'] }],
    }))
    expect(out).toEqual([{ memberId: 'alice', amountMinor: 50 }])
  })
})

describe('materializeExpenseSplits — ITEM-scope adjustments', () => {
  it('subtracts a DISCOUNT from the target item before splitting', () => {
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amountMinor: 200, assignees: ['alice', 'bob'] },
        { id: 'i2', amountMinor: 100, assignees: ['carol'] },
      ],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: 50, targetItemId: 'i1' },
      ],
    }))
    // i1 effective 150 → alice 75 + bob 75; i2 carol 100
    expect(out).toEqual([
      { memberId: 'alice', amountMinor: 75 },
      { memberId: 'bob',   amountMinor: 75 },
      { memberId: 'carol', amountMinor: 100 },
    ])
  })

  it('COUPON behaves like DISCOUNT', () => {
    const out = materializeExpenseSplits(input({
      items:       [{ id: 'i1', amountMinor: 100, assignees: ['alice'] }],
      adjustments: [{ id: 'a1', kind: 'COUPON', scope: 'ITEM', amountMinor: 30, targetItemId: 'i1' }],
    }))
    expect(out).toEqual([{ memberId: 'alice', amountMinor: 70 }])
  })
})

describe('materializeExpenseSplits — EXPENSE-scope proportional', () => {
  it('apportions a DISCOUNT proportional to item effective amounts', () => {
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amountMinor: 800, assignees: ['alice'] },
        { id: 'i2', amountMinor: 200, assignees: ['bob'] },
      ],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 100 },
      ],
    }))
    // 100 split 800:200 → 80 to i1, 20 to i2
    // i1 effective 720, i2 effective 180
    expect(out).toEqual([
      { memberId: 'alice', amountMinor: 720 },
      { memberId: 'bob',   amountMinor: 180 },
    ])
  })

  it('distributes rounding remainder via largest-remainder + index tiebreak', () => {
    // All ideal=10/3=3.333 → base=[3,3,3], leftover=1. Frac fields tie,
    // tiebreak picks idx=0 (lowest), so i1 absorbs the +1. Discount
    // alloc=[4,3,3], item effectives=[96, 97, 97].
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amountMinor: 100, assignees: ['alice'] },
        { id: 'i2', amountMinor: 100, assignees: ['bob'] },
        { id: 'i3', amountMinor: 100, assignees: ['carol'] },
      ],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 10 },
      ],
    }))
    expect(out).toEqual([
      { memberId: 'alice', amountMinor: 96 },
      { memberId: 'bob',   amountMinor: 97 },
      { memberId: 'carol', amountMinor: 97 },
    ])
  })

  it('handles SURCHARGE (positive sign)', () => {
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amountMinor: 500, assignees: ['alice'] },
        { id: 'i2', amountMinor: 500, assignees: ['bob'] },
      ],
      adjustments: [
        { id: 'a1', kind: 'SURCHARGE', scope: 'EXPENSE', amountMinor: 100 },
      ],
    }))
    expect(out).toEqual([
      { memberId: 'alice', amountMinor: 550 },
      { memberId: 'bob',   amountMinor: 550 },
    ])
  })
})

describe('materializeExpenseSplits — EXPENSE-scope apportion boundaries', () => {
  // Regression: three ¥1 items + ¥2 EXPENSE discount used to throw
  // OVER_DISCOUNT_EXPENSE because Math.floor(2 * 1 / 3) = 0 for the
  // first two items dumped the entire delta on the last (¥1 - ¥2 = -¥1).
  // Largest-remainder with per-item caps allocates [1, 1, 0] instead,
  // producing effectives [0, 0, 1] and a valid one-member split.
  it('three ¥1 items + ¥2 EXPENSE discount allocates safely (capped alloc)', () => {
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amountMinor: 1, assignees: ['alice'] },
        { id: 'i2', amountMinor: 1, assignees: ['bob']   },
        { id: 'i3', amountMinor: 1, assignees: ['carol'] },
      ],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 2 },
      ],
    }))
    expect(out).toEqual([{ memberId: 'carol', amountMinor: 1 }])
    expect(out.reduce((s, x) => s + x.amountMinor, 0)).toBe(1)
  })

  it('single ¥1 item + ¥1 EXPENSE discount → fully discounted, empty splits', () => {
    const out = materializeExpenseSplits(input({
      items:       [{ id: 'i1', amountMinor: 1, assignees: ['alice'] }],
      adjustments: [{ id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 1 }],
    }))
    expect(out).toEqual([])
  })

  it('discount equal to items total drives every item to zero', () => {
    // 60 + 40 = 100; DISCOUNT 100. Ideal [60, 40] → base = ideal exactly,
    // leftover 0, no bumping. Each item caps at its own amount; effectives
    // collapse to [0, 0] and no splits are emitted.
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amountMinor: 60, assignees: ['alice'] },
        { id: 'i2', amountMinor: 40, assignees: ['bob']   },
      ],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 100 },
      ],
    }))
    expect(out).toEqual([])
  })

  it('multiple EXPENSE adjustments net out before apportionment', () => {
    // -100 (COUPON) - 200 (DISCOUNT) + 150 (TAX) = net -150, sign=-1.
    // Items 1000 + 1000 = weightTotal 2000; alloc proportional [75, 75];
    // effectives [925, 925]; per-member [925, 925].
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amountMinor: 1000, assignees: ['alice'] },
        { id: 'i2', amountMinor: 1000, assignees: ['bob']   },
      ],
      adjustments: [
        { id: 'a1', kind: 'COUPON',   scope: 'EXPENSE', amountMinor: 100 },
        { id: 'a2', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 200 },
        { id: 'a3', kind: 'TAX',      scope: 'EXPENSE', amountMinor: 150 },
      ],
    }))
    expect(out).toEqual([
      { memberId: 'alice', amountMinor: 925 },
      { memberId: 'bob',   amountMinor: 925 },
    ])
  })

  it('weights skewed by ITEM-scope discount still apportion correctly', () => {
    // Step 2 ITEM-scope drops i1 to 100; step 3 EXPENSE-scope discount 50
    // over post-step-2 weights [100, 200] (weightTotal 300).
    // Ideal [50*100/300, 50*200/300] = [16.66, 33.33]. base=[16, 33], leftover=1.
    // Frac [0.66, 0.33] → idx 0 wins. alloc=[17, 33]. effectives=[83, 167].
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amountMinor: 500, assignees: ['alice'] },
        { id: 'i2', amountMinor: 200, assignees: ['bob']   },
      ],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM',    amountMinor: 400, targetItemId: 'i1' },
        { id: 'a2', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 50 },
      ],
    }))
    expect(out).toEqual([
      { memberId: 'alice', amountMinor: 83 },
      { memberId: 'bob',   amountMinor: 167 },
    ])
  })
})

describe('materializeExpenseSplits — multi-adjustment ordering', () => {
  it('applies ITEM-scope first, then EXPENSE-scope to the post-ITEM effectives', () => {
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amountMinor: 1000, assignees: ['alice'] },
        { id: 'i2', amountMinor: 1000, assignees: ['bob'] },
      ],
      adjustments: [
        // Step 1: ITEM scope drops i1 to 500.
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: 500, targetItemId: 'i1' },
        // Step 2: EXPENSE scope -300 apportioned over (500 + 1000) = 1500.
        // i1 takes Math.floor(300 * 500 / 1500) = 100
        // i2 absorbs remainder = 200
        // i1 effective 400, i2 effective 800
        { id: 'a2', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 300 },
      ],
    }))
    expect(out).toEqual([
      { memberId: 'alice', amountMinor: 400 },
      { memberId: 'bob',   amountMinor: 800 },
    ])
  })
})

describe('adjustmentSign — kind-to-sign mapping', () => {
  it('DISCOUNT / COUPON / TAX_EXEMPT are -1', () => {
    expect(adjustmentSign('DISCOUNT')).toBe(-1)
    expect(adjustmentSign('COUPON')).toBe(-1)
    expect(adjustmentSign('TAX_EXEMPT')).toBe(-1)
  })
  it('SURCHARGE / TAX / TIP are +1', () => {
    expect(adjustmentSign('SURCHARGE')).toBe(1)
    expect(adjustmentSign('TAX')).toBe(1)
    expect(adjustmentSign('TIP')).toBe(1)
  })
  it('OTHER defaults to -1', () => {
    expect(adjustmentSign('OTHER')).toBe(-1)
  })
})

describe('materializeExpenseSplits — invariant rejections', () => {
  it('rejects ITEM-scope over-discount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items:       [{ id: 'i1', amountMinor: 100, assignees: ['alice'] }],
      adjustments: [{ id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: 150, targetItemId: 'i1' }],
    })), 'OVER_DISCOUNT_ITEM')
  })

  it('rejects EXPENSE-scope over-discount that drives an item below zero via apportionment', () => {
    // Total 100, discount 200 → would drive items below zero
    expectThrows(() => materializeExpenseSplits(input({
      items: [
        { id: 'i1', amountMinor: 50, assignees: ['alice'] },
        { id: 'i2', amountMinor: 50, assignees: ['bob'] },
      ],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 200 },
      ],
    })), 'OVER_DISCOUNT_EXPENSE')
  })

  it('rejects EXPENSE-scope adjustment with zero weight total', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items:       [],
      adjustments: [{ id: 'a1', kind: 'TAX', scope: 'EXPENSE', amountMinor: 50 }],
    })), 'EXPENSE_SCOPE_NO_WEIGHT')
  })

  it('rejects non-member assignee', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 100, assignees: ['stranger'] }],
    })), 'NON_MEMBER_ASSIGNEE')
  })

  it('rejects empty item assignees', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 100, assignees: [] }],
    })), 'ITEM_NO_ASSIGNEES')
  })

  it('rejects zero item amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 0, assignees: ['alice'] }],
    })), 'ITEM_NOT_POSITIVE_INTEGER')
  })

  it('rejects negative item amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: -10, assignees: ['alice'] }],
    })), 'ITEM_NOT_POSITIVE_INTEGER')
  })

  it('rejects non-finite item amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: NaN, assignees: ['alice'] }],
    })), 'ITEM_NOT_POSITIVE_INTEGER')
  })

  it('rejects fractional item amount (minor units must be integer)', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 1.5, assignees: ['alice'] }],
    })), 'ITEM_NOT_POSITIVE_INTEGER')
  })

  it('rejects duplicate assignee in same item', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 100, assignees: ['alice', 'alice', 'bob'] }],
    })), 'DUPLICATE_ITEM_ASSIGNEE')
  })

  it('rejects UNKNOWN / invalid scope', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 100, assignees: ['alice'] }],
      adjustments: [
        // @ts-expect-error — intentional invalid scope at runtime
        { id: 'a1', kind: 'DISCOUNT', scope: 'UNKNOWN', amountMinor: 10 },
      ],
    })), 'UNKNOWN_SCOPE')
  })

  it('rejects unknown adjustment kind at runtime (JSON/Firestore guard)', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 100, assignees: ['alice'] }],
      adjustments: [
        // @ts-expect-error — intentional invalid kind at runtime; mimics
        // a Firestore doc that escaped the Zod boundary.
        { id: 'a1', kind: 'BOGUS', scope: 'ITEM', amountMinor: 10, targetItemId: 'i1' },
      ],
    })), 'ADJUSTMENT_UNKNOWN_KIND')
  })

  it('rejects duplicate item ids', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [
        { id: 'i1', amountMinor: 100, assignees: ['alice'] },
        { id: 'i1', amountMinor: 50,  assignees: ['bob'] },
      ],
    })), 'DUPLICATE_ITEM_ID')
  })

  it('rejects ITEM scope missing targetItemId', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: 10 },
      ],
    })), 'ITEM_SCOPE_NO_TARGET')
  })

  it('rejects EXPENSE scope carrying targetItemId', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 10, targetItemId: 'i1' },
      ],
    })), 'EXPENSE_SCOPE_HAS_TARGET')
  })

  it('rejects target item id that does not exist', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: 10, targetItemId: 'ghost' },
      ],
    })), 'TARGET_ITEM_NOT_FOUND')
  })

  it('rejects negative adjustment amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: -5, targetItemId: 'i1' },
      ],
    })), 'ADJUSTMENT_NOT_POSITIVE_INTEGER')
  })

  it('rejects zero adjustment amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: 0, targetItemId: 'i1' },
      ],
    })), 'ADJUSTMENT_NOT_POSITIVE_INTEGER')
  })

  it('rejects non-integer (Infinity) adjustment amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: Infinity, targetItemId: 'i1' },
      ],
    })), 'ADJUSTMENT_NOT_POSITIVE_INTEGER')
  })

  it('rejects fractional adjustment amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amountMinor: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: 2.5, targetItemId: 'i1' },
      ],
    })), 'ADJUSTMENT_NOT_POSITIVE_INTEGER')
  })
})

describe('canonicalizeSplits', () => {
  it('sorts splits by memberId so insertion order does not matter', () => {
    const a: MaterializeSplit[] = [
      { memberId: 'bob',   amountMinor: 50 },
      { memberId: 'alice', amountMinor: 100 },
    ]
    const b: MaterializeSplit[] = [
      { memberId: 'alice', amountMinor: 100 },
      { memberId: 'bob',   amountMinor: 50 },
    ]
    expect(canonicalizeSplits(a)).toBe(canonicalizeSplits(b))
  })

  it('strips zero-amount entries before comparing', () => {
    expect(canonicalizeSplits([
      { memberId: 'alice', amountMinor: 100 },
      { memberId: 'bob',   amountMinor: 0 },
    ])).toBe(canonicalizeSplits([
      { memberId: 'alice', amountMinor: 100 },
    ]))
  })
})

describe('materializeExpenseSplits — determinism', () => {
  it('same input twice ⇒ same output ⇒ same canonical string', () => {
    const fixture = input({
      items: [
        { id: 'i1', amountMinor: 333, assignees: ['alice', 'bob', 'carol'] },
        { id: 'i2', amountMinor: 100, assignees: ['alice'] },
      ],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 50 },
      ],
    })
    const out1 = materializeExpenseSplits(fixture)
    const out2 = materializeExpenseSplits(fixture)
    expect(out1).toEqual(out2)
    expect(canonicalizeSplits(out1)).toBe(canonicalizeSplits(out2))
  })
})
