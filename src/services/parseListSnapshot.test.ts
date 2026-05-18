// src/services/parseListSnapshot.test.ts
// Per-row resilience contract: one bad row must NOT poison the whole
// list. Critical for the realtime + one-shot list paths that share
// this helper — pre-migration cache docs, schema drift, and partial
// writes all surface here, and the behaviour difference between
// "skip bad row" and "kill the tab" is what was actually shipped.
import { describe, expect, it, vi } from 'vitest'
import type { QuerySnapshot, QueryDocumentSnapshot } from 'firebase/firestore'
import { parseListSnapshot } from './parseListSnapshot'

function fakeDoc(id: string): QueryDocumentSnapshot {
  return { id } as QueryDocumentSnapshot
}
function fakeSnap(ids: string[]): QuerySnapshot {
  return { docs: ids.map(fakeDoc) } as unknown as QuerySnapshot
}

describe('parseListSnapshot', () => {
  it('returns parsed rows for all-good input', () => {
    const fromDoc = (d: QueryDocumentSnapshot) => ({ id: d.id, ok: true })
    const out = parseListSnapshot(fakeSnap(['a', 'b', 'c']), fromDoc)
    expect(out).toEqual([
      { id: 'a', ok: true },
      { id: 'b', ok: true },
      { id: 'c', ok: true },
    ])
  })

  it('skips a single bad row and returns the rest', () => {
    const fromDoc = (d: QueryDocumentSnapshot) => {
      if (d.id === 'bad') throw new Error('schema fail')
      return { id: d.id, ok: true }
    }
    const out = parseListSnapshot(fakeSnap(['a', 'bad', 'c']), fromDoc)
    expect(out).toEqual([
      { id: 'a', ok: true },
      { id: 'c', ok: true },
    ])
  })

  it('returns empty array when every row is bad (does not throw)', () => {
    const fromDoc = vi.fn(() => { throw new Error('schema fail') })
    const out = parseListSnapshot(fakeSnap(['a', 'b']), fromDoc)
    expect(out).toEqual([])
    expect(fromDoc).toHaveBeenCalledTimes(2)
  })

  it('returns empty array for empty snapshot without invoking fromDoc', () => {
    const fromDoc = vi.fn()
    const out = parseListSnapshot(fakeSnap([]), fromDoc)
    expect(out).toEqual([])
    expect(fromDoc).not.toHaveBeenCalled()
  })

  it('preserves order of surviving rows', () => {
    const fromDoc = (d: QueryDocumentSnapshot) => {
      if (d.id === 'x') throw new Error('schema fail')
      return d.id
    }
    const out = parseListSnapshot(fakeSnap(['1', 'x', '2', 'x', '3']), fromDoc)
    expect(out).toEqual(['1', '2', '3'])
  })
})
