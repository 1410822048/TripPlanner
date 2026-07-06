import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'

vi.mock('@/hooks/useAuth', () => ({ useUid: () => 'uid-1' }))

import {
  AMBIGUOUS_RECONCILE_DELAY_MS,
  isWorkerAmbiguousError,
  scheduleAmbiguousQueryReconcile,
  useTripListMutation,
} from './useTripListMutation'
import { MUTATION_ACTION } from '@/services/queryClient'

const KEY = ['things', 'trip-1', 'uid-1'] as const

const ambiguousErr = () => Object.assign(new Error('lost'), { name: 'WorkerAmbiguous' })
const rejectedErr = () => Object.assign(new Error('403'), { name: 'WorkerRejected' })

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useTripListMutation ambiguous reconciliation helpers', () => {
  it('classifies WorkerAmbiguous by error name only', () => {
    expect(isWorkerAmbiguousError({ name: 'WorkerAmbiguous' })).toBe(true)
    expect(isWorkerAmbiguousError({ name: 'WorkerRejected' })).toBe(false)
    expect(isWorkerAmbiguousError(new Error('network'))).toBe(false)
  })

  it('delays query invalidation so ambiguous optimistic state can converge first', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()

    scheduleAmbiguousQueryReconcile(qc, KEY)

    expect(invalidate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AMBIGUOUS_RECONCILE_DELAY_MS)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY })
  })
})

describe('useTripListMutation optimistic patch behavior', () => {
  function renderPatchedMutation(
    mutate: () => Promise<unknown>,
    qc: QueryClient = new QueryClient(),
  ) {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)

    return renderHook(
      () =>
        useTripListMutation<{ id: string }, { id: string }>({
          tripId:     'trip-1',
          keyFactory: (tripId, uid) => ['things', tripId, uid] as const,
          mutate,
          patch:      (prev, { id }) => [{ id }, ...prev],
          action:     MUTATION_ACTION.DELETE,
        }),
      { wrapper },
    )
  }

  it('rolls back the patch immediately on a definitive failure', async () => {
    const qc = new QueryClient()
    qc.setQueryData(KEY, [{ id: 'old' }])
    const hook = renderPatchedMutation(() => Promise.reject(rejectedErr()), qc)

    await act(async () => {
      await hook.result.current.mutateAsync({ id: 'new' }).catch(() => {})
    })

    expect(qc.getQueryData(KEY)).toEqual([{ id: 'old' }])
  })

  it('keeps the patch on an ambiguous failure and schedules reconcile', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    qc.setQueryData(KEY, [{ id: 'old' }])
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const hook = renderPatchedMutation(() => Promise.reject(ambiguousErr()), qc)

    await act(async () => {
      await hook.result.current.mutateAsync({ id: 'new' }).catch(() => {})
    })

    expect(qc.getQueryData(KEY)).toEqual([{ id: 'new' }, { id: 'old' }])
    expect(invalidate).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AMBIGUOUS_RECONCILE_DELAY_MS)
    })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY })
  })
})
