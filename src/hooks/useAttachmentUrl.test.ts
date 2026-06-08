// Tests for the path-only attachment resolver/hook. Mocks getFirebaseStorage
// (so getBlob is programmable) and stubs URL.createObjectURL/revokeObjectURL
// (jsdom doesn't implement them).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const getBlobMock = vi.fn()
vi.mock('@/services/firebase', () => ({
  getFirebaseStorage: vi.fn(async () => ({
    storage: {},
    ref:     (_s: unknown, path: string) => ({ path }),
    getBlob: getBlobMock,
  })),
}))

import { useAttachmentUrl, clearAttachmentUrlCache } from './useAttachmentUrl'

let urlCounter = 0
let createSpy: ReturnType<typeof vi.fn>
let revokeSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  urlCounter = 0
  createSpy = vi.fn(() => `blob:mock-${++urlCounter}`)
  revokeSpy = vi.fn()
  ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = createSpy
  ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeSpy
  getBlobMock.mockReset()
  getBlobMock.mockImplementation(async () => new Blob(['x']))
  clearAttachmentUrlCache()        // start each test with an empty module cache
  createSpy.mockClear()            // ignore the revokes/creates from clear()
  revokeSpy.mockClear()
})

describe('useAttachmentUrl: thumb', () => {
  it('resolves a thumb path to a blob objectURL via getBlob', async () => {
    const { result } = renderHook(() => useAttachmentUrl('trips/t/e/r.webp', { kind: 'thumb' }))
    expect(result.current).toBeNull()                       // null while fetching
    await waitFor(() => expect(result.current).toBe('blob:mock-1'))
    expect(getBlobMock).toHaveBeenCalledTimes(1)
  })

  it('serves a cached thumb SYNCHRONOUSLY on a later mount (no flash, no refetch)', async () => {
    const first = renderHook(() => useAttachmentUrl('p-cache', { kind: 'thumb' }))
    await waitFor(() => expect(first.result.current).toBe('blob:mock-1'))
    getBlobMock.mockClear()
    // A fresh mount for the same path returns the cached URL on first render.
    const second = renderHook(() => useAttachmentUrl('p-cache', { kind: 'thumb' }))
    expect(second.result.current).toBe('blob:mock-1')
    expect(getBlobMock).not.toHaveBeenCalled()
  })

  it('de-dups concurrent getBlob for the same path (one fetch, shared objectURL)', async () => {
    const a = renderHook(() => useAttachmentUrl('p-dedup', { kind: 'thumb' }))
    const b = renderHook(() => useAttachmentUrl('p-dedup', { kind: 'thumb' }))
    await waitFor(() => expect(a.result.current).toBe('blob:mock-1'))
    await waitFor(() => expect(b.result.current).toBe('blob:mock-1'))
    expect(getBlobMock).toHaveBeenCalledTimes(1)            // one bytes fetch
    expect(createSpy).toHaveBeenCalledTimes(1)              // one shared objectURL
  })

  it('null/undefined path → null, no fetch', () => {
    const { result } = renderHook(() => useAttachmentUrl(undefined, { kind: 'thumb' }))
    expect(result.current).toBeNull()
    expect(getBlobMock).not.toHaveBeenCalled()
  })

  it('getBlob failure resolves to null (placeholder), not a throw', async () => {
    getBlobMock.mockRejectedValue(new Error('CORS'))
    const { result } = renderHook(() => useAttachmentUrl('p-fail', { kind: 'thumb' }))
    // stays null; give the rejected promise a tick to settle.
    await new Promise(r => setTimeout(r, 0))
    expect(result.current).toBeNull()
  })
})

describe('useAttachmentUrl: full', () => {
  it('creates a PER-CALLER objectURL; one unmount revokes only its own', async () => {
    const a = renderHook(() => useAttachmentUrl('p-full', { kind: 'full' }))
    const b = renderHook(() => useAttachmentUrl('p-full', { kind: 'full' }))
    await waitFor(() => expect(a.result.current).not.toBeNull())
    await waitFor(() => expect(b.result.current).not.toBeNull())
    // Per-caller: two distinct objectURLs from one shared bytes fetch.
    expect(getBlobMock).toHaveBeenCalledTimes(1)
    expect(createSpy).toHaveBeenCalledTimes(2)
    expect(a.result.current).not.toBe(b.result.current)
    const aUrl = a.result.current!
    a.unmount()
    expect(revokeSpy).toHaveBeenCalledWith(aUrl)            // only A's url
    expect(revokeSpy).not.toHaveBeenCalledWith(b.result.current!)
  })
})

describe('clearAttachmentUrlCache', () => {
  it('revokes every cached thumb objectURL', async () => {
    const { result } = renderHook(() => useAttachmentUrl('p-clear', { kind: 'thumb' }))
    await waitFor(() => expect(result.current).toBe('blob:mock-1'))
    clearAttachmentUrlCache()
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-1')
  })

  it('revokes a live per-caller FULL objectURL and hides it after clear (P2)', async () => {
    const { result, rerender } = renderHook(
      ({ p }) => useAttachmentUrl(p, { kind: 'full' }),
      { initialProps: { p: 'p-full-clear' } },
    )
    await waitFor(() => expect(result.current).not.toBeNull())
    const fullUrl = result.current!

    // Sign-out while the full preview is open.
    clearAttachmentUrlCache()
    expect(revokeSpy).toHaveBeenCalledWith(fullUrl)   // memory freed, not just thumbs

    // Next render: epoch bumped → the stale full URL no longer surfaces even
    // though path/kind are unchanged and the component hasn't unmounted.
    rerender({ p: 'p-full-clear' })
    expect(result.current).toBeNull()
  })

  it('drops an in-flight fetch that resolves AFTER clear (no repopulation, P1)', async () => {
    // getBlob stays pending until we resolve it manually.
    let resolveBlob!: (b: Blob) => void
    getBlobMock.mockImplementation(() => new Promise<Blob>(r => { resolveBlob = r }))
    renderHook(() => useAttachmentUrl('p-epoch', { kind: 'thumb' }))
    await waitFor(() => expect(getBlobMock).toHaveBeenCalledTimes(1))

    // Sign-out happens while the fetch is in flight.
    clearAttachmentUrlCache()
    // The stale fetch now resolves — it must NOT create/cache an objectURL.
    resolveBlob(new Blob(['x']))
    await new Promise(r => setTimeout(r, 0))
    expect(createSpy).not.toHaveBeenCalled()

    // Cache is genuinely empty: a fresh mount re-fetches.
    getBlobMock.mockImplementation(async () => new Blob(['y']))
    const fresh = renderHook(() => useAttachmentUrl('p-epoch', { kind: 'thumb' }))
    await waitFor(() => expect(fresh.result.current).not.toBeNull())
    expect(getBlobMock).toHaveBeenCalledTimes(2)
  })
})

describe('useAttachmentUrl: path change', () => {
  it('clears to null immediately on change to a non-cached path (no stale, P2)', async () => {
    const { result, rerender } = renderHook(
      ({ p }) => useAttachmentUrl(p, { kind: 'thumb' }),
      { initialProps: { p: 'path-A' } },
    )
    await waitFor(() => expect(result.current).toBe('blob:mock-1'))
    // Switch to a different, not-yet-cached path: must drop A's URL at once,
    // not keep showing it until B resolves.
    rerender({ p: 'path-B' })
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toBe('blob:mock-2'))
  })
})
