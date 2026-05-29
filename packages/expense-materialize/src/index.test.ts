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
      items: [{ id: 'i1', amount: 300, assignees: ['alice', 'bob', 'carol'] }],
    }))
    expect(out).toEqual([
      { memberId: 'alice', amount: 100 },
      { memberId: 'bob',   amount: 100 },
      { memberId: 'carol', amount: 100 },
    ])
  })

  it('distributes remainder to the first assignees deterministically', () => {
    const out = materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 100, assignees: ['alice', 'bob', 'carol'] }],
    }))
    // 100 / 3 = 34 + 33 + 33
    expect(out).toEqual([
      { memberId: 'alice', amount: 34 },
      { memberId: 'bob',   amount: 33 },
      { memberId: 'carol', amount: 33 },
    ])
  })

  it('aggregates across multiple items', () => {
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amount: 100, assignees: ['alice'] },
        { id: 'i2', amount: 60,  assignees: ['alice', 'bob'] },
      ],
    }))
    expect(out).toEqual([
      { memberId: 'alice', amount: 130 },
      { memberId: 'bob',   amount: 30 },
    ])
  })

  it('omits members whose split totals zero', () => {
    const out = materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 50, assignees: ['alice'] }],
    }))
    expect(out).toEqual([{ memberId: 'alice', amount: 50 }])
  })
})

describe('materializeExpenseSplits — ITEM-scope adjustments', () => {
  it('subtracts a DISCOUNT from the target item before splitting', () => {
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amount: 200, assignees: ['alice', 'bob'] },
        { id: 'i2', amount: 100, assignees: ['carol'] },
      ],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amount: 50, targetItemId: 'i1' },
      ],
    }))
    // i1 effective 150 → alice 75 + bob 75; i2 carol 100
    expect(out).toEqual([
      { memberId: 'alice', amount: 75 },
      { memberId: 'bob',   amount: 75 },
      { memberId: 'carol', amount: 100 },
    ])
  })

  it('COUPON behaves like DISCOUNT', () => {
    const out = materializeExpenseSplits(input({
      items:       [{ id: 'i1', amount: 100, assignees: ['alice'] }],
      adjustments: [{ id: 'a1', kind: 'COUPON', scope: 'ITEM', amount: 30, targetItemId: 'i1' }],
    }))
    expect(out).toEqual([{ memberId: 'alice', amount: 70 }])
  })
})

describe('materializeExpenseSplits — EXPENSE-scope proportional', () => {
  it('apportions a DISCOUNT proportional to item effective amounts', () => {
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amount: 800, assignees: ['alice'] },
        { id: 'i2', amount: 200, assignees: ['bob'] },
      ],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amount: 100 },
      ],
    }))
    // 100 split 800:200 → 80 to i1, 20 to i2
    // i1 effective 720, i2 effective 180
    expect(out).toEqual([
      { memberId: 'alice', amount: 720 },
      { memberId: 'bob',   amount: 180 },
    ])
  })

  it('absorbs rounding remainder on the last weighted item', () => {
    // 10% off 333 = 33.3 → Math.floor(33*333/333) = 33 on first; last takes 0 (33-33=0)
    // Use a case where remainder must materialize.
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amount: 100, assignees: ['alice'] },
        { id: 'i2', amount: 100, assignees: ['bob'] },
        { id: 'i3', amount: 100, assignees: ['carol'] },
      ],
      adjustments: [
        // 10 split 100:100:100 → 3 + 3 + (10-6=4) ← last absorbs remainder
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amount: 10 },
      ],
    }))
    expect(out).toEqual([
      { memberId: 'alice', amount: 97 },
      { memberId: 'bob',   amount: 97 },
      { memberId: 'carol', amount: 96 },
    ])
  })

  it('handles SURCHARGE (positive sign)', () => {
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amount: 500, assignees: ['alice'] },
        { id: 'i2', amount: 500, assignees: ['bob'] },
      ],
      adjustments: [
        { id: 'a1', kind: 'SURCHARGE', scope: 'EXPENSE', amount: 100 },
      ],
    }))
    expect(out).toEqual([
      { memberId: 'alice', amount: 550 },
      { memberId: 'bob',   amount: 550 },
    ])
  })
})

