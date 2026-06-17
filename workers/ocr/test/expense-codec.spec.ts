// Unit tests for expense-codec.ts — the trip-currency Firestore REST codec
// extracted from expense-write.ts. Covers:
//   - encodeExpense create shape (audit fields, splits/items/adjustments/
//     receipt sub-encoders, foreign source-mirror branching + its 500 guard)
//   - encodePatch partial shape (only present fields emitted; receipt arg)
//   - mergeExpense (patch overrides where present, decoded current otherwise)
//
// Payloads are produced by the REAL makeExpense*Schema so the fixtures are
// guaranteed valid post-parse shapes (the encoders never re-validate).
// createdAt / updatedAt / fxSnapshot.fetchedAt are deliberately ABSENT/null
// here — the orchestrator stamps them via REQUEST_TIME updateTransforms.
import { describe, it, expect } from 'vitest'
import {
  encodeExpense,
  encodePatch,
  mergeExpense,
} from '../src/expense-codec'
import {
  makeExpenseCreateSchema,
  makeExpenseUpdateSchema,
  type ExpenseReceiptOut,
} from '../src/expense-validate'
import { CascadeError } from '../src/cascade'
import type { ForeignArtifacts } from '../src/expense-foreign-write'
import type { FxSnapshot } from '../src/fx-rate'

const TRIP = 'trip1'
const MEMBERS = ['u1', 'u2']

/** Build a valid parsed create payload, overriding individual fields. */
function createPayload(over: Record<string, unknown> = {}) {
  return makeExpenseCreateSchema().parse({
    title:       'Lunch',
    amountMinor: 1200,
    currency:    'JPY',
    category:    'food',
    paidBy:      'u1',
    splits:      [{ memberId: 'u1', amountMinor: 600 }, { memberId: 'u2', amountMinor: 600 }],
    date:        '2026-06-01',
    adjustments: [],
    ...over,
  })
}

const RECEIPT: ExpenseReceiptOut = {
  path: 'trips/trip1/expenses/e1/receipt.webp',
  type: 'image/webp',
}

const FX: FxSnapshot = {
  provider:             'frankfurter-v2',
  baseCurrency:         'USD',
  quoteCurrency:        'JPY',
  requestedDate:        '2026-06-01',
  rateDate:             '2026-06-01',
  rateDecimal:          '150',
  sourceAmountMinor:    10_000,
  convertedAmountMinor: 15_000,
  fetchedAtMs:          1_700_000_000_000,
}

// ─── encodeExpense: create shape ──────────────────────────────────

