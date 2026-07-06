import { describe, it, expect, beforeEach } from 'vitest'
import type { SettlementRecord } from '@/types/settlement'
import {
  addSettlementTombstone,
  removeSettlementTombstone,
  filterSettlementTombstones,
  pruneSettlementTombstones,
  subscribeSettlementTombstones,
  settlementTombstoneVersion,
  __resetSettlementTombstonesForTest,
} from './settlementTombstones'

const rows = (...ids: string[]): SettlementRecord[] => ids.map(id => ({ id }) as SettlementRecord)
const ids = (list: SettlementRecord[]) => list.map(r => r.id)
const TRIP = 'trip-1'

beforeEach(() => {
  __resetSettlementTombstonesForTest()
})

describe('filterSettlementTombstones', () => {
  it('returns the same reference when nothing is tombstoned', () => {
    const list = rows('a', 'b')
    expect(filterSettlementTombstones(TRIP, list)).toBe(list)
  })

  it('hides tombstoned ids without mutating the raw list', () => {
    const list = rows('a', 'b', 'c')
    addSettlementTombstone(TRIP, 'b')

    expect(ids(filterSettlementTombstones(TRIP, list))).toEqual(['a', 'c'])
    expect(ids(list)).toEqual(['a', 'b', 'c'])
  })
})

describe('versioning', () => {
  it('bumps version and notifies subscribers only on real changes', () => {
    let notified = 0
    const unsub = subscribeSettlementTombstones(TRIP, () => { notified += 1 })
    const v0 = settlementTombstoneVersion(TRIP)

    addSettlementTombstone(TRIP, 'b')
    expect(settlementTombstoneVersion(TRIP)).toBeGreaterThan(v0)
    expect(notified).toBe(1)

    addSettlementTombstone(TRIP, 'b')
    expect(notified).toBe(1)

    removeSettlementTombstone(TRIP, 'b')
    expect(notified).toBe(2)
    unsub()
  })
})

describe('pruneSettlementTombstones', () => {
  it('keeps the tombstone while a lagging snapshot still carries the id', () => {
    addSettlementTombstone(TRIP, 'b')
    pruneSettlementTombstones(TRIP, rows('a', 'b', 'c'))

    expect(ids(filterSettlementTombstones(TRIP, rows('a', 'b', 'c')))).toEqual(['a', 'c'])
  })

  it('clears the tombstone once the id leaves server truth', () => {
    addSettlementTombstone(TRIP, 'b')
    const vAfterAdd = settlementTombstoneVersion(TRIP)

    pruneSettlementTombstones(TRIP, rows('a', 'c'))

    expect(settlementTombstoneVersion(TRIP)).toBeGreaterThan(vAfterAdd)
    expect(ids(filterSettlementTombstones(TRIP, rows('a', 'b', 'c')))).toEqual(['a', 'b', 'c'])
  })
})

describe('removeSettlementTombstone', () => {
  it('brings a tombstoned row back immediately', () => {
    addSettlementTombstone(TRIP, 'b')
    expect(ids(filterSettlementTombstones(TRIP, rows('a', 'b', 'c')))).toEqual(['a', 'c'])

    removeSettlementTombstone(TRIP, 'b')

    expect(ids(filterSettlementTombstones(TRIP, rows('a', 'b', 'c')))).toEqual(['a', 'b', 'c'])
  })
})

describe('trip isolation', () => {
  it('a tombstone on one trip does not affect another', () => {
    addSettlementTombstone(TRIP, 'b')

    expect(ids(filterSettlementTombstones('trip-2', rows('x', 'y')))).toEqual(['x', 'y'])
    expect(settlementTombstoneVersion('trip-2')).toBe(0)
  })
})
