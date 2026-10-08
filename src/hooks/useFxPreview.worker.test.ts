// @vitest-environment jsdom
// useFxPreview sources: Worker /fx-rate for cloud trips (the rate the save
// will use), a pinned stored rate when editing, direct Frankfurter in demo.
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/dates', () => ({ toLocalDateString: () => '2026-10-07' }))
vi.mock('@/services/firebase', () => ({
  getFirebaseAuth: vi.fn(async () => ({ auth: { currentUser: { getIdToken: async () => 'id-token' } } })),
}))
const base = vi.hoisted(() => ({ value: 'https://worker.test' as string | null }))
vi.mock('@/services/workerBase', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/workerBase')>(),
  requireWorkerWriteBase: () => {
    if (!base.value) throw new Error('VITE_WORKER_BASE_URL unset')
    return base.value
  },
}))

import { useFxPreview, type UseFxPreviewInput } from './useFxPreview'

function render(input: Partial<UseFxPreviewInput>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return renderHook(
    () => useFxPreview({ requestedDate: '2026-10-06', sourceCurrency: 'USD', tripCurrency: 'JPY', ...input }),
    { wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children) },
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  base.value = 'https://worker.test'
})

describe('useFxPreview rate source', () => {
  it('asks the Worker for a cloud trip and shows the rate the save will use', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(JSON.stringify({
      degenerate: false, tripCurrency: 'JPY', rateDecimal: '149.5', rateDate: '2026-10-03',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = render({ tripId: 'trip-1' })
    await waitFor(() => expect(result.current.rateDecimal).toBe('149.5'))
    expect(result.current.rateDate).toBe('2026-10-03')
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://worker.test/fx-rate')
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      tripId: 'trip-1', requestedDate: '2026-10-06', sourceCurrency: 'USD',
    })
  })

  it('refuses a Worker answer for a different trip currency', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      degenerate: false, tripCurrency: 'TWD', rateDecimal: '32.1', rateDate: '2026-10-06',
    }), { status: 200 })))
    const { result } = render({ tripId: 'trip-1' })
    // The hook retries once (retry: 1), so allow for the backoff.
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 })
    expect(result.current.rateDecimal).toBeNull()
  })

  it('shows a pinned stored rate without any request', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { result } = render({ tripId: 'trip-1', pinned: { rateDecimal: '150', rateDate: '2026-10-05' } })
    expect(result.current).toMatchObject({ rateDecimal: '150', rateDate: '2026-10-05', isLoading: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to Frankfurter without a trip or without a configured Worker', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { date: '2026-10-06', base: 'USD', quote: 'JPY', rate: 148 },
    ]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    base.value = null
    const { result } = render({ tripId: 'trip-1' })
    await waitFor(() => expect(result.current.rateDecimal).toBe('148'))
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('frankfurter')
  })
})

