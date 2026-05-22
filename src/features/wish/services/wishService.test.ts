// Regression test for deleteWish's strict-cleanup gate. Mirrors the
// deleteBooking test -- when safePurgeWithEnqueueFallback returns
// 'unrecoverable', deleteWish MUST throw before calling deleteDoc so
// the image.path → blob binding survives for a human-driven retry.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted() so the mock vars are initialized BEFORE the vi.mock
// factories run -- both are hoisted to the top of the file by the
// vitest transformer, but plain `const` declarations are not.
const mocks = vi.hoisted(() => ({
  deleteDocMock:        vi.fn(),
  bumpTripActivityMock: vi.fn(),
  safePurgeMock:        vi.fn(),
}))

vi.mock('@/services/firebase', () => ({
  getFirebase: vi.fn(async () => ({
    db:        {},
    doc:       (_db: unknown, ..._path: string[]) => ({ _kind: 'doc' }),
    deleteDoc: mocks.deleteDocMock,
  })),
  // wishService imports getFirebaseStorage at module load; provide a
  // noop so the import chain resolves.
  getFirebaseStorage: vi.fn(async () => ({})),
}))

vi.mock('@/services/orphanPurge', () => ({
  safePurgeWithEnqueueFallback: mocks.safePurgeMock,
}))

vi.mock('@/services/tripActivity', () => ({
  bumpTripActivity: mocks.bumpTripActivityMock,
}))

vi.mock('@/services/tripScopedList', () => ({
  createTripScopedListServices: () => ({ fetch: vi.fn(), subscribe: vi.fn() }),
}))

vi.mock('@/services/storageDelete', () => ({
  deleteStorageObject: vi.fn(),
}))

vi.mock('@/services/storageUpload', () => ({
  uploadFile:         vi.fn(),
  withUploadTimeout:  vi.fn(),
  UPLOAD_TIMEOUT_MS:  30_000,
}))

import { deleteWish } from './wishService'
import type { WishImage } from '@/types'

const IMAGE: WishImage = {
  url:       'https://example.com/full.webp',
  path:      'trips/t1/wishes/w1/full.webp',
  thumbUrl:  'https://example.com/thumb.webp',
  thumbPath: 'trips/t1/wishes/w1/thumb.webp',
}

beforeEach(() => {
  mocks.deleteDocMock.mockReset()
  mocks.bumpTripActivityMock.mockReset()
  mocks.safePurgeMock.mockReset()
})

describe('deleteWish strict-cleanup gate', () => {
  it('throws + skips deleteDoc when safePurge returns "unrecoverable"', async () => {
    mocks.safePurgeMock.mockResolvedValueOnce('unrecoverable')

    await expect(deleteWish('t1', 'w1', 'u1', IMAGE))
      .rejects.toThrow(/カバー画像|再試行/)

    expect(mocks.deleteDocMock).not.toHaveBeenCalled()
    expect(mocks.bumpTripActivityMock).not.toHaveBeenCalled()
  })

  it('proceeds with deleteDoc when safePurge returns "purged"', async () => {
    mocks.safePurgeMock.mockResolvedValueOnce('purged')
    mocks.deleteDocMock.mockResolvedValue(undefined)

    await deleteWish('t1', 'w1', 'u1', IMAGE)

    expect(mocks.deleteDocMock).toHaveBeenCalledTimes(1)
  })

  it('proceeds with deleteDoc when safePurge returns "queued"', async () => {
    mocks.safePurgeMock.mockResolvedValueOnce('queued')
    mocks.deleteDocMock.mockResolvedValue(undefined)

    await deleteWish('t1', 'w1', 'u1', IMAGE)

    expect(mocks.deleteDocMock).toHaveBeenCalledTimes(1)
  })

  it('skips safePurge entirely when no image, goes straight to deleteDoc', async () => {
    mocks.deleteDocMock.mockResolvedValue(undefined)

    await deleteWish('t1', 'w1', 'u1', undefined)

    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
    expect(mocks.deleteDocMock).toHaveBeenCalledTimes(1)
  })
})
