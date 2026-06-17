// Unit tests for expense-foreign-codec.ts — the Firestore REST codec for the
// foreign-currency SOURCE mirror. The headline guarantee is ENCODE/DECODE
// ROUND-TRIP: a decoded struct re-encoded then re-decoded is byte-identical,
// so create-write (which encodes from the Zod-parsed source) and
// update-recompute (which decodes the persisted mirror, re-materializes, and
// re-encodes) can't drift in how they shape these fields. Also pins the
// fxSnapshot map shape (fetchedAt as nullValue, integers as strings) the
// commit-time REQUEST_TIME transform depends on.
import { describe, it, expect } from 'vitest'
import {
  encodeSourceItems,
  encodeSourceAdjustments,
  encodeSourceSplits,
  encodeFxSnapshot,
  readIntegerField,
  decodeSourceItemsField,
  decodeSourceAdjustmentsField,
  decodeSourceSplitsField,
  type ForeignSourceItem,
  type ForeignSourceAdjustment,
  type ForeignSourceSplit,
} from '../src/expense-foreign-codec'
import type { FxSnapshot } from '../src/fx-rate'

// ─── sourceItems ──────────────────────────────────────────────────

describe('encode/decode sourceItems', () => {
  const items: ForeignSourceItem[] = [
    { id: 'i1', name: 'コーヒー', sourceAmountMinor: 1234, allocations: [{ memberId: 'u1', shares: 1 }, { memberId: 'u2', shares: 1 }] },
    { id: 'i2', name: 'ケーキ',   sourceAmountMinor: 500,  allocations: [{ memberId: 'u1', shares: 1 }] },
  ]

  it('encodes to the Firestore REST array-of-maps shape', () => {
    expect(encodeSourceItems(items)).toEqual({
      arrayValue: {
        values: [
          { mapValue: { fields: {
            id:                { stringValue:  'i1' },
            name:              { stringValue:  'コーヒー' },
            sourceAmountMinor: { integerValue: '1234' },
            allocations:         { arrayValue: { values: [
              { mapValue: { fields: { memberId: { stringValue: 'u1' }, shares: { integerValue: '1' } } } },
              { mapValue: { fields: { memberId: { stringValue: 'u2' }, shares: { integerValue: '1' } } } },
            ] } },
          } } },
          { mapValue: { fields: {
            id:                { stringValue:  'i2' },
            name:              { stringValue:  'ケーキ' },
            sourceAmountMinor: { integerValue: '500' },
            allocations:         { arrayValue: { values: [
              { mapValue: { fields: { memberId: { stringValue: 'u1' }, shares: { integerValue: '1' } } } },
            ] } },
          } } },
        ],
      },
    })
  })

  it('round-trips through decode', () => {
    expect(decodeSourceItemsField({ sourceItems: encodeSourceItems(items) })).toEqual(items)
  })

  it('decodes an absent field to undefined', () => {
    expect(decodeSourceItemsField({})).toBeUndefined()
  })
})

// ─── sourceAdjustments ────────────────────────────────────────────

describe('encode/decode sourceAdjustments', () => {
  const adjustments: ForeignSourceAdjustment[] = [
    { id: 'a1', label: '割引', kind: 'DISCOUNT', scope: 'EXPENSE', sourceAmountMinor: 200 },
    { id: 'a2', label: '項目割', kind: 'COUPON',  scope: 'ITEM',    sourceAmountMinor: 50, targetItemId: 'i2' },
  ]

  it('round-trips, preserving the optional targetItemId only when scope is ITEM', () => {
    const decoded = decodeSourceAdjustmentsField({ sourceAdjustments: encodeSourceAdjustments(adjustments) })
    expect(decoded).toEqual(adjustments)
    // EXPENSE-scope adjustment carries no targetItemId key.
    expect(decoded![0]).not.toHaveProperty('targetItemId')
    expect(decoded![1]!.targetItemId).toBe('i2')
  })

  it('decodes an absent field to undefined', () => {
    expect(decodeSourceAdjustmentsField({})).toBeUndefined()
  })
})

// ─── sourceSplits ─────────────────────────────────────────────────

describe('encode/decode sourceSplits', () => {
  const splits: ForeignSourceSplit[] = [
    { memberId: 'u1', sourceAmountMinor: 1000 },
    { memberId: 'u2', sourceAmountMinor: 2000 },
  ]

  it('round-trips through decode', () => {
    expect(decodeSourceSplitsField({ sourceSplits: encodeSourceSplits(splits) })).toEqual(splits)
  })

  it('decodes an absent field to undefined', () => {
    expect(decodeSourceSplitsField({})).toBeUndefined()
  })
})

// ─── fxSnapshot ───────────────────────────────────────────────────

describe('encodeFxSnapshot', () => {
  it('encodes nine fields, integers as strings, fetchedAt as null (REQUEST_TIME stamped by caller)', () => {
    const fx: FxSnapshot = {
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
    expect(encodeFxSnapshot(fx)).toEqual({
      mapValue: {
        fields: {
          provider:             { stringValue:  'frankfurter-v2' },
          baseCurrency:         { stringValue:  'USD' },
          quoteCurrency:        { stringValue:  'JPY' },
          requestedDate:        { stringValue:  '2026-06-01' },
          rateDate:             { stringValue:  '2026-06-01' },
          rateDecimal:          { stringValue:  '150' },
          sourceAmountMinor:    { integerValue: '10000' },
          convertedAmountMinor: { integerValue: '15000' },
          fetchedAt:            { nullValue:    null },
        },
      },
    })
  })
})

// ─── readIntegerField ─────────────────────────────────────────────

describe('readIntegerField', () => {
  it('reads a REST integerValue as a number', () => {
    expect(readIntegerField({ sourceAmountMinor: { integerValue: '4200' } }, 'sourceAmountMinor')).toBe(4200)
  })
  it('returns undefined for an absent field (distinct from zero)', () => {
    expect(readIntegerField({}, 'sourceAmountMinor')).toBeUndefined()
    expect(readIntegerField({ sourceAmountMinor: { integerValue: '0' } }, 'sourceAmountMinor')).toBe(0)
  })
})
