// Service-layer regression tests for bookingService.
//
// Phase 3.7 surfaces pinned here:
//   1. deleteBooking strict-cleanup gate — when both purge AND `_purges`
//      enqueue fail, abort before deleteDoc so the path → blob binding
//      survives a human retry. (Unchanged from earlier phases.)
//   2. createBooking path discrimination — text-only (no file) goes
//      through client setDoc; with-file goes through Worker
//      /booking-file-create (atomic doc + attachment in one tx).
//      Tests pin BOTH the Worker call shape AND the absence of client
//      setDoc on the file path.
//   3. updateBooking path discrimination — File replace goes through
//      Worker /booking-file-update with text patch + intentIds in a
//      single atomic round-trip (no separate client updateDoc on this
//      path). Detach (null) and text-only stay on the client updateDoc
//      path with `attachment: deleteField()` where applicable.
//   4. PDF coverage — bookings accept PDFs (kind='pdf', no thumb intent)
//      where wishes don't. Pin that the primary kind flips on contentType.
//
// Worker contract:
//   - workerFetch(base, idToken, endpoint, body, opts?) is the single
//     chokepoint for /booking-file-create and /booking-file-update. The
//     mock asserts full body shape so a regression that drops a field or
//     sends an unintended one is caught here, not at the Worker boundary
//     in prod. `opts` carries the upload-flow traceId; assertions match
//     it with `{ traceId: expect.any(String) }` for shape, with one
//     dedicated correlation test pinning that the SAME traceId reaches
//     both /upload-intents and the entity-write call.
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
    getDocMock:           vi.fn(),
    docMock,
    collectionMock,
    // Service-layer collaborators
    bumpTripActivityMock:      vi.fn(),
    safePurgeMock:             vi.fn(),
    purgeAttachmentsMock:      vi.fn(),
    compressImageMock:         vi.fn(),
    requestUploadIntentsMock:  vi.fn(),
    uploadToIntentMock:        vi.fn(),
    getTripMemberIdsMock:      vi.fn(),
    // Worker chokepoint
    requireWorkerWriteBaseMock: vi.fn(() => 'https://worker.test'),
    preflightIdTokenMock:       vi.fn(async () => 'tok-test'),
    workerFetchMock:            vi.fn(),
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
    getDoc:          mocks.getDocMock,
    // checkIn handling — Timestamp.fromDate fires only on the sortDate
    // recompute path in client-side updateBooking. Tests that hit that
    // path supply checkIn explicitly.
    Timestamp: { fromDate: vi.fn(() => ({ _kind: 'timestamp' })) },
  })),
}))

vi.mock('@/services/orphanPurge', () => ({
  safePurgeWithEnqueueFallback: mocks.safePurgeMock,
}))

