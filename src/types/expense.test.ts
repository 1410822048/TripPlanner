// Tests for ExpenseDocSchema's FX-group invariants. The schema parses
// Firestore docs on read; cross-field equality between the parent doc
// and fxSnapshot must hold so that:
//   - 3c UI never sees a half-populated FX state (sourceCurrency
//     present but fxSnapshot missing, or vice versa)
//   - settlement math reading amountMinor stays consistent with
//     fxSnapshot.convertedAmountMinor (the audit trail)
//   - a manual admin write that drifted one field surfaces via the
//     same firestoreDocFromSchema Sentry path as other doc-shape
//     regressions
//
// All other ExpenseDocSchema fields are exercised via service-level
// tests (expenseService.test.ts); this file is focused on the FX
// group only.
import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase/firestore'
import { ExpenseDocSchema } from './expense'

const NOW = Timestamp.fromDate(new Date('2026-05-30T00:00:00Z'))

/** Same-currency baseline -- no FX fields, the degenerate path.
 *  Typed as Record<string, unknown> so test fixtures can freely add /
 *  override optional fields (sourceCurrency / fxSnapshot etc.) without
 *  the TS narrow inferring them away. */
function baseDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tripId:      'trip-1',
    title:       'Lunch',
    amountMinor: 1000,
    currency:    'JPY',
    category:    'food' as const,
    paidBy:      'editor-uid',
    splits:      [{ memberId: 'editor-uid', amountMinor: 1000 }],
    date:        '2026-05-30',
    adjustments: [],
    createdBy:   'editor-uid',
    updatedBy:   'editor-uid',
    memberIds:   ['editor-uid'],
    createdAt:   NOW,
    updatedAt:   NOW,
    ...overrides,
  }
}

/** A valid fxSnapshot fixture aligned with foreignDoc(): USD 12.34 →
 *  JPY 1850 @ rate 146.2. Pulled out as its own const so cross-field
 *  drift tests can spread + override one snapshot field at a time
 *  without re-deriving the rest. */
const baseFx = {
  provider:             'frankfurter-v2' as const,
  baseCurrency:         'USD',
  quoteCurrency:        'JPY',
  requestedDate:        '2026-05-30',
  rateDate:             '2026-05-29',
  rateDecimal:          '146.2',
  sourceAmountMinor:    1234,
  convertedAmountMinor: 1850,
  fetchedAt:            NOW,
}

/** Consistent foreign-currency doc: USD 12.34 → JPY 1850 @ rate 146.2.
 *
 *  Foreign-mode docs MUST carry sourceAdjustments (mirror of
 *  adjustments, which is always present). Items + sourceItems stay
 *  off-by-default; tests that exercise the OCR path overlay them. */
function foreignDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseDoc({
    amountMinor:       1850,
    currency:          'JPY',
    sourceCurrency:    'USD',
    sourceAmountMinor: 1234,
    fxSnapshot:        baseFx,
    sourceAdjustments: [],
    ...overrides,
  })
}

/** Aligned items[] + sourceItems[] pair for OCR-path tests. The trip-
 *  domain `items` is what the Worker will materialize from the source-
 *  domain `sourceItems` on every money / date update; the schema only
 *  enforces id pair-wise alignment (name / assignees may diverge across
 *  sides since the Worker re-derives the trip side). */
const baseItems = [
  { id: 'item-1', name: 'Coffee',    amountMinor: 700,  assignees: ['editor-uid'] },
  { id: 'item-2', name: 'Sandwich',  amountMinor: 1150, assignees: ['editor-uid'] },
] as const

const baseSourceItems = [
  { id: 'item-1', name: 'Coffee',    sourceAmountMinor: 467, assignees: ['editor-uid'] },
  { id: 'item-2', name: 'Sandwich',  sourceAmountMinor: 767, assignees: ['editor-uid'] },
] as const

const baseAdjustments = [
  { id: 'adj-1', label: 'Member discount', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 100 },
] as const

const baseSourceAdjustments = [
  { id: 'adj-1', label: 'Member discount', kind: 'DISCOUNT', scope: 'EXPENSE', sourceAmountMinor: 67 },
] as const

describe('ExpenseDocSchema — same-currency degenerate path', () => {
  it('accepts a baseline expense with no FX fields', () => {
    expect(ExpenseDocSchema.safeParse(baseDoc()).success).toBe(true)
  })
})

