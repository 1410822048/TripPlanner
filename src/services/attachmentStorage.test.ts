import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./workerBase', () => ({
  preflightIdToken: vi.fn(async () => 'id-token'),
  requireWorkerWriteBase: vi.fn(() => 'https://worker.example.test'),
  workerFetch: vi.fn(),
  WorkerAmbiguous: class WorkerAmbiguous extends Error {},
  WORKER_FETCH_TIMEOUT_MS: 30_000,
}))

import { fetchAttachmentBlob } from './attachmentStorage'

const PATH = 'trips/trip-1/expenses/expense-1/receipt.webp'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('fetchAttachmentBlob', () => {
  it('uses one stable endpoint URL and moves the locator into fixed headers', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('image', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const blob = await fetchAttachmentBlob(PATH)

    expect(blob).not.toBeNull()
    expect(blob?.size).toBe(5)
    await expect(blob!.text()).resolves.toBe('image')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://worker.example.test/attachment-content')
    const headers = new Headers(init?.headers)
    expect(headers.get('Authorization')).toBe('Bearer id-token')
    expect(headers.get('X-Attachment-Trip-Id')).toBe('trip-1')
    expect(headers.get('X-Attachment-Path')).toBe(PATH)
  })

  it('retries a transient 5xx with a fresh request attempt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response('image', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const pending = fetchAttachmentBlob(PATH)
    await vi.runAllTimersAsync()

    const blob = await pending
    expect(blob).not.toBeNull()
    expect(blob?.size).toBe(5)
    await expect(blob!.text()).resolves.toBe('image')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry authorization failures', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchAttachmentBlob(PATH)).rejects.toThrow(/403/)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not immediately retry a rate-limited response', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchAttachmentBlob(PATH)).rejects.toThrow(/429/)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('returns null for an absent attachment without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchAttachmentBlob(PATH)).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
