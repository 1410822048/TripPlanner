import { QueryClient, QueryClientProvider, hashKey } from '@tanstack/react-query'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'

vi.mock('@/hooks/useAuth', () => ({ useUid: () => 'uid-1' }))

import { isWorkerAmbiguousError, useTripListMutation } from './useTripListMutation'
import { createListOverlay, OVERLAY_AMBIGUOUS_SETTLE_MS } from './listOverlay'
import { MUTATION_ACTION } from '@/services/queryClient'

interface Row { id: string }

const KEY = ['things', 'trip-1', 'uid-1'] as const
const KEY_HASH = hashKey(KEY)

const ambiguousErr = () => Object.assign(new Error('lost'), { name: 'WorkerAmbiguous' })
const rejectedErr  = () => Object.assign(new Error('403'), { name: 'WorkerRejected' })

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useTripListMutation ambiguous classification', () => {
  it('classifies WorkerAmbiguous by error name only', () => {
    expect(isWorkerAmbiguousError({ name: 'WorkerAmbiguous' })).toBe(true)
    expect(isWorkerAmbiguousError({ name: 'WorkerRejected' })).toBe(false)
    expect(isWorkerAmbiguousError(new Error('network'))).toBe(false)
  })
})

describe('useTripListMutation overlay wiring', () => {
  function renderMutation(
    mutate: () => Promise<unknown>,
    overlay = createListOverlay<Row>({ insert: 'head', source: 'factory-test' }),
    authoritativeFetch: () => Promise<Row[]> = async () => [],
  ) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)

    const hook = renderHook(
      () =>
        useTripListMutation<Row, { id: string }>({
          tripId:     'trip-1',
          keyFactory: (tripId, uid) => ['things', tripId, uid] as const,
          mutate,
          overlay: {
            controller: overlay,
            op: ({ id }) => ({
              kind: 'create',
              row:  { id },
              confirms: base => base.some(r => r.id === id),
              authoritativeFetch,
            }),
          },
          action: MUTATION_ACTION.DELETE,
        }),
      { wrapper },
    )
    return { hook, overlay }
  }

  it('shows the optimistic row while the write is in flight', async () => {
    const { hook, overlay } = renderMutation(() => new Promise(() => {}))

    await act(async () => {
      hook.result.current.mutate({ id: 'new' })
      await Promise.resolve()
    })

    expect(overlay.merge([{ id: 'old' }], overlay.getSnapshot(KEY_HASH)).map(r => r.id))
      .toEqual(['new', 'old'])
  })

  it('drops only the failed operation on a definitive error', async () => {
    const { hook, overlay } = renderMutation(() => Promise.reject(rejectedErr()))

    await act(async () => {
      await hook.result.current.mutateAsync({ id: 'new' }).catch(() => {})
    })

    expect(overlay.getSnapshot(KEY_HASH)).toHaveLength(0)
  })

  it('holds an ambiguous failure until server truth settles it', async () => {
    vi.useFakeTimers()
    const { hook, overlay } = renderMutation(() => Promise.reject(ambiguousErr()))

    await act(async () => {
      await hook.result.current.mutateAsync({ id: 'new' }).catch(() => {})
    })

    // The write may still be committing, so the row stays put for now.
    expect(overlay.getSnapshot(KEY_HASH)).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERLAY_AMBIGUOUS_SETTLE_MS)
    })

    expect(overlay.getSnapshot(KEY_HASH)).toHaveLength(0)
  })

  it('keeps a successful operation until the list actually agrees', async () => {
    const { hook, overlay } = renderMutation(() => Promise.resolve())

    await act(async () => {
      await hook.result.current.mutateAsync({ id: 'new' })
    })

    // Success alone proves nothing about what the list currently holds.
    expect(overlay.getSnapshot(KEY_HASH)).toHaveLength(1)

    overlay.reconcile(KEY_HASH, [{ id: 'new' }])
    expect(overlay.getSnapshot(KEY_HASH)).toHaveLength(0)
  })
})
