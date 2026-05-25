// Service-layer regression tests for wishService.
//
// Three surfaces are pinned here:
//   1. deleteWish strict-cleanup gate — when both purge AND `_purges`
//      enqueue fail, abort before deleteDoc so the path → blob binding
//      survives a human retry.
//   2. createWish partial-failure rollback — setDoc-first ordering means
//      the wish lands in Firestore (and the realtime listener pushes it
//      into TanStack cache) before the upload step runs. If upload or
//      its rollback deleteDoc fails, we MUST throw `WishCreatePartialError`
//      so the caller can `invalidateQueries` and reconcile cache with
//      reality. Without it a "save failed" toast + a still-visible wish
//      lets the user re-press → DUPLICATE wish.
//   3. updateWish rollback symmetry with booking/expense — NEW blob
//      enqueued on updateDoc fail, OLD blob purged on updateDoc success.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted() so the mock vars are initialized BEFORE the vi.mock
// factories run -- both are hoisted to the top of the file by the
// vitest transformer, but plain `const` declarations are not.
const mocks = vi.hoisted(() => {
  // doc() has two call shapes in the service: `doc(collection)` to
  // mint a new id, and `doc(db, ...segs)` to reference an existing
  // path. Discriminate on arg count so both shapes return a usable
  // ref. The synthetic new id 'w-new' is the anchor the createWish
  // tests assert against.
  const docMock = vi.fn((first: unknown, ...rest: string[]) => {
    if (rest.length === 0 && typeof first === 'object' && first !== null) {
      return { id: 'w-new', _kind: 'doc' }
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
    bumpTripActivityMock:      vi.fn(),
    safePurgeMock:             vi.fn(),
    deleteStorageObjectMock:   vi.fn(),
    compressImageMock:         vi.fn(),
    requestUploadIntentsMock:  vi.fn(),
    uploadToIntentMock:        vi.fn(),
    finalizeUploadIntentsMock: vi.fn(),
    getTripMemberIdsMock:      vi.fn(),
    captureErrorMock:          vi.fn(),
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
    arrayUnion:      vi.fn((x: unknown) => ({ _kind: 'arrayUnion', x })),
    arrayRemove:     vi.fn((x: unknown) => ({ _kind: 'arrayRemove', x })),
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
  deleteStorageObject: mocks.deleteStorageObjectMock,
}))

vi.mock('@/services/uploadIntent', () => ({
  requestUploadIntents:  mocks.requestUploadIntentsMock,
  uploadToIntent:        mocks.uploadToIntentMock,
  finalizeUploadIntents: mocks.finalizeUploadIntentsMock,
}))

vi.mock('@/services/tripMemberIds', () => ({
  getTripMemberIds: mocks.getTripMemberIdsMock,
}))

vi.mock('@/services/sentry', () => ({
  captureError: mocks.captureErrorMock,
}))

vi.mock('@/utils/image', () => ({
  compressImage: mocks.compressImageMock,
}))

import {
  deleteWish, createWish, updateWish, WishCreatePartialError,
} from './wishService'
import type { WishImage } from '@/types'

const IMAGE: WishImage = {
  url:       'https://example.com/full.webp',
  path:      'trips/t1/wishes/w1/full.webp',
  thumbUrl:  'https://example.com/thumb.webp',
  thumbPath: 'trips/t1/wishes/w1/thumb.webp',
}

// Prime the image upload pipeline: compressImage → requestUploadIntents
// → uploadToIntent → finalizeUploadIntents. `entityId` MUST match the
// wishId the service is operating on so the returned intents/blobs
// carry paths anchored to the correct entity — without this, a
// test that ran updateWish('w1', ...) but received intents under
// 'w-new' would silently lose path↔entityId binding coverage.
function primeWishUpload(entityId: string, opts: { thumb?: boolean } = {}): void {
  const includeThumb = opts.thumb !== false  // default true
  mocks.compressImageMock.mockResolvedValueOnce({
    full:  new File(['x'], 'full.webp',  { type: 'image/webp' }),
    thumb: includeThumb
      ? new File(['x'], 'thumb.webp', { type: 'image/webp' })
      : undefined,
  })
  const intents: Array<{ intentId: string; path: string; metadata: { contentType: string; customMetadata: Record<string, string> }; expiresAt: string }> = [
    { intentId: `i-${entityId}-F`, path: `trips/t1/wishes/${entityId}/F.webp`, metadata: { contentType: 'image/webp', customMetadata: {} }, expiresAt: '2030-01-01T00:00:00Z' },
  ]
  if (includeThumb) {
    intents.push({ intentId: `i-${entityId}-T`, path: `trips/t1/wishes/${entityId}/T.webp`, metadata: { contentType: 'image/webp', customMetadata: {} }, expiresAt: '2030-01-01T00:00:00Z' })
  }
  mocks.requestUploadIntentsMock.mockResolvedValueOnce(intents)
  mocks.uploadToIntentMock.mockResolvedValue(undefined)
  const blobs: Array<{ kind: string; path: string; url: string; contentType: string; size: number }> = [
    { kind: 'full',  path: `trips/t1/wishes/${entityId}/F.webp`, url: `https://x/${entityId}/F.webp`, contentType: 'image/webp', size: 100 },
  ]
  if (includeThumb) {
    blobs.push({ kind: 'thumb', path: `trips/t1/wishes/${entityId}/T.webp`, url: `https://x/${entityId}/T.webp`, contentType: 'image/webp', size: 50 })
  }
  mocks.finalizeUploadIntentsMock.mockResolvedValueOnce({
    ok: true, entityType: 'wish', tripId: 't1', entityId, blobs,
  })
}

beforeEach(() => {
  // Assertion targets — full reset so prior test's resolved values don't
  // leak through.
  mocks.setDocMock.mockReset()
  mocks.updateDocMock.mockReset()
  mocks.deleteDocMock.mockReset()
  mocks.safePurgeMock.mockReset()
  mocks.bumpTripActivityMock.mockReset()
  mocks.compressImageMock.mockReset()
  mocks.requestUploadIntentsMock.mockReset()
  mocks.uploadToIntentMock.mockReset()
  mocks.finalizeUploadIntentsMock.mockReset()
  mocks.captureErrorMock.mockReset()
  mocks.deleteStorageObjectMock.mockReset()

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
// deleteWish strict-cleanup gate — mirrors deleteBooking
// ────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────
// createWish — setDoc-first + upload + updateDoc, with cleanup ladder
// ────────────────────────────────────────────────────────────────────

describe('createWish', () => {
  it('no file: setDoc only, no upload, no rollback, returns wishId', async () => {
    mocks.setDocMock.mockResolvedValueOnce(undefined)

    const id = await createWish('t1', { title: 'Place' } as unknown as Parameters<typeof createWish>[1], null, 'u1')

    expect(id).toBe('w-new')
    expect(mocks.setDocMock).toHaveBeenCalledTimes(1)
    expect(mocks.compressImageMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.updateDocMock).not.toHaveBeenCalled()
    expect(mocks.deleteDocMock).not.toHaveBeenCalled()
    expect(mocks.captureErrorMock).not.toHaveBeenCalled()
  })

  it('with file: setDoc → upload (full+thumb) → updateDoc with image, binds intents to new wishId', async () => {
    mocks.setDocMock.mockResolvedValueOnce(undefined)
    mocks.updateDocMock.mockResolvedValueOnce(undefined)
    primeWishUpload('w-new')

    const id = await createWish(
      't1',
      { title: 'Place' } as unknown as Parameters<typeof createWish>[1],
      new File([], 'r.jpg', { type: 'image/jpeg' }),
      'u1',
    )

    expect(id).toBe('w-new')
    expect(mocks.setDocMock).toHaveBeenCalledTimes(1)
    // Worker intent request MUST carry the freshly-minted wishId so
    // the Worker mints paths under the correct entity. A drift here
    // would 403 in prod when storage.rules verify path against intent.
    // Lock the FULL body (not just identity fields) so a regression
    // that drops the thumb entry / swaps kinds / mis-types contentType
    // can't slip past — the Worker uses this array verbatim to mint
    // intents.
    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'wish', entityId: 'w-new',
      uploads: [
        { kind: 'full',  contentType: 'image/webp', size: 1 },
        { kind: 'thumb', contentType: 'image/webp', size: 1 },
      ],
    })
    expect(mocks.uploadToIntentMock).toHaveBeenCalledTimes(2)  // full + thumb
    // (intent, file, label) MUST be correctly paired per call — a swap
    // (e.g., full file uploaded to thumb intent's path) would mean
    // mismatched bytes land at each path. Storage.rules would 403 in
    // prod via size + customMetadata checks, but mockResolvedValue
    // tolerates the swap silently. Pin the triples here.
    expect(mocks.uploadToIntentMock).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ intentId: 'i-w-new-F', path: 'trips/t1/wishes/w-new/F.webp' }),
      expect.objectContaining({ name: 'full.webp', type: 'image/webp' }),
      'wish-full',
    )
    expect(mocks.uploadToIntentMock).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ intentId: 'i-w-new-T', path: 'trips/t1/wishes/w-new/T.webp' }),
      expect.objectContaining({ name: 'thumb.webp', type: 'image/webp' }),
      'wish-thumb',
    )
    // finalize MUST consume BOTH intents in order — dropping the thumb
    // would leave it pending until purge cron sweeps it, which is the
    // exact bug client-side tests should catch before prod sees it.
    expect(mocks.finalizeUploadIntentsMock).toHaveBeenCalledWith('t1', ['i-w-new-F', 'i-w-new-T'])
    expect(mocks.updateDocMock).toHaveBeenCalledTimes(1)
    // updateDoc patch includes the image returned by finalize.
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch.image).toMatchObject({
      url:      'https://x/w-new/F.webp',
      path:     'trips/t1/wishes/w-new/F.webp',
      thumbUrl: 'https://x/w-new/T.webp',
      thumbPath:'trips/t1/wishes/w-new/T.webp',
    })
    expect(mocks.deleteDocMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('upload fails BEFORE any blob → deleteDoc rolls back, no safePurge, throws original error', async () => {
    mocks.setDocMock.mockResolvedValueOnce(undefined)
    mocks.deleteDocMock.mockResolvedValueOnce(undefined)
    mocks.compressImageMock.mockResolvedValueOnce({
      full: new File(['x'], 'f.webp', { type: 'image/webp' }),
    })
    mocks.requestUploadIntentsMock.mockRejectedValueOnce(new Error('boom'))

    await expect(createWish(
      't1',
      { title: 'X' } as unknown as Parameters<typeof createWish>[1],
      new File([], 'r.jpg'),
      'u1',
    )).rejects.toThrow(/boom/)

    // No-thumb path: uploads body must be SINGLE-ENTRY [full] only —
    // a regression that always sends both entries would mint an
    // orphan thumb intent the purge cron would have to sweep later.
    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'wish', entityId: 'w-new',
      uploads: [
        { kind: 'full', contentType: 'image/webp', size: 1 },
      ],
    })
    expect(mocks.deleteDocMock).toHaveBeenCalledTimes(1)
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()  // nothing uploaded yet
    expect(mocks.captureErrorMock).toHaveBeenCalledTimes(1)  // upload error only
  })

  it('updateDoc fails AFTER upload → safePurge blob (paths under new wishId) + deleteDoc + throws', async () => {
    mocks.setDocMock.mockResolvedValueOnce(undefined)
    mocks.deleteDocMock.mockResolvedValueOnce(undefined)
    mocks.safePurgeMock.mockResolvedValueOnce('purged')
    primeWishUpload('w-new')
    mocks.updateDocMock.mockRejectedValueOnce(new Error('patch-fail'))

    await expect(createWish(
      't1',
      { title: 'X' } as unknown as Parameters<typeof createWish>[1],
      new File([], 'r.jpg'),
      'u1',
    )).rejects.toThrow(/patch-fail/)

    // Request body must still be correctly built on the failure path —
    // requestUploadIntents ran successfully BEFORE updateDoc failed.
    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'wish', entityId: 'w-new',
      uploads: [
        { kind: 'full',  contentType: 'image/webp', size: 1 },
        { kind: 'thumb', contentType: 'image/webp', size: 1 },
      ],
    })
    // (intent, file, label) triples must still be correctly paired on
    // the failure path — uploadToIntent runs to completion before
    // updateDoc fails, so a swap regression here would also leak bad
    // bytes to Storage before the rollback enqueue.
    expect(mocks.uploadToIntentMock).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ intentId: 'i-w-new-F' }),
      expect.objectContaining({ name: 'full.webp', type: 'image/webp' }),
      'wish-full',
    )
    expect(mocks.uploadToIntentMock).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ intentId: 'i-w-new-T' }),
      expect.objectContaining({ name: 'thumb.webp', type: 'image/webp' }),
      'wish-thumb',
    )
    // finalize had to receive BOTH intentIds before updateDoc would
    // see the full image payload — pin it here too so a service-side
    // thumb-drop regression can't slip through this failure path.
    expect(mocks.finalizeUploadIntentsMock).toHaveBeenCalledWith('t1', ['i-w-new-F', 'i-w-new-T'])
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { entityId: string; source: string; paths: string[] } }
    expect(purgeArgs.enqueue.source).toBe('createWish/rollback-blob')
    expect(purgeArgs.enqueue.entityId).toBe('w-new')
    expect(purgeArgs.enqueue.paths).toEqual(expect.arrayContaining([
      'trips/t1/wishes/w-new/F.webp',
      'trips/t1/wishes/w-new/T.webp',
    ]))
    expect(mocks.deleteDocMock).toHaveBeenCalledTimes(1)
  })

  it('upload fails + deleteDoc ALSO fails → throws WishCreatePartialError(wishId) for cache-invalidate signal', async () => {
    // Backlog-flagged gap: setDoc lands → realtime listener pushes the
    // wish into TanStack cache → upload fails → deleteDoc also fails
    // (network blip, rules race, whatever). Mutation onError must
    // receive the typed error so it can invalidateQueries and
    // reconcile cache with the wish actually persisted in Firestore.
    // Otherwise: "save failed" toast + wish still visible → user
    // re-presses save → DUPLICATE wish.
    mocks.setDocMock.mockResolvedValueOnce(undefined)
    mocks.compressImageMock.mockResolvedValueOnce({
      full: new File(['x'], 'f.webp', { type: 'image/webp' }),
    })
    mocks.requestUploadIntentsMock.mockRejectedValueOnce(new Error('upload-bust'))
    mocks.deleteDocMock.mockRejectedValueOnce(new Error('rollback-bust'))

    let caught: unknown
    try {
      await createWish(
        't1',
        { title: 'X' } as unknown as Parameters<typeof createWish>[1],
        new File([], 'r.jpg'),
        'u1',
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WishCreatePartialError)
    expect((caught as WishCreatePartialError).wishId).toBe('w-new')
    // Sentry captures BOTH the upload error and the rollback error so
    // ops can correlate the partial-failure pair.
    expect(mocks.captureErrorMock).toHaveBeenCalledTimes(2)
  })

  it('compressImage returns non-image (PDF passthrough) → no upload, no updateDoc, returns wishId', async () => {
    // Wish covers are image-only; uploadWishImage returns null when
    // compressImage hands back a non-image (PDF, HEIC). setDoc still
    // succeeds, no rollback fires.
    mocks.setDocMock.mockResolvedValueOnce(undefined)
    mocks.compressImageMock.mockResolvedValueOnce({
      full: new File(['x'], 'doc.pdf', { type: 'application/pdf' }),
    })

    const id = await createWish(
      't1',
      { title: 'X' } as unknown as Parameters<typeof createWish>[1],
      new File([], 'doc.pdf', { type: 'application/pdf' }),
      'u1',
    )

    expect(id).toBe('w-new')
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.updateDocMock).not.toHaveBeenCalled()
    expect(mocks.deleteDocMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────
// updateWish — file replace ordering + rollback symmetry
// ────────────────────────────────────────────────────────────────────

describe('updateWish', () => {
  it('file replace + updateDoc OK → upload bound to existing wishId, purge OLD on success', async () => {
    primeWishUpload('w1')
    mocks.updateDocMock.mockResolvedValueOnce(undefined)
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await updateWish(
      't1', 'w1',
      { title: 'Edit' } as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg'), existingImage: IMAGE },
    )

    // The intent request must be bound to the EXISTING wishId, not
    // to any drifted id — paths the Worker mints flow through this.
    // Lock the full uploads body too so a regression on the update
    // flow that drops thumb / swaps kinds is caught here as well.
    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'wish', entityId: 'w1',
      uploads: [
        { kind: 'full',  contentType: 'image/webp', size: 1 },
        { kind: 'thumb', contentType: 'image/webp', size: 1 },
      ],
    })
    expect(mocks.uploadToIntentMock).toHaveBeenCalledTimes(2)
    // Per-call (intent, file, label) pairing — same Worker contract
    // applies on update flow as create flow.
    expect(mocks.uploadToIntentMock).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ intentId: 'i-w1-F', path: 'trips/t1/wishes/w1/F.webp' }),
      expect.objectContaining({ name: 'full.webp', type: 'image/webp' }),
      'wish-full',
    )
    expect(mocks.uploadToIntentMock).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ intentId: 'i-w1-T', path: 'trips/t1/wishes/w1/T.webp' }),
      expect.objectContaining({ name: 'thumb.webp', type: 'image/webp' }),
      'wish-thumb',
    )
    // finalize MUST consume both intents — a service-side drop of
    // the thumb intentId would 200 here but leave the thumb intent
    // pending in Firestore until purge cron sweeps it.
    expect(mocks.finalizeUploadIntentsMock).toHaveBeenCalledWith('t1', ['i-w1-F', 'i-w1-T'])
    // updateDoc patch.image carries the new (w1-bound) paths.
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch.image).toMatchObject({
      path:      'trips/t1/wishes/w1/F.webp',
      thumbPath: 'trips/t1/wishes/w1/T.webp',
    })
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)  // old purge on success
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { source: string; paths: string[] } }
    expect(purgeArgs.enqueue.source).toBe('updateWish/purge-old-image')
    expect(purgeArgs.enqueue.paths).toEqual(expect.arrayContaining([IMAGE.path, IMAGE.thumbPath]))
  })

  it('file replace + updateDoc FAIL → safePurge NEW (w1-bound) blob, OLD untouched, throws', async () => {
    primeWishUpload('w1')
    mocks.updateDocMock.mockRejectedValueOnce(new Error('patch-fail'))
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await expect(updateWish(
      't1', 'w1',
      { title: 'Edit' } as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg'), existingImage: IMAGE },
    )).rejects.toThrow(/patch-fail/)

    // Request body must be correctly built on the update failure
    // path too — requestUploadIntents ran successfully before
    // updateDoc rejected.
    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'wish', entityId: 'w1',
      uploads: [
        { kind: 'full',  contentType: 'image/webp', size: 1 },
        { kind: 'thumb', contentType: 'image/webp', size: 1 },
      ],
    })
    // (intent, file, label) triples ran before updateDoc failed —
    // pin the pairing so a swap regression here ALSO can't slip
    // through the rollback path silently.
    expect(mocks.uploadToIntentMock).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ intentId: 'i-w1-F' }),
      expect.objectContaining({ name: 'full.webp', type: 'image/webp' }),
      'wish-full',
    )
    expect(mocks.uploadToIntentMock).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ intentId: 'i-w1-T' }),
      expect.objectContaining({ name: 'thumb.webp', type: 'image/webp' }),
      'wish-thumb',
    )
    // finalize ran before updateDoc — pin BOTH intentIds here so a
    // service-side thumb-drop regression can't slip through the
    // failure path either (mirrors the createWish failure-path test).
    expect(mocks.finalizeUploadIntentsMock).toHaveBeenCalledWith('t1', ['i-w1-F', 'i-w1-T'])
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { entityId: string; source: string; paths: string[] } }
    expect(purgeArgs.enqueue.source).toBe('updateWish/rollback-new-image')
    expect(purgeArgs.enqueue.entityId).toBe('w1')
    // NEW blob (under w1, fresh filename) is enqueued; OLD (under w1
    // too, but different filename) must NOT appear — doc still
    // references it via the unchanged patch.
    expect(purgeArgs.enqueue.paths).toContain('trips/t1/wishes/w1/F.webp')
    expect(purgeArgs.enqueue.paths).not.toContain(IMAGE.path)
  })

  it('attachment=null + updateDoc OK → patch.image = deleteField, no upload, purge OLD', async () => {
    mocks.updateDocMock.mockResolvedValueOnce(undefined)
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await updateWish(
      't1', 'w1',
      {} as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: null, existingImage: IMAGE },
    )

    expect(mocks.uploadToIntentMock).not.toHaveBeenCalled()
    expect(mocks.deleteFieldMock).toHaveBeenCalled()
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch.image).toEqual({ _kind: 'deleteField' })
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { source: string } }
    expect(purgeArgs.enqueue.source).toBe('updateWish/purge-old-image')
  })
})
