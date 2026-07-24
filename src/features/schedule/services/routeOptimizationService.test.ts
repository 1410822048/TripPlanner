import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { workerFetch, preflightIdToken, WorkerAmbiguous, WorkerRejected } = vi.hoisted(() => {
  class MockWorkerAmbiguous extends Error {
    readonly cause: unknown
    constructor(message: string, cause: unknown) {
      super(message)
      this.name = 'WorkerAmbiguous'
      this.cause = cause
    }
  }
  class MockWorkerRejected extends Error {
    readonly status: number
    readonly code?: string
    readonly field?: string
    constructor(status: number, message: string, code?: string, field?: string) {
      super(message)
      this.name = 'WorkerRejected'
      this.status = status
      this.code = code
      this.field = field
    }
  }
  return {
    workerFetch: vi.fn(),
    preflightIdToken: vi.fn(),
    WorkerAmbiguous: MockWorkerAmbiguous,
    WorkerRejected: MockWorkerRejected,
  }
})

vi.mock('@/services/workerBase', () => ({
  WORKER_BASE_URL: 'https://worker.example.test',
  preflightIdToken,
  requireWorkerWriteBase: vi.fn(() => 'https://worker.example.test'),
  workerFetch,
  WorkerAmbiguous,
  WorkerRejected,
}))

import {
  applyRoutePreview,
  clearRoutePlaceSearchCache,
  requestRouteAutocomplete,
  requestRoutePlaceResolution,
  requestRoutePreview,
  routeErrorMessage,
  type RoutePreview,
} from './routeOptimizationService'

const previewResponse = {
  previewRevision: 'r'.repeat(16),
  scheduleInputHash: 'i'.repeat(16),
  payloadHash: 'p'.repeat(16),
  previewToken: 't'.repeat(32),
  expiresAt: '2026-07-20T00:00:00.000Z',
  canApply: true,
  routeChanged: true,
  geometryDegraded: false,
  confidence: 'transit-unverified',
  timeConflictScheduleIds: [],
  applyPlan: { revision: 'r'.repeat(16), date: '2026-07-20', schedules: [] },
  display: { type: 'FeatureCollection', features: [] },
  legs: [],
} satisfies RoutePreview

describe('requestRoutePlaceResolution', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends Google Maps URLs only to the resolver endpoint and validates candidates', async () => {
    preflightIdToken.mockResolvedValue('firebase-id-token')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      query: '江ノ島',
      candidates: [{
        provider: 'google-maps',
        providerPlaceId: 'google-maps:enoshima',
        name: '江ノ島',
        lat: 35.299,
        lng: 139.481,
        timeZone: 'Asia/Tokyo',
        countryCode: 'JP',
      }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await expect(requestRoutePlaceResolution(
      'trip-1',
      'https://maps.app.goo.gl/Enoshima123',
      controller.signal,
      { biasCountryCode: 'JP', normalizationCountryCode: 'JP' },
    )).resolves.toMatchObject([{
      provider: 'google-maps',
      providerPlaceId: 'google-maps:enoshima',
    }])

    expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.example.test/route-resolve-place',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          tripId: 'trip-1',
          googleMapsUrl: 'https://maps.app.goo.gl/Enoshima123',
          bias: { countryCode: 'JP', normalizationCountryCode: 'JP' },
        }),
        signal: expect.any(AbortSignal),
      }),
    )
  })
})