describe('encodeExpense', () => {
  it('encodes the canonical create field map (audit fields + splits)', () => {
    const fields = encodeExpense(createPayload(), TRIP, MEMBERS, 'u1')
    expect(fields.tripId).toEqual({ stringValue: 'trip1' })
    expect(fields.title).toEqual({ stringValue: 'Lunch' })
    expect(fields.amountMinor).toEqual({ integerValue: '1200' })
    expect(fields.currency).toEqual({ stringValue: 'JPY' })
    expect(fields.category).toEqual({ stringValue: 'food' })
    expect(fields.paidBy).toEqual({ stringValue: 'u1' })
    expect(fields.date).toEqual({ stringValue: '2026-06-01' })
    expect(fields.createdBy).toEqual({ stringValue: 'u1' })
    expect(fields.updatedBy).toEqual({ stringValue: 'u1' })
    expect(fields.deletedAt).toEqual({ nullValue: null })
    expect(fields.receiptPurgedAt).toEqual({ nullValue: null })
    expect(fields.memberIds).toEqual({
      arrayValue: { values: [{ stringValue: 'u1' }, { stringValue: 'u2' }] },
    })
    expect(fields.splits).toEqual({
      arrayValue: {
        values: [
          { mapValue: { fields: { memberId: { stringValue: 'u1' }, amountMinor: { integerValue: '600' } } } },
          { mapValue: { fields: { memberId: { stringValue: 'u2' }, amountMinor: { integerValue: '600' } } } },
        ],
      },
    })
    // adjustments[] is always present (empty array when none).
    expect(fields.adjustments).toEqual({ arrayValue: { values: [] } })
  })

  it('omits optional fields and the server-stamped timestamps', () => {
    const fields = encodeExpense(createPayload(), TRIP, MEMBERS, 'u1')
    expect(fields.note).toBeUndefined()
    expect(fields.items).toBeUndefined()
    expect(fields.receipt).toBeUndefined()
    expect(fields.sourceCurrency).toBeUndefined()
    // createdAt / updatedAt are written via updateTransforms, not the map.
    expect(fields.createdAt).toBeUndefined()
    expect(fields.updatedAt).toBeUndefined()
  })

  it('encodes note, items and ITEM-vs-EXPENSE-scope adjustments', () => {
    const fields = encodeExpense(createPayload({
      note:  'tip included',
      items: [{ id: 'i1', name: 'Coffee', amountMinor: 1200, allocations: [{ memberId: 'u1', shares: 1 }, { memberId: 'u2', shares: 1 }] }],
      adjustments: [
        { id: 'a1', label: '割引', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 100 },
        { id: 'a2', label: '項目割', kind: 'COUPON', scope: 'ITEM', amountMinor: 50, targetItemId: 'i1' },
      ],
    }), TRIP, MEMBERS, 'u1')

    expect(fields.note).toEqual({ stringValue: 'tip included' })
    expect(fields.items).toEqual({
      arrayValue: {
        values: [
          { mapValue: { fields: {
            id:          { stringValue: 'i1' },
            name:        { stringValue: 'Coffee' },
            amountMinor: { integerValue: '1200' },
            allocations:   { arrayValue: { values: [
              { mapValue: { fields: { memberId: { stringValue: 'u1' }, shares: { integerValue: '1' } } } },
              { mapValue: { fields: { memberId: { stringValue: 'u2' }, shares: { integerValue: '1' } } } },
            ] } },
          } } },
        ],
      },
    })
    const adjVals = (fields.adjustments as { arrayValue: { values: { mapValue: { fields: Record<string, unknown> } }[] } }).arrayValue.values
    // EXPENSE scope carries no targetItemId; ITEM scope does.
    expect(adjVals[0]!.mapValue.fields).not.toHaveProperty('targetItemId')
    expect(adjVals[1]!.mapValue.fields.targetItemId).toEqual({ stringValue: 'i1' })
  })

  it('encodes receipt path-only (path/type/thumbPath, no bearer URL)', () => {
    const noThumb = encodeExpense(createPayload(), TRIP, MEMBERS, 'u1', RECEIPT)
    // path-only: only path / type are written when there's no thumb; reads
    // go through getBlob(path). The exact-shape match excludes any url.
    expect(noThumb.receipt).toEqual({
      mapValue: { fields: {
        path: { stringValue: 'trips/trip1/expenses/e1/receipt.webp' },
        type: { stringValue: 'image/webp' },
      } },
    })

    const withThumb = encodeExpense(createPayload(), TRIP, MEMBERS, 'u1', {
      ...RECEIPT,
      thumbPath: 'trips/trip1/expenses/e1/thumb.webp',
    })
    // Exact-shape match: thumbPath added, still no url/thumbUrl.
    expect(withThumb.receipt).toEqual({
      mapValue: { fields: {
        path:      { stringValue: 'trips/trip1/expenses/e1/receipt.webp' },
        type:      { stringValue: 'image/webp' },
        thumbPath: { stringValue: 'trips/trip1/expenses/e1/thumb.webp' },
      } },
    })
  })
})

// ─── encodeExpense: foreign source mirror ─────────────────────────

