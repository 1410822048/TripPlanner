// Unit tests for buildOcrExpenseDraft — the pure OCR-result → form-draft
// assembler extracted out of ExpenseFormModal's useOcrFlow.onSuccess. Covers
// the four things the old closure tangled together:
//   - currency resolution (registry-gated detect → persisted → trip fallback)
//   - FAIL-FAST money parse (throws a localised error before returning a draft)
//   - id minting + ITEM-scope adjustment target resolution (deterministic
//     newId so targetItemId is exactly assertable)
//   - non-destructive title fill + new-only category fill
//
// USD↔JPY cases use clean values so every parse/format is hand-verifiable:
// USD "$12.34" → 1234 minor; JPY "3000" → 3000 minor (0 fraction digits).
import { describe, it, expect } from 'vitest'
import {
  buildOcrExpenseDraft,
  type OcrExpenseDraftContext,
} from './buildOcrExpenseDraft'
import type { OcrResult, OcrItem, OcrAdjustment } from './ocrService'

/** Deterministic id generator: 'id-1', 'id-2', … in call order. The function
 *  mints item ids first (one per item), then one per adjustment. */
function makeNewId(): () => string {
  let n = 0
  return () => `id-${++n}`
}

function ocrItem(name: string, amountText: string): OcrItem {
  return { name, amountText }
}

function ocrAdj(over: Partial<OcrAdjustment> = {}): OcrAdjustment {
  return {
    label:          'Coupon',
    kind:           'DISCOUNT',
    amountText:     '100',
    suggestedScope: 'EXPENSE',
    ...over,
  }
}

function ocrResult(over: Partial<OcrResult> = {}): OcrResult {
  return {
    items:        [],
    adjustments:  [],
    ignoredLines: [],
    totalText:    '0',
    ...over,
  }
}

function ctx(over: Partial<OcrExpenseDraftContext> = {}): OcrExpenseDraftContext {
  return {
    tripCurrency:            'JPY',
    persistedSourceCurrency: undefined,
    isEdit:                  false,
    currentTitle:            '',
    ...over,
  }
}

// ─── Currency resolution ──────────────────────────────────────────

describe('buildOcrExpenseDraft — currency resolution', () => {
  it('falls back to tripCurrency when OCR omits the currency', () => {
    const draft = buildOcrExpenseDraft(
      ocrResult({ items: [ocrItem('Lunch', '3000')], totalText: '3000' }),
      ctx({ tripCurrency: 'JPY' }),
      makeNewId(),
    )
    expect(draft.ocrCurrency).toBe('JPY')
    expect(draft.items[0]!.amountMinor).toBe(3000)
    expect(draft.items[0]!.amountText).toBe('3000')
    expect(draft.amountText).toBe('3000')
  })

  it('honors a registry-known detected currency (USD on a JPY trip → foreign)', () => {
    const draft = buildOcrExpenseDraft(
      ocrResult({ currency: 'USD', items: [ocrItem('Coffee', '12.34')], totalText: '12.34' }),
      ctx({ tripCurrency: 'JPY' }),
      makeNewId(),
    )
    expect(draft.ocrCurrency).toBe('USD')
    expect(draft.items[0]!.amountMinor).toBe(1234)
    expect(draft.items[0]!.amountText).toBe('12.34')
    expect(draft.amountText).toBe('12.34')
  })

  it('ignores an unregistered ISO-shaped code (CAD) and falls back to persisted source', () => {
    const draft = buildOcrExpenseDraft(
      ocrResult({ currency: 'CAD', items: [ocrItem('Coffee', '12.34')], totalText: '12.34' }),
      ctx({ tripCurrency: 'JPY', persistedSourceCurrency: 'USD' }),
      makeNewId(),
    )
    // CAD is not in CURRENCY_OPTIONS → detect drops → persisted USD wins.
    expect(draft.ocrCurrency).toBe('USD')
    expect(draft.items[0]!.amountMinor).toBe(1234)
  })

  it('falls back trip-first when both detect and persisted are absent', () => {
    const draft = buildOcrExpenseDraft(
      ocrResult({ currency: 'CAD', items: [ocrItem('Lunch', '3000')], totalText: '3000' }),
      ctx({ tripCurrency: 'JPY', persistedSourceCurrency: undefined }),
      makeNewId(),
    )
    expect(draft.ocrCurrency).toBe('JPY')
  })
})

// ─── Fail-fast money parse ────────────────────────────────────────

describe('buildOcrExpenseDraft — fail-fast parse', () => {
  it('throws a localised error (no draft returned) when an item amount breaks the currency grammar', () => {
    // JPY has 0 fraction digits; "12.34" passes the Worker shape check but
    // breaks parseMoneyToMinor → the whole draft must throw, never partially
    // apply.
    expect(() =>
      buildOcrExpenseDraft(
        ocrResult({ items: [ocrItem('Coffee', '12.34')], totalText: '12.34' }),
        ctx({ tripCurrency: 'JPY' }),
        makeNewId(),
      ),
    ).toThrow(/OCRの金額がJPY/)
  })

  it('throws when the total is malformed even if every item parses', () => {
    expect(() =>
      buildOcrExpenseDraft(
        ocrResult({ items: [ocrItem('Lunch', '3000')], totalText: '3,0,0,0.x' }),
        ctx({ tripCurrency: 'JPY' }),
        makeNewId(),
      ),
    ).toThrow(/total/)
  })
})

