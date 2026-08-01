import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { patchListCache, rollbackListCache } from './queryCache'

interface Row {
  id:    string
  title: string
}

const KEY = ['bookings', 'trip-1'] as const

function seed(rows: Row[]): QueryClient {
  const qc = new QueryClient()
  qc.setQueryData<Row[]>(KEY, rows)
  return qc
}

const read = (qc: QueryClient) => qc.getQueryData<Row[]>(KEY)!

describe('rollbackListCache', () => {
  it('drops the optimistic row without reverting a concurrent realtime push', () => {
    const a  = { id: 'a', title: 'A' }
    const qc = seed([a])

    const ctx = patchListCache<Row>(qc, KEY, prev => [...prev, { id: 'temp-1', title: 'new' }])

    // A teammate's snapshot lands while the mutation is still in flight.
    const b = { id: 'b', title: 'B' }
    qc.setQueryData<Row[]>(KEY, [a, b, { id: 'temp-1', title: 'new' }])

    rollbackListCache<Row>(qc, KEY, ctx)

    expect(read(qc).map(r => r.id)).toEqual(['a', 'b'])
  })

  it('restores a deleted row at its original index', () => {
    const rows = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ]
    const qc = seed(rows)

    const ctx = patchListCache<Row>(qc, KEY, prev => prev.filter(r => r.id !== 'b'))
    expect(read(qc).map(r => r.id)).toEqual(['a', 'c'])

    rollbackListCache<Row>(qc, KEY, ctx)

    expect(read(qc)).toEqual(rows)
  })

  it('does not resurrect a row another mutation deleted successfully', () => {
    const qc = seed([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ])

    // Two optimistic deletes in flight; `a` fails, `b` succeeds.
    const ctxA = patchListCache<Row>(qc, KEY, prev => prev.filter(r => r.id !== 'a'))
    patchListCache<Row>(qc, KEY, prev => prev.filter(r => r.id !== 'b'))

    rollbackListCache<Row>(qc, KEY, ctxA)

    expect(read(qc).map(r => r.id)).toEqual(['a'])
  })

  it('keeps a newer value for a row the failed patch had edited', () => {
    const qc = seed([{ id: 'a', title: 'A' }])

    const ctx = patchListCache<Row>(qc, KEY, prev =>
      prev.map(r => (r.id === 'a' ? { ...r, title: 'optimistic' } : r)))

    // Snapshot push overwrites the row before the mutation fails.
    qc.setQueryData<Row[]>(KEY, [{ id: 'a', title: 'from server' }])

    rollbackListCache<Row>(qc, KEY, ctx)

    expect(read(qc)).toEqual([{ id: 'a', title: 'from server' }])
  })

  it('reverts an edit that nothing else touched', () => {
    const qc = seed([{ id: 'a', title: 'A' }])

    const ctx = patchListCache<Row>(qc, KEY, prev =>
      prev.map(r => (r.id === 'a' ? { ...r, title: 'optimistic' } : r)))

    rollbackListCache<Row>(qc, KEY, ctx)

    expect(read(qc)).toEqual([{ id: 'a', title: 'A' }])
  })

  // ─── Known limitations ────────────────────────────────────────────
  // Both predate the operation-scoped rewrite (the whole-snapshot restore
  // produced identical results) and both need optimistic state modelled as
  // layers over an authoritative base — the shape settlementTombstones.ts
  // already uses — rather than more reference heuristics here. `.fails`
  // pins them: fix the primitive and these go red, so drop the marker.

  it.fails('should not keep a failed edit when an earlier patch on the same row rolls back first', () => {
    const qc = seed([{ id: 'a', title: 'A' }])

    const ctxA = patchListCache<Row>(qc, KEY, prev =>
      prev.map(r => ({ ...r, title: 'from A' })))
    const ctxB = patchListCache<Row>(qc, KEY, prev =>
      prev.map(r => ({ ...r, title: `${r.title} + B` })))

    // A settles first, so the reference gate correctly declines to touch a
    // row B has since replaced. B then reverts only to A's optimistic value.
    rollbackListCache<Row>(qc, KEY, ctxA)
    rollbackListCache<Row>(qc, KEY, ctxB)

    expect(read(qc)).toEqual([{ id: 'a', title: 'A' }])
  })

  it.fails('should not restore a row the server deleted while our delete was in flight', () => {
    const qc = seed([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ])

    const ctx = patchListCache<Row>(qc, KEY, prev => prev.filter(r => r.id !== 'a'))
    // Authoritative snapshot removes the same row for its own reasons.
    qc.setQueryData<Row[]>(KEY, [{ id: 'b', title: 'B' }])

    rollbackListCache<Row>(qc, KEY, ctx)

    // An absent id carries no provenance, so the row comes back.
    expect(read(qc).map(r => r.id)).toEqual(['b'])
  })

  it('removes the optimistic row when the cache was cold at patch time', () => {
    const qc = new QueryClient()

    const ctx = patchListCache<Row>(qc, KEY, prev => [...prev, { id: 'temp-1', title: 'new' }])
    rollbackListCache<Row>(qc, KEY, ctx)

    expect(read(qc)).toEqual([])
  })
})
