import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import type { SettlementRecord } from '@/types/settlement'
import { AMBIGUOUS_RECONCILE_DELAY_MS } from '@/hooks/useTripListMutation'
import {
  SETTLEMENT_DELETE_RETRY_DELAY_MS,
  __resetSettlementTombstonesForTest,
  filterSettlementTombstones,
} from './settlementTombstones'

vi.mock('@/hooks/useAuth', () => ({ useUid: () => 'uid-1' }))

const serviceMocks = vi.hoisted(() => ({
  getSettlementsByTrip:   vi.fn(),
  subscribeToSettlements: vi.fn(),
  createSettlement:       vi.fn(),
  deleteSettlement:       vi.fn(),
}))

vi.mock('../services/settlementService', () => ({
  getSettlementsByTrip:   serviceMocks.getSettlementsByTrip,
  subscribeToSettlements: serviceMocks.subscribeToSettlements,
  createSettlement:       serviceMocks.createSettlement,
  deleteSettlement:       serviceMocks.deleteSettlement,
  settlementKeys:         {
    all: (tripId: string) => ['settlements', tripId] as const,
  },
}))

import { useDeleteSettlement } from './useSettlements'

const TRIP = 'trip-1'
const KEY = ['settlements', TRIP] as const

const row = (id: string): SettlementRecord => ({ id }) as SettlementRecord
const visibleIds = (ids: string[]) => filterSettlementTombstones(TRIP, ids.map(row)).map(s => s.id)
const ambiguousErr = () => Object.assign(new Error('lost'), { name: 'WorkerAmbiguous' })
const rejectedErr = () => Object.assign(new Error('403'), { name: 'WorkerRejected' })

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries:   { retry: false },
      mutations: { retry: false },
    },
  })
}

function renderDeleteMutation(qc = makeQueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)

  return renderHook(() => useDeleteSettlement(TRIP), { wrapper })
}

beforeEach(() => {
  __resetSettlementTombstonesForTest()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useDeleteSettlement tombstone flow', () => {
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
    const qc = makeQueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    serviceMocks.deleteSettlement
      .mockRejectedValueOnce(ambiguousErr())
      .mockResolvedValueOnce(undefined)
    const hook = renderDeleteMutation(qc)

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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AMBIGUOUS_RECONCILE_DELAY_MS)
    })

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('retry failure defers to server truth and restores when the doc is still present', async () => {
    vi.useFakeTimers()
    const qc = makeQueryClient()
    qc.setQueryData(KEY, [row('x')])
    vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    serviceMocks.deleteSettlement
      .mockRejectedValueOnce(ambiguousErr())
      .mockRejectedValueOnce(rejectedErr())
    const hook = renderDeleteMutation(qc)

    await act(async () => {
      await hook.result.current.mutateAsync({ settlementId: 'x' }).catch(() => {})
    })
    expect(visibleIds(['x'])).toEqual([])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLEMENT_DELETE_RETRY_DELAY_MS)
    })
    expect(visibleIds(['x'])).toEqual([])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AMBIGUOUS_RECONCILE_DELAY_MS)
    })

    expect(visibleIds(['x'])).toEqual(['x'])
  })

  it('retry failure stays hidden when the original commit converges before reconcile', async () => {
    vi.useFakeTimers()
    const qc = makeQueryClient()
    qc.setQueryData(KEY, [row('x')])
    vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    serviceMocks.deleteSettlement
      .mockRejectedValueOnce(ambiguousErr())
      .mockRejectedValueOnce(rejectedErr())
    const hook = renderDeleteMutation(qc)

    await act(async () => {
      await hook.result.current.mutateAsync({ settlementId: 'x' }).catch(() => {})
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLEMENT_DELETE_RETRY_DELAY_MS)
    })
    qc.setQueryData(KEY, [row('other')])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AMBIGUOUS_RECONCILE_DELAY_MS)
    })

    expect(visibleIds(['x'])).toEqual([])
  })

  it('safe-degrades to visible when server truth cannot be established', async () => {
    vi.useFakeTimers()
    const qc = makeQueryClient()
    vi.spyOn(qc, 'invalidateQueries').mockRejectedValue(new Error('offline'))
    serviceMocks.deleteSettlement
      .mockRejectedValueOnce(ambiguousErr())
      .mockRejectedValueOnce(rejectedErr())
    const hook = renderDeleteMutation(qc)

    await act(async () => {
      await hook.result.current.mutateAsync({ settlementId: 'x' }).catch(() => {})
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLEMENT_DELETE_RETRY_DELAY_MS + AMBIGUOUS_RECONCILE_DELAY_MS)
    })

    expect(visibleIds(['x'])).toEqual(['x'])
  })
})