// ─── Item minting + allocations ─────────────────────────────────────

describe('buildOcrExpenseDraft — items', () => {
  it('mints ids in order and resets allocations to empty (Phase B contract)', () => {
    const draft = buildOcrExpenseDraft(
      ocrResult({
        items:     [ocrItem('A', '100'), ocrItem('B', '200')],
        totalText: '300',
      }),
      ctx({ tripCurrency: 'JPY' }),
      makeNewId(),
    )
    expect(draft.items).toEqual([
      { id: 'id-1', name: 'A', amountMinor: 100, amountText: '100', allocations: [] },
      { id: 'id-2', name: 'B', amountMinor: 200, amountText: '200', allocations: [] },
    ])
  })
})

// ─── Adjustment scope / target resolution ─────────────────────────

describe('buildOcrExpenseDraft — adjustments', () => {
  it('resolves an ITEM-scope adjustment to the minted target id', () => {
    const draft = buildOcrExpenseDraft(
      ocrResult({
        items:       [ocrItem('A', '100'), ocrItem('B', '200')],
        totalText:   '250',
        adjustments: [ocrAdj({
          label: '割引', amountText: '50',
          suggestedScope: 'ITEM', suggestedTargetItemIndex: 1,
        })],
      }),
      ctx({ tripCurrency: 'JPY' }),
      makeNewId(),
    )
    // items mint id-1/id-2 first, then the adjustment mints id-3.
    expect(draft.adjustments).toEqual([
      { id: 'id-3', label: '割引', kind: 'DISCOUNT', scope: 'ITEM', amountMinor: 50, targetItemId: 'id-2' },
    ])
    expect(draft.adjustmentText).toEqual({ 'id-3': '50' })
  })

  it('drops an out-of-range ITEM target instead of making it receipt-wide', () => {
    const draft = buildOcrExpenseDraft(
      ocrResult({
        items:       [ocrItem('A', '100')],
        totalText:   '50',
        adjustments: [ocrAdj({
          amountText: '50', suggestedScope: 'ITEM', suggestedTargetItemIndex: 5,
        })],
      }),
      ctx({ tripCurrency: 'JPY' }),
      makeNewId(),
    )
    expect(draft.adjustments).toEqual([])
    expect(draft.adjustmentText).toEqual({})
  })

  it('drops an ITEM scope with no target index', () => {
    const draft = buildOcrExpenseDraft(
      ocrResult({
        items:       [ocrItem('A', '100')],
        totalText:   '50',
        adjustments: [ocrAdj({ amountText: '50', suggestedScope: 'ITEM' })],
      }),
      ctx(),
      makeNewId(),
    )
    expect(draft.adjustments).toEqual([])
    expect(draft.adjustmentText).toEqual({})
  })

  it('drops UNKNOWN scope so the form surfaces a total mismatch for review', () => {
    const draft = buildOcrExpenseDraft(
      ocrResult({
        items:       [ocrItem('A', '100')],
        totalText:   '50',
        adjustments: [ocrAdj({ amountText: '50', suggestedScope: 'UNKNOWN' })],
      }),
      ctx(),
      makeNewId(),
    )
    expect(draft.adjustments).toEqual([])
    expect(draft.adjustmentText).toEqual({})
  })

  it('maps a zero-amount adjustment to an empty inflight text', () => {
    const draft = buildOcrExpenseDraft(
      ocrResult({
        items:       [ocrItem('A', '100')],
        totalText:   '100',
        adjustments: [ocrAdj({ amountText: '0' })],
      }),
      ctx(),
      makeNewId(),
    )
    expect(draft.adjustments[0]!.amountMinor).toBe(0)
    expect(draft.adjustmentText['id-2']).toBe('')
  })
})

// ─── Title / category fill ────────────────────────────────────────

describe('buildOcrExpenseDraft — title & category', () => {
  it('fills the title from storeName only when the current title is blank', () => {
    const withStore = ocrResult({ storeName: 'スターバックス', totalText: '0' })
    expect(buildOcrExpenseDraft(withStore, ctx({ currentTitle: '' }), makeNewId()).title)
      .toBe('スターバックス')
    expect(buildOcrExpenseDraft(withStore, ctx({ currentTitle: '   ' }), makeNewId()).title)
      .toBe('スターバックス')
    // Already typed → non-destructive.
    expect(buildOcrExpenseDraft(withStore, ctx({ currentTitle: 'My lunch' }), makeNewId()).title)
      .toBeUndefined()
  })

  it('omits the title when OCR has no storeName', () => {
    expect(buildOcrExpenseDraft(ocrResult(), ctx({ currentTitle: '' }), makeNewId()).title)
      .toBeUndefined()
  })

  it('applies category only on a new expense, never on edit', () => {
    const withCat = ocrResult({ category: 'transport', totalText: '0' })
    expect(buildOcrExpenseDraft(withCat, ctx({ isEdit: false }), makeNewId()).category)
      .toBe('transport')
    expect(buildOcrExpenseDraft(withCat, ctx({ isEdit: true }), makeNewId()).category)
      .toBeUndefined()
  })

  it('omits category when OCR omits it', () => {
    expect(buildOcrExpenseDraft(ocrResult(), ctx({ isEdit: false }), makeNewId()).category)
      .toBeUndefined()
  })
})
