// Tests for the signed-URL resolver. Mocks ./workerBase (workerFetch +
// preflightIdToken) so no network / firebase; asserts the batching,
// grouping, dedup, caching, path-parsing, and clear semantics.
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface WFBody { tripId?: string; paths?: string[]; entityType?: string; entityId?: string; variant?: string }

const { workerFetchMock, preflightMock } = vi.hoisted(() => ({
  workerFetchMock: vi.fn<(base: string, tok: string, endpoint: string, body: WFBody) => Promise<unknown>>(),
  preflightMock:   vi.fn<() => Promise<string>>(),
}))

vi.mock('./workerBase', () => ({
  WORKER_BASE_URL:  'http://worker',
  preflightIdToken: preflightMock,
  workerFetch:      workerFetchMock,
}))

import {
  resolveSignedUrl,
  peekSignedUrl,
  clearSignedUrlCache,
  attachmentUrlMode,
} from './attachmentUrlResolver'

const future = (ms = 30 * 60 * 1000) => new Date(Date.now() + ms).toISOString()

/** Default mock: thumb returns one url per path; entity returns a url tagged
 *  with the derived coords so tests can assert the parse. */
function defaultWorkerFetch() {
  workerFetchMock.mockImplementation(async (_base, _tok, endpoint, body) => {
    if (endpoint === '/attachment-thumb-urls') {
      return { urls: (body.paths ?? []).map(p => ({ path: p, url: `signed:${p}`, expiresAt: future() })) }
    }
    return { url: `signed:${body.entityType}/${body.entityId}/${body.variant}`, expiresAt: future() }
  })
}

beforeEach(() => {
  clearSignedUrlCache()
  workerFetchMock.mockReset()
  defaultWorkerFetch()
  preflightMock.mockReset()
  preflightMock.mockResolvedValue('tok')
})

describe('attachmentUrlMode', () => {
  it('defaults to getBlob; signed only when explicitly set', () => {
    expect(attachmentUrlMode()).toBe('getBlob')
    vi.stubEnv('VITE_ATTACHMENT_URL_MODE', 'signed')
    expect(attachmentUrlMode()).toBe('signed')
    vi.stubEnv('VITE_ATTACHMENT_URL_MODE', 'getBlob')
    expect(attachmentUrlMode()).toBe('getBlob')
    vi.unstubAllEnvs()
  })
})

describe('resolveSignedUrl — thumb batching', () => {
  it('collapses same-tick thumb requests into ONE batch call', async () => {
    const p1 = 'trips/T/expenses/e1/x.thumb.webp'
    const p2 = 'trips/T/expenses/e2/y.thumb.webp'
    const [a, b] = await Promise.all([resolveSignedUrl(p1, 'thumb'), resolveSignedUrl(p2, 'thumb')])
    expect(a?.url).toBe(`signed:${p1}`)
    expect(b?.url).toBe(`signed:${p2}`)
    expect(workerFetchMock).toHaveBeenCalledTimes(1)
    const [, , endpoint, body] = workerFetchMock.mock.calls[0]!
    expect(endpoint).toBe('/attachment-thumb-urls')
    expect(body).toEqual({ tripId: 'T', paths: [p1, p2] })
  })

  it('groups by tripId → one call per trip', async () => {
    await Promise.all([
      resolveSignedUrl('trips/A/expenses/e1/x.thumb.webp', 'thumb'),
      resolveSignedUrl('trips/B/expenses/e2/y.thumb.webp', 'thumb'),
    ])
    expect(workerFetchMock).toHaveBeenCalledTimes(2)
    const trips = workerFetchMock.mock.calls.map(c => c[3].tripId).sort()
    expect(trips).toEqual(['A', 'B'])
  })

  it('chunks >20 paths in one trip into multiple requests', async () => {
    const paths = Array.from({ length: 21 }, (_, i) => `trips/T/expenses/e${i}/x.thumb.webp`)
    await Promise.all(paths.map(p => resolveSignedUrl(p, 'thumb')))
    expect(workerFetchMock).toHaveBeenCalledTimes(2)   // 20 + 1
  })

  it('de-dups concurrent resolves of the same path', async () => {
    const p = 'trips/T/expenses/e1/x.thumb.webp'
    const [a, b] = await Promise.all([resolveSignedUrl(p, 'thumb'), resolveSignedUrl(p, 'thumb')])
    expect(a).toBe(b)                                   // same cached entry
    expect(workerFetchMock).toHaveBeenCalledTimes(1)
    expect(workerFetchMock.mock.calls[0]![3].paths).toEqual([p])
  })

  it('serves a cache hit without re-calling the Worker', async () => {
    const p = 'trips/T/expenses/e1/x.thumb.webp'
    await resolveSignedUrl(p, 'thumb')
    workerFetchMock.mockClear()
    const again = await resolveSignedUrl(p, 'thumb')
    expect(again?.url).toBe(`signed:${p}`)
    expect(workerFetchMock).not.toHaveBeenCalled()
  })

  it('unparseable thumb path → null, no Worker call', async () => {
    const e = await resolveSignedUrl('not-a-trip-path', 'thumb')
    expect(e).toBeNull()
    expect(workerFetchMock).not.toHaveBeenCalled()
  })
})

