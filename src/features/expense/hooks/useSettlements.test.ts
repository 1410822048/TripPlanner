import { QueryClient, QueryClientProvider, hashKey } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import type { SettlementRecord } from '@/types/settlement'

vi.mock('@/hooks/useAuth', () => ({ useUid: () => 'uid-1' }))

const serviceMocks = vi.hoisted(() => ({
  getSettlementsByTrip:           vi.fn(),
  getSettlementsByTripFromServer: vi.fn(),
  subscribeToSettlements:         vi.fn(),
  createSettlement:               vi.fn(),
  deleteSettlement:               vi.fn(),
}))

vi.mock('../services/settlementService', () => ({
  ...serviceMocks,
  settlementKeys: {
    all: (tripId: string, uid?: string) => ['settlements', tripId, uid ?? ''] as const,
  },
}))

import {
  SETTLEMENT_DELETE_RETRY_DELAY_MS,
  settlementOverlay,
  useDeleteSettlement,
  useSettlements,
} from './useSettlements'

const TRIP = 'trip-1'
const KEY_HASH = hashKey(['settlements', TRIP, 'uid-1'])

const row = (id: string): SettlementRecord => ({ id }) as SettlementRecord
const ambiguousErr = () => Object.assign(new Error('lost'), { name: 'WorkerAmbiguous' })
const rejectedErr  = () => Object.assign(new Error('403'), { name: 'WorkerRejected' })

/** What the list would render for this server truth, overlay applied. */
const visibleIds = (ids: string[]) =>
  settlementOverlay.merge(ids.map(row), settlementOverlay.getSnapshot(KEY_HASH)).map(s => s.id)

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

function renderDeleteMutation(qc = makeQueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
  return renderHook(() => useDeleteSettlement(TRIP), { wrapper })
}

function renderSettlementHooks(qc = makeQueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
  return renderHook(() => ({
    list:   useSettlements(TRIP),
    delete: useDeleteSettlement(TRIP),
  }), { wrapper })
}

beforeEach(() => {
  settlementOverlay.__resetForTest()
  vi.clearAllMocks()
  serviceMocks.getSettlementsByTripFromServer.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useDeleteSettlement overlay flow', () => {
  it('hides the row as soon as the delete starts, while the raw cache still has it', async () => {
    serviceMocks.getSettlementsByTrip.mockResolvedValueOnce([row('x')])
    serviceMocks.subscribeToSettlements.mockResolvedValueOnce(() => {})
    serviceMocks.deleteSettlement.mockReturnValueOnce(new Promise(() => {}))
    const hook = renderSettlementHooks()

    await waitFor(() => {
      expect(hook.result.current.list.data?.map(s => s.id)).toEqual(['x'])
    })

    await act(async () => {
      hook.result.current.delete.mutate({ settlementId: 'x' })
      await Promise.resolve()
    })

    expect(hook.result.current.list.data?.map(s => s.id)).toEqual([])
  })

  it('restores the row immediately on a definitive failure', async () => {
    serviceMocks.deleteSettlement.mockRejectedValueOnce(rejectedErr())
    const hook = renderDeleteMutation()

    await act(async () => {
      await hook.result.current.mutateAsync({ settlementId: 'x' }).catch(() => {})
    })

    expect(visibleIds(['x'])).toEqual(['x'])
  })

  it('keeps the row hidden when the ambiguous retry succeeds', async () => {
    vi.useFakeTimers()
    serviceMocks.deleteSettlement
      .mockRejectedValueOnce(ambiguousErr())
      .mockResolvedValueOnce(undefined)
    const hook = renderDeleteMutation()

    await act(async () => {
      await hook.result.current.mutateAsync({ settlementId: 'x' }).catch(() => {})
    })

    expect(visibleIds(['x'])).toEqual([])
    expect(serviceMocks.deleteSettlement).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLEMENT_DELETE_RETRY_DELAY_MS)
    })

    expect(serviceMocks.deleteSettlement).toHaveBeenCalledTimes(2)
    expect(visibleIds(['x'])).toEqual([])
    // Success alone must not settle it — server truth still says otherwise.
    expect(serviceMocks.getSettlementsByTripFromServer).not.toHaveBeenCalled()
  })

  it('restores the row when a failed retry defers to server truth that still has the doc', async () => {
    vi.useFakeTimers()
    serviceMocks.getSettlementsByTripFromServer.mockResolvedValue([row('x')])
    serviceMocks.deleteSettlement
      .mockRejectedValueOnce(ambiguousErr())
      .mockRejectedValueOnce(rejectedErr())
    const hook = renderDeleteMutation()

    await act(async () => {
      await hook.result.current.mutateAsync({ settlementId: 'x' }).catch(() => {})
    })
    expect(visibleIds(['x'])).toEqual([])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLEMENT_DELETE_RETRY_DELAY_MS)
    })

    expect(visibleIds(['x'])).toEqual(['x'])
  })

  it('stays hidden when the original commit converged despite the failed retry', async () => {
    vi.useFakeTimers()
    serviceMocks.getSettlementsByTripFromServer.mockResolvedValue([row('other')])
    serviceMocks.deleteSettlement
      .mockRejectedValueOnce(ambiguousErr())
      .mockRejectedValueOnce(rejectedErr())
    const hook = renderDeleteMutation()

    await act(async () => {
      await hook.result.current.mutateAsync({ settlementId: 'x' }).catch(() => {})
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLEMENT_DELETE_RETRY_DELAY_MS)
    })

    // Server truth no longer carries the row, so there is nothing left to
    // hide: the op retires instead of lingering, and `x` never reappears.
    expect(visibleIds(['other'])).toEqual(['other'])
    expect(settlementOverlay.getSnapshot(KEY_HASH)).toHaveLength(0)
  })

  it('safe-degrades to visible when server truth cannot be established', async () => {
    vi.useFakeTimers()
    serviceMocks.getSettlementsByTripFromServer.mockRejectedValue(new Error('offline'))
    serviceMocks.deleteSettlement
      .mockRejectedValueOnce(ambiguousErr())
      .mockRejectedValueOnce(rejectedErr())
    const hook = renderDeleteMutation()

    await act(async () => {
      await hook.result.current.mutateAsync({ settlementId: 'x' }).catch(() => {})
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLEMENT_DELETE_RETRY_DELAY_MS)
    })

    // Hiding a settlement that may still exist would invite recording the
    // payment twice, so an unreachable server reveals rather than hides.
    expect(visibleIds(['x'])).toEqual(['x'])
  })
})
