import { QueryClient } from '@tanstack/react-query'
import { Timestamp } from 'firebase/firestore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trip } from '@/types'
import { tripKeys } from '../queryKeys'

const mocks = vi.hoisted(() => ({
  subscribeToTrip: vi.fn(),
  captureError: vi.fn(),
  markPerf: vi.fn(),
}))

vi.mock('../services/tripService', () => ({
  subscribeToTrip: mocks.subscribeToTrip,
}))

vi.mock('@/services/sentry', () => ({
  captureError: mocks.captureError,
}))

vi.mock('@/utils/perf', () => ({
  markPerf: mocks.markPerf,
}))

import { acquireSharedTripSubscription, syncSharedTripIds } from './sharedTripSubscriptions'

interface Channel {
  onData: (trip: Trip | null) => void
  onError: (error: Error) => void
  unsubscribe: ReturnType<typeof vi.fn>
}

const channels = new Map<string, Channel>()

function trip(id: string, createdAt: number): Trip {
  const timestamp = Timestamp.fromMillis(createdAt)
  return {
    id,
    title: id,
    destination: 'Taipei',
    startDate: timestamp,
    endDate: timestamp,
    currency: 'TWD',
    defaultCountryCode: 'TW',
    ownerId: 'owner',
    formerMemberNames: {},
    memberIds: ['owner'],
    wishVotingDeadlineAt: null,
    wishVotingDeadlineNotifiedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  channels.clear()
  vi.clearAllMocks()
  mocks.subscribeToTrip.mockImplementation(
    async (
      id: string,
      onData: (value: Trip | null) => void,
      onError: (error: Error) => void,
    ) => {
      const unsubscribe = vi.fn()
      channels.set(id, { onData, onError, unsubscribe })
      return unsubscribe
    },
  )
})

afterEach(async () => {
  await flushMicrotasks()
})

describe('shared trip subscriptions', () => {
  it('opens one listener per trip for multiple consumers and publishes once', async () => {
    const queryClient = new QueryClient()
    const releaseA = acquireSharedTripSubscription(queryClient, 'user-1')
    const releaseB = acquireSharedTripSubscription(queryClient, 'user-1')

    syncSharedTripIds(queryClient, 'user-1', ['trip-a', 'trip-b'])
    syncSharedTripIds(queryClient, 'user-1', ['trip-a', 'trip-b'])

    expect(mocks.subscribeToTrip).toHaveBeenCalledTimes(2)
    channels.get('trip-a')!.onData(trip('trip-a', 1))
    channels.get('trip-b')!.onData(trip('trip-b', 2))

    expect(queryClient.getQueryData<Trip[]>(tripKeys.mine('user-1'))?.map(value => value.id))
      .toEqual(['trip-b', 'trip-a'])
    expect(mocks.markPerf).toHaveBeenCalledTimes(1)

    await flushMicrotasks()
    releaseA()
    await flushMicrotasks()
    expect(channels.get('trip-a')!.unsubscribe).not.toHaveBeenCalled()

    releaseB()
    await flushMicrotasks()
    expect(channels.get('trip-a')!.unsubscribe).toHaveBeenCalledOnce()
    expect(channels.get('trip-b')!.unsubscribe).toHaveBeenCalledOnce()
  })

  it('removes departed ids immediately without reopening unchanged listeners', async () => {
    const queryClient = new QueryClient()
    const release = acquireSharedTripSubscription(queryClient, 'user-1')
    syncSharedTripIds(queryClient, 'user-1', ['trip-a', 'trip-b'])
    await flushMicrotasks()

    channels.get('trip-a')!.onData(trip('trip-a', 1))
    channels.get('trip-b')!.onData(trip('trip-b', 2))
    syncSharedTripIds(queryClient, 'user-1', ['trip-b', 'trip-c'])

    expect(channels.get('trip-a')!.unsubscribe).toHaveBeenCalledOnce()
    expect(mocks.subscribeToTrip).toHaveBeenCalledTimes(3)
    expect(queryClient.getQueryData<Trip[]>(tripKeys.mine('user-1'))?.map(value => value.id))
      .toEqual(['trip-b'])

    release()
  })

  it('does not collapse a complete one-shot cache while first snapshots arrive', () => {
    const queryClient = new QueryClient()
    const cachedA = trip('trip-a', 1)
    const cachedB = trip('trip-b', 2)
    queryClient.setQueryData(tripKeys.mine('user-1'), [cachedB, cachedA])
    const release = acquireSharedTripSubscription(queryClient, 'user-1')
    syncSharedTripIds(queryClient, 'user-1', ['trip-a', 'trip-b'])

    const updatedA = trip('trip-a', 3)
    channels.get('trip-a')!.onData(updatedA)

    expect(queryClient.getQueryData<Trip[]>(tripKeys.mine('user-1'))?.map(value => value.id))
      .toEqual(['trip-a', 'trip-b'])
    release()
  })

  it('reuses the pending controller across a StrictMode release and reacquire', async () => {
    const queryClient = new QueryClient()
    const releaseFirst = acquireSharedTripSubscription(queryClient, 'user-1')
    syncSharedTripIds(queryClient, 'user-1', ['trip-a'])

    releaseFirst()
    const releaseSecond = acquireSharedTripSubscription(queryClient, 'user-1')
    await flushMicrotasks()

    expect(mocks.subscribeToTrip).toHaveBeenCalledOnce()
    expect(channels.get('trip-a')!.unsubscribe).not.toHaveBeenCalled()
    releaseSecond()
  })

  it('closes an asynchronously-created listener after the final release', async () => {
    const queryClient = new QueryClient()
    const unsubscribe = vi.fn()
    let resolveSubscription: ((unsubscribe: () => void) => void) | undefined
    mocks.subscribeToTrip.mockReturnValueOnce(new Promise(resolve => {
      resolveSubscription = resolve
    }))

    const release = acquireSharedTripSubscription(queryClient, 'user-1')
    syncSharedTripIds(queryClient, 'user-1', ['trip-a'])
    release()
    await flushMicrotasks()

    resolveSubscription!(unsubscribe)
    await flushMicrotasks()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps QueryClient instances isolated even with the same uid', () => {
    const firstClient = new QueryClient()
    const secondClient = new QueryClient()
    const releaseFirst = acquireSharedTripSubscription(firstClient, 'user-1')
    const releaseSecond = acquireSharedTripSubscription(secondClient, 'user-1')

    syncSharedTripIds(firstClient, 'user-1', ['trip-a'])
    syncSharedTripIds(secondClient, 'user-1', ['trip-a'])

    expect(mocks.subscribeToTrip).toHaveBeenCalledTimes(2)
    releaseFirst()
    releaseSecond()
  })
})
