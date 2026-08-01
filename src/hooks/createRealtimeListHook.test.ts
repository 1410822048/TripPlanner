import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'

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

    const b = mount()
    await flush()
    expect(subscribe).toHaveBeenCalledTimes(2)

    rejectFirst(new Error('late failure'))
    await flush()

    // The late rejection must not deregister `b`, or nothing would ever
    // unsubscribe it.
    b.unmount()
    expect(unsub).toHaveBeenCalledTimes(1)
  })
})
