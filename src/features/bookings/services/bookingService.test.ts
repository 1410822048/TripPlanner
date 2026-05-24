// Service-layer regression tests for bookingService.
//
// Three surfaces pinned here:
//   1. deleteBooking strict-cleanup gate — when both purge AND
//      `_purges` enqueue reject, abort BEFORE deleting the doc so
//      the attachment.path → blob binding survives a human-driven
//      retry. Without this, the doc-delete proceeds and the path
//      vanishes from every future cleanup attempt.
//   2. createBooking upload→setDoc ordering — upload first to a
//      unique-suffix path, then setDoc; if setDoc rejects, the new
//      blob routes through safePurge/_purges. Upload failure throws
//      before any doc lands, so no orphan ladder needed for that case.
//   3. updateBooking file replace rollback symmetry — upload NEW
//      first, then updateDoc. On reject: NEW enqueued, OLD untouched
//      (doc still references it). On success: OLD purged. Same
//      ordering pattern as expense / wish.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted() so the mock vars are initialized BEFORE the vi.mock
// factories run -- both are hoisted to the top of the file by the
// vitest transformer, but plain `const` declarations are not.
const mocks = vi.hoisted(() => {
  // doc() has two call shapes in the service: `doc(collection)` mints
  // a new id; `doc(db, ...segs)` references an existing path. New
  // booking docs anchor on 'b-new'.
  const docMock = vi.fn((first: unknown, ...rest: string[]) => {
    if (rest.length === 0 && typeof first === 'object' && first !== null) {
      return { id: 'b-new', _kind: 'doc' }
    }
    return { id: rest.at(-1) ?? 'unknown', _kind: 'doc' }
  })
  const collectionMock = vi.fn((_db: unknown, ..._segs: string[]) => ({ _kind: 'collection' }))
  return {
    // Firestore SDK shims
    setDocMock:           vi.fn(),
    updateDocMock:        vi.fn(),
    deleteDocMock:        vi.fn(),
    deleteFieldMock:      vi.fn(() => ({ _kind: 'deleteField' })),
    serverTimestampMock:  vi.fn(() => ({ _kind: 'serverTimestamp' })),
    docMock,
    collectionMock,
    // Service-layer collaborators
    bumpTripActivityMock:  vi.fn(),
    safePurgeMock:         vi.fn(),
    uploadAttachmentMock:  vi.fn(),
    purgeAttachmentsMock:  vi.fn(),
    getTripMemberIdsMock:  vi.fn(),
    captureErrorMock:      vi.fn(),
  }
})

vi.mock('@/services/firebase', () => ({
  getFirebase: vi.fn(async () => ({
    db:              {},
    collection:      mocks.collectionMock,
    doc:             mocks.docMock,
    setDoc:          mocks.setDocMock,
    updateDoc:       mocks.updateDocMock,
    deleteDoc:       mocks.deleteDocMock,
    deleteField:     mocks.deleteFieldMock,
    serverTimestamp: mocks.serverTimestampMock,
    // checkIn handling in createBooking/updateBooking; we always pass
    // input without checkIn so Timestamp.fromDate is not actually
    // invoked, but the destructure needs the key present.
    Timestamp: { fromDate: vi.fn(() => ({ _kind: 'timestamp' })) },
    getDoc:    vi.fn(),
  })),
}))

vi.mock('@/services/orphanPurge', () => ({
  safePurgeWithEnqueueFallback: mocks.safePurgeMock,
}))

vi.mock('./bookingStorage', () => ({
  uploadAttachment: mocks.uploadAttachmentMock,
  purgeAttachments: mocks.purgeAttachmentsMock,
}))

vi.mock('@/services/tripActivity', () => ({
  bumpTripActivity: mocks.bumpTripActivityMock,
}))

vi.mock('@/services/tripScopedList', () => ({
  createTripScopedListServices: () => ({ fetch: vi.fn(), subscribe: vi.fn() }),
}))

vi.mock('@/services/tripMemberIds', () => ({
  getTripMemberIds: mocks.getTripMemberIdsMock,
}))

vi.mock('@/services/sentry', () => ({
  captureError: mocks.captureErrorMock,
}))

// validateUpdateOrThrow is a pass-through gate in tests — the schema
// parse is exercised separately at the schema level.
vi.mock('@/services/validateUpdate', () => ({
  validateUpdateOrThrow: (_schema: unknown, updates: unknown) => updates,
}))

import { createBooking, updateBooking, deleteBooking } from './bookingService'
import type { BookingAttachment } from '@/types'

