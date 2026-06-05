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
  materializeExpenseSplitContributions,
  canonicalizeSplits,
  adjustmentSign,
  convertSourceLinesToTarget,
  convertSourceSplitsToTarget,
  convertAndMaterializeFromSource,
  MaterializeError,
  type MaterializeInput,
  type MaterializeSplit,
  type ConvertAndMaterializeFromSourceInput,
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

describe('materializeExpenseSplitContributions', () => {
  it('keeps item identity before member aggregation', () => {
    const out = materializeExpenseSplitContributions(input({
      items: [
        { id: 'i1', amountMinor: 100, assignees: ['alice', 'bob'] },
        { id: 'i2', amountMinor: 90,  assignees: ['alice'] },
      ],
    }))
    expect(out).toEqual([
      { itemId: 'i1', memberId: 'alice', amountMinor: 50 },
      { itemId: 'i1', memberId: 'bob',   amountMinor: 50 },
      { itemId: 'i2', memberId: 'alice', amountMinor: 90 },
    ])
  })

  it('uses the same adjustment math as materializeExpenseSplits', () => {
    const fixture = input({
      items: [
        { id: 'i1', amountMinor: 800, assignees: ['alice'] },
        { id: 'i2', amountMinor: 200, assignees: ['bob'] },
      ],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 100 },
      ],
    })
    expect(materializeExpenseSplitContributions(fixture)).toEqual([
      { itemId: 'i1', memberId: 'alice', amountMinor: 720 },
      { itemId: 'i2', memberId: 'bob',   amountMinor: 180 },
    ])
    expect(materializeExpenseSplits(fixture)).toEqual([
      { memberId: 'alice', amountMinor: 720 },
      { memberId: 'bob',   amountMinor: 180 },
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

// ─── convertAndMaterializeFromSource ──────────────────────────────
//
// Source-domain wrapper. Each block exercises one corner of the
// source-domain contract:
//   1. USD → JPY zero-fraction target, exact-multiple receipt
//   2. USD → JPY rounding residual lands on largest item
//   3. USD → JPY adjustments (TAX) reconcile via residual
//   4. USD → JPY DISCOUNT subtracts in both source + trip domains
//   5. USD → TWD zero-fraction target with apportionment
//   6. USD → VND wide-magnitude target, residual stays on items
//   7. USD → IDR similar wide-magnitude target
//   8. degenerate source-sum mismatch rejection (items only)
//   9. degenerate source-sum mismatch rejection (with adjustments)
//  10. NaN / non-canonical rate propagates fx-core error
//  11. source item non-positive integer rejected at boundary
//  12. source adjustment non-positive integer rejected at boundary
//  13. SOURCE_AMOUNT_NOT_POSITIVE_INTEGER on missing total
//  14. materializer error (over-discount EXPENSE) propagates
//  15. determinism — identical input → identical bytes

function sourceInput(
  partial: Partial<ConvertAndMaterializeFromSourceInput>,
): ConvertAndMaterializeFromSourceInput {
  return {
    sourceItems:          partial.sourceItems          ?? [],
    sourceAdjustments:    partial.sourceAdjustments    ?? [],
    sourceAmountMinor:    partial.sourceAmountMinor    ?? 0,
    rateDecimal:          partial.rateDecimal          ?? '1',
    sourceFractionDigits: partial.sourceFractionDigits ?? 2,  // USD default
    targetFractionDigits: partial.targetFractionDigits ?? 0,  // JPY default
    members:              partial.members              ?? M,
  }
}

describe('convertAndMaterializeFromSource — USD → JPY exact-multiple receipt', () => {
  it('converts items + reconciles totals when residual is zero', () => {
    // USD $10.00 (1000 minor with sf=2) × rate 100 → ¥1000 (1000 minor with tf=0)
    //   num = 1000 * 100 * 10^0 = 100000; den = 10^(2+0) = 100; 100000/100 = 1000 → ¥1000
    const result = convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 1000, assignees: ['alice', 'bob'] },
      ],
      sourceAmountMinor: 1000,
      rateDecimal:       '100',
    }))
    expect(result.amountMinor).toBe(1000)
    expect(result.items).toEqual([
      { id: 'i1', amountMinor: 1000, assignees: ['alice', 'bob'] },
    ])
    expect(result.adjustments).toEqual([])
    expect(result.splits).toEqual([
      { memberId: 'alice', amountMinor: 500 },
      { memberId: 'bob',   amountMinor: 500 },
    ])
  })
})

