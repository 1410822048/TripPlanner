// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const harness = vi.hoisted(() => ({
  trips: { data: undefined as unknown[] | undefined, isPending: false, error: null as Error | null, refetch: vi.fn() },
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ state: { status: 'signed-in', user: { uid: 'u1' } } }),
}))
vi.mock('@/features/trips/hooks/useTrips', () => ({ useMyTrips: () => harness.trips }))
vi.mock('@/features/trips/hooks/useCurrentTrip', () => ({ useCurrentTrip: () => null }))
vi.mock('@/store/demoTripStore', () => ({ useSelectedDemoTrip: () => ({ id: 'demo' }) }))

import { useTripContext } from './useTripContext'

beforeEach(() => {
  harness.trips = { data: undefined, isPending: false, error: null, refetch: vi.fn() }
})

describe('useTripContext', () => {
  it('reports a failed trips read as a retryable error, not "no trips"', () => {
    harness.trips.error = new Error('permission-denied')
    const { result } = renderHook(() => useTripContext())
    expect(result.current).toMatchObject({ status: 'error', message: 'permission-denied' })

    if (result.current.status !== 'error') throw new Error('narrow')
    result.current.retry()
    expect(harness.trips.refetch).toHaveBeenCalledTimes(1)
  })

  it('still reports no-trip when the read succeeded empty', () => {
    harness.trips.data = []
    const { result } = renderHook(() => useTripContext())
    expect(result.current).toEqual({ status: 'no-trip' })
  })
})
