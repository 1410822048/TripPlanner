import { QueryClient, QueryClientProvider, hashKey } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import type { CreateScheduleInput, Schedule } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'

vi.mock('@/hooks/useAuth', () => ({ useUid: () => 'uid-1' }))

const serviceMocks = vi.hoisted(() => ({
  getSchedulesByTrip:           vi.fn(),
  getSchedulesByTripFromServer: vi.fn(),
  subscribeToSchedules:         vi.fn(),
  createSchedule:               vi.fn(),
  updateSchedule:               vi.fn(),
  deleteSchedule:               vi.fn(),
}))

vi.mock('../services/scheduleService', async () => {
  const actual = await vi.importActual<typeof import('../services/scheduleService')>(
    '../services/scheduleService',
  )
  return { ...actual, ...serviceMocks }
})

import {
  nextScheduleOrder,
  scheduleOverlay,
  useCreateSchedule,
  useDeleteSchedule,
  useUpdateSchedule,
} from './useSchedules'

const TRIP = 'trip-1'
const KEY_HASH = hashKey(['schedules', TRIP, 'uid-1'])

const input = (over: Partial<CreateScheduleInput> = {}): CreateScheduleInput => ({
  title: 'Museum', date: '2026-09-18', timeMode: 'flexible', durationMinutes: 60,
  category: 'activity',
  ...over,
})

const item = (over: Partial<Schedule> & { id: string }): Schedule => ({
  tripId: TRIP, order: 0, ...input(), routeRevision: null, travelToNext: null,
  createdBy: 'uid-1', updatedBy: 'uid-1', memberIds: ['uid-1'],
  createdAt: MOCK_TIMESTAMP, updatedAt: MOCK_TIMESTAMP,
  ...over,
}) as Schedule

const view = (base: Schedule[]) =>
  scheduleOverlay.merge(base, scheduleOverlay.getSnapshot(KEY_HASH))

function render<T>(hook: () => T) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
  return renderHook(hook, { wrapper })
}

beforeEach(() => {
  scheduleOverlay.__resetForTest()
  vi.clearAllMocks()
  serviceMocks.getSchedulesByTripFromServer.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('nextScheduleOrder', () => {
  it('counts only the same day and starts at 0', () => {
    expect(nextScheduleOrder([], '2026-09-18')).toBe(0)
    expect(nextScheduleOrder([
      item({ id: 'a', date: '2026-09-18', order: 0 }),
      item({ id: 'b', date: '2026-09-19', order: 7 }),
    ], '2026-09-18')).toBe(1)
  })
})

describe('schedule overlay operations', () => {
  it('persists exactly the order the optimistic row shows', async () => {
    serviceMocks.createSchedule.mockResolvedValueOnce('s-1')
    const hook = render(() => useCreateSchedule(TRIP))

    const order = nextScheduleOrder([item({ id: 'a', order: 0 })], '2026-09-18')
    await act(async () => {
      await hook.result.current.mutateAsync({
        scheduleId: 's-1', createdBy: 'uid-1', order, input: input(),
      })
    })

    // The bug this replaced: onMutate ran before mutationFn, so the second
    // computation saw the optimistic row and stored order + 1.
    expect(serviceMocks.createSchedule).toHaveBeenCalledWith(
      TRIP, expect.anything(), 'uid-1', 1, 's-1',
    )
  })

  it('renders one row when the created schedule echoes back mid-flight', async () => {
    serviceMocks.createSchedule.mockReturnValueOnce(new Promise(() => {}))
    const hook = render(() => useCreateSchedule(TRIP))

    await act(async () => {
      hook.result.current.mutate({
        scheduleId: 's-1', createdBy: 'uid-1', order: 0, input: input(),
      })
      await Promise.resolve()
    })

    expect(view([]).map(s => s.id)).toEqual(['s-1'])
    expect(view([item({ id: 's-1' })]).map(s => s.id)).toEqual(['s-1'])
  })

  it('retires an edit once server truth carries it, including the cleared field', async () => {
    serviceMocks.updateSchedule.mockResolvedValueOnce(undefined)
    const hook = render(() => useUpdateSchedule(TRIP))

    await act(async () => {
      await hook.result.current.mutateAsync({
        scheduleId: 'a', uid: 'uid-1',
        updates: { title: 'New title', description: undefined },
      })
    })

    // A cleared optional field is stored as absent, not empty.
    scheduleOverlay.reconcile(KEY_HASH, [item({ id: 'a', title: 'New title' })])
    expect(scheduleOverlay.getSnapshot(KEY_HASH)).toHaveLength(0)
  })

  it('holds a route-invalidating edit until the optimization columns are cleared', async () => {
    serviceMocks.updateSchedule.mockResolvedValueOnce(undefined)
    const hook = render(() => useUpdateSchedule(TRIP))

    await act(async () => {
      await hook.result.current.mutateAsync({
        scheduleId: 'a', uid: 'uid-1', updates: { date: '2026-09-20' },
      })
    })

    // Field matches but the stale route revision is still there.
    scheduleOverlay.reconcile(KEY_HASH, [item({ id: 'a', date: '2026-09-20', routeRevision: 'r1' })])
    expect(scheduleOverlay.getSnapshot(KEY_HASH)).toHaveLength(1)
    expect(view([item({ id: 'a', date: '2026-09-20', routeRevision: 'r1' })])[0]?.routeRevision)
      .toBeNull()

    scheduleOverlay.reconcile(KEY_HASH, [item({ id: 'a', date: '2026-09-20', routeRevision: null })])
    expect(scheduleOverlay.getSnapshot(KEY_HASH)).toHaveLength(0)
  })

  it('does not resurrect a row the server deleted too when our delete fails', async () => {
    serviceMocks.deleteSchedule.mockRejectedValueOnce(
      Object.assign(new Error('403'), { name: 'WorkerRejected' }),
    )
    const hook = render(() => useDeleteSchedule(TRIP))

    await act(async () => {
      await hook.result.current.mutateAsync('a').catch(() => {})
    })

    expect(scheduleOverlay.getSnapshot(KEY_HASH)).toHaveLength(0)
    expect(view([item({ id: 'b' })]).map(s => s.id)).toEqual(['b'])
  })
})
