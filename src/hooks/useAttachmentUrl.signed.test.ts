// Signed-mode behaviour of useAttachmentUrl. Kept in its own file because the
// resolver mock forces attachmentUrlMode() = 'signed' for the whole module;
// the getBlob-branch tests live in useAttachmentUrl.test.ts (default mode).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

const { getBlobMock, resolveMock, clearMock } = vi.hoisted(() => ({
  getBlobMock: vi.fn(),
  resolveMock: vi.fn(),
  clearMock:   vi.fn(),
}))

vi.mock('@/services/firebase', () => ({
  getFirebaseStorage: vi.fn(async () => ({ storage: {}, ref: (_s: unknown, p: string) => ({ path: p }), getBlob: getBlobMock })),
}))

vi.mock('@/services/attachmentUrlResolver', () => ({
  attachmentUrlMode:    () => 'signed',
  resolveSignedUrl:     resolveMock,
  peekSignedUrl:        () => null,
  clearSignedUrlCache:  clearMock,
  REFRESH_SKEW_MS:      60_000,
}))

import { useAttachmentUrl } from './useAttachmentUrl'

beforeEach(() => {
  getBlobMock.mockReset()
  resolveMock.mockReset()
  resolveMock.mockResolvedValue({ url: 'https://gcs/signed-1', expiresAtMs: Date.now() + 30 * 60 * 1000 })
})

describe('useAttachmentUrl: signed mode', () => {
  it('thumb resolves to the Worker-minted URL — never calls getBlob', async () => {
    const path = 'trips/T/expenses/e1/x.thumb.webp'
    const { result } = renderHook(() => useAttachmentUrl(path, { kind: 'thumb' }))
    await waitFor(() => expect(result.current).toBe('https://gcs/signed-1'))
    expect(resolveMock).toHaveBeenCalledWith(path, 'thumb')
    expect(getBlobMock).not.toHaveBeenCalled()
  })

  it('full resolves to the Worker-minted URL', async () => {
    resolveMock.mockResolvedValueOnce({ url: 'https://gcs/full-1', expiresAtMs: Date.now() + 10 * 60 * 1000 })
    const path = 'trips/T/expenses/e1/r.webp'
    const { result } = renderHook(() => useAttachmentUrl(path, { kind: 'full' }))
    await waitFor(() => expect(result.current).toBe('https://gcs/full-1'))
    expect(resolveMock).toHaveBeenCalledWith(path, 'full')
  })

  it('null path → null, no resolve', () => {
    const { result } = renderHook(() => useAttachmentUrl(undefined, { kind: 'thumb' }))
    expect(result.current).toBeNull()
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it('resolver null (failure) → null placeholder', async () => {
    resolveMock.mockResolvedValue(null)
    const { result } = renderHook(() => useAttachmentUrl('trips/T/expenses/e1/x.thumb.webp', { kind: 'thumb' }))
    await new Promise(r => setTimeout(r, 0))
    expect(result.current).toBeNull()
  })

  it('thumb does NOT auto-refresh; full DOES re-mint near expiry (P2)', async () => {
    vi.useFakeTimers()
    try {
      const TTL = 30 * 60 * 1000
      // Fresh expiry per call so the full re-mint advances expiry forward
      // (no 0ms refresh loop) rather than returning a fixed past timestamp.
      resolveMock.mockImplementation(async () => ({ url: 'https://gcs/x', expiresAtMs: Date.now() + TTL }))

      // thumb: resolved once on mount, NEVER re-signed in the background even
      // after the URL's TTL fully elapses.
      const thumb = renderHook(() => useAttachmentUrl('trips/T/expenses/e1/x.thumb.webp', { kind: 'thumb' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(resolveMock).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(TTL + 5 * 60 * 1000) })
      expect(resolveMock).toHaveBeenCalledTimes(1)   // no background re-sign for thumb
      thumb.unmount()

      resolveMock.mockClear()

      // full: re-mints once we cross (expiry - REFRESH_SKEW_MS).
      const full = renderHook(() => useAttachmentUrl('trips/T/expenses/e1/r.webp', { kind: 'full' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(resolveMock).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(TTL) })
      expect(resolveMock.mock.calls.length).toBeGreaterThanOrEqual(2)   // full auto-refreshes
      full.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
