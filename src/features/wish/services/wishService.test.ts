// Service-layer regression tests for wishService.
//
// Phase 3.7 surfaces pinned here:
//   1. deleteWish strict-cleanup gate — when both purge AND `_purges`
//      enqueue fail, abort before deleteDoc so the path → blob binding
//      survives a human retry. (Unchanged from earlier phases.)
//   2. createWish path discrimination — text-only (no file / non-image
//      passthrough) goes through client setDoc; with-image goes through
//      Worker /wish-file-create (atomic doc + image in one tx). Tests
//      pin BOTH the Worker call shape AND the absence of client setDoc
//      on the image path.
//   3. updateWish path discrimination — image-File replace goes through
//      Worker /wish-file-update with text patch + intentIds in a single
//      atomic round-trip (no separate client updateDoc on this path).
//      Detach (null), non-image fallback, and text-only stay on the
//      client updateDoc path with `image: deleteField()` where
//      applicable.
//
// Worker contract:
//   - workerFetch(base, idToken, endpoint, body) is the single chokepoint
//     for /wish-file-create and /wish-file-update. The mock asserts full
//     body shape (tripId / wishId / wish | patch / intentIds) so a
//     regression that drops a field or sends an unintended one is caught
//     here, not at the Worker boundary in prod.
//   - finalizeUploadIntents is no longer involved on wish: doc + image
//     write happen atomically inside /wish-file-create or
//     /wish-file-update. Tests do NOT mock or assert finalize calls.
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  requestUploadIntents: mocks.requestUploadIntentsMock,
  uploadToIntent:       mocks.uploadToIntentMock,
}))

vi.mock('@/services/workerBase', () => ({
  requireWorkerWriteBase: mocks.requireWorkerWriteBaseMock,
  preflightIdToken:       mocks.preflightIdTokenMock,
  workerFetch:            mocks.workerFetchMock,
}))

vi.mock('@/services/tripMemberIds', () => ({
  getTripMemberIds: mocks.getTripMemberIdsMock,
}))

vi.mock('@/utils/image', () => ({
  compressImage: mocks.compressImageMock,
}))

import { deleteWish, createWish, updateWish } from './wishService'
import type { WishImage } from '@/types'

const IMAGE: WishImage = {
  url:       'https://example.com/full.webp',
  path:      'trips/t1/wishes/w1/full.webp',
  thumbUrl:  'https://example.com/thumb.webp',
  thumbPath: 'trips/t1/wishes/w1/thumb.webp',
}

// Prime the upload-first pipeline: compressImage → requestUploadIntents
// → uploadToIntent. `entityId` MUST match the wishId the service is
// operating on so the returned intents carry paths anchored to the
// correct entity — without this, a test that ran updateWish('w1', ...)
// but received intents under 'w-new' would silently lose path↔entityId
// binding coverage.
//
// Phase 3.7: NO finalize — Worker /wish-file-create or /wish-file-update
// consumes intents inside its own atomic tx with the doc write. The
// workerFetchMock resolves with `{ wishId }` on /wish-file-create or
// `{ ok: true }` on /wish-file-update by default.
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
  mocks.deleteStorageObjectMock.mockReset()
  mocks.workerFetchMock.mockReset()

  // Shape-stable mocks — clear calls but keep impl.
  mocks.docMock.mockClear()
  mocks.collectionMock.mockClear()
  mocks.deleteFieldMock.mockClear()
  mocks.serverTimestampMock.mockClear()
  mocks.requireWorkerWriteBaseMock.mockClear()
  mocks.preflightIdTokenMock.mockClear()

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
// createWish — text-only client setDoc vs Worker /wish-file-create
// ────────────────────────────────────────────────────────────────────

