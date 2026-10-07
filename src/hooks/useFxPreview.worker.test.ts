// @vitest-environment jsdom
// useFxPreview sources: Worker /fx-rate for cloud trips (the rate the save
// will use), a pinned stored rate when editing, direct Frankfurter in demo.
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
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