describe('convertAndMaterializeFromSource — USD → JPY residual on largest item', () => {
  it('exposes the same line conversion without requiring assignees', () => {
    const result = convertSourceLinesToTarget({
      sourceItems: [
        { id: 'i1', amountMinor: 1 },
        { id: 'i2', amountMinor: 1 },
        { id: 'i3', amountMinor: 2 },
      ],
      sourceAdjustments:    [],
      sourceAmountMinor:    4,
      rateDecimal:          '146.2',
      sourceFractionDigits: 2,
      targetFractionDigits: 0,
    })
    expect(result.amountMinor).toBe(6)
    expect(result.items.map(i => i.amountMinor)).toEqual([1, 1, 4])
    expect(result.adjustments).toEqual([])
  })

  it('drift from per-line rounding lands on the largest item', () => {
    // USD source: $0.01 + $0.01 + $0.02 = $0.04 total
    // sourceMinor: 1 + 1 + 2 = 4
    // rate 146.2 → tripAmountMinor = convert(4, 146.2, sf=2, tf=0)
    //   num = 4 * 1462 * 1 = 5848; den = 10^(2+1)=1000; 5848/1000=5 rem 848 → 6
    // per-line:
    //   convert(1, 146.2) → num=1462, den=1000 → 1 rem 462 → 1 (half-even)
    //   convert(2, 146.2) → num=2924, den=1000 → 2 rem 924 → 3
    // raw items: [1, 1, 3] sum=5, expected=6 → residual +1 to largest (3) → [1,1,4]
    const result = convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 1, assignees: ['alice'] },
        { id: 'i2', amountMinor: 1, assignees: ['bob'] },
        { id: 'i3', amountMinor: 2, assignees: ['carol'] },
      ],
      sourceAmountMinor: 4,
      rateDecimal:       '146.2',
    }))
    expect(result.amountMinor).toBe(6)
    expect(result.items.map(i => i.amountMinor)).toEqual([1, 1, 4])
    expect(result.splits).toEqual([
      { memberId: 'alice', amountMinor: 1 },
      { memberId: 'bob',   amountMinor: 1 },
      { memberId: 'carol', amountMinor: 4 },
    ])
  })
})

describe('convertAndMaterializeFromSource — USD → JPY positive adjustment (TAX)', () => {
  it('TAX adjustment converts independently, items absorb apportionment', () => {
    // USD: items $10.00 + $5.00 = $15.00 + TAX $1.50 = $16.50 → 1650 minor
    // rate 100 → ¥1650 total. items raw: ¥1000 + ¥500 = ¥1500;
    //   tax 150 cents → ¥150; expectedItemSum = 1650 - 150 = 1500;
    //   residual = 0; items stay [1000, 500].
    // Materializer: EXPENSE TAX +150 apportions 100 / 50 → effective [1100, 550].
    // splits: i1 1100 / [alice,bob] = 550 each; i2 550 / [carol] = 550.
    const result = convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 1000, assignees: ['alice', 'bob'] },
        { id: 'i2', amountMinor: 500,  assignees: ['carol'] },
      ],
      sourceAdjustments: [
        { id: 'a1', kind: 'TAX', scope: 'EXPENSE', amountMinor: 150 },
      ],
      sourceAmountMinor: 1650,
      rateDecimal:       '100',
    }))
    expect(result.amountMinor).toBe(1650)
    expect(result.items.map(i => i.amountMinor)).toEqual([1000, 500])
    expect(result.adjustments.map(a => a.amountMinor)).toEqual([150])
    expect(result.splits).toEqual([
      { memberId: 'alice', amountMinor: 550 },
      { memberId: 'bob',   amountMinor: 550 },
      { memberId: 'carol', amountMinor: 550 },
    ])
  })
})

