import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, StrictMode, type ReactNode } from 'react'

vi.mock('@/hooks/useAuth', () => ({ useUid: () => 'uid-1' }))
vi.mock('@/services/sentry', () => ({ captureError: vi.fn() }))

import { createRealtimeListHook } from './createRealtimeListHook'

type Subscribe = (
  key:     string,
  uid:     string | undefined,
  onData:  (rows: { id: string }[]) => void,
  onError: (e: Error) => void,
) => Promise<() => void>

function setup(subscribe: Subscribe, scope: string) {
  const useRows = createRealtimeListHook<{ id: string }>({
    queryKeyFactory: (key, uid) => [scope, key, uid],
    source:          'test',
    initialFetch:    async () => [],
    subscribe,
  })
  const qc = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)

  return () => renderHook(() => useRows('trip-1'), { wrapper })
}

const flush = () => act(async () => {})

describe('createRealtimeListHook shared-listener generations', () => {
  it('does not let a release from a failed generation unsubscribe a newer one', async () => {
    const unsub = vi.fn()
    const subscribe = vi.fn<Subscribe>()
      .mockRejectedValueOnce(new Error('subscribe init failed'))
      .mockResolvedValueOnce(unsub)
    const mount = setup(subscribe, 'gen-fail')

    const a = mount()
    const b = mount()
    await flush()
    expect(subscribe).toHaveBeenCalledTimes(1)

    a.unmount()

    const c = mount()
    await flush()
    expect(subscribe).toHaveBeenCalledTimes(2)

    // `b` belongs to the dead generation; releasing it must not touch `c`.
    b.unmount()
    expect(unsub).not.toHaveBeenCalled()

    c.unmount()
    await flush()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it('keeps the newer generation registered when an older subscribe rejects late', async () => {
    let rejectFirst!: (e: unknown) => void
    const pending = new Promise<() => void>((_, reject) => { rejectFirst = reject })
    const unsub = vi.fn()
    const subscribe = vi.fn<Subscribe>()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(unsub)
    const mount = setup(subscribe, 'gen-late')

    const a = mount()
    a.unmount()
    await flush()

    const b = mount()
    await flush()
    expect(subscribe).toHaveBeenCalledTimes(2)

    rejectFirst(new Error('late failure'))
    await flush()

    // The late rejection must not deregister `b`, or nothing would ever
    // unsubscribe it.
    b.unmount()
    await flush()
    expect(unsub).toHaveBeenCalledTimes(1)
  })
})

describe('shared-listener lifecycle and snapshot authority', () => {
  function harness() {
    const callbacks: Array<(rows: { id: string }[]) => void> = []
    const unsubs: Array<ReturnType<typeof vi.fn>> = []
    const fetches: Array<(rows: { id: string }[]) => void> = []
    const initialFetch = vi.fn(() => new Promise<{ id: string }[]>(resolve => fetches.push(resolve)))
    const subscribe = vi.fn<Subscribe>(async (_key, _uid, onData) => {
      callbacks.push(onData)
      const unsub = vi.fn()
      unsubs.push(unsub)
      return unsub
    })
    const useRows = createRealtimeListHook({
      queryKeyFactory: key => ['lifecycle', key], source: 'test', initialFetch, subscribe,
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const mount = (client = qc, key = 'a', strict = false) => renderHook(
      ({ scope }) => useRows(scope),
      {
        initialProps: { scope: key },
        wrapper: ({ children }) => createElement(QueryClientProvider, { client },
          strict ? createElement(StrictMode, null, children) : children),
      },
    )
    return { qc, callbacks, unsubs, fetches, subscribe, mount }
  }

  it('shares one listener and releases only the final consumer', async () => {
    const h = harness()
    const a = h.mount(), b = h.mount()
    await flush()
    expect(h.subscribe).toHaveBeenCalledTimes(1)
    a.unmount()
    await flush()
    expect(h.unsubs[0]).not.toHaveBeenCalled()
    b.unmount()
    await flush()
    expect(h.unsubs[0]).toHaveBeenCalledTimes(1)
  })

  it('isolates two QueryClients using the same key', async () => {
    const h = harness()
    const other = new QueryClient()
    const a = h.mount(), b = h.mount(other)
    await flush()
    act(() => h.callbacks[0]!([{ id: 'only-a' }]))
    expect(h.subscribe).toHaveBeenCalledTimes(2)
    expect(h.qc.getQueryData(['lifecycle', 'a'])).toEqual([{ id: 'only-a' }])
    expect(other.getQueryData(['lifecycle', 'a'])).toBeUndefined()
    a.unmount(); b.unmount()
    await flush()
  })

  it('keeps one subscription across StrictMode effect replay', async () => {
    const h = harness()
    const a = h.mount(h.qc, 'a', true)
    await flush()
    expect(h.subscribe).toHaveBeenCalledTimes(1)
    a.unmount()
    await flush()
    expect(h.unsubs[0]).toHaveBeenCalledTimes(1)
  })

  it('ignores late callbacks after release and after a new generation starts', async () => {
    const h = harness()
    const a = h.mount()
    await flush()
    a.unmount()
    act(() => h.callbacks[0]!([{ id: 'late-before-dispose' }]))
    expect(h.qc.getQueryData(['lifecycle', 'a'])).toBeUndefined()
    await flush()
    h.qc.clear()
    const b = h.mount()
    await flush()
    act(() => h.callbacks[1]!([{ id: 'new' }]))
    act(() => h.callbacks[0]!([{ id: 'old' }]))
    expect(h.qc.getQueryData(['lifecycle', 'a'])).toEqual([{ id: 'new' }])
    expect(h.qc.getQueryState(['lifecycle', 'a'])?.fetchStatus).toBe('idle')
    b.unmount()
    await flush()
  })

  it('does not let a late initial fetch or refetch overwrite a newer snapshot', async () => {
    const h = harness()
    const a = h.mount()
    await flush()
    act(() => h.callbacks[0]!([{ id: 'new' }]))
    await act(async () => h.fetches[0]!([{ id: 'old' }]))
    expect(h.qc.getQueryData(['lifecycle', 'a'])).toEqual([{ id: 'new' }])
    let refetch!: Promise<void>
    act(() => { refetch = h.qc.invalidateQueries({ queryKey: ['lifecycle', 'a'] }) })
    await flush()
    act(() => h.callbacks[0]!([]))
    await act(async () => { h.fetches[1]!([{ id: 'revoked' }]); await refetch })
    expect(h.qc.getQueryData(['lifecycle', 'a'])).toEqual([])
    expect(h.qc.getQueryState(['lifecycle', 'a'])?.fetchStatus).toBe('idle')
    expect(h.qc.getQueryState(['lifecycle', 'a'])?.status).toBe('success')
    a.unmount()
    await flush()
  })

  it('switches scope without accepting the prior scope callback', async () => {
    const h = harness()
    const a = h.mount()
    await flush()
    a.rerender({ scope: 'b' })
    await flush()
    act(() => h.callbacks[1]!([{ id: 'b' }]))
    act(() => h.callbacks[0]!([{ id: 'a-late' }]))
    expect(h.qc.getQueryData(['lifecycle', 'b'])).toEqual([{ id: 'b' }])
    expect(h.qc.getQueryData(['lifecycle', 'a'])).toBeUndefined()
    a.unmount()
    await flush()
  })

  it('closes an asynchronously initialized listener after final unmount', async () => {
    let resolve!: (unsub: () => void) => void
    const subscribe = vi.fn<Subscribe>(() => new Promise(done => { resolve = done }))
    const mount = setup(subscribe, 'late-init')
    const a = mount()
    a.unmount()
    await flush()
    const unsub = vi.fn()
    await act(async () => resolve(unsub))
    expect(unsub).toHaveBeenCalledTimes(1)
  })
})

describe('terminal listener failures', () => {
  function harness() {
    const attempts: Array<{
      data: (rows: { id: string }[]) => void
      error: (e: Error) => void
      unsub: ReturnType<typeof vi.fn>
    }> = []
    const subscribe = vi.fn<Subscribe>(async (_key, _uid, data, error) => {
      const unsub = vi.fn()
      attempts.push({ data, error, unsub })
      return unsub
    })
    const useRows = createRealtimeListHook({
      queryKeyFactory: key => ['terminal', key], source: 'terminal-test',
      initialFetch: async () => [{ id: 'cached' }], subscribe,
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
    return { attempts, subscribe, mount: () => renderHook(() => useRows('a'), { wrapper }) }
  }

  it('reports permission failure without looping and restarts for a new consumer', async () => {
    const h = harness()
    const a = h.mount()
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true))
    const error = Object.assign(new Error('revoked'), { code: 'permission-denied' })
    act(() => h.attempts[0]!.error(error))
    await waitFor(() => expect(a.result.current.error).toBe(error))
    expect(a.result.current.isError).toBe(true)
    expect(a.result.current.fetchStatus).toBe('idle')
    expect(h.subscribe).toHaveBeenCalledTimes(1)
    expect(h.attempts[0]!.unsub).toHaveBeenCalledTimes(1)

    const b = h.mount()
    await flush()
    expect(h.subscribe).toHaveBeenCalledTimes(2)
    act(() => h.attempts[1]!.data([{ id: 'recovered' }]))
    await waitFor(() => expect(a.result.current.data).toEqual([{ id: 'recovered' }]))
    expect(a.result.current.isSuccess).toBe(true)
    // The first consumer still owns a reference to the recovered listener.
    b.unmount()
    await flush()
    expect(h.attempts[1]!.unsub).not.toHaveBeenCalled()
    a.unmount()
    await flush()
    expect(h.attempts[1]!.unsub).toHaveBeenCalledTimes(1)
  })

  it('refetch restarts once and rejects callbacks from the failed attempt', async () => {
    const h = harness()
    const a = h.mount()
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true))
    act(() => h.attempts[0]!.error(new Error('terminal')))
    await waitFor(() => expect(a.result.current.isError).toBe(true))
    await act(async () => { await a.result.current.refetch() })
    expect(h.subscribe).toHaveBeenCalledTimes(2)
    act(() => h.attempts[1]!.data([{ id: 'new' }]))
    act(() => {
      h.attempts[0]!.data([{ id: 'old' }])
      h.attempts[0]!.error(new Error('old failure'))
    })
    await waitFor(() => expect(a.result.current.data).toEqual([{ id: 'new' }]))
    expect(a.result.current.isSuccess).toBe(true)
    a.unmount()
    await flush()
  })

  it('disposes a late init handle without stopping its recovered attempt', async () => {
    let fail!: (e: Error) => void
    let resolve!: (unsub: () => void) => void
    const subscribe = vi.fn<Subscribe>()
      .mockImplementationOnce((_key, _uid, _data, error) => {
        fail = error
        return new Promise(done => { resolve = done })
      })
      .mockResolvedValueOnce(vi.fn())
    const mount = setup(subscribe, 'terminal-late-init')
    const a = mount()
    await flush()
    act(() => fail(new Error('failed before init resolved')))
    await act(async () => { await a.result.current.refetch() })
    expect(subscribe).toHaveBeenCalledTimes(2)
    const oldUnsub = vi.fn()
    await act(async () => resolve(oldUnsub))
    expect(oldUnsub).toHaveBeenCalledTimes(1)
    a.unmount()
    await flush()
  })
})