const ATTACHMENT: BookingAttachment = {
  fileUrl:   'https://example.com/full.webp',
  filePath:  'trips/t1/bookings/b1/full.webp',
  fileType:  'image/webp',
  thumbUrl:  'https://example.com/thumb.webp',
  thumbPath: 'trips/t1/bookings/b1/thumb.webp',
}

// A NEW attachment (different path) returned by uploadAttachment when
// the test exercises create/update file paths. Path MUST be derived
// from the bookingId uploadAttachment was actually called with —
// otherwise an updateBooking('b1', ...) test would silently receive
// a 'b-new'-anchored attachment and lose path↔bookingId binding
// coverage. Used via `mockImplementationOnce(async (_t, id) =>
// newAttachmentFor(id))` so the binding is enforced at mock time.
function newAttachmentFor(bookingId: string): BookingAttachment {
  return {
    fileUrl:   `https://example.com/${bookingId}/NEW.webp`,
    filePath:  `trips/t1/bookings/${bookingId}/NEW.webp`,
    fileType:  'image/webp',
    thumbUrl:  `https://example.com/${bookingId}/NEW-thumb.webp`,
    thumbPath: `trips/t1/bookings/${bookingId}/NEW-thumb.webp`,
  }
}

beforeEach(() => {
  // Assertion targets — full reset to avoid resolved-value leak.
  mocks.setDocMock.mockReset()
  mocks.updateDocMock.mockReset()
  mocks.deleteDocMock.mockReset()
  mocks.safePurgeMock.mockReset()
  mocks.bumpTripActivityMock.mockReset()
  mocks.uploadAttachmentMock.mockReset()
  mocks.purgeAttachmentsMock.mockReset()
  mocks.captureErrorMock.mockReset()

  // Shape-stable mocks — clear calls but keep impl.
  mocks.docMock.mockClear()
  mocks.collectionMock.mockClear()
  mocks.deleteFieldMock.mockClear()
  mocks.serverTimestampMock.mockClear()

  // Sensible defaults.
  mocks.getTripMemberIdsMock.mockReset()
  mocks.getTripMemberIdsMock.mockResolvedValue(['u1'])
})

// ────────────────────────────────────────────────────────────────────
// deleteBooking strict-cleanup gate
// ────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────
// createBooking — upload then setDoc, with rollback ladder
// ────────────────────────────────────────────────────────────────────