vi.mock('./bookingStorage', () => ({
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

vi.mock('@/utils/image', () => ({
  compressImage: mocks.compressImageMock,
}))

vi.mock('@/services/uploadIntent', () => ({
  requestUploadIntents: mocks.requestUploadIntentsMock,
  uploadToIntent:       mocks.uploadToIntentMock,
}))

vi.mock('@/services/workerBase', () => ({
  requireWorkerWriteBase: mocks.requireWorkerWriteBaseMock,
  preflightIdToken:       mocks.preflightIdTokenMock,
  workerFetch:            mocks.workerFetchMock,
}))

// validateUpdateOrThrow is a pass-through gate in tests — the schema
// parse is exercised separately at the schema level.
vi.mock('@/services/validateUpdate', () => ({
  validateUpdateOrThrow: (_schema: unknown, updates: unknown) => updates,
}))

import { createBooking, updateBooking, deleteBooking } from './bookingService'
import type { BookingAttachment } from '@/types'

const ATTACHMENT: BookingAttachment = {
  filePath:  'trips/t1/bookings/b1/full.webp',
  fileType:  'image/webp',
  thumbPath: 'trips/t1/bookings/b1/thumb.webp',
}

/**
 * Prime the upload-first pipeline: compressImage → requestUploadIntents
 * → uploadToIntent. `entityId` MUST match the bookingId the service is
 * operating on so the returned intents carry paths anchored to the
 * correct entity. `kind` switches between image (full+thumb) and PDF
 * (primary='pdf', no thumb) to mirror the service's contentType-driven
 * dispatch.
 */
function primeBookingUpload(
  entityId: string,
  opts: { kind?: 'image' | 'pdf' } = {},
): void {
  const isPdf = opts.kind === 'pdf'
  if (isPdf) {
    mocks.compressImageMock.mockResolvedValueOnce({
      full: new File(['x'], 'doc.pdf', { type: 'application/pdf' }),
    })
  } else {
    mocks.compressImageMock.mockResolvedValueOnce({
      full:  new File(['x'], 'full.webp',  { type: 'image/webp' }),
      thumb: new File(['x'], 'thumb.webp', { type: 'image/webp' }),
    })
  }
  const intents: Array<{ intentId: string; path: string; metadata: { contentType: string; customMetadata: Record<string, string> }; expiresAt: string }> = [
    { intentId: `i-${entityId}-P`, path: `trips/t1/bookings/${entityId}/P${isPdf ? '.pdf' : '.webp'}`, metadata: { contentType: isPdf ? 'application/pdf' : 'image/webp', customMetadata: { kind: isPdf ? 'pdf' : 'full' } }, expiresAt: '2030-01-01T00:00:00Z' },
  ]
  if (!isPdf) {
    intents.push({ intentId: `i-${entityId}-T`, path: `trips/t1/bookings/${entityId}/T.webp`, metadata: { contentType: 'image/webp', customMetadata: { kind: 'thumb' } }, expiresAt: '2030-01-01T00:00:00Z' })
  }
  mocks.requestUploadIntentsMock.mockResolvedValueOnce(intents)
  mocks.uploadToIntentMock.mockResolvedValue(undefined)
}

beforeEach(() => {
  mocks.setDocMock.mockReset()
  mocks.updateDocMock.mockReset()
  mocks.deleteDocMock.mockReset()
  mocks.safePurgeMock.mockReset()
  mocks.bumpTripActivityMock.mockReset()
  mocks.compressImageMock.mockReset()
  mocks.requestUploadIntentsMock.mockReset()
  mocks.uploadToIntentMock.mockReset()
  mocks.purgeAttachmentsMock.mockReset()
  mocks.workerFetchMock.mockReset()
  mocks.getDocMock.mockReset()

  mocks.docMock.mockClear()
  mocks.collectionMock.mockClear()
  mocks.deleteFieldMock.mockClear()
  mocks.serverTimestampMock.mockClear()
  mocks.requireWorkerWriteBaseMock.mockClear()
  mocks.preflightIdTokenMock.mockClear()

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
// createBooking — text-only client setDoc vs Worker /booking-file-create
// ────────────────────────────────────────────────────────────────────

describe('createBooking', () => {
  it('no file: client setDoc only, no compress, no Worker call, returns bookingId', async () => {
    mocks.setDocMock.mockResolvedValueOnce(undefined)

    const id = await createBooking(
      't1',
      { type: 'flight', title: 'Flight' } as unknown as Parameters<typeof createBooking>[1],
      null,
      'u1',
    )

    expect(id).toBe('b-new')
    expect(mocks.setDocMock).toHaveBeenCalledTimes(1)
    // No attachment field in setDoc payload — text-only path.
    const payload = mocks.setDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect('attachment' in payload).toBe(false)
    // Text-only path must NEVER touch the Worker — the whole point of
    // keeping setDoc here is the fast no-round-trip path.
    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.compressImageMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.uploadToIntentMock).not.toHaveBeenCalled()
  })

  it('with image File: upload-first → POST /booking-file-create, NO client setDoc', async () => {
    primeBookingUpload('b-new')
    mocks.workerFetchMock.mockResolvedValueOnce({ bookingId: 'b-new' })

    const id = await createBooking(
      't1',
      { type: 'flight', title: 'Flight' } as unknown as Parameters<typeof createBooking>[1],
      new File([], 'r.jpg', { type: 'image/jpeg' }),
      'u1',
    )

    expect(id).toBe('b-new')
    // Worker-authoritative: client must NOT touch setDoc on this path.
    expect(mocks.setDocMock).not.toHaveBeenCalled()
    // No client-side memberIds read either — Worker resolves trip
    // membership inside the tx.
    expect(mocks.getTripMemberIdsMock).not.toHaveBeenCalled()

    // requestUploadIntents body MUST carry the freshly-minted bookingId,
    // mode='create' (Worker authzUpload skips doc-exists check), and the
    // image upload pair (full + thumb, both image/webp post-compress).
    // 2nd arg = opts.traceId (full UUID) — shape only, value is
    // non-deterministic. Correlation across mint + entity-write is pinned
    // in a dedicated test below.
    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'booking', entityId: 'b-new',
      mode:   'create',
      uploads: [
        { kind: 'full',  contentType: 'image/webp', size: 1 },
        { kind: 'thumb', contentType: 'image/webp', size: 1 },
      ],
    }, { traceId: expect.any(String) })
    expect(mocks.uploadToIntentMock).toHaveBeenCalledTimes(2)
    // (intent, file, label) MUST be correctly paired per call — a swap
    // (e.g., full file uploaded to thumb intent's path) would mean
    // mismatched bytes land at each path.
    expect(mocks.uploadToIntentMock).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ intentId: 'i-b-new-P' }),
      expect.objectContaining({ name: 'full.webp', type: 'image/webp' }),
      'booking-full',
    )
    expect(mocks.uploadToIntentMock).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ intentId: 'i-b-new-T' }),
      expect.objectContaining({ name: 'thumb.webp', type: 'image/webp' }),
      'booking-thumb',
    )

    // workerFetch body: pin so a regression that drops intentIds /
    // swaps bookingId / lets an `attachment` field slip into the
    // booking payload is caught here. 5th arg = `{ traceId }` header
    // opts forwarded by workerFetch (shape-only; same UUID also lands
    // on the /upload-intents mint above — correlation pinned separately).
    expect(mocks.workerFetchMock).toHaveBeenCalledTimes(1)
    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test',
      'tok-test',
      '/booking-file-create',
      {
        tripId:    't1',
        bookingId: 'b-new',
        booking:   { type: 'flight', title: 'Flight' },
        intentIds: ['i-b-new-P', 'i-b-new-T'],
      },
      { traceId: expect.any(String) },
    )
  })

  it('with PDF File: primary kind=pdf, NO thumb intent minted, /booking-file-create called', async () => {
    // PDF coverage: bookings accept PDFs (wishes don't). The service
    // dispatches primary kind on full.type === 'application/pdf', and
    // mintIntentsAndUpload omits the thumb intent entirely. A regression
    // that always-sent kind='full' would land a forbidden CT at the
    // Worker; one that always-sent a thumb intent would mint an orphan
    // intent the purge cron would have to sweep.
    primeBookingUpload('b-new', { kind: 'pdf' })
    mocks.workerFetchMock.mockResolvedValueOnce({ bookingId: 'b-new' })

    await createBooking(
      't1',
      { type: 'hotel', title: 'Voucher' } as unknown as Parameters<typeof createBooking>[1],
      new File([], 'doc.pdf', { type: 'application/pdf' }),
      'u1',
    )

    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'booking', entityId: 'b-new',
      mode:   'create',
      uploads: [
        { kind: 'pdf', contentType: 'application/pdf', size: 1 },
      ],
    }, { traceId: expect.any(String) })
    expect(mocks.uploadToIntentMock).toHaveBeenCalledTimes(1)
    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test',
      'tok-test',
      '/booking-file-create',
      {
        tripId:    't1',
        bookingId: 'b-new',
        booking:   { type: 'hotel', title: 'Voucher' },
        intentIds: ['i-b-new-P'],
      },
      { traceId: expect.any(String) },
    )
    expect(mocks.setDocMock).not.toHaveBeenCalled()
  })

  it('compressImage fails: throws original error, no setDoc, no Worker call, no orphan to clean', async () => {
    // Compress is the path-gate — failure aborts BEFORE any side effect.
    // No doc written, no blob uploaded, no rollback needed under the
    // atomic Worker tx contract.
    mocks.compressImageMock.mockRejectedValueOnce(new Error('canvas-bust'))

    await expect(createBooking(
      't1',
      { type: 'flight' } as unknown as Parameters<typeof createBooking>[1],
      new File([], 'r.jpg'),
      'u1',
    )).rejects.toThrow(/canvas-bust/)

    expect(mocks.setDocMock).not.toHaveBeenCalled()
    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('requestUploadIntents fails: throws, no Worker call, no setDoc, no client purge', async () => {
    mocks.compressImageMock.mockResolvedValueOnce({
      full: new File(['x'], 'f.webp', { type: 'image/webp' }),
    })
    mocks.requestUploadIntentsMock.mockRejectedValueOnce(new Error('boom'))

    await expect(createBooking(
      't1',
      { type: 'flight' } as unknown as Parameters<typeof createBooking>[1],
      new File([], 'r.jpg'),
      'u1',
    )).rejects.toThrow(/boom/)

    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.setDocMock).not.toHaveBeenCalled()
    // Phase 3.7: no client-side blob purge on rollback. Worker
    // storage-scan cron reaps orphaned bytes; intents that never minted
    // a path aren't an orphan source either.
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('/booking-file-create fails AFTER upload: throws, NO client setDoc, NO client purge (Worker scan reaps)', async () => {
    // Worker tx atomically commits OR aborts: doc + intent markUsed all
    // or nothing. Client has nothing local to purge; storage-scan reaps
    // the orphan blob bytes.
    primeBookingUpload('b-new')
    mocks.workerFetchMock.mockRejectedValueOnce(new Error('worker-rejected'))

    await expect(createBooking(
      't1',
      { type: 'flight', title: 'X' } as unknown as Parameters<typeof createBooking>[1],
      new File([], 'r.jpg'),
      'u1',
    )).rejects.toThrow(/worker-rejected/)

    expect(mocks.uploadToIntentMock).toHaveBeenCalledTimes(2)
    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test',
      'tok-test',
      '/booking-file-create',
      {
        tripId:    't1',
        bookingId: 'b-new',
        booking:   { type: 'flight', title: 'X' },
        intentIds: ['i-b-new-P', 'i-b-new-T'],
      },
      { traceId: expect.any(String) },
    )
    expect(mocks.setDocMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('upload-trace correlation: SAME traceId reaches /upload-intents AND /booking-file-create', async () => {
    // Phase 3.7 observability contract: mintAndUploadEntityIntents mints
    // one traceId per flow and forwards it to BOTH the intent-mint
    // workerFetch AND the entity-write workerFetch. A regression that
    // generated separate UUIDs would silently break log-line correlation
    // (operator can no longer `wrangler tail | grep <traceId>` to walk
    // mint → upload → write for a single Sentry breadcrumb).
    primeBookingUpload('b-new')
    mocks.workerFetchMock.mockResolvedValueOnce({ bookingId: 'b-new' })

    await createBooking(
      't1',
      { type: 'flight', title: 'Trace' } as unknown as Parameters<typeof createBooking>[1],
      new File([], 'r.jpg', { type: 'image/jpeg' }),
      'u1',
    )

    const mintOpts  = mocks.requestUploadIntentsMock.mock.calls[0]![1] as { traceId: string }
    const writeOpts = mocks.workerFetchMock.mock.calls[0]![4] as { traceId: string }
    expect(mintOpts.traceId).toBeTruthy()
    expect(mintOpts.traceId).toBe(writeOpts.traceId)
  })
})

// ────────────────────────────────────────────────────────────────────
// updateBooking — Worker-authoritative replace vs client text/detach
// ────────────────────────────────────────────────────────────────────

describe('updateBooking', () => {
  it('File replace + Worker OK → single /booking-file-update (no client updateDoc), purge OLD', async () => {
    primeBookingUpload('b1')
    mocks.workerFetchMock.mockResolvedValueOnce({ ok: true })
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await updateBooking(
      't1', 'b1',
      { title: 'Edit' } as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg', { type: 'image/jpeg' }), existing: ATTACHMENT },
    )

    // Worker-authoritative replace: text + attachment land atomically in
    // ONE Worker call — no client updateDoc on this path. A regression
    // that left a separate client updateDoc would race the Worker's tx.
    expect(mocks.updateDocMock).not.toHaveBeenCalled()

    // Intent request bound to the EXISTING bookingId. mode='update' tells
    // Worker authzUpload to enforce the doc-exists check.
    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'booking', entityId: 'b1',
      mode:   'update',
      uploads: [
        { kind: 'full',  contentType: 'image/webp', size: 1 },
        { kind: 'thumb', contentType: 'image/webp', size: 1 },
      ],
    }, { traceId: expect.any(String) })
    expect(mocks.uploadToIntentMock).toHaveBeenCalledTimes(2)

    // Worker call: patch carries validated text fields, intentIds bound
    // to the bookingId, expectedCurrentPath = the existing attachment
    // filePath (stale-replace guard). NO `attachment` in the patch.
    expect(mocks.workerFetchMock).toHaveBeenCalledTimes(1)
    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test',
      'tok-test',
      '/booking-file-update',
      {
        tripId:              't1',
        bookingId:           'b1',
        patch:               { title: 'Edit' },
        intentIds:           ['i-b1-P', 'i-b1-T'],
        expectedCurrentPath: ATTACHMENT.filePath,
      },
      { traceId: expect.any(String) },
    )

    // OLD blob purge on success.
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { source: string; paths: string[] } }
    expect(purgeArgs.enqueue.source).toBe('updateBooking/purge-old-attachment')
    expect(purgeArgs.enqueue.paths).toEqual(expect.arrayContaining([ATTACHMENT.filePath, ATTACHMENT.thumbPath]))
  })

  it('File replace + cleared text fields → Worker patch carries empty-string sentinel (not undefined)', async () => {
    // Regression pin for the JSON-undefined-drop class of bug:
    // BookingFormModal produces `field: undefined` for cleared optional
    // text inputs. workerFetch's JSON.stringify silently drops undefined
    // keys, and Worker /booking-file-update's `encodeBookingUpdate`
    // gates field deletion on KEY PRESENCE (`rawKeys.has(k)`) — so an
    // absent key is a no-op and the stale value stays in the doc.
    // bookingService normalizes `undefined → ''` for CLEARABLE_TEXT_FIELDS
    // before the Worker call so the empty-string sentinel survives
    // serialization and trips the Worker's deleteField allowlist.
    // A regression that reverts to `patch: validated` raw would silently
    // strip the cleared keys here.
    primeBookingUpload('b1')
    mocks.workerFetchMock.mockResolvedValueOnce({ ok: true })
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await updateBooking(
      't1', 'b1',
      // Form: user cleared checkIn + note, left title alone, never
      // touched confirmationCode (key absent → must stay absent in patch
      // so Worker treats as no-op, not as field-deletion).
      { title: 'Edit', checkIn: undefined, note: undefined } as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg', { type: 'image/jpeg' }), existing: ATTACHMENT },
    )

    const workerBody = mocks.workerFetchMock.mock.calls[0]![3] as { patch: Record<string, unknown> }
    expect(workerBody.patch).toEqual({
      title:   'Edit',
      checkIn: '',
      note:    '',
    })
    // Worker contract: keys never sent by the form must stay absent so
    // Worker.encodeBookingUpdate treats them as no-op (not field-delete).
    expect(workerBody.patch).not.toHaveProperty('confirmationCode')
    expect(workerBody.patch).not.toHaveProperty('provider')
    expect(workerBody.patch).not.toHaveProperty('address')
    expect(workerBody.patch).not.toHaveProperty('checkOut')
  })

  it('PDF File replace → /booking-file-update with kind=pdf primary, no thumb intent', async () => {
    primeBookingUpload('b1', { kind: 'pdf' })
    mocks.workerFetchMock.mockResolvedValueOnce({ ok: true })
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await updateBooking(
      't1', 'b1',
      {} as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: new File([], 'doc.pdf', { type: 'application/pdf' }), existing: ATTACHMENT },
    )

    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'booking', entityId: 'b1',
      mode:   'update',
      uploads: [
        { kind: 'pdf', contentType: 'application/pdf', size: 1 },
      ],
    }, { traceId: expect.any(String) })
    expect(mocks.uploadToIntentMock).toHaveBeenCalledTimes(1)
    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test',
      'tok-test',
      '/booking-file-update',
      {
        tripId:              't1',
        bookingId:           'b1',
        patch:               {},
        intentIds:           ['i-b1-P'],
        expectedCurrentPath: ATTACHMENT.filePath,
      },
      { traceId: expect.any(String) },
    )
    expect(mocks.updateDocMock).not.toHaveBeenCalled()
  })

  it('File replace + Worker FAILS: no purge of OLD (still referenced), no client updateDoc, throws', async () => {
    // Worker tx atomically aborts: doc attachment still points to OLD,
    // text patch never applied. Client has no OLD to purge (OLD still
    // doc-referenced) and no NEW to purge (Worker storage-scan reaps).
    primeBookingUpload('b1')
    mocks.workerFetchMock.mockRejectedValueOnce(new Error('worker-409-stale'))

    await expect(updateBooking(
      't1', 'b1',
      { title: 'Edit' } as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg', { type: 'image/jpeg' }), existing: ATTACHMENT },
    )).rejects.toThrow(/worker-409-stale/)

    expect(mocks.updateDocMock).not.toHaveBeenCalled()
    expect(mocks.workerFetchMock).toHaveBeenCalledTimes(1)
    // OLD untouched, NEW reaped by Worker scan.
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('attachment=null + updateDoc OK → client updateDoc with patch.attachment=deleteField, no Worker call, purge OLD', async () => {
    // Detach flow is purely client-side: deleteField() in the text
    // patch removes the attachment field. firestore.rules permit
    // removing `attachment` client-side (only replace is Worker-restricted).
    mocks.updateDocMock.mockResolvedValueOnce(undefined)
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await updateBooking(
      't1', 'b1',
      {} as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: null, existing: ATTACHMENT },
    )

    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.uploadToIntentMock).not.toHaveBeenCalled()
    expect(mocks.deleteFieldMock).toHaveBeenCalled()
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch.attachment).toEqual({ _kind: 'deleteField' })
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { source: string } }
    expect(purgeArgs.enqueue.source).toBe('updateBooking/purge-old-attachment')
  })

  it('first-attach (no existing) + File → /booking-file-update with expectedCurrentPath=null, no purge', async () => {
    // Edge case: editing a booking that has no existing attachment and
    // adding one for the first time. expectedCurrentPath must be null
    // to match the Worker's first-attach stale-replace gate.
    primeBookingUpload('b1')
    mocks.workerFetchMock.mockResolvedValueOnce({ ok: true })

    await updateBooking(
      't1', 'b1',
      { title: 'Edit' } as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg', { type: 'image/jpeg' }), existing: undefined },
    )

    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test',
      'tok-test',
      '/booking-file-update',
      {
        tripId:              't1',
        bookingId:           'b1',
        patch:               { title: 'Edit' },
        intentIds:           ['i-b1-P', 'i-b1-T'],
        // First-attach: editor saw no attachment. Worker accepts null
        // only when the live doc also has no attachment.
        expectedCurrentPath: null,
      },
      { traceId: expect.any(String) },
    )
    // No OLD to purge.
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('attachment=undefined (text-only edit) → client updateDoc only, no Worker, no upload, no purge', async () => {
    mocks.updateDocMock.mockResolvedValueOnce(undefined)

    await updateBooking(
      't1', 'b1',
      { title: 'Rename' } as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: undefined, existing: ATTACHMENT },
    )

    expect(mocks.compressImageMock).not.toHaveBeenCalled()
    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()  // attachment untouched
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch).not.toHaveProperty('attachment')
  })

  it('text updateDoc FAILS (text-only path) → no upload, no Worker, no purge, throws', async () => {
    mocks.updateDocMock.mockRejectedValueOnce(new Error('text-fail'))

    await expect(updateBooking(
      't1', 'b1',
      { title: 'Rename' } as unknown as Parameters<typeof updateBooking>[2],
      { uid: 'u1', attachment: undefined, existing: ATTACHMENT },
    )).rejects.toThrow(/text-fail/)

    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })
})