describe('materializeExpenseSplits — multi-adjustment ordering', () => {
  it('applies ITEM-scope first, then EXPENSE-scope to the post-ITEM effectives', () => {
    const out = materializeExpenseSplits(input({
      items: [
        { id: 'i1', amount: 1000, assignees: ['alice'] },
        { id: 'i2', amount: 1000, assignees: ['bob'] },
      ],
      adjustments: [
        // Step 1: ITEM scope drops i1 to 500.
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amount: 500, targetItemId: 'i1' },
        // Step 2: EXPENSE scope -300 apportioned over (500 + 1000) = 1500.
        // i1 takes Math.floor(300 * 500 / 1500) = 100
        // i2 absorbs remainder = 200
        // i1 effective 400, i2 effective 800
        { id: 'a2', kind: 'DISCOUNT', scope: 'EXPENSE', amount: 300 },
      ],
    }))
    expect(out).toEqual([
      { memberId: 'alice', amount: 400 },
      { memberId: 'bob',   amount: 800 },
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
      items:       [{ id: 'i1', amount: 100, assignees: ['alice'] }],
      adjustments: [{ id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amount: 150, targetItemId: 'i1' }],
    })), 'OVER_DISCOUNT_ITEM')
  })

  it('rejects EXPENSE-scope over-discount that drives an item below zero via apportionment', () => {
    // Total 100, discount 200 → would drive items below zero
    expectThrows(() => materializeExpenseSplits(input({
      items: [
        { id: 'i1', amount: 50, assignees: ['alice'] },
        { id: 'i2', amount: 50, assignees: ['bob'] },
      ],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amount: 200 },
      ],
    })), 'OVER_DISCOUNT_EXPENSE')
  })

  it('rejects EXPENSE-scope adjustment with zero weight total', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items:       [],
      adjustments: [{ id: 'a1', kind: 'TAX', scope: 'EXPENSE', amount: 50 }],
    })), 'EXPENSE_SCOPE_NO_WEIGHT')
  })

  it('rejects non-member assignee', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 100, assignees: ['stranger'] }],
    })), 'NON_MEMBER_ASSIGNEE')
  })

  it('rejects empty item assignees', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 100, assignees: [] }],
    })), 'ITEM_NO_ASSIGNEES')
  })

  it('rejects zero item amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 0, assignees: ['alice'] }],
    })), 'ITEM_NOT_POSITIVE_INTEGER')
  })

  it('rejects negative item amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: -10, assignees: ['alice'] }],
    })), 'ITEM_NOT_POSITIVE_INTEGER')
  })

  it('rejects non-finite item amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: NaN, assignees: ['alice'] }],
    })), 'ITEM_NOT_POSITIVE_INTEGER')
  })

  it('rejects fractional item amount (minor units must be integer)', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 1.5, assignees: ['alice'] }],
    })), 'ITEM_NOT_POSITIVE_INTEGER')
  })

  it('rejects duplicate assignee in same item', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 100, assignees: ['alice', 'alice', 'bob'] }],
    })), 'DUPLICATE_ITEM_ASSIGNEE')
  })

  it('rejects UNKNOWN / invalid scope', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 100, assignees: ['alice'] }],
      adjustments: [
        // @ts-expect-error — intentional invalid scope at runtime
        { id: 'a1', kind: 'DISCOUNT', scope: 'UNKNOWN', amount: 10 },
      ],
    })), 'UNKNOWN_SCOPE')
  })

  it('rejects unknown adjustment kind at runtime (JSON/Firestore guard)', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 100, assignees: ['alice'] }],
      adjustments: [
        // @ts-expect-error — intentional invalid kind at runtime; mimics
        // a Firestore doc that escaped the Zod boundary.
        { id: 'a1', kind: 'BOGUS', scope: 'ITEM', amount: 10, targetItemId: 'i1' },
      ],
    })), 'ADJUSTMENT_UNKNOWN_KIND')
  })

  it('rejects duplicate item ids', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [
        { id: 'i1', amount: 100, assignees: ['alice'] },
        { id: 'i1', amount: 50,  assignees: ['bob'] },
      ],
    })), 'DUPLICATE_ITEM_ID')
  })

  it('rejects ITEM scope missing targetItemId', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amount: 10 },
      ],
    })), 'ITEM_SCOPE_NO_TARGET')
  })

  it('rejects EXPENSE scope carrying targetItemId', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amount: 10, targetItemId: 'i1' },
      ],
    })), 'EXPENSE_SCOPE_HAS_TARGET')
  })

  it('rejects target item id that does not exist', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amount: 10, targetItemId: 'ghost' },
      ],
    })), 'TARGET_ITEM_NOT_FOUND')
  })

  it('rejects negative adjustment amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amount: -5, targetItemId: 'i1' },
      ],
    })), 'ADJUSTMENT_NOT_POSITIVE_INTEGER')
  })

  it('rejects zero adjustment amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amount: 0, targetItemId: 'i1' },
      ],
    })), 'ADJUSTMENT_NOT_POSITIVE_INTEGER')
  })

  it('rejects non-integer (Infinity) adjustment amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amount: Infinity, targetItemId: 'i1' },
      ],
    })), 'ADJUSTMENT_NOT_POSITIVE_INTEGER')
  })

  it('rejects fractional adjustment amount', () => {
    expectThrows(() => materializeExpenseSplits(input({
      items: [{ id: 'i1', amount: 100, assignees: ['alice'] }],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'ITEM', amount: 2.5, targetItemId: 'i1' },
      ],
    })), 'ADJUSTMENT_NOT_POSITIVE_INTEGER')
  })
})

describe('canonicalizeSplits', () => {
  it('sorts splits by memberId so insertion order does not matter', () => {
    const a: MaterializeSplit[] = [
      { memberId: 'bob',   amount: 50 },
      { memberId: 'alice', amount: 100 },
    ]
    const b: MaterializeSplit[] = [
      { memberId: 'alice', amount: 100 },
      { memberId: 'bob',   amount: 50 },
    ]
    expect(canonicalizeSplits(a)).toBe(canonicalizeSplits(b))
  })

  it('strips zero-amount entries before comparing', () => {
    expect(canonicalizeSplits([
      { memberId: 'alice', amount: 100 },
      { memberId: 'bob',   amount: 0 },
    ])).toBe(canonicalizeSplits([
      { memberId: 'alice', amount: 100 },
    ]))
  })
})

describe('materializeExpenseSplits — determinism', () => {
  it('same input twice ⇒ same output ⇒ same canonical string', () => {
    const fixture = input({
      items: [
        { id: 'i1', amount: 333, assignees: ['alice', 'bob', 'carol'] },
        { id: 'i2', amount: 100, assignees: ['alice'] },
      ],
      adjustments: [
        { id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amount: 50 },
      ],
    })
    const out1 = materializeExpenseSplits(fixture)
    const out2 = materializeExpenseSplits(fixture)
    expect(out1).toEqual(out2)
    expect(canonicalizeSplits(out1)).toBe(canonicalizeSplits(out2))
  })
})
