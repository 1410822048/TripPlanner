// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, hashKey, onlineManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import type { Wish } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'

vi.mock('@/hooks/useAuth', () => ({ useUid: () => 'uid-1' }))

const serviceMocks = vi.hoisted(() => ({
  getWishesByTrip:           vi.fn(),
  getWishesByTripFromServer: vi.fn(),
  subscribeToWishes:         vi.fn(),
  createWish:                vi.fn(),
  updateWish:                vi.fn(),
  deleteWish:                vi.fn(),
  toggleWishVote:            vi.fn(),
}))

vi.mock('../services/wishService', async () => {
  const actual = await vi.importActual<typeof import('../services/wishService')>(
    '../services/wishService',
  )
  return { ...actual, ...serviceMocks }
})

import {
  wishOverlay,
  useCreateWish,
  useDeleteWish,
  useToggleWishVote,
  useUpdateWish,
} from './useWishes'

const TRIP = 'trip-1'
const KEY_HASH = hashKey(['wishes', TRIP, 'uid-1'])

const wish = (over: Partial<Wish> & { id: string }): Wish => ({
  tripId: TRIP, category: 'place', title: 'w', votes: [], proposedBy: 'uid-9',
  memberIds: ['uid-1'], createdBy: 'uid-9', updatedBy: 'uid-9',
  createdAt: MOCK_TIMESTAMP, updatedAt: MOCK_TIMESTAMP,
  ...over,
}) as Wish

const view = (base: Wish[]) => wishOverlay.merge(base, wishOverlay.getSnapshot(KEY_HASH))

function render<T>(hook: () => T) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
  return renderHook(hook, { wrapper })
}

