// Unit tests for settlement-lock-write.ts — the pair-contention + expense
// lock-set builders shared by settlement create + delete. The headline
// invariant is CREATE/DELETE SYMMETRY: buildExpenseUnlockWrites must release
// EXACTLY the id buildExpenseSettlementLockWrites added, and an expense
// shared by two settlements must stay locked until BOTH release (cross-pair
// reference-set semantics, no global ARRAY_CONTAINS scan). Also pins
// pairKey injectivity (the base64url underscore-collision footgun) and the
// write shapes (updateMask + exists:true precondition) the orchestrator
// depends on.
import { describe, it, expect } from 'vitest'
import {
  pairKey,
  pairLockPath,
  buildLockWrite,
  buildExpenseSettlementLockWrites,
  buildExpenseUnlockWrites,
  encodeStringArray,
  decodeStringArrayField,
} from '../src/settlement-lock-write'
import { docResourceName, type TxReadDoc } from '../src/firestore-tx'
import type { FsValue } from '../src/firestore'

const PROJECT = 'demo'
const TRIP    = 'trip-1'

/** Minimal in-tx expense read. buildExpenseUnlockWrites only reads
 *  `exists` + `settlementLockIds`; the output document path is built from
 *  the passed expenseId, NOT doc.name, so the name is fixed boilerplate. */
function expenseDoc(over: { exists?: boolean; lockIds?: string[] }): TxReadDoc {
  const fields: Record<string, FsValue> = {}
  if (over.lockIds !== undefined) fields.settlementLockIds = encodeStringArray(over.lockIds)
  return {
    exists:     over.exists ?? true,
    fields,
    name:       'projects/demo/databases/(default)/documents/trips/trip-1/expenses/e1',
    updateTime: null,
  }
}

const lockWrite = (expenseId: string, ids: string[]) => ({
  document:        docResourceName(PROJECT, `trips/${TRIP}/expenses/${expenseId}`),
  fields:          { settlementLockIds: encodeStringArray(ids) },
  updateMask:      ['settlementLockIds'],
  currentDocument: { exists: true },
})

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

// ─── buildExpenseSettlementLockWrites (create side) ───────────────

describe('buildExpenseSettlementLockWrites', () => {
  it('unions the settlement id into each expense lock set', () => {
    const writes = buildExpenseSettlementLockWrites(
      PROJECT, TRIP, ['e1', 'e2'], 'S1',
      new Map([['e1', []], ['e2', ['S0']]]),
    )
    expect(writes).toEqual([lockWrite('e1', ['S1']), lockWrite('e2', ['S0', 'S1'])])
  })

  it('is idempotent — re-locking an already-referenced expense does not duplicate the id', () => {
    const writes = buildExpenseSettlementLockWrites(PROJECT, TRIP, ['e1'], 'S1', new Map([['e1', ['S1']]]))
    expect(writes).toEqual([lockWrite('e1', ['S1'])])
  })

  it('defaults to a fresh [id] set for an expense with no current lock entry', () => {
    const writes = buildExpenseSettlementLockWrites(PROJECT, TRIP, ['e9'], 'S1', new Map())
    expect(writes).toEqual([lockWrite('e9', ['S1'])])
  })
})

// ─── buildExpenseUnlockWrites (delete side) ───────────────────────

describe('buildExpenseUnlockWrites', () => {
  it('removes the settlement id from the lock set', () => {
    const writes = buildExpenseUnlockWrites(PROJECT, TRIP, 'S1', ['e1'], [expenseDoc({ lockIds: ['S1'] })])
    expect(writes).toEqual([lockWrite('e1', [])])
  })

  it('skips an expense the cascade already deleted (no resurrect-as-stub write)', () => {
    const writes = buildExpenseUnlockWrites(PROJECT, TRIP, 'S1', ['e1'], [expenseDoc({ exists: false })])
    expect(writes).toEqual([])
  })

  it('leaves an expense untouched when it does not reference this settlement id', () => {
    const writes = buildExpenseUnlockWrites(PROJECT, TRIP, 'S1', ['e1'], [expenseDoc({ lockIds: ['S2'] })])
    expect(writes).toEqual([])
  })

  it('skips a positional gap (missing read doc) defensively', () => {
    const writes = buildExpenseUnlockWrites(PROJECT, TRIP, 'S1', ['e1'], [])
    expect(writes).toEqual([])
  })
})

// ─── Create / delete symmetry ─────────────────────────────────────

describe('create/delete lock symmetry', () => {
  it('delete releases EXACTLY the id create added (round-trips to the original set)', () => {
    // create: e1 starts unlocked, S1 locks it → persisted set becomes ['S1'].
    const created = buildExpenseSettlementLockWrites(PROJECT, TRIP, ['e1'], 'S1', new Map([['e1', []]]))
    expect(created).toEqual([lockWrite('e1', ['S1'])])

    // delete: feed the post-create doc; S1 must be removed → back to [].
    const deleted = buildExpenseUnlockWrites(PROJECT, TRIP, 'S1', ['e1'], [expenseDoc({ lockIds: ['S1'] })])
    expect(deleted).toEqual([lockWrite('e1', [])])
  })

  it('an expense shared by two settlements stays locked until BOTH release (cross-pair)', () => {
    // e1 already locked by S0 (another pair). S1 locks it too → ['S0','S1'].
    const created = buildExpenseSettlementLockWrites(PROJECT, TRIP, ['e1'], 'S1', new Map([['e1', ['S0']]]))
    expect(created).toEqual([lockWrite('e1', ['S0', 'S1'])])

    // delete S1: e1 keeps S0 → still locked.
    const afterS1 = buildExpenseUnlockWrites(PROJECT, TRIP, 'S1', ['e1'], [expenseDoc({ lockIds: ['S0', 'S1'] })])
    expect(afterS1).toEqual([lockWrite('e1', ['S0'])])

    // delete S0: now fully released → [].
    const afterS0 = buildExpenseUnlockWrites(PROJECT, TRIP, 'S0', ['e1'], [expenseDoc({ lockIds: ['S0'] })])
    expect(afterS0).toEqual([lockWrite('e1', [])])
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
