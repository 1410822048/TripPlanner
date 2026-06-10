// Signed-mode behaviour of useAttachmentUrl. Kept in its own file because the
// resolver mock forces attachmentUrlMode('full') = 'signed' for the whole
// module; the getBlob-branch tests live in useAttachmentUrl.test.ts.
//
// Signed is FULL/PDF only — thumbnails are pinned to getBlob (signed thumb was
// removed, design §7), so the mock returns 'getBlob' for thumb and these tests
// only cover the full signed path + its near-expiry re-mint.
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
  attachmentUrlMode:   (kind: string) => (kind === 'full' ? 'signed' : 'getBlob'),
  resolveSignedUrl:    resolveMock,
  peekSignedUrl:       () => null,
  clearSignedUrlCache: clearMock,
  REFRESH_SKEW_MS:     60_000,
}))

import { useAttachmentUrl } from './useAttachmentUrl'

beforeEach(() => {
  getBlobMock.mockReset()
  resolveMock.mockReset()
  resolveMock.mockResolvedValue({ url: 'https://gcs/signed-1', expiresAtMs: Date.now() + 10 * 60 * 1000 })
})

describe('useAttachmentUrl: signed mode (full/pdf only)', () => {
  it('full resolves to the Worker-minted URL — never calls getBlob', async () => {
    const path = 'trips/T/expenses/e1/r.webp'
    const { result } = renderHook(() => useAttachmentUrl(path, { kind: 'full' }))
    await waitFor(() => expect(result.current).toBe('https://gcs/signed-1'))
    expect(resolveMock).toHaveBeenCalledWith(path)
    expect(getBlobMock).not.toHaveBeenCalled()
  })

  it('thumb stays on getBlob — never calls the signed resolver', async () => {
    getBlobMock.mockResolvedValue(undefined)   // routing-only; null blob → null url
    const { result } = renderHook(() => useAttachmentUrl('trips/T/expenses/e1/x.thumb.webp', { kind: 'thumb' }))
    await new Promise(r => setTimeout(r, 0))
    expect(resolveMock).not.toHaveBeenCalled()
    expect(getBlobMock).toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it('null path → null, no resolve', () => {
    const { result } = renderHook(() => useAttachmentUrl(undefined, { kind: 'full' }))
    expect(result.current).toBeNull()
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it('resolver null (failure) → null placeholder', async () => {
    resolveMock.mockResolvedValue(null)
    const { result } = renderHook(() => useAttachmentUrl('trips/T/expenses/e1/r.webp', { kind: 'full' }))
    await new Promise(r => setTimeout(r, 0))
    expect(result.current).toBeNull()
  })

  it('full re-mints near expiry (P2)', async () => {
    vi.useFakeTimers()
    try {
      const TTL = 10 * 60 * 1000
      // Fresh expiry per call so the re-mint advances expiry forward (no 0ms
      // refresh loop) rather than returning a fixed past timestamp.
      resolveMock.mockImplementation(async () => ({ url: 'https://gcs/x', expiresAtMs: Date.now() + TTL }))

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