describe('convertAndMaterializeFromSource — USD → JPY negative adjustment (DISCOUNT)', () => {
  it('DISCOUNT subtracts in source and trip domains', () => {
    // USD: $10.00 + $5.00 items - $1.50 discount = $13.50 → 1350 minor
    // rate 100 → ¥1350 total. items raw [1000, 500]; signedAdjSum = -150;
    //   expectedItemSum = 1350 - (-150) = 1500; residual = 0.
    // Materializer DISCOUNT 150 apportions -100/-50 → effective [900, 450].
    const result = convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 1000, assignees: ['alice', 'bob'] },
        { id: 'i2', amountMinor: 500,  assignees: ['carol'] },
      ],
      sourceAdjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 150 },
      ],
      sourceAmountMinor: 1350,
      rateDecimal:       '100',
    }))
    expect(result.amountMinor).toBe(1350)
    expect(result.splits).toEqual([
      { memberId: 'alice', amountMinor: 450 },
      { memberId: 'bob',   amountMinor: 450 },
      { memberId: 'carol', amountMinor: 450 },
    ])
  })
})

describe('convertAndMaterializeFromSource — USD → TWD', () => {
  it('zero-fraction trip currency with per-line residual reconciliation', () => {
    // USD $1.00 + $2.00 = $3.00 → 100 + 200 = 300 minor
    // rate 32.5 → tripAmount = convert(300, 32.5, sf=2, tf=0)
    //   num=300*325*1=97500; den=10^(2+1)=1000; 97500/1000=97 rem 500 → exact half → even rounding → 98
    // per-line:
    //   convert(100, 32.5) num=100*325=32500, den=1000, 32 rem 500 → even → 32
    //   convert(200, 32.5) num=200*325=65000, den=1000, 65 rem 0 → 65
    // raw: 32 + 65 = 97, expected 98 → residual +1 on largest (65) → [32, 66]
    const result = convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 100, assignees: ['alice'] },
        { id: 'i2', amountMinor: 200, assignees: ['bob'] },
      ],
      sourceAmountMinor: 300,
      rateDecimal:       '32.5',
    }))
    expect(result.amountMinor).toBe(98)
    expect(result.items.map(i => i.amountMinor)).toEqual([32, 66])
    expect(result.splits).toEqual([
      { memberId: 'alice', amountMinor: 32 },
      { memberId: 'bob',   amountMinor: 66 },
    ])
  })
})

describe('convertAndMaterializeFromSource — USD → VND wide-magnitude', () => {
  it('handles ~23000x rate without overflow', () => {
    // USD $1.00 (100 minor sf=2) × rate 23500 → ₫23500 (23500 minor tf=0)
    //   num = 100 * 23500 * 10^0 = 2_350_000; den = 10^(2+0) = 100; → 23500
    const result = convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 100, assignees: ['alice', 'bob'] },
      ],
      sourceAmountMinor: 100,
      rateDecimal:       '23500',
    }))
    expect(result.amountMinor).toBe(23500)
    expect(result.items).toEqual([
      { id: 'i1', amountMinor: 23500, assignees: ['alice', 'bob'] },
    ])
    expect(result.splits).toEqual([
      { memberId: 'alice', amountMinor: 11750 },
      { memberId: 'bob',   amountMinor: 11750 },
    ])
  })
})

