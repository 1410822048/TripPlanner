// Service-layer regression tests for bookingService.
//
// Phase 3.6 ordering pinned here:
//   1. deleteBooking strict-cleanup gate — when both purge AND
//      `_purges` enqueue reject, abort BEFORE deleting the doc so
//      the attachment.path → blob binding survives a human-driven
//      retry. Without this, the doc-delete proceeds and the path
//      vanishes from every future cleanup attempt.
//   2. createBooking doc-first ordering — setDoc the booking
//      (without attachment) FIRST, THEN uploadAttachment so the
//      Worker patches `attachment` atomically in /upload-finalize.
//      If the upload step fails, rollback the doc (deleteDoc).
//      If both fail, throw BookingCreatePartialError so the mutation
//      hook can invalidateQueries.
//   3. updateBooking split-write ordering — text patch via updateDoc
//      FIRST (including attachment: deleteField() for null detach),
//      then uploadAttachment for the File replace case. On combined
//      success, purge OLD. Worker is the only writer for
//      `attachment` on the replace path.
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

import { createBooking, updateBooking, deleteBooking, BookingCreatePartialError } from './bookingService'
import type { BookingAttachment } from '@/types'

const ATTACHMENT: BookingAttachment = {
  fileUrl:   'https://example.com/full.webp',
  filePath:  'trips/t1/bookings/b1/full.webp',
  fileType:  'image/webp',
  thumbUrl:  'https://example.com/thumb.webp',
  thumbPath: 'trips/t1/bookings/b1/thumb.webp',
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
// createBooking — Phase 3.6 doc-first + Worker patches attachment
// ────────────────────────────────────────────────────────────────────

describe('createBooking', () => {
  it('no file: setDoc only (no attachment field), no upload, returns bookingId', async () => {
    mocks.setDocMock.mockResolvedValueOnce(undefined)

    const id = await createBooking(
      't1',
      { title: 'Flight' } as unknown as Parameters<typeof createBooking>[1],
      null,
      'u1',
    )

    expect(id).toBe('b-new')
    expect(mocks.setDocMock).toHaveBeenCalledTimes(1)
    // No attachment field in setDoc payload -- doc-first invariant
    // mirrors wishService.createWish.
    const payload = mocks.setDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect('attachment' in payload).toBe(false)
    expect(mocks.uploadAttachmentMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('with file: setDoc (no attachment) → uploadAttachment with expectedCurrentPath=null', async () => {
    // Phase 3.6: setDoc lands FIRST without attachment. Worker patches
    // the attachment field via /upload-finalize. expectedCurrentPath
    // MUST be null for first-attach -- the booking has no attachment
    // yet, so Worker's stale-finalize guard rejects anything else.
    mocks.setDocMock.mockResolvedValueOnce(undefined)
    mocks.uploadAttachmentMock.mockResolvedValueOnce(undefined)

    const id = await createBooking(
      't1',
      { title: 'Flight' } as unknown as Parameters<typeof createBooking>[1],
      new File([], 'r.jpg'),
      'u1',
    )

    expect(id).toBe('b-new')
    expect(mocks.setDocMock).toHaveBeenCalledTimes(1)
    // setDoc payload has NO attachment field -- Worker writes it.
    const payload = mocks.setDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect('attachment' in payload).toBe(false)
    // uploadAttachment MUST be called with (tripId, freshly-minted
    // bookingId, file, null). expectedCurrentPath=null is the
    // load-bearing arg here: Worker's stale-finalize guard 409's a
    // string when the booking has no attachment yet.
    expect(mocks.uploadAttachmentMock).toHaveBeenCalledTimes(1)
    expect(mocks.uploadAttachmentMock).toHaveBeenCalledWith(
      't1', 'b-new', expect.any(File), null,
    )
    expect(mocks.deleteDocMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('setDoc fails → no upload, no orphan, throws original error', async () => {
    // setDoc-first ordering: a setDoc failure stops the flow before
    // any Storage side effects. No rollback needed -- the booking
    // never landed.
    mocks.setDocMock.mockRejectedValueOnce(new Error('setDoc-fail'))

    await expect(createBooking(
      't1',
      { title: 'Flight' } as unknown as Parameters<typeof createBooking>[1],
      new File([], 'r.jpg'),
      'u1',
    )).rejects.toThrow(/setDoc-fail/)

    expect(mocks.uploadAttachmentMock).not.toHaveBeenCalled()
    expect(mocks.deleteDocMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
    expect(mocks.captureErrorMock).not.toHaveBeenCalled()
  })

  it('uploadAttachment fails AFTER setDoc → deleteDoc rolls back, no client-side purge (cron reaps blobs)', async () => {
    // Phase 3.6: orphan blob (if any landed in Storage before Worker
    // /upload-finalize tx aborted) is reclaimed by orphan-storage-scan.
    // Client only rolls back the doc, NOT the blobs -- the Worker is
    // the only writer for `attachment` and a finalize abort leaves
    // nothing for safePurge to target via the doc.
    mocks.setDocMock.mockResolvedValueOnce(undefined)
    mocks.uploadAttachmentMock.mockRejectedValueOnce(new Error('upload-bust'))
    mocks.deleteDocMock.mockResolvedValueOnce(undefined)

    await expect(createBooking(
      't1',
      { title: 'Flight' } as unknown as Parameters<typeof createBooking>[1],
      new File([], 'r.jpg'),
      'u1',
    )).rejects.toThrow(/upload-bust/)

    expect(mocks.uploadAttachmentMock).toHaveBeenCalledWith('t1', 'b-new', expect.any(File), null)
    expect(mocks.deleteDocMock).toHaveBeenCalledTimes(1)
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
    // Service still captures the upload error to Sentry for observability.
    expect(mocks.captureErrorMock).toHaveBeenCalledTimes(1)
  })

  it('uploadAttachment fails + deleteDoc ALSO fails → throws BookingCreatePartialError(bookingId)', async () => {
    // The backlog gap that BookingCreatePartialError exists to close:
    // setDoc lands → realtime listener pushes booking into cache →
    // upload fails → deleteDoc also fails (network blip, rules race,
    // whatever). Mutation onError must receive the typed error so it
    // can invalidateQueries and reconcile cache with reality.
    // Otherwise: "save failed" toast + booking still visible → user
    // re-presses save → DUPLICATE booking. Mirrors
    // WishCreatePartialError.
    mocks.setDocMock.mockResolvedValueOnce(undefined)
    mocks.uploadAttachmentMock.mockRejectedValueOnce(new Error('upload-bust'))
    mocks.deleteDocMock.mockRejectedValueOnce(new Error('rollback-bust'))

    let caught: unknown
    try {
      await createBooking(
        't1',
        { title: 'Flight' } as unknown as Parameters<typeof createBooking>[1],
        new File([], 'r.jpg'),
        'u1',
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(BookingCreatePartialError)
    expect((caught as BookingCreatePartialError).bookingId).toBe('b-new')
    // Sentry captures BOTH the upload error and the rollback error so
    // ops can correlate the partial-failure pair.
    expect(mocks.captureErrorMock).toHaveBeenCalledTimes(2)
  })
})

// ────────────────────────────────────────────────────────────────────
// updateBooking — Phase 3.6 split-write (text via updateDoc, attachment via Worker)
// ────────────────────────────────────────────────────────────────────

describe('updateBooking', () => {
  it('file replace + both writes OK → updateDoc patch lacks attachment, Worker called with expectedCurrentPath=existing.filePath, OLD purged', async () => {
    // Phase 3.6 split-write: text fields go through client updateDoc,
    // attachment goes through Worker via uploadAttachment. The text
    // patch MUST NOT include `attachment` -- firestore.rules
    // (Commit 3) will lock client writes to "unchanged OR deleteField"
    // for that field.
    mocks.updateDocMock.mockResolvedValueOnce(undefined)
    mocks.uploadAttachmentMock.mockResolvedValueOnce(undefined)
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await updateBooking(
      't1', 'b1',
      { title: 'Edit' } as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg'), existing: ATTACHMENT },
    )

    // Text patch first, with NO attachment field.
    expect(mocks.updateDocMock).toHaveBeenCalledTimes(1)
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect('attachment' in patch).toBe(false)

    // uploadAttachment carries the OLD primary path so the Worker
    // can detect Tab B drift via expectedCurrentPath. A bug that
    // passed null here on replace would let stale Tab A's finalize
    // overwrite Tab B's already-committed attachment.
    expect(mocks.uploadAttachmentMock).toHaveBeenCalledWith(
      't1', 'b1', expect.any(File), ATTACHMENT.filePath,
    )

    // OLD blob purged on combined success.
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { entityId: string; source: string; paths: string[] } }
    expect(purgeArgs.enqueue.source).toBe('updateBooking/purge-old-attachment')
    expect(purgeArgs.enqueue.entityId).toBe('b1')
    expect(purgeArgs.enqueue.paths).toEqual(expect.arrayContaining([ATTACHMENT.filePath, ATTACHMENT.thumbPath]))
  })

  it('file replace + updateDoc FAILS (text step) → no upload, no purge, throws', async () => {
    // Split-write ordering: text patch first. If text patch fails,
    // the attachment step never runs -- nothing to roll back.
    mocks.updateDocMock.mockRejectedValueOnce(new Error('patch-fail'))

    await expect(updateBooking(
      't1', 'b1',
      { title: 'Edit' } as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg'), existing: ATTACHMENT },
    )).rejects.toThrow(/patch-fail/)

    expect(mocks.uploadAttachmentMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('file replace + uploadAttachment FAILS → throws; text update already applied, OLD untouched', async () => {
    // Failure of step 2 (Worker attachment patch) after step 1
    // (text updateDoc) succeeded: text edits persist, attachment
    // unchanged on the doc (Worker tx aborted). User can retry from
    // the form -- text re-applies idempotently, attachment uploads
    // fresh. NO client-side purge of OLD or NEW: doc still
    // references OLD, NEW (if any blob landed) is reaped by the
    // Worker's storage-scan cron.
    mocks.updateDocMock.mockResolvedValueOnce(undefined)
    mocks.uploadAttachmentMock.mockRejectedValueOnce(new Error('upload-bust'))

    await expect(updateBooking(
      't1', 'b1',
      { title: 'Edit' } as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg'), existing: ATTACHMENT },
    )).rejects.toThrow(/upload-bust/)

    expect(mocks.uploadAttachmentMock).toHaveBeenCalledWith(
      't1', 'b1', expect.any(File), ATTACHMENT.filePath,
    )
    // OLD is NOT purged -- doc still references it.
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('attachment=null + updateDoc OK → patch.attachment = deleteField, no upload, purge OLD', async () => {
    // Detach flow is purely client-side: deleteField() in the text
    // patch removes the attachment field. firestore.rules (Commit 3)
    // explicitly allows the client to remove `attachment` (only
    // replace is Worker-restricted).
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

  it('replace flow without prior attachment (existing=undefined) → uploadAttachment expectedCurrentPath=null', async () => {
    // Edge case: editing a booking that has no existing attachment
    // and adding one for the first time. expectedCurrentPath must be
    // null to match the Worker's first-attach stale-finalize gate.
    mocks.updateDocMock.mockResolvedValueOnce(undefined)
    mocks.uploadAttachmentMock.mockResolvedValueOnce(undefined)

    await updateBooking(
      't1', 'b1',
      { title: 'Edit' } as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg'), existing: undefined },
    )

    expect(mocks.uploadAttachmentMock).toHaveBeenCalledWith(
      't1', 'b1', expect.any(File), null,
    )
    // No existing attachment → no OLD purge needed.
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })
})
