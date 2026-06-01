// Tests for SettlementDocSchema's FX-group invariants. The schema
// parses Firestore docs on read; the all-or-none + cross-field
// equality contract must hold so that:
//   - the Commit 3 history-row UI never renders a half-populated FX
//     state (sourceCurrency present without fxSnapshot, etc.)
//   - chronological replay in computeBalancesFull reads amountMinor
//     consistent with fxSnapshot.convertedAmountMinor (the audit trail)
//   - a Worker bug in Commit 2 (or a raw admin write) that drifts one
//     field surfaces via the same firestoreDocFromSchema Sentry path
//     as other doc-shape regressions
//
// Mirrors expense.test.ts shape — same baseDoc / baseFx pattern, same
// drift-one-field-at-a-time matrix. Commit 1 ships the schema dormant
// (client still only sends TRIP_CURRENCY payloads); this test
// guarantees the schema is ready the moment Commit 2 lights it up.
import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase/firestore'
import { SettlementDocSchema } from './settlement'

const NOW = Timestamp.fromDate(new Date('2026-06-01T00:00:00Z'))

/** TRIP_CURRENCY baseline — no FX fields, the degenerate path. Typed
 *  as Record<string, unknown> so fixtures can freely add / override
 *  optional fields without TS narrowing them away. */
function baseDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tripId:      'trip-1',
    fromUid:     'alice-uid',
    toUid:       'bob-uid',
    amountMinor: 9750,
    currency:    'JPY',
    settledBy:   'bob-uid',
    createdAt:   NOW,
    ...overrides,
  }
}

/** Valid fxSnapshot fixture aligned with foreignDoc(): USD 65.00
 *  source → JPY 9750 canonical @ 150. Pulled out so drift tests can
 *  spread + override one field at a time. */
const baseFx = {
  provider:             'frankfurter-v2' as const,
  baseCurrency:         'USD',
  quoteCurrency:        'JPY',
  requestedDate:        '2026-06-01',
  rateDate:             '2026-06-01',
  rateDecimal:          '150',
  sourceAmountMinor:    6500,
  convertedAmountMinor: 9750,
  fetchedAt:            NOW,
}

/** FOREIGN_CURRENCY baseline — full 4-field group + matching fx
 *  snapshot. Cross-field equalities all satisfied; individual tests
 *  drift one field at a time to verify each invariant fires. */
function foreignDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...baseDoc(),
    sourceCurrency:    'USD',
    sourceAmountMinor: 6500,
    fxSnapshot:        { ...baseFx },
    settledOn:         '2026-06-01',
    ...overrides,
  }
}

describe('SettlementDocSchema — TRIP_CURRENCY (degenerate path)', () => {
  it('parses with no FX fields', () => {
    const result = SettlementDocSchema.safeParse(baseDoc())
    expect(result.success).toBe(true)
  })

  it('parses with optional note', () => {
    const result = SettlementDocSchema.safeParse(baseDoc({ note: '6/1 dinner' }))
    expect(result.success).toBe(true)
  })

  it('rejects non-currency-code currency', () => {
    const result = SettlementDocSchema.safeParse(baseDoc({ currency: 'jpy' }))
    expect(result.success).toBe(false)
  })

  it('rejects zero amountMinor', () => {
    const result = SettlementDocSchema.safeParse(baseDoc({ amountMinor: 0 }))
    expect(result.success).toBe(false)
  })
})