describe('convertAndMaterializeFromSource — USD → IDR wide-magnitude', () => {
  it('handles ~14500x rate with residual on largest item', () => {
    // USD $0.03 + $0.02 = $0.05 → 3+2=5 minor sf=2
    // rate 14567 → tripAmount = convert(5, 14567, 2, 0)
    //   num = 5 * 14567 = 72835; den = 100; 72835/100 = 728 rem 35 → 728 (round down)
    // per-line:
    //   convert(3) num=3*14567=43701, den=100, 43701/100=437 rem 1 → 437
    //   convert(2) num=2*14567=29134, den=100, 29134/100=291 rem 34 → 291
    // raw 437+291=728, expected 728 → residual 0 → items stay [437, 291]
    const result = convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 3, assignees: ['alice'] },
        { id: 'i2', amountMinor: 2, assignees: ['bob'] },
      ],
      sourceAmountMinor: 5,
      rateDecimal:       '14567',
    }))
    expect(result.amountMinor).toBe(728)
    expect(result.items.map(i => i.amountMinor)).toEqual([437, 291])
    expect(result.splits).toEqual([
      { memberId: 'alice', amountMinor: 437 },
      { memberId: 'bob',   amountMinor: 291 },
    ])
  })
})

describe('convertAndMaterializeFromSource — source-domain validation', () => {
  it('rejects when items sum ≠ sourceAmountMinor (no adjustments)', () => {
    expect(() => convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 100, assignees: ['alice'] },
        { id: 'i2', amountMinor: 200, assignees: ['bob'] },
      ],
      sourceAmountMinor: 500, // claims 500 but items sum is 300
      rateDecimal:       '100',
    }))).toThrow(MaterializeError)
    let err: unknown
    try {
      convertAndMaterializeFromSource(sourceInput({
        sourceItems: [
          { id: 'i1', amountMinor: 100, assignees: ['alice'] },
          { id: 'i2', amountMinor: 200, assignees: ['bob'] },
        ],
        sourceAmountMinor: 500,
        rateDecimal:       '100',
      }))
    } catch (e) { err = e }
    expect((err as MaterializeError).code).toBe('SOURCE_SUM_MISMATCH')
  })

  it('rejects when items + signed adjustments ≠ sourceAmountMinor', () => {
    // items 1000 + 500 = 1500; TAX +150 → expected 1650; client claims 1700
    expectThrows(() => convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 1000, assignees: ['alice'] },
        { id: 'i2', amountMinor: 500,  assignees: ['bob'] },
      ],
      sourceAdjustments: [
        { id: 'a1', kind: 'TAX', scope: 'EXPENSE', amountMinor: 150 },
      ],
      sourceAmountMinor: 1700,
      rateDecimal:       '100',
    })), 'SOURCE_SUM_MISMATCH')
  })

  it('rejects sourceAmountMinor 0', () => {
    expectThrows(() => convertAndMaterializeFromSource(sourceInput({
      sourceItems: [],
      sourceAmountMinor: 0,
      rateDecimal:       '100',
    })), 'SOURCE_AMOUNT_NOT_POSITIVE_INTEGER')
  })

  it('rejects sourceAmountMinor non-integer', () => {
    expectThrows(() => convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 100, assignees: ['alice'] },
      ],
      sourceAmountMinor: 100.5,
      rateDecimal:       '100',
    })), 'SOURCE_AMOUNT_NOT_POSITIVE_INTEGER')
  })

  it('rejects source item amountMinor 0', () => {
    expectThrows(() => convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 0, assignees: ['alice'] },
      ],
      sourceAmountMinor: 100,
      rateDecimal:       '100',
    })), 'SOURCE_ITEM_NOT_POSITIVE_INTEGER')
  })

  it('rejects source adjustment amountMinor 0', () => {
    expectThrows(() => convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 100, assignees: ['alice'] },
      ],
      sourceAdjustments: [
        { id: 'a1', kind: 'TAX', scope: 'EXPENSE', amountMinor: 0 },
      ],
      sourceAmountMinor: 100,
      rateDecimal:       '100',
    })), 'SOURCE_ADJUSTMENT_NOT_POSITIVE_INTEGER')
  })
})