describe('route place search cache', () => {
  beforeEach(() => {
    clearRoutePlaceSearchCache()
    preflightIdToken.mockReset()
    preflightIdToken.mockResolvedValue('firebase-id-token')
  })
  afterEach(() => vi.unstubAllGlobals())

  const candidate = {
    provider: 'geoapify',
    providerPlaceId: 'hase',
    name: '長谷駅',
    lat: 35.311,
    lng: 139.536,
    timeZone: 'Asia/Tokyo',
    countryCode: 'JP',
  }

  it('deduplicates identical in-flight requests and reuses the five-minute memory result', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([candidate]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const first = new AbortController()
    const second = new AbortController()
    const context = { biasCountryCode: 'JP', normalizationCountryCode: 'JP' }

    await Promise.all([
      requestRouteAutocomplete('trip-1', '長谷站', first.signal, context),
      requestRouteAutocomplete('trip-1', '長谷站', second.signal, context),
    ])
    await requestRouteAutocomplete('trip-1', '長谷站', new AbortController().signal, context)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(preflightIdToken).toHaveBeenCalledTimes(1)
  })

  it('keeps country context in the cache identity', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([candidate]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await requestRouteAutocomplete('trip-1', '中央站', new AbortController().signal, { biasCountryCode: 'JP' })
    await requestRouteAutocomplete('trip-1', '中央站', new AbortController().signal, { biasCountryCode: 'TW' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not cache failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([candidate]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestRouteAutocomplete('trip-1', '長谷站', new AbortController().signal)).rejects.toThrow()
    await requestRouteAutocomplete('trip-1', '長谷站', new AbortController().signal)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('aborts one caller without cancelling a shared provider request', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetchMock = vi.fn(async () => {
      await gate
      return new Response(JSON.stringify([candidate]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const first = new AbortController()
    const second = new AbortController()
    const aborted = requestRouteAutocomplete('trip-1', '長谷站', first.signal)
    const surviving = requestRouteAutocomplete('trip-1', '長谷站', second.signal)
    first.abort()
    release()

    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    await expect(surviving).resolves.toEqual([candidate])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('requestRoutePreview', () => {
  beforeEach(() => {
    workerFetch.mockReset()
    preflightIdToken.mockReset()
    preflightIdToken.mockResolvedValue('firebase-id-token')
    workerFetch.mockResolvedValue(previewResponse)
  })

  it('shares an identical in-flight preview request', async () => {
    await Promise.all([
      requestRoutePreview('trip-1', '2026-07-20'),
      requestRoutePreview('trip-1', '2026-07-20'),
    ])

    expect(preflightIdToken).toHaveBeenCalledTimes(1)
    expect(workerFetch).toHaveBeenCalledTimes(1)
    expect(workerFetch).toHaveBeenCalledWith(
      'https://worker.example.test',
      'firebase-id-token',
      '/route-preview',
      { tripId: 'trip-1', date: '2026-07-20' },
      { timeoutMs: 35_000 },
    )
  })

  it.each([
    ['PREVIEW_STALE', '行程已變更，請重新產生預覽'],
    ['ROUTE_EDITOR_REQUIRED', '你沒有整理此行程的權限'],
    ['ROUTE_PREVIEW_DEADLINE', '路線預覽逾時，請稍後再試'],
    ['ROUTE_PROVIDER_ERROR', '路線服務暫時無法使用，請稍後再試'],
  ])('maps %s to stable Traditional Chinese copy', (code, copy) => {
    expect(routeErrorMessage(
      new WorkerRejected(409, 'backend English detail', code, 'schedules'),
      'preview',
    )).toBe(copy)
  })

  it('releases a failed request so the user can retry', async () => {
    workerFetch.mockRejectedValueOnce(new Error('provider unavailable'))

    await expect(requestRoutePreview('trip-1', '2026-07-20')).rejects.toThrow('provider unavailable')
    await requestRoutePreview('trip-1', '2026-07-20')

    expect(workerFetch).toHaveBeenCalledTimes(2)
  })

  it('accepts time-conflict metadata without receiving replacement times', async () => {
    workerFetch.mockResolvedValueOnce({
      ...previewResponse,
      timeConflictScheduleIds: ['schedule-1'],
    })

    await expect(requestRoutePreview('trip-fractional', '2026-07-20')).resolves.toMatchObject({
      timeConflictScheduleIds: ['schedule-1'],
    })
  })

  it('accepts a bounded static transit estimate for a long leg', async () => {
    workerFetch.mockResolvedValueOnce({
      ...previewResponse,
      legs: [{
        legIndex: 0,
        fromId: 'a',
        toId: 'b',
        kind: 'transit-check',
        walkingMinutes: 38,
        geometryAvailable: false,
        transitEstimate: {
          minMinutes: 20,
          maxMinutes: 30,
          basis: 'ors-walking-distance',
        },
      }],
    })

    await expect(requestRoutePreview('trip-static-estimate', '2026-07-20')).resolves.toMatchObject({
      legs: [{ transitEstimate: { minMinutes: 20, maxMinutes: 30 } }],
    })
  })

  it('rejects an inverted static transit estimate range', async () => {
    workerFetch.mockResolvedValueOnce({
      ...previewResponse,
      legs: [{
        legIndex: 0,
        fromId: 'a',
        toId: 'b',
        kind: 'transit-check',
        walkingMinutes: 38,
        geometryAvailable: false,
        transitEstimate: {
          minMinutes: 30,
          maxMinutes: 20,
          basis: 'ors-walking-distance',
        },
      }],
    })

    await expect(requestRoutePreview('trip-invalid-estimate', '2026-07-20'))
      .rejects.toThrow('Worker 回傳的路線資料格式不相容，請確認 Worker 已更新')
  })

  it('reports an incompatible Worker response in Traditional Chinese', async () => {
    workerFetch.mockResolvedValueOnce({ legacy: true })

    await expect(requestRoutePreview('trip-legacy-worker', '2026-07-20'))
      .rejects.toThrow('Worker 回傳的路線資料格式不相容，請確認 Worker 已更新')
  })

  it('applies only the signed schedule order', async () => {
    workerFetch.mockResolvedValueOnce({ status: 'applied', revision: 'r'.repeat(16) })
    await applyRoutePreview('trip-1', {
      ...previewResponse,
      applyPlan: {
        revision: 'r'.repeat(16),
        date: '2026-07-20',
        schedules: [{ id: 'a', order: 0 }, { id: 'b', order: 1 }],
      },
    })

    expect(workerFetch).toHaveBeenLastCalledWith(
      'https://worker.example.test',
      'firebase-id-token',
      '/route-apply',
      expect.objectContaining({
        schedules: [{ id: 'a', order: 0 }, { id: 'b', order: 1 }],
      }),
    )
  })

  it('recovers an ambiguous apply response through the signed revision status', async () => {
    const ambiguous = new WorkerAmbiguous('response lost', new Error('network'))
    workerFetch
      .mockRejectedValueOnce(ambiguous)
      .mockResolvedValueOnce({
        status: 'applied',
        revision: 'r'.repeat(16),
        appliedAt: '2026-07-20T00:00:00.000Z',
      })

    await expect(applyRoutePreview('trip-1', {
      ...previewResponse,
      applyPlan: {
        revision: 'r'.repeat(16),
        date: '2026-07-20',
        schedules: [{ id: 'a', order: 0 }, { id: 'b', order: 1 }],
      },
    })).resolves.toEqual({ status: 'already_applied', revision: 'r'.repeat(16) })

    expect(workerFetch).toHaveBeenNthCalledWith(
      2,
      'https://worker.example.test',
      'firebase-id-token',
      '/route-apply-status',
      { tripId: 'trip-1', revision: 'r'.repeat(16) },
    )
  })

  it('preserves the original ambiguous error when no receipt exists', async () => {
    const ambiguous = new WorkerAmbiguous('response lost', new Error('network'))
    workerFetch
      .mockRejectedValueOnce(ambiguous)
      .mockResolvedValueOnce({ status: 'not_found', revision: 'r'.repeat(16) })

    await expect(applyRoutePreview('trip-1', previewResponse)).rejects.toBe(ambiguous)
  })
})