describe('resolveSignedUrl — entity full/pdf parse', () => {
  it('expense image → variant=full, entityType=expense', async () => {
    const e = await resolveSignedUrl('trips/T/expenses/e1/r.webp', 'full')
    expect(e?.url).toBe('signed:expense/e1/full')
    const [, , endpoint, body] = workerFetchMock.mock.calls[0]!
    expect(endpoint).toBe('/attachment-url')
    expect(body).toEqual({ tripId: 'T', entityType: 'expense', entityId: 'e1', variant: 'full' })
  })

  it('.pdf file → variant=pdf', async () => {
    await resolveSignedUrl('trips/T/expenses/e1/r.pdf', 'full')
    expect(workerFetchMock.mock.calls[0]![3].variant).toBe('pdf')
  })

  it('booking path → entityType=booking', async () => {
    await resolveSignedUrl('trips/T/bookings/b1/f.jpg', 'full')
    expect(workerFetchMock.mock.calls[0]![3]).toMatchObject({ entityType: 'booking', entityId: 'b1' })
  })

  it('wish path → entityType=wish', async () => {
    await resolveSignedUrl('trips/T/wishes/w1/i.webp', 'full')
    expect(workerFetchMock.mock.calls[0]![3]).toMatchObject({ entityType: 'wish', variant: 'full' })
  })

  it('unparseable full path → null, no Worker call', async () => {
    const e = await resolveSignedUrl('garbage', 'full')
    expect(e).toBeNull()
    expect(workerFetchMock).not.toHaveBeenCalled()
  })
})

describe('resolveSignedUrl — failure + freshness + clear', () => {
  const p = 'trips/T/expenses/e1/x.thumb.webp'

  it('workerFetch throw → null', async () => {
    workerFetchMock.mockRejectedValue(new Error('boom'))
    expect(await resolveSignedUrl(p, 'thumb')).toBeNull()
  })

  it('preflight token failure → null, no Worker call', async () => {
    preflightMock.mockRejectedValue(new Error('not signed in'))
    expect(await resolveSignedUrl(p, 'thumb')).toBeNull()
    expect(workerFetchMock).not.toHaveBeenCalled()
  })

  it('a near-expiry URL is not treated as fresh → re-mints', async () => {
    workerFetchMock.mockImplementation(async (_b, _t, _ep, body) => ({
      urls: (body.paths ?? []).map(pp => ({ path: pp, url: `signed:${pp}`, expiresAt: new Date(Date.now() + 30_000).toISOString() })),
    }))
    await resolveSignedUrl(p, 'thumb')
    expect(peekSignedUrl(p, 'thumb')).toBeNull()        // < REFRESH_SKEW_MS from expiry
    await resolveSignedUrl(p, 'thumb')
    expect(workerFetchMock).toHaveBeenCalledTimes(2)    // stale → second mint
  })

  it('clearSignedUrlCache drops the cache → next resolve re-fetches', async () => {
    await resolveSignedUrl(p, 'thumb')
    expect(peekSignedUrl(p, 'thumb')?.url).toBe(`signed:${p}`)
    clearSignedUrlCache()
    expect(peekSignedUrl(p, 'thumb')).toBeNull()
    workerFetchMock.mockClear()
    await resolveSignedUrl(p, 'thumb')
    expect(workerFetchMock).toHaveBeenCalledTimes(1)
  })

  it('clear BEFORE the microtask flush settles queued thumb waiters to null (no hang)', async () => {
    // Enqueue but do NOT await — the flush microtask hasn't run yet.
    const pending = resolveSignedUrl(p, 'thumb')
    // Sign-out fires in the gap between enqueue and flush.
    clearSignedUrlCache()
    // Must resolve (to null), not hang forever; the empty flush makes no call.
    await expect(pending).resolves.toBeNull()
    expect(workerFetchMock).not.toHaveBeenCalled()
  })
})
