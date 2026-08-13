import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { Timestamp } from 'firebase/firestore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trip } from '@/types'
import { tripKeys } from '@/features/trips/queryKeys'

const mocks = vi.hoisted(() => ({
  useUid: vi.fn(),
  useTripStore: vi.fn(),
  getBookingsByTrip: vi.fn(),
  captureError: vi.fn(),
}))

vi.mock('@/hooks/useAuth', () => ({ useUid: mocks.useUid }))
vi.mock('@/store/tripStore', () => ({ useTripStore: mocks.useTripStore }))
vi.mock('../services/bookingService', () => ({
  getBookingsByTrip: mocks.getBookingsByTrip,
}))
vi.mock('./useBookings', () => ({
  bookingKeys: {
    all: (tripId: string, uid?: string) => ['bookings', tripId, uid ?? ''] as const,
  },
}))
vi.mock('@/services/sentry', () => ({ captureError: mocks.captureError }))

import { usePrefetchBookings } from './usePrefetchBookings'

function trip(id: string): Trip {
  const timestamp = Timestamp.fromMillis(1)
  return {
    id,
    title: id,
    destination: 'Taipei',
    startDate: timestamp,
    endDate: timestamp,
    currency: 'TWD',
    defaultCountryCode: 'TW',
    ownerId: 'user-1',
    formerMemberNames: {},
    memberIds: ['user-1'],
    wishVotingDeadlineAt: null,
    wishVotingDeadlineNotifiedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function wrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.useUid.mockReturnValue('user-1')
  mocks.useTripStore.mockImplementation(
    (selector: (state: { selectedTripId: string | null }) => string | null) =>
      selector({ selectedTripId: 'trip-a' }),
  )
  mocks.getBookingsByTrip.mockResolvedValue([])
  Object.defineProperty(navigator, 'connection', {
    configurable: true,
    value: undefined,
  })
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePrefetchBookings', () => {
  it('waits until after the LCP grace period before warming an authorised trip', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(tripKeys.mine('user-1'), [trip('trip-a')])
    renderHook(() => usePrefetchBookings(), { wrapper: wrapper(queryClient) })

    await act(async () => { await vi.advanceTimersByTimeAsync(1499) })
    expect(mocks.getBookingsByTrip).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    await vi.waitFor(() => expect(mocks.getBookingsByTrip).toHaveBeenCalledWith('trip-a', 'user-1'))
  })

  it('waits for late membership reconciliation without trusting the persisted trip id', async () => {
    const queryClient = new QueryClient()
    renderHook(() => usePrefetchBookings(), { wrapper: wrapper(queryClient) })

    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(mocks.getBookingsByTrip).not.toHaveBeenCalled()

    await act(async () => {
      queryClient.setQueryData(tripKeys.mine('user-1'), [trip('trip-a')])
      await vi.advanceTimersByTimeAsync(0)
    })
    await vi.waitFor(() => expect(mocks.getBookingsByTrip).toHaveBeenCalledWith('trip-a', 'user-1'))
  })

  it('skips background reads when the user enabled data saver', async () => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { saveData: true, effectiveType: '4g' },
    })
    const queryClient = new QueryClient()
    queryClient.setQueryData(tripKeys.mine('user-1'), [trip('trip-a')])
    renderHook(() => usePrefetchBookings(), { wrapper: wrapper(queryClient) })

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(mocks.getBookingsByTrip).not.toHaveBeenCalled()
  })

  it('waits while hidden and resumes after the page becomes visible', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(tripKeys.mine('user-1'), [trip('trip-a')])
    renderHook(() => usePrefetchBookings(), { wrapper: wrapper(queryClient) })

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })

    expect(mocks.getBookingsByTrip).not.toHaveBeenCalled()

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await vi.waitFor(() => expect(mocks.getBookingsByTrip).toHaveBeenCalledWith('trip-a', 'user-1'))
  })

  it('cancels the delayed work when the layout unmounts', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(tripKeys.mine('user-1'), [trip('trip-a')])
    const { unmount } = renderHook(() => usePrefetchBookings(), { wrapper: wrapper(queryClient) })

    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(mocks.getBookingsByTrip).not.toHaveBeenCalled()
  })
})
