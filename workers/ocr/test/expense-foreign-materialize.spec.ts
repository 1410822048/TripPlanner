// Unit tests for expense-foreign-materialize.ts — the source→trip projection
// shared by foreign CREATE + UPDATE. Verifies the two domains and the
// error-field mapping that make create/update produce identical results:
//   - line domain: convert + materialize + re-join the materializer's id-keyed
//     output with the source-side name/label strings
//   - split domain: manual-total convert
//   - MaterializeError → field-aware ExpenseValidationError
//
// Rate "100" (USD 2 fraction digits → JPY 0) makes every conversion a clean
// integer: source minor / 100 = trip minor.
import { describe, it, expect } from 'vitest'
import {
  materializeForeignLineDomain,
  materializeForeignSplitDomain,
} from '../src/expense-foreign-materialize'
import { ExpenseValidationError } from '../src/expense-validate'
import type {
  ForeignSourceItem,
  ForeignSourceAdjustment,
  ForeignSourceSplit,
} from '../src/expense-foreign-codec'

const RATE = { rateDecimal: '100', sourceFractionDigits: 2, targetFractionDigits: 0 }

/** splits[] → { memberId: amountMinor } for order-independent assertion. */
function splitsMap(splits: { memberId: string; amountMinor: number }[]): Record<string, number> {
  return Object.fromEntries(splits.map(s => [s.memberId, s.amountMinor]))
}

// ─── line domain ──────────────────────────────────────────────────

describe('materializeForeignLineDomain', () => {
  it('converts items + materializes splits, re-joining source names', () => {
    const sourceItems: ForeignSourceItem[] = [
      { id: 'i1', name: 'A', sourceAmountMinor: 1000, allocations: [{ memberId: 'u1', shares: 1 }] },
      { id: 'i2', name: 'B', sourceAmountMinor: 2000, allocations: [{ memberId: 'u2', shares: 1 }] },
    ]
    const out = materializeForeignLineDomain({
      sourceItems,
      sourceAdjustments: [],
      sourceAmountMinor: 3000,
      members:           ['u1', 'u2'],
      ...RATE,
    })
    expect(out.amountMinor).toBe(3000)                          // $30.00 → ¥3000
    expect(out.tripItems).toEqual([
      { id: 'i1', name: 'A', amountMinor: 1000, allocations: [{ memberId: 'u1', shares: 1 }] },
      { id: 'i2', name: 'B', amountMinor: 2000, allocations: [{ memberId: 'u2', shares: 1 }] },
    ])
    expect(out.tripAdjustments).toEqual([])
    expect(splitsMap(out.splits)).toEqual({ u1: 1000, u2: 2000 })
  })

  it('re-joins the source-side label onto the converted adjustment', () => {
    const out = materializeForeignLineDomain({
      sourceItems:       [{ id: 'i1', name: 'A', sourceAmountMinor: 1000, allocations: [{ memberId: 'u1', shares: 1 }, { memberId: 'u2', shares: 1 }] }],
      sourceAdjustments: [{ id: 'a1', label: 'クーポン', kind: 'DISCOUNT', scope: 'EXPENSE', sourceAmountMinor: 200 }],
      sourceAmountMinor: 800,                                   // 1000 − 200
      members:           ['u1', 'u2'],
      ...RATE,
    })
    expect(out.amountMinor).toBe(800)                           // $8.00 → ¥800
    expect(out.tripAdjustments).toEqual([
      { id: 'a1', label: 'クーポン', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 200 },
    ])
    expect(out.tripItems[0]!.name).toBe('A')
    // Splits reconcile to the post-discount total.
    const sum = out.splits.reduce((s, x) => s + x.amountMinor, 0)
    expect(sum).toBe(800)
  })

  it('maps SOURCE_SUM_MISMATCH to the sourceAmountMinor field', () => {
    expect.assertions(2)
    try {
      materializeForeignLineDomain({
        sourceItems:       [{ id: 'i1', name: 'A', sourceAmountMinor: 1000, allocations: [{ memberId: 'u1', shares: 1 }] }],
        sourceAdjustments: [],
        sourceAmountMinor: 5000,                                // items sum 1000 ≠ 5000
        members:           ['u1'],
        ...RATE,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(ExpenseValidationError)
      expect((e as ExpenseValidationError).field).toBe('sourceAmountMinor')
    }
  })

  it('maps SOURCE_ITEM_NOT_POSITIVE_INTEGER to the sourceItems field', () => {
    expect.assertions(2)
    try {
      materializeForeignLineDomain({
        sourceItems:       [{ id: 'i1', name: 'A', sourceAmountMinor: 0, allocations: [{ memberId: 'u1', shares: 1 }] }],
        sourceAdjustments: [],
        sourceAmountMinor: 1,
        members:           ['u1'],
        ...RATE,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(ExpenseValidationError)
      expect((e as ExpenseValidationError).field).toBe('sourceItems')
    }
  })
})

// ─── split domain ─────────────────────────────────────────────────

describe('materializeForeignSplitDomain', () => {
  it('converts source splits directly to trip splits + total', () => {
    const sourceSplits: ForeignSourceSplit[] = [
      { memberId: 'u1', sourceAmountMinor: 1000 },
      { memberId: 'u2', sourceAmountMinor: 2000 },
    ]
    const out = materializeForeignSplitDomain({ sourceSplits, sourceAmountMinor: 3000, ...RATE })
    expect(out.amountMinor).toBe(3000)
    expect(splitsMap(out.splits)).toEqual({ u1: 1000, u2: 2000 })
  })

  it('maps SOURCE_SPLIT_SUM_MISMATCH to the sourceSplits field', () => {
    expect.assertions(2)
    try {
      materializeForeignSplitDomain({
        sourceSplits:      [{ memberId: 'u1', sourceAmountMinor: 1000 }, { memberId: 'u2', sourceAmountMinor: 2000 }],
        sourceAmountMinor: 5000,                                // splits sum 3000 ≠ 5000
        ...RATE,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(ExpenseValidationError)
      expect((e as ExpenseValidationError).field).toBe('sourceSplits')
    }
  })
})
