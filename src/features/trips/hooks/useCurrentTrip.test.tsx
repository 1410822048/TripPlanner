import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { Timestamp } from 'firebase/firestore'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trip } from '@/types'

const mocks = vi.hoisted(() => ({
  useUid: vi.fn(),
  useMyTrips: vi.fn(),
  useTripStore: vi.fn(),
  getTripByIdFromServer: vi.fn(),
}))

vi.mock('@/hooks/useAuth', () => ({ useUid: mocks.useUid }))
vi.mock('./useTrips', () => ({ useMyTrips: mocks.useMyTrips }))
vi.mock('@/store/tripStore', () => ({ useTripStore: mocks.useTripStore }))
vi.mock('../services/tripService', () => ({
  getTripByIdFromServer: mocks.getTripByIdFromServer,
}))

import { useCurrentTrip } from './useCurrentTrip'

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
    memberIds: ['user-1'],
    wishVotingDeadlineAt: null,
    wishVotingDeadlineNotifiedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useUid.mockReturnValue('user-1')
  mocks.useTripStore.mockImplementation(
    (selector: (state: { selectedTripId: string | null }) => string | null) =>
      selector({ selectedTripId: 'trip-a' }),
  )
  mocks.useMyTrips.mockReturnValue({ data: undefined })
  mocks.getTripByIdFromServer.mockResolvedValue(trip('trip-a'))
})

describe('useCurrentTrip server-only fast path', () => {
  it('renders the persisted trip before the full membership list resolves', async () => {
    const { result } = renderHook(() => useCurrentTrip(), { wrapper: wrapper() })

    await waitFor(() => expect(result.current?.id).toBe('trip-a'))
    expect(mocks.getTripByIdFromServer).toHaveBeenCalledWith('trip-a')
  })

  it('keeps the membership-derived list authoritative once available', () => {
    const authoritative = trip('trip-a')
    authoritative.title = 'authoritative'
    mocks.useMyTrips.mockReturnValue({ data: [authoritative] })

    const { result } = renderHook(() => useCurrentTrip(), { wrapper: wrapper() })

    expect(result.current?.title).toBe('authoritative')
    expect(mocks.getTripByIdFromServer).not.toHaveBeenCalled()
  })

  it('does not direct-read a persisted id rejected by the membership list', () => {
    mocks.useMyTrips.mockReturnValue({ data: [] })

    const { result } = renderHook(() => useCurrentTrip(), { wrapper: wrapper() })

    expect(result.current).toBeNull()
    expect(mocks.getTripByIdFromServer).not.toHaveBeenCalled()
  })

  it('fails closed when the server denies the fast-path read', async () => {
    mocks.getTripByIdFromServer.mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'permission-denied' }),
    )

    const { result } = renderHook(() => useCurrentTrip(), { wrapper: wrapper() })

    await waitFor(() => expect(mocks.getTripByIdFromServer).toHaveBeenCalledOnce())
    expect(result.current).toBeNull()
  })
})
