// Unit tests for the optimistic-delete overlay. The whole correctness
// argument lives in these pure functions, so this is the cheapest seam to
// pin it: add hides a row at read-time WITHOUT mutating the raw list, a
// lagging snapshot that still carries the id can't un-hide it (the flicker
// we defend against), prune only clears once server truth drops the id,
// rollback (remove) brings the row back, and every change bumps the
// per-key version that drives useSyncExternalStore re-renders.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  addTombstones,
  removeTombstones,
  filterTombstoned,
  pruneTombstones,
  subscribeTombstones,
  tombstoneVersion,
  __resetTombstonesForTest,
} from './listTombstones'

interface Row { id: string }
const idOf = (r: Row) => r.id
const rows = (...ids: string[]): Row[] => ids.map(id => ({ id }))
const KEY = ['settlements', 'trip-1'] as const

beforeEach(() => {
  __resetTombstonesForTest()
})

describe('filterTombstoned', () => {
  it('returns the SAME reference when nothing is tombstoned (referential stability)', () => {
    const list = rows('a', 'b')
    expect(filterTombstoned(KEY, list, idOf)).toBe(list)
  })

  it('hides tombstoned ids without mutating the input list', () => {
    const list = rows('a', 'b', 'c')
    addTombstones(KEY, ['b'])
    const filtered = filterTombstoned(KEY, list, idOf)
    expect(filtered.map(idOf)).toEqual(['a', 'c'])
    expect(list.map(idOf)).toEqual(['a', 'b', 'c']) // raw untouched — overlay only
  })
})

describe('versioning (drives useSyncExternalStore re-render)', () => {
  it('bumps the version + notifies subscribers on a real change, not a no-op', () => {
    let notified = 0
    const unsub = subscribeTombstones(KEY, () => { notified += 1 })
    const v0 = tombstoneVersion(KEY)

    addTombstones(KEY, ['b'])
    expect(tombstoneVersion(KEY)).toBeGreaterThan(v0)
    expect(notified).toBe(1)

    addTombstones(KEY, ['b'])      // already tombstoned → no-op, no churn
    expect(notified).toBe(1)

    removeTombstones(KEY, ['b'])
    expect(notified).toBe(2)
    unsub()
  })
})

describe('prune (server truth confirms / denies the delete)', () => {
  it('the flicker scenario: a lagging snapshot still carrying the id KEEPS the tombstone', () => {
    addTombstones(KEY, ['b'])
    // Snapshot mid-flight at delete time still has 'b'.
    pruneTombstones(KEY, rows('a', 'b', 'c'), idOf)
    // Tombstone survives → 'b' stays hidden, no flicker-back.
    expect(filterTombstoned(KEY, rows('a', 'b', 'c'), idOf).map(idOf)).toEqual(['a', 'c'])
  })

  it('clears the tombstone once the id leaves server truth (delete confirmed)', () => {
    addTombstones(KEY, ['b'])
    const vAfterAdd = tombstoneVersion(KEY)
    pruneTombstones(KEY, rows('a', 'c'), idOf) // server dropped 'b'
    expect(tombstoneVersion(KEY)).toBeGreaterThan(vAfterAdd) // pruning notifies too
    // Tombstone gone; if 'b' ever reappeared it would NOT be hidden.
    expect(filterTombstoned(KEY, rows('a', 'b', 'c'), idOf).map(idOf)).toEqual(['a', 'b', 'c'])
  })
})

describe('remove (rollback)', () => {
  it('brings a tombstoned row back immediately', () => {
    addTombstones(KEY, ['b'])
    expect(filterTombstoned(KEY, rows('a', 'b', 'c'), idOf).map(idOf)).toEqual(['a', 'c'])
    removeTombstones(KEY, ['b'])
    expect(filterTombstoned(KEY, rows('a', 'b', 'c'), idOf).map(idOf)).toEqual(['a', 'b', 'c'])
  })
})

describe('query-key isolation', () => {
  it('a tombstone on one key does not affect another', () => {
    const OTHER = ['settlements', 'trip-2'] as const
    addTombstones(KEY, ['b'])
    expect(filterTombstoned(OTHER, rows('x', 'y'), idOf).map(idOf)).toEqual(['x', 'y'])
    expect(tombstoneVersion(OTHER)).toBe(0)
  })
})