describe('SettlementDocSchema — FX group all-or-none', () => {
  it('parses fully populated FOREIGN_CURRENCY doc', () => {
    const result = SettlementDocSchema.safeParse(foreignDoc())
    expect(result.success).toBe(true)
  })

  // Drop each of the 4 group fields one at a time to confirm all-or-none.
  for (const field of ['sourceCurrency', 'sourceAmountMinor', 'fxSnapshot', 'settledOn'] as const) {
    it(`rejects when only ${field} is missing (3/4 populated)`, () => {
      const doc = foreignDoc()
      delete doc[field]
      const result = SettlementDocSchema.safeParse(doc)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some(i =>
          i.message.includes('all-or-none'),
        )).toBe(true)
      }
    })
  }

  // Keep only one of the 4 fields to confirm 1/4 also fails.
  it('rejects when only sourceCurrency is present (1/4 populated)', () => {
    const doc = baseDoc({ sourceCurrency: 'USD' })
    const result = SettlementDocSchema.safeParse(doc)
    expect(result.success).toBe(false)
  })

  it('rejects when only fxSnapshot is present (1/4 populated)', () => {
    const doc = baseDoc({ fxSnapshot: { ...baseFx } })
    const result = SettlementDocSchema.safeParse(doc)
    expect(result.success).toBe(false)
  })
})

describe('SettlementDocSchema — FX cross-field equality', () => {
  it('rejects sourceCurrency !== fxSnapshot.baseCurrency', () => {
    const result = SettlementDocSchema.safeParse(foreignDoc({
      sourceCurrency: 'EUR',
    }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i =>
        i.message.includes('baseCurrency'),
      )).toBe(true)
    }
  })

  it('rejects currency !== fxSnapshot.quoteCurrency', () => {
    const result = SettlementDocSchema.safeParse(foreignDoc({
      currency: 'TWD',
    }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i =>
        i.message.includes('quoteCurrency'),
      )).toBe(true)
    }
  })

  it('rejects sourceAmountMinor !== fxSnapshot.sourceAmountMinor', () => {
    const result = SettlementDocSchema.safeParse(foreignDoc({
      sourceAmountMinor: 6501,
    }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i =>
        i.message.includes('sourceAmountMinor'),
      )).toBe(true)
    }
  })

  it('rejects amountMinor !== fxSnapshot.convertedAmountMinor', () => {
    const result = SettlementDocSchema.safeParse(foreignDoc({
      amountMinor: 9751,
    }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i =>
        i.message.includes('convertedAmountMinor'),
      )).toBe(true)
    }
  })

  it('rejects settledOn !== fxSnapshot.requestedDate', () => {
    const result = SettlementDocSchema.safeParse(foreignDoc({
      settledOn: '2026-05-31',
    }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i =>
        i.message.includes('requestedDate'),
      )).toBe(true)
    }
  })
})

describe('SettlementDocSchema — FX field-level validation', () => {
  it('rejects non-canonical rateDecimal (trailing zero)', () => {
    const result = SettlementDocSchema.safeParse(foreignDoc({
      fxSnapshot: { ...baseFx, rateDecimal: '150.0' },
    }))
    expect(result.success).toBe(false)
  })

  // Zero is rejected to match fx-core::isCanonicalRateString. A bug
  // ever writing "0" into a Firestore doc would silently materialise
  // every conversion as 0 minor units — fail fast at parse.
  it('rejects zero rateDecimal ("0")', () => {
    const result = SettlementDocSchema.safeParse(foreignDoc({
      fxSnapshot: { ...baseFx, rateDecimal: '0' },
    }))
    expect(result.success).toBe(false)
  })

  it('rejects zero rateDecimal ("0.0")', () => {
    const result = SettlementDocSchema.safeParse(foreignDoc({
      fxSnapshot: { ...baseFx, rateDecimal: '0.0' },
    }))
    expect(result.success).toBe(false)
  })

  it('rejects malformed settledOn date', () => {
    const result = SettlementDocSchema.safeParse(foreignDoc({
      settledOn: '2026/06/01',
      fxSnapshot: { ...baseFx, requestedDate: '2026/06/01' },
    }))
    expect(result.success).toBe(false)
  })

  it('rejects lowercase sourceCurrency', () => {
    const result = SettlementDocSchema.safeParse(foreignDoc({
      sourceCurrency: 'usd',
      fxSnapshot: { ...baseFx, baseCurrency: 'usd' },
    }))
    expect(result.success).toBe(false)
  })
})
