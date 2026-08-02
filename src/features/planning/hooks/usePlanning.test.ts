import { QueryClient, QueryClientProvider, hashKey } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import type { PlanItem } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'

vi.mock('@/hooks/useAuth', () => ({ useUid: () => 'uid-1' }))

const serviceMocks = vi.hoisted(() => ({
  getPlanItemsByTrip:           vi.fn(),
  getPlanItemsByTripFromServer: vi.fn(),
  subscribeToPlanItems:         vi.fn(),
  createPlanItem:               vi.fn(),
  updatePlanItem:               vi.fn(),
  togglePlanItemDone:           vi.fn(),
  deletePlanItem:               vi.fn(),
}))

vi.mock('../services/planningService', () => serviceMocks)

import {
  planningOverlay,
  useCreatePlanItem,
  useDeletePlanItem,
  useTogglePlanItem,
  useUpdatePlanItem,
} from './usePlanning'

const TRIP = 'trip-1'
const KEY_HASH = hashKey(['planning', TRIP, 'uid-1'])

const item = (over: Partial<PlanItem> & { id: string }): PlanItem => ({
  tripId: TRIP, category: 'todo', title: 'x', completedBy: {},
  createdBy: 'uid-1', updatedBy: 'uid-1', memberIds: ['uid-1'],
  createdAt: MOCK_TIMESTAMP, updatedAt: MOCK_TIMESTAMP,
  ...over,
}) as PlanItem

/** What the list would render for this server truth. */
const view = (base: PlanItem[]) =>
  planningOverlay.merge(base, planningOverlay.getSnapshot(KEY_HASH))

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function render<T>(hook: () => T) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return renderHook(hook, { wrapper: wrapper(qc) })
}

beforeEach(() => {
  planningOverlay.__resetForTest()
  vi.clearAllMocks()
  serviceMocks.getPlanItemsByTripFromServer.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('planning overlay operations', () => {
  it('does not mask a co-member completion that lands while our toggle is in flight', async () => {
    serviceMocks.togglePlanItemDone.mockReturnValueOnce(new Promise(() => {}))
    const hook = render(() => useTogglePlanItem(TRIP))

    await act(async () => {
      hook.result.current.mutate({ itemId: 'a', uid: 'uid-1', done: true })
      await Promise.resolve()
    })

    // Server truth now carries uid-2's completion but not ours yet. A
    // snapshot-style patch would have replaced the whole map and dropped
    // uid-2; the reducer merges into whatever base arrived.
    const merged = view([item({ id: 'a', completedBy: { 'uid-2': MOCK_TIMESTAMP } })])

    expect(Object.keys(merged[0]!.completedBy).sort()).toEqual(['uid-1', 'uid-2'])
  })

  it('retires the toggle once server truth carries our own completion', async () => {
    serviceMocks.togglePlanItemDone.mockResolvedValueOnce(undefined)
    const hook = render(() => useTogglePlanItem(TRIP))

    await act(async () => {
      await hook.result.current.mutateAsync({ itemId: 'a', uid: 'uid-1', done: true })
    })

    const confirmed = [item({ id: 'a', completedBy: { 'uid-1': MOCK_TIMESTAMP } })]
    planningOverlay.reconcile(KEY_HASH, confirmed)

    expect(planningOverlay.getSnapshot(KEY_HASH)).toHaveLength(0)
  })

  it('renders one row when the created item echoes back before the write resolves', async () => {
    serviceMocks.createPlanItem.mockReturnValueOnce(new Promise(() => {}))
    const hook = render(() => useCreatePlanItem(TRIP))

    await act(async () => {
      hook.result.current.mutate({
        itemId: 'new-1', createdBy: 'uid-1',
        input: { category: 'todo', title: 'Buy adapters' },
      })
      await Promise.resolve()
    })

    expect(view([]).map(p => p.id)).toEqual(['new-1'])
    // Local echo arrives while the mutation is still pending.
    expect(view([item({ id: 'new-1', title: 'Buy adapters' })]).map(p => p.id)).toEqual(['new-1'])
  })

  it('drops only the failed edit when two edits to one row are in flight', async () => {
    serviceMocks.updatePlanItem
      .mockRejectedValueOnce(Object.assign(new Error('403'), { name: 'WorkerRejected' }))
      .mockReturnValueOnce(new Promise(() => {}))
    const hook = render(() => useUpdatePlanItem(TRIP))

    await act(async () => {
      hook.result.current.mutate({ itemId: 'a', updates: { title: 'from A' }, uid: 'uid-1' })
      await Promise.resolve()
    })
    await act(async () => {
      hook.result.current.mutate({ itemId: 'a', updates: { category: 'packing' }, uid: 'uid-1' })
      await Promise.resolve()
    })

    const merged = view([item({ id: 'a', title: 'server', category: 'todo' })])
    expect(merged[0]).toMatchObject({ title: 'server', category: 'packing' })
  })

  it('confirms a cleared note even though the server stores the field as absent', async () => {
    serviceMocks.updatePlanItem.mockResolvedValueOnce(undefined)
    const hook = render(() => useUpdatePlanItem(TRIP))

    await act(async () => {
      await hook.result.current.mutateAsync({ itemId: 'a', updates: { note: '' }, uid: 'uid-1' })
    })

    // `updatePlanItem` turns a cleared note into deleteField(), so truth
    // comes back with no `note` key at all.
    planningOverlay.reconcile(KEY_HASH, [item({ id: 'a' })])

    expect(planningOverlay.getSnapshot(KEY_HASH)).toHaveLength(0)
  })

  it('does not resurrect a row the server deleted too when our delete fails', async () => {
    serviceMocks.deletePlanItem.mockRejectedValueOnce(
      Object.assign(new Error('403'), { name: 'WorkerRejected' }),
    )
    const hook = render(() => useDeletePlanItem(TRIP))

    await act(async () => {
      await hook.result.current.mutateAsync('a').catch(() => {})
    })

    // The op is gone, and nothing re-inserts a row server truth lacks.
    expect(planningOverlay.getSnapshot(KEY_HASH)).toHaveLength(0)
    expect(view([item({ id: 'b' })]).map(p => p.id)).toEqual(['b'])
  })
})