describe('ExpenseDocSchema — FX group all-or-none', () => {
  it('accepts a fully-populated foreign-currency expense', () => {
    expect(ExpenseDocSchema.safeParse(foreignDoc()).success).toBe(true)
  })

  // Each partial-population case below MUST reject, otherwise a
  // Worker bug that wrote only some FX fields would surface as silent
  // display drift instead of a loud read-schema rejection.

  it('rejects sourceCurrency alone (missing sourceAmountMinor + fxSnapshot)', () => {
    const doc = baseDoc({ sourceCurrency: 'USD' })
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i => /all-or-none/i.test(i.message))).toBe(true)
    }
  })

  it('rejects sourceAmountMinor alone', () => {
    expect(ExpenseDocSchema.safeParse(baseDoc({ sourceAmountMinor: 1234 })).success).toBe(false)
  })

  it('rejects fxSnapshot alone', () => {
    expect(ExpenseDocSchema.safeParse(baseDoc({ fxSnapshot: baseFx })).success).toBe(false)
  })

  it('rejects sourceCurrency + sourceAmountMinor without fxSnapshot', () => {
    const doc = baseDoc({ sourceCurrency: 'USD', sourceAmountMinor: 1234 })
    expect(ExpenseDocSchema.safeParse(doc).success).toBe(false)
  })

  it('rejects sourceCurrency + fxSnapshot without sourceAmountMinor (cross-field eq would also fail)', () => {
    const doc = baseDoc({ sourceCurrency: 'USD', fxSnapshot: baseFx })
    expect(ExpenseDocSchema.safeParse(doc).success).toBe(false)
  })

  it('rejects sourceAmountMinor + fxSnapshot without sourceCurrency', () => {
    const doc = baseDoc({ sourceAmountMinor: 1234, fxSnapshot: baseFx })
    expect(ExpenseDocSchema.safeParse(doc).success).toBe(false)
  })
})

