// Regression test for deleteBooking's strict-cleanup gate.
//
// The headline invariant: if safePurgeWithEnqueueFallback returns
// 'unrecoverable' (both in-process purge AND `_purges` enqueue
// rejected), deleteBooking MUST throw BEFORE calling deleteDoc.
// Without this gate, the doc-delete proceeds and the
// attachment.path → blob binding vanishes from every future cleanup
// attempt (cron has nothing to verify against, trip cascade only
// catches blobs under `trips/{tripId}/...` whose owning doc is gone),
// leaving the bytes billing forever with zero recovery path.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted() so the mock vars are initialized BEFORE the vi.mock
// factories run -- both are hoisted to the top of the file by the
// vitest transformer, but plain `const` declarations are not.
const mocks = vi.hoisted(() => ({
  deleteDocMock:        vi.fn(),
  bumpTripActivityMock: vi.fn(),
  safePurgeMock:        vi.fn(),
  purgeAttachmentsMock: vi.fn(),
}))

vi.mock('@/services/firebase', () => ({
  getFirebase: vi.fn(async () => ({
    db:        {},
    doc:       (_db: unknown, ..._path: string[]) => ({ _kind: 'doc' }),
    deleteDoc: mocks.deleteDocMock,
  })),
}))

vi.mock('@/services/orphanPurge', () => ({
  safePurgeWithEnqueueFallback: mocks.safePurgeMock,
}))

vi.mock('./bookingStorage', () => ({
  uploadAttachment:  vi.fn(),
  purgeAttachments:  mocks.purgeAttachmentsMock,
}))

vi.mock('@/services/tripActivity', () => ({
  bumpTripActivity: mocks.bumpTripActivityMock,
}))

// tripScopedList factory pulls in createTripScopedListServices side
// effects at import-time; stub to a noop pair so the module loads.
vi.mock('@/services/tripScopedList', () => ({
  createTripScopedListServices: () => ({ fetch: vi.fn(), subscribe: vi.fn() }),
}))

import { deleteBooking } from './bookingService'
import type { BookingAttachment } from '@/types'

const ATTACHMENT: BookingAttachment = {
  fileUrl:   'https://example.com/full.webp',
  filePath:  'trips/t1/bookings/b1/full.webp',
  fileType:  'image/webp',
  thumbUrl:  'https://example.com/thumb.webp',
  thumbPath: 'trips/t1/bookings/b1/thumb.webp',
}

beforeEach(() => {
  mocks.deleteDocMock.mockReset()
  mocks.bumpTripActivityMock.mockReset()
  mocks.safePurgeMock.mockReset()
  mocks.purgeAttachmentsMock.mockReset()
})

describe('deleteBooking strict-cleanup gate', () => {
  it('throws + skips deleteDoc when safePurge returns "unrecoverable"', async () => {
    mocks.safePurgeMock.mockResolvedValueOnce('unrecoverable')

    await expect(deleteBooking('t1', 'b1', 'u1', ATTACHMENT))
      .rejects.toThrow(/添付ファイル|再試行/)

    expect(mocks.deleteDocMock).not.toHaveBeenCalled()
    expect(mocks.bumpTripActivityMock).not.toHaveBeenCalled()
  })

  it('proceeds with deleteDoc when safePurge returns "purged"', async () => {
    mocks.safePurgeMock.mockResolvedValueOnce('purged')
    mocks.deleteDocMock.mockResolvedValue(undefined)

    await deleteBooking('t1', 'b1', 'u1', ATTACHMENT)

    expect(mocks.deleteDocMock).toHaveBeenCalledTimes(1)
  })

  it('proceeds with deleteDoc when safePurge returns "queued" (cron will drain)', async () => {
    mocks.safePurgeMock.mockResolvedValueOnce('queued')
    mocks.deleteDocMock.mockResolvedValue(undefined)

    await deleteBooking('t1', 'b1', 'u1', ATTACHMENT)

    expect(mocks.deleteDocMock).toHaveBeenCalledTimes(1)
  })

  it('skips safePurge entirely when no attachment, goes straight to deleteDoc', async () => {
    mocks.deleteDocMock.mockResolvedValue(undefined)

    await deleteBooking('t1', 'b1', 'u1', undefined)

    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
    expect(mocks.deleteDocMock).toHaveBeenCalledTimes(1)
  })
})
