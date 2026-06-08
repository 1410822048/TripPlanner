// Unit tests for buildForeignLinePreview — the pure source→trip per-line FX
// preview extracted out of ExpenseFormModal. Two material paths, matching
// convertSourceLinesToTarget's success/throw boundary:
//   - balanced draft (items + signed adjustments === total) → authoritative
//     per-line conversion (same import the save path uses)
//   - imbalanced draft (mid-edit) → convertSourceLinesToTarget throws
//     SOURCE_SUM_MISMATCH → independent per-line approximation fallback
// plus the null gates (not foreign / no rate / no amount).
//
// Rate "100" with USD (2 fraction digits) → JPY (0) makes every conversion a
// clean integer: source minor / 100 = trip minor (e.g. $10.00 = 1000 → ¥1000).
import { describe, it, expect } from 'vitest'
import {
  buildForeignLinePreview,
  type ForeignLinePreviewInput,
} from './buildForeignLinePreview'

/** Minimal balanced USD→JPY foreign draft; override per case. */
function baseInput(over: Partial<ForeignLinePreviewInput> = {}): ForeignLinePreviewInput {
  return {
    isForeignOpen:     true,
    rateDecimal:       '100',
    sourceAmountMinor: 3000,        // $30.00
    sourceCurrency:    'USD',
    tripCurrency:      'JPY',
    items:             [{ id: 'i1', amountMinor: 1000 }, { id: 'i2', amountMinor: 2000 }],
    adjustments:       [],
    ...over,
  }
}

/** Object→entries for ergonomic Map assertions. */
function mapOf(m: Map<string, number>): Record<string, number> {
  return Object.fromEntries(m)
}

// ─── null gates ───────────────────────────────────────────────────

describe('buildForeignLinePreview — null gates', () => {
  it('returns null when not foreign-open', () => {
    expect(buildForeignLinePreview(baseInput({ isForeignOpen: false }))).toBeNull()
  })
  it('returns null when no rate is resolved yet', () => {
    expect(buildForeignLinePreview(baseInput({ rateDecimal: null }))).toBeNull()
    expect(buildForeignLinePreview(baseInput({ rateDecimal: '' }))).toBeNull()
  })
  it('returns null when no amount has been typed', () => {
    expect(buildForeignLinePreview(baseInput({ sourceAmountMinor: 0 }))).toBeNull()
  })
})

// ─── balanced (authoritative) path ────────────────────────────────

describe('buildForeignLinePreview — balanced draft', () => {
  it('converts every line authoritatively when items sum to the total', () => {
    const preview = buildForeignLinePreview(baseInput())
    expect(preview).not.toBeNull()
    expect(preview!.amountMinor).toBe(3000)                       // $30.00 → ¥3000
    expect(mapOf(preview!.itemAmountById)).toEqual({ i1: 1000, i2: 2000 })
    expect(mapOf(preview!.adjustmentAmountById)).toEqual({})
  })

  it('carries a balanced adjustment through the authoritative path', () => {
    // items $10.00, DISCOUNT $2.00 → total $8.00 (1000 - 200 = 800): balanced.
    const preview = buildForeignLinePreview(baseInput({
      sourceAmountMinor: 800,
      items:             [{ id: 'i1', amountMinor: 1000 }],
      adjustments:       [{ id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 200 }],
    }))
    expect(preview!.amountMinor).toBe(800)                        // $8.00 → ¥800
    expect(mapOf(preview!.itemAmountById)).toEqual({ i1: 1000 })
    expect(mapOf(preview!.adjustmentAmountById)).toEqual({ a1: 200 })
  })
})

// ─── imbalanced (fallback) path ───────────────────────────────────

describe('buildForeignLinePreview — imbalanced draft fallback', () => {
  it('falls back to independent line conversions when items != total', () => {
    // total $50.00 but items only $10.00 → SOURCE_SUM_MISMATCH → fallback.
    const preview = buildForeignLinePreview(baseInput({
      sourceAmountMinor: 5000,
      items:             [{ id: 'i1', amountMinor: 1000 }],
      adjustments:       [],
    }))
    expect(preview!.amountMinor).toBe(5000)                       // total still shown
    expect(mapOf(preview!.itemAmountById)).toEqual({ i1: 1000 })  // approximate per-line
  })

  it('approximates adjustments too in the fallback', () => {
    const preview = buildForeignLinePreview(baseInput({
      sourceAmountMinor: 5000,
      items:             [{ id: 'i1', amountMinor: 1000 }],
      adjustments:       [{ id: 'a1', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 200 }],
    }))
    expect(preview!.amountMinor).toBe(5000)
    expect(mapOf(preview!.itemAmountById)).toEqual({ i1: 1000 })
    expect(mapOf(preview!.adjustmentAmountById)).toEqual({ a1: 200 })
  })

  it('manual foreign entry (no receipt lines) shows the converted total with empty maps', () => {
    // No items: 0 != total → throws → fallback. Total converts; maps stay empty.
    const preview = buildForeignLinePreview(baseInput({
      sourceAmountMinor: 4600,                                    // $46.00 → ¥4600
      items:             [],
      adjustments:       [],
    }))
    expect(preview!.amountMinor).toBe(4600)
    expect(mapOf(preview!.itemAmountById)).toEqual({})
    expect(mapOf(preview!.adjustmentAmountById)).toEqual({})
  })
})
