// Edit-mode seeding: an expense only re-opens in "equal" mode when its
// stored splits are EXACTLY what splitEqually would produce. A ±1
// tolerance used to treat a custom 500/501 split as equal, and saving
// then silently re-split it.
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'
import { useSplitsState } from './useSplitsState'

const members = ['a', 'b', 'c'].map(id => ({ id, displayName: id })) as unknown as TripMember[]

function expenseWith(splits: Array<[string, number]>): Expense {
  return {
    currency: 'JPY',
    amountMinor: splits.reduce((s, [, n]) => s + n, 0),
    splits: splits.map(([memberId, amountMinor]) => ({ memberId, amountMinor })),
  } as unknown as Expense
}

describe('useSplitsState edit seeding', () => {
  it('keeps a near-equal custom split as custom (500 / 501)', () => {
    // splitEqually(1001, [a, b]) = [501, 500]; [500, 501] is a deliberate
    // custom split that the ±1 tolerance used to flip to equal (and
    // re-saving moved the extra unit from b to a).
    const { result } = renderHook(() => useSplitsState(expenseWith([['a', 500], ['b', 501]]), members))
    expect(result.current.state.mode).toBe('custom')
    expect(result.current.state.custom).toMatchObject({ a: '500', b: '501' })
  })

  it('recognises a genuine equal split with remainder (334 / 333 / 333)', () => {
    const { result } = renderHook(() => useSplitsState(expenseWith([['a', 334], ['b', 333], ['c', 333]]), members))
    expect(result.current.state.mode).toBe('equal')
    expect([...result.current.state.included]).toEqual(['a', 'b', 'c'])
  })

  it('keeps zero-share members of a tiny equal split included (¥2 over 3)', () => {
    const { result } = renderHook(() => useSplitsState(expenseWith([['a', 1], ['b', 1], ['c', 0]]), members))
    expect(result.current.state.mode).toBe('equal')
    expect([...result.current.state.included]).toEqual(['a', 'b', 'c'])
  })

  it('ignores excluded zero rows when the rest is an equal split', () => {
    const { result } = renderHook(() => useSplitsState(expenseWith([['a', 500], ['b', 500], ['c', 0]]), members))
    expect(result.current.state.mode).toBe('equal')
    expect([...result.current.state.included]).toEqual(['a', 'b'])
  })
})