describe('createBooking', () => {
  it('no file: setDoc only, no upload, returns bookingId', async () => {
    mocks.setDocMock.mockResolvedValueOnce(undefined)

    const id = await createBooking(
      't1',
      { title: 'Flight' } as unknown as Parameters<typeof createBooking>[1],
      null,
      'u1',
    )

    expect(id).toBe('b-new')
    expect(mocks.setDocMock).toHaveBeenCalledTimes(1)
    expect(mocks.uploadAttachmentMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('with file: upload → setDoc, attachment path bound to new bookingId, no rollback', async () => {
    mocks.uploadAttachmentMock.mockImplementationOnce(async (_trip: string, bookingId: string) => newAttachmentFor(bookingId))
    mocks.setDocMock.mockResolvedValueOnce(undefined)

    const id = await createBooking(
      't1',
      { title: 'Flight' } as unknown as Parameters<typeof createBooking>[1],
      new File([], 'r.jpg'),
      'u1',
    )

    expect(id).toBe('b-new')
    // The path uploadAttachment writes to MUST be anchored on the
    // freshly-minted bookingId — Storage rules verify path against
    // the intent's entityId. A drift here would 403 in prod.
    expect(mocks.uploadAttachmentMock).toHaveBeenCalledWith('t1', 'b-new', expect.any(File))
    expect(mocks.setDocMock).toHaveBeenCalledTimes(1)
    // setDoc payload embeds the freshly-uploaded attachment, whose
    // path was derived from the bookingId actually used.
    const payload = mocks.setDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(payload.attachment).toEqual(newAttachmentFor('b-new'))
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('upload fails → throws, no setDoc, no orphan (nothing landed)', async () => {
    // Upload-first ordering means an upload failure leaves Storage
    // clean (no half-written blob the SDK keeps) AND no doc — the
    // mutation onError just rolls back the optimistic patch. No
    // safePurge ladder needed.
    mocks.uploadAttachmentMock.mockRejectedValueOnce(new Error('upload-bust'))

    await expect(createBooking(
      't1',
      { title: 'Flight' } as unknown as Parameters<typeof createBooking>[1],
      new File([], 'r.jpg'),
      'u1',
    )).rejects.toThrow(/upload-bust/)

    expect(mocks.setDocMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
    // The service still calls captureError for observability.
    expect(mocks.captureErrorMock).toHaveBeenCalledTimes(1)
  })

  it('setDoc fails after upload → safePurge new (b-new-bound) blob, throws', async () => {
    // Upload succeeded → blob exists. setDoc rejected → no doc
    // referencing it. The bytes are orphaned unless we route through
    // the safePurge/_purges ladder.
    mocks.uploadAttachmentMock.mockImplementationOnce(async (_trip: string, bookingId: string) => newAttachmentFor(bookingId))
    mocks.setDocMock.mockRejectedValueOnce(new Error('setDoc-fail'))
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await expect(createBooking(
      't1',
      { title: 'Flight' } as unknown as Parameters<typeof createBooking>[1],
      new File([], 'r.jpg'),
      'u1',
    )).rejects.toThrow(/setDoc-fail/)

    expect(mocks.uploadAttachmentMock).toHaveBeenCalledWith('t1', 'b-new', expect.any(File))
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { entityId: string; source: string; paths: string[] } }
    expect(purgeArgs.enqueue.source).toBe('createBooking/rollback-attachment')
    expect(purgeArgs.enqueue.entityId).toBe('b-new')
    const newAtt = newAttachmentFor('b-new')
    expect(purgeArgs.enqueue.paths).toEqual(expect.arrayContaining([newAtt.filePath, newAtt.thumbPath]))
  })
})

// ────────────────────────────────────────────────────────────────────
// updateBooking — file replace ordering + rollback symmetry
// ────────────────────────────────────────────────────────────────────

describe('updateBooking', () => {
  it('file replace + updateDoc OK → upload bound to existing bookingId, purge OLD on success', async () => {
    mocks.uploadAttachmentMock.mockImplementationOnce(async (_trip: string, bookingId: string) => newAttachmentFor(bookingId))
    mocks.updateDocMock.mockResolvedValueOnce(undefined)
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await updateBooking(
      't1', 'b1',
      { title: 'Edit' } as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg'), existing: ATTACHMENT },
    )

    // uploadAttachment MUST be called with the EXISTING bookingId, not
    // a drifted id — Storage rules verify path against intent.entityId.
    expect(mocks.uploadAttachmentMock).toHaveBeenCalledWith('t1', 'b1', expect.any(File))
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    // patch.attachment carries the b1-bound new path (NOT 'b-new').
    expect(patch.attachment).toEqual(newAttachmentFor('b1'))
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)  // old purge on success
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { entityId: string; source: string; paths: string[] } }
    expect(purgeArgs.enqueue.source).toBe('updateBooking/purge-old-attachment')
    expect(purgeArgs.enqueue.entityId).toBe('b1')
    expect(purgeArgs.enqueue.paths).toContain(ATTACHMENT.filePath)
  })

  it('file replace + updateDoc FAIL → safePurge NEW (b1-bound) blob, OLD untouched, throws', async () => {
    mocks.uploadAttachmentMock.mockImplementationOnce(async (_trip: string, bookingId: string) => newAttachmentFor(bookingId))
    mocks.updateDocMock.mockRejectedValueOnce(new Error('patch-fail'))
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await expect(updateBooking(
      't1', 'b1',
      { title: 'Edit' } as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg'), existing: ATTACHMENT },
    )).rejects.toThrow(/patch-fail/)

    expect(mocks.uploadAttachmentMock).toHaveBeenCalledWith('t1', 'b1', expect.any(File))
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { entityId: string; source: string; paths: string[] } }
    expect(purgeArgs.enqueue.source).toBe('updateBooking/rollback-new-attachment')
    expect(purgeArgs.enqueue.entityId).toBe('b1')
    // NEW blob (under b1, fresh filename) enqueued; OLD (under b1 too
    // but different filename) must NOT appear — doc still references it.
    const newAtt = newAttachmentFor('b1')
    expect(purgeArgs.enqueue.paths).toContain(newAtt.filePath)
    expect(purgeArgs.enqueue.paths).not.toContain(ATTACHMENT.filePath)
  })

  it('attachment=null + updateDoc OK → patch.attachment = deleteField, no upload, purge OLD', async () => {
    mocks.updateDocMock.mockResolvedValueOnce(undefined)
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await updateBooking(
      't1', 'b1',
      {} as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: null, existing: ATTACHMENT },
    )

    expect(mocks.uploadAttachmentMock).not.toHaveBeenCalled()
    expect(mocks.deleteFieldMock).toHaveBeenCalled()
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch.attachment).toEqual({ _kind: 'deleteField' })
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { source: string } }
    expect(purgeArgs.enqueue.source).toBe('updateBooking/purge-old-attachment')
  })
})
