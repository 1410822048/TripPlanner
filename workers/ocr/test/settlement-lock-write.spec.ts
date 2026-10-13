// Unit tests for settlement-lock-write.ts: pairKey injectivity (the
// base64url underscore-collision footgun), the pair-lock path and write
// shape, and the reference-set codec. The per-expense lock set is covered
// end-to-end in settlement-route-write.spec (create / cancel / property).
import { describe, it, expect } from 'vitest'
import {
  pairKey,
  pairLockPath,
  buildLockWrite,
  encodeStringArray,
  decodeStringArrayField,
} from '../src/settlement-lock-write'
import { docResourceName } from '../src/firestore-tx'

const PROJECT = 'demo'
const TRIP    = 'trip-1'

// ─── pairKey / pairLockPath ───────────────────────────────────────

describe('pairKey', () => {
  it('is direction-agnostic (A→B and B→A share a key)', () => {
    expect(pairKey('alice', 'bob')).toBe(pairKey('bob', 'alice'))
  })

  it('length-prefixes so concatenation is injective (no base64url underscore collision)', () => {
    // {a, b_c} and {a_b, c} both naive-collapse to "a_b_c" — must stay distinct.
    expect(pairKey('a', 'b_c')).not.toBe(pairKey('a_b', 'c'))
  })

  it('encodes <lo.len>:<lo>:<hi.len>:<hi> in lexicographic order', () => {
    expect(pairKey('xy', 'z')).toBe('2:xy:1:z')
    expect(pairKey('z', 'xy')).toBe('2:xy:1:z')
  })
})

describe('pairLockPath', () => {
  it('composes the pair key under the trip settlementPairLocks collection', () => {
    expect(pairLockPath(TRIP, 'alice', 'bob')).toBe(`trips/${TRIP}/settlementPairLocks/${pairKey('alice', 'bob')}`)
  })
})

// ─── buildLockWrite ───────────────────────────────────────────────

describe('buildLockWrite', () => {
  it('stamps lastSettlementId + REQUEST_TIME with no currentDocument precondition (lazy-create)', () => {
    const path = pairLockPath(TRIP, 'alice', 'bob')
    expect(buildLockWrite(PROJECT, path, 'S1')).toEqual({
      document: docResourceName(PROJECT, path),
      fields:   { lastSettlementId: { stringValue: 'S1' } },
      updateTransforms: [{ fieldPath: 'lastSettlementAt', setToServerValue: 'REQUEST_TIME' }],
    })
  })
})

// ─── encode/decode reference-set round-trip ───────────────────────

describe('encodeStringArray / decodeStringArrayField', () => {
  it('round-trips a reference set', () => {
    expect(decodeStringArrayField({ settlementLockIds: encodeStringArray(['a', 'b']) }, 'settlementLockIds'))
      .toEqual(['a', 'b'])
  })

  it('decodes a missing field / undefined fields to an empty set', () => {
    expect(decodeStringArrayField({}, 'settlementLockIds')).toEqual([])
    expect(decodeStringArrayField(undefined, 'settlementLockIds')).toEqual([])
  })

  it('encodes an empty set as an empty array value', () => {
    expect(encodeStringArray([])).toEqual({ arrayValue: { values: [] } })
  })
})
