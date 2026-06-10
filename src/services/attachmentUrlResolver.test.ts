// Tests for the signed-URL resolver (full/pdf entity-ref only — thumb signing
// was removed, design §7). Mocks ./workerBase (workerFetch + preflightIdToken
// + requireWorkerWriteBase) so no network / firebase; asserts entity-ref
// parsing, caching, dedup, freshness, fail-closed base, and clear.
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface WFBody { tripId?: string; entityType?: string; entityId?: string; variant?: string }

const { workerFetchMock, preflightMock, requireBaseMock } = vi.hoisted(() => ({
  workerFetchMock: vi.fn<(base: string, tok: string, endpoint: string, body: WFBody) => Promise<unknown>>(),
  preflightMock:   vi.fn<() => Promise<string>>(),
  requireBaseMock: vi.fn<() => string>(),
}))

vi.mock('./workerBase', () => ({
  requireWorkerWriteBase: requireBaseMock,
  preflightIdToken:       preflightMock,
  workerFetch:            workerFetchMock,
}))

import {
  resolveSignedUrl,
  peekSignedUrl,
  clearSignedUrlCache,
  attachmentUrlMode,
} from './attachmentUrlResolver'

const future = (ms = 30 * 60 * 1000) => new Date(Date.now() + ms).toISOString()

/** Default mock: entity returns a url tagged with the derived coords so tests
 *  can assert the parse. */
function defaultWorkerFetch() {
  workerFetchMock.mockImplementation(async (_base, _tok, _endpoint, body) =>
    ({ url: `signed:${body.entityType}/${body.entityId}/${body.variant}`, expiresAt: future() }))
}

beforeEach(() => {
  clearSignedUrlCache()
  workerFetchMock.mockReset()
  defaultWorkerFetch()
  preflightMock.mockReset()
  preflightMock.mockResolvedValue('tok')
  requireBaseMock.mockReset()
  requireBaseMock.mockReturnValue('http://worker')
})

describe('attachmentUrlMode', () => {
  it('thumb is pinned to getBlob regardless of env; full reads env', () => {
    expect(attachmentUrlMode('thumb')).toBe('getBlob')
    expect(attachmentUrlMode('full')).toBe('getBlob')

    // global signed → full signed, thumb STILL getBlob (signed thumb removed)
    vi.stubEnv('VITE_ATTACHMENT_URL_MODE', 'signed')
    expect(attachmentUrlMode('full')).toBe('signed')
    expect(attachmentUrlMode('thumb')).toBe('getBlob')
    vi.unstubAllEnvs()

    // full per-kind override opts full in without the global; thumb unmoved
    vi.stubEnv('VITE_ATTACHMENT_FULL_URL_MODE', 'signed')
    expect(attachmentUrlMode('full')).toBe('signed')
    expect(attachmentUrlMode('thumb')).toBe('getBlob')
    vi.unstubAllEnvs()
  })
})

describe('resolveSignedUrl — entity full/pdf parse', () => {
  it('expense image → variant=full, entityType=expense', async () => {
    const e = await resolveSignedUrl('trips/T/expenses/e1/r.webp')
    expect(e?.url).toBe('signed:expense/e1/full')
    const [, , endpoint, body] = workerFetchMock.mock.calls[0]!
    expect(endpoint).toBe('/attachment-url')
    expect(body).toEqual({ tripId: 'T', entityType: 'expense', entityId: 'e1', variant: 'full' })
  })

  it('.pdf file → variant=pdf', async () => {
    await resolveSignedUrl('trips/T/expenses/e1/r.pdf')
    expect(workerFetchMock.mock.calls[0]![3].variant).toBe('pdf')
  })

  it('booking path → entityType=booking', async () => {
    await resolveSignedUrl('trips/T/bookings/b1/f.jpg')
    expect(workerFetchMock.mock.calls[0]![3]).toMatchObject({ entityType: 'booking', entityId: 'b1' })
  })

  it('wish path → entityType=wish', async () => {
    await resolveSignedUrl('trips/T/wishes/w1/i.webp')
    expect(workerFetchMock.mock.calls[0]![3]).toMatchObject({ entityType: 'wish', variant: 'full' })
  })

  it('unparseable path → null, no Worker call', async () => {
    expect(await resolveSignedUrl('garbage')).toBeNull()
    expect(workerFetchMock).not.toHaveBeenCalled()
  })

  it('de-dups concurrent resolves of the same path', async () => {
    const p = 'trips/T/expenses/e1/r.webp'
    const [a, b] = await Promise.all([resolveSignedUrl(p), resolveSignedUrl(p)])
    expect(a).toBe(b)
    expect(workerFetchMock).toHaveBeenCalledTimes(1)
  })

  it('serves a cache hit without re-calling the Worker', async () => {
    const p = 'trips/T/expenses/e1/r.webp'
    await resolveSignedUrl(p)
    workerFetchMock.mockClear()
    const again = await resolveSignedUrl(p)
    expect(again?.url).toBe('signed:expense/e1/full')
    expect(workerFetchMock).not.toHaveBeenCalled()
  })
})

describe('resolveSignedUrl — failure + freshness + clear', () => {
  const p = 'trips/T/expenses/e1/r.webp'

  it('workerFetch throw → null', async () => {
    workerFetchMock.mockRejectedValue(new Error('boom'))
    expect(await resolveSignedUrl(p)).toBeNull()
  })

  it('preflight token failure → null, no Worker call', async () => {
    preflightMock.mockRejectedValue(new Error('not signed in'))
    expect(await resolveSignedUrl(p)).toBeNull()
    expect(workerFetchMock).not.toHaveBeenCalled()
  })

  it('signed base missing (requireWorkerWriteBase throws) → null, no prod fallback', async () => {
    requireBaseMock.mockImplementation(() => { throw new Error('VITE_WORKER_BASE_URL not set') })
    expect(await resolveSignedUrl(p)).toBeNull()
    expect(workerFetchMock).not.toHaveBeenCalled()   // fail-closed, not silently-prod
  })

  it('a near-expiry URL is not treated as fresh → re-mints', async () => {
    workerFetchMock.mockImplementation(async (_b, _t, _ep, body) =>
      ({ url: `signed:${body.entityId}`, expiresAt: new Date(Date.now() + 30_000).toISOString() }))
    await resolveSignedUrl(p)
    expect(peekSignedUrl(p)).toBeNull()        // < REFRESH_SKEW_MS from expiry
    await resolveSignedUrl(p)
    expect(workerFetchMock).toHaveBeenCalledTimes(2)   // stale → second mint
  })

  it('clearSignedUrlCache drops the cache → next resolve re-fetches', async () => {
    await resolveSignedUrl(p)
    expect(peekSignedUrl(p)?.url).toBe('signed:expense/e1/full')
    clearSignedUrlCache()
    expect(peekSignedUrl(p)).toBeNull()
    workerFetchMock.mockClear()
    await resolveSignedUrl(p)
    expect(workerFetchMock).toHaveBeenCalledTimes(1)
  })
})
