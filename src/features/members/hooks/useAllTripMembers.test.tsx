import { createElement, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Member } from '@/types'
import type { ListSnapshotMetadata } from '@/services/realtimeQuery'

type Subscribe = (
  tripId: string, uid: string,
  onData: (rows: Member[], metadata?: ListSnapshotMetadata) => void,
  onError: (error: Error) => void,
) => Promise<() => void>
const mocks = vi.hoisted(() => ({ read: vi.fn<() => Promise<Member[]>>(), subscribe: vi.fn<Subscribe>() }))
vi.mock('@/hooks/useAuth', () => ({ useUid: () => 'u' }))
vi.mock('@/services/sentry', () => ({ captureError: vi.fn() }))
vi.mock('@/features/trips/hooks/useTrips', () => ({ useMyTrips: () => ({ data: [{ id: 't' }], isPending: false }) }))
vi.mock('../services/memberService', () => ({ getMembersByTrip: mocks.read, subscribeToMembers: mocks.subscribe }))
import { useAllTripMembers } from './useAllTripMembers'
import { useMembers } from './useMembers'

const rows = (...ids: string[]) => ids.map(id => ({ id }) as Member)
const key = ['members', 't', 'u']
const confirmed = { fromCache: false, hasPendingWrites: false }
let qc: QueryClient
let callbacks: Array<{ push: Parameters<Subscribe>[2]; fail: Parameters<Subscribe>[3]; unsub: ReturnType<typeof vi.fn> }>

beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue(rows('a'))
  mocks.subscribe.mockReset()
  callbacks = []
  mocks.subscribe.mockImplementation(async (_trip, _uid, push, fail) => {
    const unsub = vi.fn()
    callbacks.push({ push, fail, unsub })
    return unsub
  })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => qc.clear())

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children)
}

function useFanoutView() {
  const fanout = useAllTripMembers('u')
  // 與真正頁面相同，在 render 讀取 data，讓 Query 追蹤顯示用欄位。
  return { ...fanout, rows: fanout.memberResults[0]?.data }
}

describe('fanout shared-listener recovery', () => {
  it('restores realtime delivery after a failed listener and rejects callbacks from the old generation', async () => {
    const view = renderHook(useFanoutView, { wrapper })
    await waitFor(() => expect(view.result.current.memberResults[0]?.data).toHaveLength(1))
    await waitFor(() => expect(callbacks).toHaveLength(1))
    const old = callbacks[0]!
    act(() => old.fail(new Error('member schema invalid')))
    await waitFor(() => expect(qc.getQueryState(key)?.status).toBe('error'))
    expect(old.unsub).toHaveBeenCalledOnce()
    mocks.read.mockResolvedValue(rows('a', 'b'))
    await act(async () => { await view.result.current.memberResults[0]!.refetch() })
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(view.result.current.memberResults[0]?.data).toHaveLength(2))
    act(() => {
      old.push(rows('stale'), confirmed)
      old.fail(new Error('late error'))
    })
    expect(qc.getQueryData<Member[]>(key)?.map(member => member.id)).toEqual(['a', 'b'])
    expect(qc.getQueryState(key)?.status).toBe('success')
    act(() => callbacks[1]!.push(rows('a', 'b', 'c'), confirmed))
    await waitFor(() => expect(view.result.current.memberResults[0]?.data).toHaveLength(3))
    expect(view.result.current.memberResults[0]?.dataUpdatedAt).toBeGreaterThan(0)
    view.unmount()
    await act(async () => {})
    expect(callbacks[1]!.unsub).toHaveBeenCalledOnce()
    act(() => callbacks[1]!.push(rows('after-unmount'), confirmed))
    expect(qc.getQueryData<Member[]>(key)).toHaveLength(3)
  })

  it('retries subscription initialization failure on refetch', async () => {
    mocks.subscribe.mockRejectedValueOnce(new Error('SDK init failed'))
    const view = renderHook(useFanoutView, { wrapper })
    await waitFor(() => expect(qc.getQueryState(key)?.status).toBe('error'))
    await act(async () => { await view.result.current.memberResults[0]!.refetch() })
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2))
    act(() => callbacks[0]!.push(rows('recovered'), confirmed))
    await waitFor(() => expect(view.result.current.memberResults[0]?.data?.[0]?.id).toBe('recovered'))
    view.unmount()
  })

  it('does not duplicate a healthy listener on refetch', async () => {
    const view = renderHook(useFanoutView, { wrapper })
    await waitFor(() => expect(callbacks).toHaveLength(1))
    await act(async () => { await view.result.current.memberResults[0]!.refetch() })
    expect(mocks.subscribe).toHaveBeenCalledOnce()
    expect(callbacks[0]!.unsub).not.toHaveBeenCalled()
    view.unmount()
  })

  it('restarts only once for concurrent refetches from fanout and single-trip consumers', async () => {
    const view = renderHook(() => ({ fanout: useAllTripMembers('u'), list: useMembers('t') }), { wrapper })
    await waitFor(() => expect(callbacks).toHaveLength(1))
    await waitFor(() => expect(view.result.current.list.data).toHaveLength(1))
    act(() => callbacks[0]!.fail(new Error('listener failed')))
    await waitFor(() => expect(qc.getQueryState(key)?.status).toBe('error'))
    await act(async () => { await Promise.all([
      view.result.current.fanout.memberResults[0]!.refetch(), view.result.current.list.refetch(),
    ]) })
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2))
    act(() => callbacks[1]!.push(rows('updated'), confirmed))
    await waitFor(() => expect(view.result.current.list.data?.[0]?.id).toBe('updated'))
    expect(view.result.current.fanout.memberResults[0]?.data?.[0]?.id).toBe('updated')
    view.unmount()
  })
})