// The Worker caches only final answers (fx-core isFinalRate); the preview
// cache must follow the same rule or it keeps showing a provisional rate
// the save no longer uses. One QueryClient spans "close and reopen the form".
describe('useFxPreview cache follows rate finality', () => {
  afterEach(() => { vi.useRealTimers() })

  function workerAnswer(rateDecimal: string, rateDate: string) {
    return new Response(JSON.stringify({ degenerate: false, tripCurrency: 'JPY', rateDecimal, rateDate }), { status: 200 })
  }
  function renderShared(client: QueryClient, requestedDate: string) {
    return renderHook(
      () => useFxPreview({ requestedDate, sourceCurrency: 'USD', tripCurrency: 'JPY', tripId: 'trip-1' }),
      { wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children) },
    )
  }
  const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

  it('re-asks on reopen while today is unpublished, and shows the published rate', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(workerAnswer('149', '2026-10-06'))
      .mockResolvedValueOnce(workerAnswer('150', '2026-10-07'))
    vi.stubGlobal('fetch', fetchMock)
    const client = newClient()

    const first = renderShared(client, '2026-10-07')
    await waitFor(() => expect(first.result.current.rateDecimal).toBe('149'))
    first.unmount()

    const second = renderShared(client, '2026-10-07')
    await waitFor(() => expect(second.result.current.rateDecimal).toBe('150'))
    expect(second.result.current.rateDate).toBe('2026-10-07')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a published answer for good', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
    const fetchMock = vi.fn().mockResolvedValue(workerAnswer('150', '2026-10-07'))
    vi.stubGlobal('fetch', fetchMock)
    const client = newClient()

    const first = renderShared(client, '2026-10-07')
    await waitFor(() => expect(first.result.current.rateDecimal).toBe('150'))
    first.unmount()
    const second = renderShared(client, '2026-10-07')
    expect(second.result.current.rateDecimal).toBe('150')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps an earlier-dated answer for a past day (weekend) for good', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
    const fetchMock = vi.fn().mockResolvedValue(workerAnswer('148', '2026-10-02'))
    vi.stubGlobal('fetch', fetchMock)
    const client = newClient()

    const first = renderShared(client, '2026-10-04')
    await waitFor(() => expect(first.result.current.rateDecimal).toBe('148'))
    first.unmount()
    const second = renderShared(client, '2026-10-04')
    expect(second.result.current.rateDecimal).toBe('148')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('an open form picks up publication without being reopened', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(workerAnswer('149', '2026-10-06'))
      .mockResolvedValue(workerAnswer('150', '2026-10-07'))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderShared(newClient(), '2026-10-07')
    await waitFor(() => expect(result.current.rateDecimal).toBe('149'))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await waitFor(() => expect(result.current.rateDecimal).toBe('150'))
    // Final now: the interval stops.
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// A FX_RATE_CHANGED refusal carries the Worker's rate; the hook shows it as-is
// (no refetch, which could already say something newer) until a later
// preview fetch supersedes it. `isFinal` tells the form whether a save may
// close optimistically.
describe('useFxPreview adoptRate / isFinal', () => {
  afterEach(() => { vi.useRealTimers() })

  function workerAnswer(rateDecimal: string, rateDate: string) {
    return new Response(JSON.stringify({ degenerate: false, tripCurrency: 'JPY', rateDecimal, rateDate }), { status: 200 })
  }

  it('shows an adopted rate without asking again, and a later fetch supersedes it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(workerAnswer('149', '2026-10-06'))
      .mockResolvedValue(workerAnswer('151', '2026-10-07'))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = render({ tripId: 'trip-1', requestedDate: '2026-10-07' })
    await waitFor(() => expect(result.current.rateDecimal).toBe('149'))
    expect(result.current.isFinal).toBe(false)

    act(() => { result.current.adoptRate({ rateDecimal: '150', rateDate: '2026-10-07' }) })
    expect(result.current.rateQuote).toEqual({ rateDecimal: '150', rateDate: '2026-10-07' })
    expect(result.current.isFinal).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Was provisional when fetched, so the interval is still armed; its
    // answer is newer than the adopted one and wins.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await waitFor(() => expect(result.current.rateDecimal).toBe('151'))
  })

  it('an adopted rate is dropped when the date changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => workerAnswer('149.5', '2026-10-03')))
    const { result, rerender } = renderHook(
      ({ date }: { date: string }) => useFxPreview({ requestedDate: date, sourceCurrency: 'USD', tripCurrency: 'JPY', tripId: 'trip-1' }),
      {
        initialProps: { date: '2026-10-05' },
        wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, {
          client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
        }, children),
      },
    )
    await waitFor(() => expect(result.current.rateDecimal).toBe('149.5'))
    act(() => { result.current.adoptRate({ rateDecimal: '150', rateDate: '2026-10-05' }) })
    expect(result.current.rateDecimal).toBe('150')
    rerender({ date: '2026-10-06' })
    await waitFor(() => expect(result.current.rateDecimal).toBe('149.5'))
  })

  it('a pinned stored rate is final (the Worker reuses it), and an adopted rate overrides it', () => {
    vi.stubGlobal('fetch', vi.fn())
    const { result } = render({ tripId: 'trip-1', pinned: { rateDecimal: '150', rateDate: '2026-10-05' } })
    expect(result.current.isFinal).toBe(true)
    act(() => { result.current.adoptRate({ rateDecimal: '151', rateDate: '2026-10-06' }) })
    expect(result.current.rateQuote).toEqual({ rateDecimal: '151', rateDate: '2026-10-06' })
  })
})
