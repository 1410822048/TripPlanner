import { afterEach, describe, expect, it, vi } from 'vitest'

const jsonResponse = (value: unknown, init: ResponseInit = {}) => new Response(
  JSON.stringify(value),
  {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    ...init,
  },
)

async function loadService() {
  vi.resetModules()
  return import('./clientCompatibility')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('client compatibility manifest contract', () => {
  it('projects the two decision fields and tolerates unknown manifest fields', async () => {
    const { parseCompatibilityManifest } = await loadService()

    expect(parseCompatibilityManifest({ revision: 2, minimumWriteEpoch: 1 }))
      .toEqual({ revision: 2, minimumWriteEpoch: 1 })
    // Forward compatibility: a future manifest field must not break the
    // parser already deployed in installed bundles.
    expect(parseCompatibilityManifest({ revision: 1, minimumWriteEpoch: 1, extra: true }))
      .toEqual({ revision: 1, minimumWriteEpoch: 1 })
    expect(() => parseCompatibilityManifest({ revision: 1 }))
      .toThrow('非負安全整數')
    expect(() => parseCompatibilityManifest({ revision: -1, minimumWriteEpoch: 1 }))
      .toThrow('非負安全整數')
    expect(() => parseCompatibilityManifest({ revision: 1.5, minimumWriteEpoch: 1 }))
      .toThrow('非負安全整數')
    expect(() => parseCompatibilityManifest([])).toThrow('JSON object')
  })

  it('allows an equal epoch and blocks an obsolete client synchronously', async () => {
    const service = await loadService()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ revision: 1, minimumWriteEpoch: 1 }))
      .mockResolvedValueOnce(jsonResponse({ revision: 2, minimumWriteEpoch: 2 }))
    vi.stubGlobal('fetch', fetchMock)

    await service.refreshClientCompatibility()
    expect(service.getClientCompatibilitySnapshot().updateRequired).toBe(false)
    expect(service.getClientWriteBlockReason()).toBeNull()

    await service.refreshClientCompatibility()
    expect(service.getClientCompatibilitySnapshot().updateRequired).toBe(true)
    expect(service.getClientWriteBlockReason()).toBe('請先更新 App 才能儲存')
    expect(() => service.assertClientWriteCompatible()).toThrow('請先更新 App 才能儲存')
  })

  it('ignores older revisions but lets a newer revision lower the minimum for rollback', async () => {
    const service = await loadService()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ revision: 5, minimumWriteEpoch: 2 }))
      .mockResolvedValueOnce(jsonResponse({ revision: 4, minimumWriteEpoch: 0 }))
      .mockResolvedValueOnce(jsonResponse({ revision: 6, minimumWriteEpoch: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    await service.refreshClientCompatibility()
    expect(service.getClientCompatibilitySnapshot().updateRequired).toBe(true)

    await service.refreshClientCompatibility()
    expect(service.getClientCompatibilitySnapshot().manifest)
      .toEqual({ revision: 5, minimumWriteEpoch: 2 })

    await service.refreshClientCompatibility()
    expect(service.getClientCompatibilitySnapshot())
      .toEqual({ manifest: { revision: 6, minimumWriteEpoch: 1 }, updateRequired: false })
  })

  it('rejects conflicting content at the same revision without changing the decision', async () => {
    const service = await loadService()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ revision: 3, minimumWriteEpoch: 1 }))
      .mockResolvedValueOnce(jsonResponse({ revision: 3, minimumWriteEpoch: 2 }))
    vi.stubGlobal('fetch', fetchMock)

    await service.refreshClientCompatibility()
    await expect(service.refreshClientCompatibility()).rejects.toThrow('相同 revision')
    expect(service.getClientCompatibilitySnapshot())
      .toEqual({ manifest: { revision: 3, minimumWriteEpoch: 1 }, updateRequired: false })
  })

  it.each([
    ['404', () => new Response(null, { status: 404 })],
    ['HTML fallback', () => new Response('<html></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })],
    ['malformed JSON', () => new Response('{', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })],
    ['oversized body', () => new Response(`{"revision":1,"minimumWriteEpoch":1,"padding":"${'x'.repeat(1_024)}"}`, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })],
  ])('keeps an unknown client fail-open after a %s response', async (_label, response) => {
    const service = await loadService()
    vi.stubGlobal('fetch', vi.fn(async () => response()))

    await expect(service.refreshClientCompatibility()).rejects.toBeInstanceOf(Error)
    expect(service.getClientCompatibilitySnapshot())
      .toEqual({ manifest: null, updateRequired: false })
    expect(() => service.assertClientWriteCompatible()).not.toThrow()
  })

  it('deduplicates concurrent refreshes into one network request', async () => {
    const service = await loadService()
    let resolveFetch!: (response: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)

    const first = service.refreshClientCompatibility()
    const second = service.refreshClientCompatibility()

    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledOnce()

    resolveFetch(jsonResponse({ revision: 1, minimumWriteEpoch: 1 }))
    await expect(first).resolves.toMatchObject({ updateRequired: false })
  })

  it('hydrates from storage and accepts only a newer cross-tab decision', async () => {
    window.localStorage.setItem(
      'tripmate:client-compatibility:v1',
      JSON.stringify({ revision: 7, minimumWriteEpoch: 2 }),
    )
    const service = await loadService()

    expect(service.getClientCompatibilitySnapshot().updateRequired).toBe(true)
    service.syncClientCompatibilityFromStorage(null)
    service.syncClientCompatibilityFromStorage(JSON.stringify({ revision: 6, minimumWriteEpoch: 0 }))
    expect(service.getClientCompatibilitySnapshot().updateRequired).toBe(true)

    service.syncClientCompatibilityFromStorage(JSON.stringify({ revision: 8, minimumWriteEpoch: 1 }))
    expect(service.getClientCompatibilitySnapshot())
      .toEqual({ manifest: { revision: 8, minimumWriteEpoch: 1 }, updateRequired: false })
  })
})