describe('ExpenseDocSchema — FX cross-field equality', () => {
  // The fxSnapshot is the audit trail for the conversion that yielded
  // amountMinor; if any of the four equalities below break, the doc
  // is internally inconsistent. The Worker is authoritative for these
  // values -- this schema-level check guards against either a Worker
  // bug or a raw admin write that landed inconsistent values.

  it('rejects sourceCurrency mismatch with fxSnapshot.baseCurrency', () => {
    const doc = foreignDoc({ sourceCurrency: 'EUR' })  // fxSnapshot.baseCurrency stays 'USD'
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i => /sourceCurrency.*must equal/i.test(i.message))).toBe(true)
    }
  })

  it('rejects currency mismatch with fxSnapshot.quoteCurrency', () => {
    const doc = foreignDoc({ currency: 'TWD' })  // fxSnapshot.quoteCurrency stays 'JPY'
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i => /currency.*must equal.*quoteCurrency/i.test(i.message))).toBe(true)
    }
  })

  it('rejects sourceAmountMinor mismatch with fxSnapshot.sourceAmountMinor', () => {
    const doc = foreignDoc({ sourceAmountMinor: 9999 })  // fxSnapshot.sourceAmountMinor stays 1234
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i => /sourceAmountMinor.*must equal/i.test(i.message))).toBe(true)
    }
  })

  it('rejects amountMinor mismatch with fxSnapshot.convertedAmountMinor', () => {
    // This is the load-bearing one: amountMinor drives settlement /
    // trip-total math; a fxSnapshot.convertedAmountMinor that doesn't
    // match would let the audit trail diverge from the active money.
    const doc = foreignDoc({ amountMinor: 9999 })  // fxSnapshot.convertedAmountMinor stays 1850
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i => /amountMinor.*must equal.*convertedAmountMinor/i.test(i.message))).toBe(true)
    }
  })

  it('reports ALL cross-field mismatches in a single parse (no early bail)', () => {
    // Each mismatch is its own ctx.addIssue, so a doc with multiple
    // drifts surfaces every issue at once. Defensive: a future
    // refactor that re-introduced early-return after the first issue
    // would silently mask compounding drift.
    const doc = foreignDoc({
      sourceCurrency:    'EUR',  // != baseCurrency 'USD'
      sourceAmountMinor: 9999,   // != fxSnapshot.sourceAmountMinor 1234
      amountMinor:       8888,   // != convertedAmountMinor 1850
    })
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.length).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('ExpenseDocSchema — FX field types still enforced', () => {
  it('rejects non-canonical rateDecimal (trailing zero)', () => {
    const doc = foreignDoc({ fxSnapshot: { ...baseFx, rateDecimal: '146.20' } })
    expect(ExpenseDocSchema.safeParse(doc).success).toBe(false)
  })

  it('rejects lowercase sourceCurrency', () => {
    // Both sides of the pair must be lowered together to isolate the
    // per-field regex from the cross-field equality check.
    const doc = foreignDoc({
      sourceCurrency: 'usd',
      fxSnapshot:     { ...baseFx, baseCurrency: 'usd' },
    })
    expect(ExpenseDocSchema.safeParse(doc).success).toBe(false)
  })

  it('rejects non-ISO-date requestedDate', () => {
    const doc = foreignDoc({ fxSnapshot: { ...baseFx, requestedDate: '2026/05/30' } })
    expect(ExpenseDocSchema.safeParse(doc).success).toBe(false)
  })
})

describe('ExpenseDocSchema — source-domain mirror', () => {
  // sourceAdjustments is REQUIRED on every foreign-mode doc (adjustments
  // is always present, so its source mirror must be too). foreignDoc()
  // already supplies `sourceAdjustments: []` -- these tests verify the
  // schema actually enforces the requirement.

  it('rejects foreign-mode doc missing sourceAdjustments', () => {
    // Manually undo the helper default so we can assert the schema
    // (rather than the helper) is what enforces the invariant.
    const doc = foreignDoc()
    delete (doc as Record<string, unknown>).sourceAdjustments
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i =>
        /sourceAdjustments.*must be present/i.test(i.message),
      )).toBe(true)
    }
  })

  it('accepts foreign-mode doc with aligned adjustments + sourceAdjustments', () => {
    const doc = foreignDoc({
      adjustments:       [...baseAdjustments],
      sourceAdjustments: [...baseSourceAdjustments],
    })
    expect(ExpenseDocSchema.safeParse(doc).success).toBe(true)
  })

  it('rejects sourceAdjustments length mismatch with adjustments', () => {
    const doc = foreignDoc({
      adjustments:       [...baseAdjustments],
      sourceAdjustments: [],  // length 0 vs adjustments length 1
    })
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i =>
        /sourceAdjustments\.length.*must equal adjustments\.length/i.test(i.message),
      )).toBe(true)
    }
  })

  it('rejects sourceAdjustments id mismatch with adjustments', () => {
    const doc = foreignDoc({
      adjustments:       [...baseAdjustments],
      sourceAdjustments: [{ ...baseSourceAdjustments[0], id: 'wrong-id' }],
    })
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i =>
        /sourceAdjustments\[0\]\.id.*must equal items\[0\]\.id|sourceAdjustments\[0\]\.id.*must equal/i.test(i.message),
      )).toBe(true)
    }
  })

  // sourceItems mirrors items presence: foreign-no-OCR omits both,
  // foreign-with-OCR carries both with id pair-wise alignment.

  it('accepts foreign-mode doc with no items + no sourceItems (no-OCR path)', () => {
    expect(ExpenseDocSchema.safeParse(foreignDoc()).success).toBe(true)
  })

  it('accepts foreign-mode doc with aligned items + sourceItems', () => {
    const doc = foreignDoc({
      items:       [...baseItems],
      sourceItems: [...baseSourceItems],
    })
    expect(ExpenseDocSchema.safeParse(doc).success).toBe(true)
  })

  it('rejects foreign-mode items without sourceItems', () => {
    const doc = foreignDoc({ items: [...baseItems] })  // no sourceItems
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i =>
        /sourceItems must be present iff items/i.test(i.message),
      )).toBe(true)
    }
  })

  it('rejects foreign-mode sourceItems without items', () => {
    const doc = foreignDoc({ sourceItems: [...baseSourceItems] })  // no items
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i =>
        /sourceItems must be present iff items/i.test(i.message),
      )).toBe(true)
    }
  })

  it('rejects sourceItems length mismatch with items', () => {
    const doc = foreignDoc({
      items:       [...baseItems],
      sourceItems: [baseSourceItems[0]],  // length 1 vs items length 2
    })
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i =>
        /sourceItems\.length.*must equal items\.length/i.test(i.message),
      )).toBe(true)
    }
  })

  it('rejects sourceItems id mismatch with items', () => {
    const doc = foreignDoc({
      items: [...baseItems],
      sourceItems: [
        { ...baseSourceItems[0], id: 'item-X' },  // mismatched
        baseSourceItems[1],
      ],
    })
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i =>
        /sourceItems\[0\]\.id.*must equal items\[0\]\.id/i.test(i.message),
      )).toBe(true)
    }
  })

  // Same-currency anti-orphan: any source-domain field on a non-FX doc
  // is rejected loudly so a stray sourceItems can't lie about a doc
  // having foreign provenance it doesn't actually have.

  it('rejects same-currency doc with stray sourceItems', () => {
    const doc = baseDoc({ sourceItems: [...baseSourceItems] })
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i =>
        /sourceItems must be absent on same-currency/i.test(i.message),
      )).toBe(true)
    }
  })

  it('rejects same-currency doc with stray sourceAdjustments', () => {
    const doc = baseDoc({ sourceAdjustments: [...baseSourceAdjustments] })
    const res = ExpenseDocSchema.safeParse(doc)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i =>
        /sourceAdjustments must be absent on same-currency/i.test(i.message),
      )).toBe(true)
    }
  })
})