describe('convertAndMaterializeFromSource — fx-core error propagation', () => {
  it('propagates non-canonical rate from fx-core', () => {
    // fx-core throws plain Error for non-canonical rate (not MaterializeError)
    expect(() => convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 100, assignees: ['alice'] },
      ],
      sourceAmountMinor: 100,
      rateDecimal:       '1.20',  // trailing zero — non-canonical
    }))).toThrow(/non-canonical/)
  })

  it('propagates NaN-ish rate from fx-core (zero rejected)', () => {
    expect(() => convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 100, assignees: ['alice'] },
      ],
      sourceAmountMinor: 100,
      rateDecimal:       '0',
    }))).toThrow()
  })
})

describe('convertAndMaterializeFromSource — materializer error propagation', () => {
  it('items rounding to zero in trip currency surfaces ITEM_NOT_POSITIVE_INTEGER', () => {
    // Pathological rate forces per-line + total to round to 0 minor in
    // trip currency. Source-domain checks pass; the materializer is the
    // final gate and rejects zero-amount items. Worker maps this error
    // to ExpenseValidationError so the operator sees one error class.
    expectThrows(() => convertAndMaterializeFromSource(sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 1, assignees: ['alice'] },
      ],
      sourceAmountMinor: 1,
      rateDecimal:       '0.00001',
    })), 'ITEM_NOT_POSITIVE_INTEGER')
  })
})

describe('convertAndMaterializeFromSource — determinism', () => {
  it('identical input produces identical output', () => {
    const fixture = sourceInput({
      sourceItems: [
        { id: 'i1', amountMinor: 333, assignees: ['alice', 'bob', 'carol'] },
        { id: 'i2', amountMinor: 100, assignees: ['alice'] },
      ],
      sourceAdjustments: [
        { id: 'a1', kind: 'TAX', scope: 'EXPENSE', amountMinor: 50 },
      ],
      sourceAmountMinor: 483,
      rateDecimal:       '146.2',
    })
    const r1 = convertAndMaterializeFromSource(fixture)
    const r2 = convertAndMaterializeFromSource(fixture)
    expect(r1).toEqual(r2)
    expect(canonicalizeSplits(r1.splits)).toBe(canonicalizeSplits(r2.splits))
  })
})

describe('convertSourceSplitsToTarget', () => {
  it('converts manual-total source splits without manufacturing line items', () => {
    const result = convertSourceSplitsToTarget({
      sourceSplits: [
        { memberId: 'alice', amountMinor: 700 },
        { memberId: 'bob',   amountMinor: 300 },
      ],
      sourceAmountMinor:     1000,
      rateDecimal:           '150',
      sourceFractionDigits:  2,
      targetFractionDigits:  0,
    })

    expect(result.amountMinor).toBe(1500)
    expect(result.splits).toEqual([
      { memberId: 'alice', amountMinor: 1050 },
      { memberId: 'bob',   amountMinor: 450 },
    ])
  })

  it('retains zero target-minor splits so source member coverage stays auditable', () => {
    const result = convertSourceSplitsToTarget({
      sourceSplits: [
        { memberId: 'alice', amountMinor: 99 },
        { memberId: 'bob',   amountMinor: 1 },
      ],
      sourceAmountMinor:     100,
      rateDecimal:           '1',
      sourceFractionDigits:  2,
      targetFractionDigits:  0,
    })

    expect(result.amountMinor).toBe(1)
    expect(result.splits).toEqual([
      { memberId: 'alice', amountMinor: 1 },
      { memberId: 'bob',   amountMinor: 0 },
    ])
  })

  it('rejects source split sums that do not match the source total', () => {
    expectThrows(() => convertSourceSplitsToTarget({
      sourceSplits: [
        { memberId: 'alice', amountMinor: 400 },
        { memberId: 'bob',   amountMinor: 500 },
      ],
      sourceAmountMinor:     1000,
      rateDecimal:           '150',
      sourceFractionDigits:  2,
      targetFractionDigits:  0,
    }), 'SOURCE_SPLIT_SUM_MISMATCH')
  })
})