describe('encodeExpense foreign mirror', () => {
  it('encodes the manual-total (sourceSplits) source domain + null fetchedAt', () => {
    const foreign: ForeignArtifacts = {
      sourceCurrency:    'USD',
      sourceAmountMinor: 10_000,
      sourceSplits:      [{ memberId: 'u1', sourceAmountMinor: 6_000 }, { memberId: 'u2', sourceAmountMinor: 4_000 }],
      fxSnapshot:        FX,
    }
    const fields = encodeExpense(createPayload(), TRIP, MEMBERS, 'u1', undefined, foreign)
    expect(fields.sourceCurrency).toEqual({ stringValue: 'USD' })
    expect(fields.sourceAmountMinor).toEqual({ integerValue: '10000' })
    expect(fields.sourceSplits).toBeDefined()
    expect(fields.sourceItems).toBeUndefined()
    expect(fields.sourceAdjustments).toBeUndefined()
    // fetchedAt is null in the map; the orchestrator stamps REQUEST_TIME.
    const fx = (fields.fxSnapshot as { mapValue: { fields: Record<string, unknown> } }).mapValue.fields
    expect(fx.fetchedAt).toEqual({ nullValue: null })
  })

  it('encodes the line (sourceItems + sourceAdjustments) source domain', () => {
    const foreign: ForeignArtifacts = {
      sourceCurrency:    'USD',
      sourceAmountMinor: 10_000,
      sourceItems:       [{ id: 'i1', name: 'A', sourceAmountMinor: 10_000, allocations: [{ memberId: 'u1', shares: 1 }] }],
      sourceAdjustments: [],
      fxSnapshot:        FX,
    }
    const fields = encodeExpense(createPayload(), TRIP, MEMBERS, 'u1', undefined, foreign)
    expect(fields.sourceItems).toBeDefined()
    expect(fields.sourceAdjustments).toBeDefined()
    expect(fields.sourceSplits).toBeUndefined()
  })

  it('throws CascadeError 500 when foreign artifacts carry no source domain', () => {
    expect.assertions(2)
    const foreign: ForeignArtifacts = {
      sourceCurrency:    'USD',
      sourceAmountMinor: 10_000,
      fxSnapshot:        FX,
    }
    try {
      encodeExpense(createPayload(), TRIP, MEMBERS, 'u1', undefined, foreign)
    } catch (e) {
      expect(e).toBeInstanceOf(CascadeError)
      expect((e as CascadeError).status).toBe(500)
    }
  })
})

// ─── encodePatch: partial shape ───────────────────────────────────

describe('encodePatch', () => {
  it('encodes only the fields present in the patch', () => {
    const out = encodePatch(makeExpenseUpdateSchema().parse({ amountMinor: 999 }))
    expect(out).toEqual({ amountMinor: { integerValue: '999' } })
  })

  it('encodes splits / title together and the out-of-band receipt arg', () => {
    const patch = makeExpenseUpdateSchema().parse({
      title:  'New title',
      splits: [{ memberId: 'u1', amountMinor: 1000 }],
    })
    const out = encodePatch(patch, RECEIPT)
    expect(out.title).toEqual({ stringValue: 'New title' })
    expect(out.splits).toBeDefined()
    expect(out.receipt).toBeDefined()
    // Fields absent from the patch are not emitted.
    expect(out.amountMinor).toBeUndefined()
    expect(out.category).toBeUndefined()
  })

  it('omits receipt entirely when no receipt arg is passed', () => {
    const out = encodePatch(makeExpenseUpdateSchema().parse({ note: 'hi' }))
    expect(out).toEqual({ note: { stringValue: 'hi' } })
    expect(out.receipt).toBeUndefined()
  })
})

// ─── mergeExpense ─────────────────────────────────────────────────

describe('mergeExpense', () => {
  it('takes patched fields where present and decoded-current fields otherwise', () => {
    // Use encodeExpense as the fixture producer so the stored shape is
    // exactly what decodeExpense reads (encode → decode round-trip).
    const current = encodeExpense(createPayload(), TRIP, MEMBERS, 'u1')
    const patch = makeExpenseUpdateSchema().parse({ amountMinor: 2000, paidBy: 'u2' })

    const merged = mergeExpense(current, patch)
    expect(merged.amountMinor).toBe(2000)  // from patch
    expect(merged.paidBy).toBe('u2')       // from patch
    expect(merged.currency).toBe('JPY')    // from decoded current
    expect(merged.splits).toEqual([        // from decoded current (untouched)
      { memberId: 'u1', amountMinor: 600 },
      { memberId: 'u2', amountMinor: 600 },
    ])
  })
})