describe('createWish', () => {
  it('no file: client setDoc only, no compress, no Worker call, returns wishId', async () => {
    mocks.setDocMock.mockResolvedValueOnce(undefined)

    const id = await createWish('t1', { title: 'Place' } as unknown as Parameters<typeof createWish>[1], null, 'u1')

    expect(id).toBe('w-new')
    expect(mocks.setDocMock).toHaveBeenCalledTimes(1)
    // Text-only path must NEVER touch the Worker — the whole point of
    // keeping setDoc here is the fast no-round-trip path.
    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.compressImageMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.uploadToIntentMock).not.toHaveBeenCalled()
  })

  it('with image File: upload-first → POST /wish-file-create, NO client setDoc', async () => {
    primeWishUpload('w-new')
    mocks.workerFetchMock.mockResolvedValueOnce({ wishId: 'w-new' })

    const id = await createWish(
      't1',
      { title: 'Place' } as unknown as Parameters<typeof createWish>[1],
      new File([], 'r.jpg', { type: 'image/jpeg' }),
      'u1',
    )

    expect(id).toBe('w-new')

    // Worker-authoritative: client must NOT touch setDoc on this path.
    // A regression that left a client setDoc would either race the
    // Worker's tx (duplicate doc / 409) or — post Commit 4 rules — be
    // blocked by the image-absent rule and surface as a deny.
    expect(mocks.setDocMock).not.toHaveBeenCalled()
    // No client-side memberIds read either — Worker resolves trip
    // membership inside the tx.
    expect(mocks.getTripMemberIdsMock).not.toHaveBeenCalled()

    // requestUploadIntents body MUST carry the freshly-minted wishId so
    // the Worker mints paths under the correct entity. mode='create'
    // tells Worker authzUpload to skip the wish-doc-exists check (the
    // doc legitimately doesn't exist yet — /wish-file-create will create
    // it in the same tx). Lock the FULL body so a regression that drops
    // mode or alters uploads is caught.
    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'wish', entityId: 'w-new',
      mode:   'create',
      uploads: [
        { kind: 'full',  contentType: 'image/webp', size: 1 },
        { kind: 'thumb', contentType: 'image/webp', size: 1 },
      ],
    })
    expect(mocks.uploadToIntentMock).toHaveBeenCalledTimes(2)
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

    // workerFetch body: (base, idToken, endpoint, body). Pin the full
    // body so a regression that drops intentIds / swaps wishId / lets
    // an `image` field slip into the wish payload is caught here.
    expect(mocks.workerFetchMock).toHaveBeenCalledTimes(1)
    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test',
      'tok-test',
      '/wish-file-create',
      {
        tripId:    't1',
        wishId:    'w-new',
        wish:      { title: 'Place' },
        intentIds: ['i-w-new-F', 'i-w-new-T'],
      },
    )
  })

  it('with non-image File (PDF passthrough): falls back to client setDoc, no Worker call', async () => {
    // Wish covers are image-only; if compressImage hands back a non-
    // image (PDF, decode failure), createWish silently degrades to the
    // text-only path. setDoc still succeeds, no Worker call.
    mocks.compressImageMock.mockResolvedValueOnce({
      full: new File(['x'], 'doc.pdf', { type: 'application/pdf' }),
    })
    mocks.setDocMock.mockResolvedValueOnce(undefined)

    const id = await createWish(
      't1',
      { title: 'X' } as unknown as Parameters<typeof createWish>[1],
      new File([], 'doc.pdf', { type: 'application/pdf' }),
      'u1',
    )

    expect(id).toBe('w-new')
    expect(mocks.setDocMock).toHaveBeenCalledTimes(1)
    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.uploadToIntentMock).not.toHaveBeenCalled()
  })

  it('compressImage fails: throws original error, no setDoc, no Worker call, no orphan to clean', async () => {
    // Compress is the path-gate — failure aborts BEFORE any side effect.
    // No doc written, no blob uploaded, no rollback needed (no
    // half-state to recover from under the atomic Worker tx contract).
    mocks.compressImageMock.mockRejectedValueOnce(new Error('canvas-bust'))

    await expect(createWish(
      't1',
      { title: 'X' } as unknown as Parameters<typeof createWish>[1],
      new File([], 'r.jpg'),
      'u1',
    )).rejects.toThrow(/canvas-bust/)

    expect(mocks.setDocMock).not.toHaveBeenCalled()
    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.uploadToIntentMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('requestUploadIntents fails: throws, no Worker /wish-file-create call, no setDoc, no client purge', async () => {
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
      mode:   'create',
      uploads: [
        { kind: 'full', contentType: 'image/webp', size: 1 },
      ],
    })
    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.setDocMock).not.toHaveBeenCalled()
    // Phase 3.7: no client-side blob purge on rollback. Worker
    // storage-scan cron reaps orphaned bytes; intents that never minted
    // a path aren't an orphan source either.
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('/wish-file-create fails AFTER upload: throws, NO client setDoc, NO client purge (Worker scan reaps)', async () => {
    // Worker tx atomically commits OR aborts: doc + intent markUsed all
    // or nothing. Client has nothing local to purge; storage-scan reaps
    // the orphan blob bytes.
    primeWishUpload('w-new')
    mocks.workerFetchMock.mockRejectedValueOnce(new Error('worker-rejected'))

    await expect(createWish(
      't1',
      { title: 'X' } as unknown as Parameters<typeof createWish>[1],
      new File([], 'r.jpg'),
      'u1',
    )).rejects.toThrow(/worker-rejected/)

    // Upload pipeline ran fully before Worker rejected.
    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'wish', entityId: 'w-new',
      mode:   'create',
      uploads: [
        { kind: 'full',  contentType: 'image/webp', size: 1 },
        { kind: 'thumb', contentType: 'image/webp', size: 1 },
      ],
    })
    expect(mocks.uploadToIntentMock).toHaveBeenCalledTimes(2)
    // workerFetch fired with the full body shape on the failure path
    // too — pin so a regression doesn't slip past on the rejection
    // branch.
    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test',
      'tok-test',
      '/wish-file-create',
      {
        tripId:    't1',
        wishId:    'w-new',
        wish:      { title: 'X' },
        intentIds: ['i-w-new-F', 'i-w-new-T'],
      },
    )
    expect(mocks.setDocMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────
// updateWish — Worker-authoritative replace vs client text/detach
// ────────────────────────────────────────────────────────────────────

describe('updateWish', () => {
  it('image File replace + Worker OK → single /wish-file-update (no client updateDoc), purge OLD', async () => {
    primeWishUpload('w1')
    mocks.workerFetchMock.mockResolvedValueOnce({ ok: true })
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await updateWish(
      't1', 'w1',
      { title: 'Edit' } as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg', { type: 'image/jpeg' }), existingImage: IMAGE },
    )

    // Worker-authoritative replace: text + image land atomically in ONE
    // Worker call — no client updateDoc on this path. A regression that
    // left a separate client updateDoc would race the Worker's tx OR
    // (post Commit 4) be blocked by rules-tightening on the image field.
    expect(mocks.updateDocMock).not.toHaveBeenCalled()

    // Intent request bound to the EXISTING wishId. mode='update' tells
    // Worker authzUpload to enforce the proposer check.
    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'wish', entityId: 'w1',
      mode:   'update',
      uploads: [
        { kind: 'full',  contentType: 'image/webp', size: 1 },
        { kind: 'thumb', contentType: 'image/webp', size: 1 },
      ],
    })
    expect(mocks.uploadToIntentMock).toHaveBeenCalledTimes(2)
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

    // Worker call: patch carries validated text fields, intentIds bound
    // to the wishId, expectedCurrentPath = the existing image.path
    // (stale-replace guard — Worker rejects 409 if Tab B drifted).
    // NO `image` in the patch — Worker writes that from the consumed
    // intents.
    expect(mocks.workerFetchMock).toHaveBeenCalledTimes(1)
    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test',
      'tok-test',
      '/wish-file-update',
      {
        tripId:              't1',
        wishId:              'w1',
        patch:               { title: 'Edit' },
        intentIds:           ['i-w1-F', 'i-w1-T'],
        expectedCurrentPath: IMAGE.path,
      },
    )

    // OLD blob purge on success.
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { source: string; paths: string[] } }
    expect(purgeArgs.enqueue.source).toBe('updateWish/purge-old-image')
    expect(purgeArgs.enqueue.paths).toEqual(expect.arrayContaining([IMAGE.path, IMAGE.thumbPath]))
  })

  it('image File replace + /wish-file-update FAILS: no purge of OLD (still referenced), no client updateDoc, throws', async () => {
    // Worker tx atomically aborts: doc image still points to OLD blob,
    // text patch never applied. Client has no OLD to purge (OLD is
    // still doc-referenced) and no NEW to purge (Worker storage-scan
    // reaps the orphaned upload).
    primeWishUpload('w1')
    mocks.workerFetchMock.mockRejectedValueOnce(new Error('worker-409-stale'))

    await expect(updateWish(
      't1', 'w1',
      { title: 'Edit' } as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg', { type: 'image/jpeg' }), existingImage: IMAGE },
    )).rejects.toThrow(/worker-409-stale/)

    expect(mocks.updateDocMock).not.toHaveBeenCalled()
    expect(mocks.workerFetchMock).toHaveBeenCalledTimes(1)
    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test',
      'tok-test',
      '/wish-file-update',
      {
        tripId:              't1',
        wishId:              'w1',
        patch:               { title: 'Edit' },
        intentIds:           ['i-w1-F', 'i-w1-T'],
        expectedCurrentPath: IMAGE.path,
      },
    )
    // OLD untouched, NEW reaped by Worker scan.
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('attachment=null + updateDoc OK → client updateDoc with patch.image=deleteField, no Worker call, purge OLD', async () => {
    mocks.updateDocMock.mockResolvedValueOnce(undefined)
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await updateWish(
      't1', 'w1',
      {} as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: null, existingImage: IMAGE },
    )

    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.uploadToIntentMock).not.toHaveBeenCalled()
    expect(mocks.deleteFieldMock).toHaveBeenCalled()
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch.image).toEqual({ _kind: 'deleteField' })
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { source: string } }
    expect(purgeArgs.enqueue.source).toBe('updateWish/purge-old-image')
  })

  it('non-image File (PDF) → client updateDoc with patch.image=deleteField, no Worker call, purge OLD', async () => {
    // Wish covers are image-only. A non-image File falls back to
    // detach semantics: clear the image field in the text patch, no
    // Worker call, purge the OLD blob if one existed.
    mocks.compressImageMock.mockResolvedValueOnce({
      full: new File(['x'], 'doc.pdf', { type: 'application/pdf' }),
    })
    mocks.updateDocMock.mockResolvedValueOnce(undefined)
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await updateWish(
      't1', 'w1',
      {} as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: new File([], 'doc.pdf', { type: 'application/pdf' }), existingImage: IMAGE },
    )

    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.uploadToIntentMock).not.toHaveBeenCalled()
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch.image).toEqual({ _kind: 'deleteField' })
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
  })

  it('first-attach (no existingImage) + image File → /wish-file-update, no purge (nothing to purge)', async () => {
    primeWishUpload('w1')
    mocks.workerFetchMock.mockResolvedValueOnce({ ok: true })

    await updateWish(
      't1', 'w1',
      { title: 'Edit' } as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg', { type: 'image/jpeg' }), existingImage: undefined },
    )

    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test',
      'tok-test',
      '/wish-file-update',
      {
        tripId:              't1',
        wishId:              'w1',
        patch:               { title: 'Edit' },
        intentIds:           ['i-w1-F', 'i-w1-T'],
        // First-attach: editor saw no image, Worker accepts null only
        // when the live doc also has no image (guards Tab-B-attached race).
        expectedCurrentPath: null,
      },
    )
    // No OLD to purge.
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('attachment=undefined (text-only edit) → client updateDoc only, no Worker, no upload, no purge', async () => {
    mocks.updateDocMock.mockResolvedValueOnce(undefined)

    await updateWish(
      't1', 'w1',
      { title: 'Rename' } as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: undefined, existingImage: IMAGE },
    )

    expect(mocks.compressImageMock).not.toHaveBeenCalled()
    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()  // image untouched
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch).not.toHaveProperty('image')
  })

  it('text updateDoc FAILS (text-only path) → no upload, no Worker, no purge, throws', async () => {
    // Text-only path failure: image untouched, no upload ever attempted.
    mocks.updateDocMock.mockRejectedValueOnce(new Error('text-fail'))

    await expect(updateWish(
      't1', 'w1',
      { title: 'Rename' } as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: undefined, existingImage: IMAGE },
    )).rejects.toThrow(/text-fail/)

    expect(mocks.workerFetchMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })
})
