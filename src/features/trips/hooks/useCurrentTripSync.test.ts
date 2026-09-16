import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  uid: 'u1' as string | undefined,
  trips: [{ id: 'remaining' }] as { id: string }[] | undefined,
  state: {
    selectedTripId: 'removed' as string | null,
    selectedTripAt: 0,
    recentTripIds: ['remaining'],
    setSelectedTripId: vi.fn(),
  },
}))
vi.mock('@/hooks/useAuth', () => ({ useUid: () => mocks.uid }))
vi.mock('@/store/tripStore', () => ({ useTripStore: () => mocks.state }))
vi.mock('./useTrips', () => ({ useMyTrips: () => ({ data: mocks.trips }) }))
import { useCurrentTripSync } from './useCurrentTripSync'

beforeEach(() => {
  vi.useFakeTimers()
  mocks.uid = 'u1'
  mocks.trips = [{ id: 'remaining' }]
  mocks.state.selectedTripId = 'removed'
  mocks.state.selectedTripAt = Date.now()
  mocks.state.setSelectedTripId.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('selection grace expiry', () => {
  it('falls back at expiry even without another snapshot', () => {
    const view = renderHook(() => useCurrentTripSync())
    act(() => vi.advanceTimersByTime(2999))
    expect(mocks.state.setSelectedTripId).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(mocks.state.setSelectedTripId).toHaveBeenCalledExactlyOnceWith('remaining')
    view.unmount()
  })

  it('clears an empty list only after grace expires', () => {
    mocks.trips = []
    const view = renderHook(() => useCurrentTripSync())
    expect(mocks.state.setSelectedTripId).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(3000))
    expect(mocks.state.setSelectedTripId).toHaveBeenCalledWith(null)
    view.unmount()
  })

  it('cancels fallback when the joined trip arrives', () => {
    const view = renderHook(() => useCurrentTripSync())
    act(() => vi.advanceTimersByTime(1000))
    mocks.trips = [{ id: 'removed' }, { id: 'remaining' }]
    view.rerender()
    act(() => vi.advanceTimersByTime(3000))
    expect(mocks.state.setSelectedTripId).not.toHaveBeenCalled()
    view.unmount()
  })

  it('uses the latest list and the original deadline when snapshots change', () => {
    const view = renderHook(() => useCurrentTripSync())
    act(() => vi.advanceTimersByTime(1000))
    mocks.trips = [{ id: 'new-fallback' }]
    view.rerender()
    act(() => vi.advanceTimersByTime(2000))
    expect(mocks.state.setSelectedTripId).toHaveBeenCalledExactlyOnceWith('new-fallback')
    view.unmount()
  })

  it.each(['selection', 'sign-out', 'unmount'])('cancels stale timer after %s', change => {
    const view = renderHook(() => useCurrentTripSync())
    if (change === 'selection') mocks.state.selectedTripId = 'remaining'
    if (change === 'sign-out') mocks.uid = undefined
    if (change === 'unmount') view.unmount()
    else view.rerender()
    act(() => vi.advanceTimersByTime(3100))
    expect(mocks.state.setSelectedTripId).not.toHaveBeenCalled()
    if (change !== 'unmount') view.unmount()
  })

  it('immediately reconciles a stale persisted selection', () => {
    mocks.state.selectedTripAt = Date.now() - 4000
    const view = renderHook(() => useCurrentTripSync())
    expect(mocks.state.setSelectedTripId).toHaveBeenCalledExactlyOnceWith('remaining')
    view.unmount()
  })
})
