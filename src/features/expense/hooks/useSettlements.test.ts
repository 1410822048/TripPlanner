// @vitest-environment jsdom
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
  createSettlementRoute:          vi.fn(),
  deleteSettlement:               vi.fn(),
}))

vi.mock('../services/settlementService', () => ({
  ...serviceMocks,
  settlementKeys: {
    all: (tripId: string, uid?: string) => ['settlements', tripId, uid ?? ''] as const,
  },
}))

import { OVERLAY_AMBIGUOUS_SETTLE_MS } from '@/hooks/listOverlay'
import {
  SETTLEMENT_DELETE_RETRY_DELAY_MS,
  optimisticRouteRow,
  settlementOverlay,
  useCreateSettlementRoute,
  useDeleteSettlement,
  useSettlements,
} from './useSettlements'

/** Retry first, then wait out the settle window before reading truth. */
const RETRY_THEN_SETTLE_MS = SETTLEMENT_DELETE_RETRY_DELAY_MS + OVERLAY_AMBIGUOUS_SETTLE_MS

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
      await vi.advanceTimersByTimeAsync(RETRY_THEN_SETTLE_MS)
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
      await vi.advanceTimersByTimeAsync(RETRY_THEN_SETTLE_MS)
    })

    // Server truth no longer carries the row, so there is nothing left to
    // hide once the listener catches up. Until then `x` stays hidden even
    // against a stale cache that still holds it, and the op retires as soon
    // as a snapshot agrees.
    expect(visibleIds(['x', 'other'])).toEqual(['other'])
    settlementOverlay.reconcile(KEY_HASH, [row('other')])
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
      await vi.advanceTimersByTimeAsync(RETRY_THEN_SETTLE_MS)
    })

    // Hiding a settlement that may still exist would invite recording the
    // payment twice, so an unreachable server reveals rather than hides.
    expect(visibleIds(['x'])).toEqual(['x'])
  })
})

describe('a settlement is one row, however many legs its route has', () => {
  const ROUTE = {
    kind: 'TRANSFER' as const, payerUid: 'a', receiverUid: 'c', amountMinor: 300,
    // Out of canonical order on purpose: the row stores canonical order.
    legs: [
      { fromUid: 'b', toUid: 'c', amountMinor: 300, expectedRemainingMinor: 300 },
      { fromUid: 'a', toUid: 'b', amountMinor: 300, expectedRemainingMinor: 500 },
    ],
  }
  const VARS = {
    routeId: 'r1', route: ROUTE, note: '晚餐',
    optimistic: { currency: 'JPY', settledBy: 'c', pendingLocks: [{ expenseId: 'e1', legIndexes: [0] }, { expenseId: 'e2', legIndexes: [0, 1] }] },
  }

  function renderCreate(qc = makeQueryClient()) {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
    return renderHook(() => useCreateSettlementRoute(TRIP), { wrapper })
  }

  it('the optimistic row carries the Worker\'s id, canonical legs and pending locks', () => {
    const r = optimisticRouteRow(TRIP, VARS)
    expect(r).toMatchObject({
      id: 'r1', tripId: TRIP, kind: 'TRANSFER', currency: 'JPY', payerUid: 'a', receiverUid: 'c', amountMinor: 300,
      participantUids: ['a', 'b', 'c'], note: '晚餐', settledBy: 'c', deletedAt: null,
      lockedExpenses: [{ expenseId: 'e1', legIndexes: [0] }, { expenseId: 'e2', legIndexes: [0, 1] }],
    })
    expect(r.legs).toEqual([
      { fromUid: 'a', toUid: 'b', amountMinor: 300 },
      { fromUid: 'b', toUid: 'c', amountMinor: 300 },
    ])
    expect(r.ownerRecorded).toBeUndefined()
  })

  it('an optimistic offset has no payer, and a foreign transfer shows the received amount', () => {
    const offset = optimisticRouteRow(TRIP, {
      routeId: 'o1', route: { kind: 'OFFSET', participantUids: ['a', 'b', 'c'], legs: ROUTE.legs.map(l => ({ ...l, amountMinor: 300, expectedRemainingMinor: 300 })) },
      optimistic: { currency: 'JPY', settledBy: 'c', ownerRecorded: true, pendingLocks: [] },
    })
    expect(offset.payerUid).toBeUndefined()
    expect(offset.amountMinor).toBeUndefined()
    expect(offset.ownerRecorded).toBe(true)
    const foreign = optimisticRouteRow(TRIP, {
      ...VARS,
      foreign: { sourceCurrency: 'USD', settledOn: '2026-10-10', expectedFxRate: { rateDecimal: '150', rateDate: '2026-10-10' } },
      optimistic: { ...VARS.optimistic, sourceAmountMinor: 200 },
    })
    expect(foreign).toMatchObject({ sourceCurrency: 'USD', sourceAmountMinor: 200, settledOn: '2026-10-10' })
  })

  it('shows the row while in flight and drops it on a definitive failure', async () => {
    let reject!: (e: unknown) => void
    serviceMocks.createSettlementRoute.mockReturnValueOnce(new Promise((_, r) => { reject = r }))
    const hook = renderCreate()
    act(() => { hook.result.current.mutate(VARS) })
    await waitFor(() => expect(visibleIds([])).toEqual(['r1']))
    await act(async () => { reject(rejectedErr()); await Promise.resolve() })
    await waitFor(() => expect(visibleIds([])).toEqual([]))
  })

  it('an ambiguous failure keeps the row until server truth decides', async () => {
    vi.useFakeTimers()
    serviceMocks.createSettlementRoute.mockRejectedValueOnce(ambiguousErr())
    serviceMocks.getSettlementsByTripFromServer.mockResolvedValue([row('r1')])
    const hook = renderCreate()
    await act(async () => { await hook.result.current.mutateAsync(VARS).catch(() => {}) })
    expect(visibleIds([])).toEqual(['r1'])
    await act(async () => { await vi.advanceTimersByTimeAsync(OVERLAY_AMBIGUOUS_SETTLE_MS + 50) })
    // The commit did land: the real row takes over, nothing duplicated.
    expect(visibleIds(['r1'])).toEqual(['r1'])
  })

  it('cancelling hides the row and restores it on refusal, with one request', async () => {
    serviceMocks.deleteSettlement.mockRejectedValueOnce(rejectedErr())
    const hook = renderDeleteMutation()
    let pending!: Promise<unknown>
    act(() => { pending = hook.result.current.mutateAsync({ settlementId: 'r1' }).catch(() => {}) })
    expect(visibleIds(['r1', 'other'])).toEqual(['other'])
    await act(async () => { await pending })
    expect(visibleIds(['r1', 'other'])).toEqual(['r1', 'other'])
    expect(serviceMocks.deleteSettlement).toHaveBeenCalledTimes(1)
    expect(serviceMocks.deleteSettlement).toHaveBeenCalledWith(TRIP, 'r1')
  })
})