beforeEach(() => {
  wishOverlay.__resetForTest()
  vi.clearAllMocks()
  serviceMocks.getWishesByTripFromServer.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('wish overlay operations', () => {
  it('does not drop a co-member vote that lands while ours is in flight', async () => {
    serviceMocks.toggleWishVote.mockReturnValueOnce(new Promise(() => {}))
    const hook = render(() => useToggleWishVote(TRIP))

    await act(async () => {
      hook.result.current.mutate({ wishId: 'w1', uid: 'uid-1', isVoting: true })
      await Promise.resolve()
    })

    // Server truth now carries uid-2's vote but not ours. The service uses
    // arrayUnion for this reason; the overlay has to match it.
    const merged = view([wish({ id: 'w1', votes: ['uid-2'] })])

    expect([...merged[0]!.votes].sort()).toEqual(['uid-1', 'uid-2'])
  })

  it('removes only our own vote when un-voting', async () => {
    serviceMocks.toggleWishVote.mockReturnValueOnce(new Promise(() => {}))
    const hook = render(() => useToggleWishVote(TRIP))

    await act(async () => {
      hook.result.current.mutate({ wishId: 'w1', uid: 'uid-1', isVoting: false })
      await Promise.resolve()
    })

    expect(view([wish({ id: 'w1', votes: ['uid-1', 'uid-2'] })])[0]!.votes).toEqual(['uid-2'])
  })

  it('retires the vote once server truth carries it', async () => {
    serviceMocks.toggleWishVote.mockResolvedValueOnce(undefined)
    const hook = render(() => useToggleWishVote(TRIP))

    await act(async () => {
      await hook.result.current.mutateAsync({ wishId: 'w1', uid: 'uid-1', isVoting: true })
    })

    wishOverlay.reconcile(KEY_HASH, [wish({ id: 'w1', votes: ['uid-1'] })])
    expect(wishOverlay.getSnapshot(KEY_HASH)).toHaveLength(0)
  })

  it('renders one card when the created wish echoes back mid-flight', async () => {
    serviceMocks.createWish.mockReturnValueOnce(new Promise(() => {}))
    const hook = render(() => useCreateWish(TRIP))

    await act(async () => {
      hook.result.current.mutate({
        wishId: 'w-new', file: null, proposedBy: 'uid-1',
        input: { category: 'place', title: 'Ghibli Museum' },
      })
      await Promise.resolve()
    })

    expect(view([]).map(w => w.id)).toEqual(['w-new'])
    expect(view([wish({ id: 'w-new' })]).map(w => w.id)).toEqual(['w-new'])
  })

  it('confirms a cleared link even though the server stores it as absent', async () => {
    serviceMocks.updateWish.mockResolvedValueOnce(undefined)
    const hook = render(() => useUpdateWish(TRIP))

    await act(async () => {
      await hook.result.current.mutateAsync({
        wishId: 'w1', uid: 'uid-1', attachment: undefined, existingImage: undefined,
        updates: { title: 'New', link: '' },
      })
    })

    wishOverlay.reconcile(KEY_HASH, [wish({ id: 'w1', title: 'New' })])
    expect(wishOverlay.getSnapshot(KEY_HASH)).toHaveLength(0)
  })

  it('does not resurrect a wish the server deleted too when our delete fails', async () => {
    serviceMocks.deleteWish.mockRejectedValueOnce(
      Object.assign(new Error('403'), { name: 'WorkerRejected' }),
    )
    const hook = render(() => useDeleteWish(TRIP))

    await act(async () => {
      await hook.result.current.mutateAsync({ wishId: 'w1' }).catch(() => {})
    })

    expect(wishOverlay.getSnapshot(KEY_HASH)).toHaveLength(0)
    expect(view([wish({ id: 'w2' })]).map(w => w.id)).toEqual(['w2'])
  })
})

describe('wish write paths offline', () => {
  afterEach(() => { onlineManager.setOnline(true) })
  const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'cover.png', { type: 'image/png' })

  it('text-only create runs offline (client SDK queue), image create waits for the network (Worker)', async () => {
    serviceMocks.createWish.mockResolvedValue('w-x')
    const hook = render(() => useCreateWish(TRIP))
    onlineManager.setOnline(false)

    await act(async () => {
      await hook.result.current.mutateAsync({
        wishId: 'w-text', file: null, proposedBy: 'uid-1', input: { category: 'place', title: 'text' },
      })
    })
    expect(serviceMocks.createWish).toHaveBeenCalledTimes(1)

    await act(async () => {
      hook.result.current.mutate({
        wishId: 'w-img', file: png(), proposedBy: 'uid-1', input: { category: 'place', title: 'img' },
      })
    })
    await waitFor(() => expect(hook.result.current.isPending).toBe(true))
    expect(serviceMocks.createWish).toHaveBeenCalledTimes(1)   // the Worker path is paused, not run
    // Both paths share the overlay: the paused image create still shows its row.
    expect(view([]).map(w => w.id).sort()).toEqual(['w-img', 'w-text'])
  })

  it('text / detach update runs offline, image replace waits for the network', async () => {
    serviceMocks.updateWish.mockResolvedValue(undefined)
    const hook = render(() => useUpdateWish(TRIP))
    onlineManager.setOnline(false)

    await act(async () => {
      await hook.result.current.mutateAsync({
        wishId: 'w1', uid: 'uid-1', attachment: undefined, existingImage: undefined, updates: { title: 'T' },
      })
      await hook.result.current.mutateAsync({
        wishId: 'w1', uid: 'uid-1', attachment: null, existingImage: undefined, updates: { title: 'T2' },
      })
    })
    expect(serviceMocks.updateWish).toHaveBeenCalledTimes(2)

    await act(async () => {
      hook.result.current.mutate({
        wishId: 'w1', uid: 'uid-1', attachment: png(), existingImage: undefined, updates: { title: 'T3' },
      })
    })
    await waitFor(() => expect(hook.result.current.isPending).toBe(true))
    expect(serviceMocks.updateWish).toHaveBeenCalledTimes(2)
  })
})
