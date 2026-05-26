// Service-layer regression tests for wishService.
//
// Three surfaces are pinned here:
//   1. deleteWish strict-cleanup gate — when both purge AND `_purges`
//      enqueue fail, abort before deleteDoc so the path → blob binding
//      survives a human retry.
//   2. createWish doc-first + Worker-authoritative image. setDoc lands
//      (NO image field), the Worker patches `wish.image` via
//      /upload-finalize. If upload or its rollback deleteDoc fails, we
//      MUST throw `WishCreatePartialError` so the caller can
//      `invalidateQueries` and reconcile cache with reality. Without
//      it a "save failed" toast + a still-visible wish lets the user
//      re-press → DUPLICATE wish.
//   3. updateWish split-write — text patch first (with
//      `image: deleteField()` on detach / non-image fallback), THEN
//      uploadWishImage for image File replace. OLD blob purged on
//      combined success.
//
// Phase 3.6 contract notes wired into the assertions below:
//   - finalizeUploadIntents now takes (tripId, intentIds, applyToDoc)
//     where applyToDoc carries `expectedCurrentPath`. Stale-finalize
//     guard lives in the Worker; tests assert the body shape.
//   - finalize response is `{ ok: true }` (no blob payload). Client
//     re-reads via realtime listener; assertions that previously
//     poked at `patch.image` from updateDoc on the replace path are
//     gone (Worker writes that field, not the client).
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
// wishId the service is operating on so the returned intents carry
// paths anchored to the correct entity — without this, a test that ran
// updateWish('w1', ...) but received intents under 'w-new' would
// silently lose path↔entityId binding coverage.
//
// Phase 3.6: finalize response is `{ ok: true }` only -- no blobs.
// Worker patches `wish.image` itself; the client re-reads via realtime
// listener so the test doesn't simulate any patch payload.
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
  mocks.finalizeUploadIntentsMock.mockResolvedValueOnce({ ok: true })
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
// createWish — doc-first + Worker-authoritative image patch
// ────────────────────────────────────────────────────────────────────

describe('createWish', () => {
  it('no file: setDoc only, no upload, no rollback, returns wishId', async () => {
    mocks.setDocMock.mockResolvedValueOnce(undefined)

    const id = await createWish('t1', { title: 'Place' } as unknown as Parameters<typeof createWish>[1], null, 'u1')

    expect(id).toBe('w-new')
    expect(mocks.setDocMock).toHaveBeenCalledTimes(1)
    expect(mocks.compressImageMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.finalizeUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.updateDocMock).not.toHaveBeenCalled()
    expect(mocks.deleteDocMock).not.toHaveBeenCalled()
    expect(mocks.captureErrorMock).not.toHaveBeenCalled()
  })

  it('with file: setDoc (no image) → upload (full+thumb) → finalize with applyToDoc null, Worker writes image, NO client updateDoc', async () => {
    mocks.setDocMock.mockResolvedValueOnce(undefined)
    primeWishUpload('w-new')

    const id = await createWish(
      't1',
      { title: 'Place' } as unknown as Parameters<typeof createWish>[1],
      new File([], 'r.jpg', { type: 'image/jpeg' }),
      'u1',
    )

    expect(id).toBe('w-new')
    expect(mocks.setDocMock).toHaveBeenCalledTimes(1)
    // Doc-first: setDoc payload MUST NOT carry an image field. The
    // Worker is the authoritative writer for that field from Phase 3.6
    // onward, so any client-side write would either be rejected by
    // rules (Commit 3) or get clobbered by the Worker's patch.
    const setDocPayload = mocks.setDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(setDocPayload).not.toHaveProperty('image')
    // Worker intent request MUST carry the freshly-minted wishId so
    // the Worker mints paths under the correct entity. A drift here
    // would fail at Worker /upload-finalize when consumeIntentInTx
    // compares the uploaded object's customMetadata.entityId against
    // the intent's entityId field. storage.rules itself only checks
    // that the upload's metadata.entityId matches the URL param --
    // a wrong wishId at intent-request time produces a consistent
    // (wrong) URL + metadata pair that rules accept, so the safety
    // net is the Worker's consume-time check. Lock the FULL body
    // (not just identity fields) so a regression that drops the
    // thumb entry / swaps kinds / mis-types contentType can't slip
    // past — the Worker uses this array verbatim to mint intents.
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
    // Phase 3.6 finalize contract: (tripId, intentIds, applyToDoc) with
    // expectedCurrentPath=null on create (no existing image). A
    // regression that omits applyToDoc would be a 400 schema-validate
    // in prod -- pin the full body shape here.
    expect(mocks.finalizeUploadIntentsMock).toHaveBeenCalledWith(
      't1',
      ['i-w-new-F', 'i-w-new-T'],
      { mode: 'patch', expectedCurrentPath: null },
    )
    // Worker writes wish.image directly via finalize's tx; the client
    // does NOT call updateDoc on the create path anymore.
    expect(mocks.updateDocMock).not.toHaveBeenCalled()
    expect(mocks.deleteDocMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('compressImage fails AFTER setDoc → deleteDoc rolls back, no upload attempted, throws original error', async () => {
    // P2 regression guard: compressImage runs AFTER setDoc lands.
    // Canvas / encode / File-construction failure must NOT leave the
    // wish doc orphan -- otherwise the realtime listener pushes it to
    // the cache, the user sees "save failed" + a stale row, and a
    // retry creates a duplicate. Whole image step (compress + upload)
    // shares one rollback try/catch in createWish.
    mocks.setDocMock.mockResolvedValueOnce(undefined)
    mocks.deleteDocMock.mockResolvedValueOnce(undefined)
    mocks.compressImageMock.mockRejectedValueOnce(new Error('canvas-bust'))

    await expect(createWish(
      't1',
      { title: 'X' } as unknown as Parameters<typeof createWish>[1],
      new File([], 'r.jpg'),
      'u1',
    )).rejects.toThrow(/canvas-bust/)

    // Upload pipeline never engaged -- compress aborted first.
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.uploadToIntentMock).not.toHaveBeenCalled()
    expect(mocks.finalizeUploadIntentsMock).not.toHaveBeenCalled()
    // Doc rolled back via single deleteDoc; Worker storage-scan owns
    // any orphan bytes (there were none here, but the contract holds).
    expect(mocks.deleteDocMock).toHaveBeenCalledTimes(1)
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
    expect(mocks.captureErrorMock).toHaveBeenCalledTimes(1)  // compress error only
  })

  it('compressImage fails + deleteDoc ALSO fails → throws WishCreatePartialError(wishId)', async () => {
    // Same partial-failure escalation as the upload-fail variant: when
    // BOTH the image step AND the rollback fail, throw the typed error
    // so the mutation hook can invalidateQueries and reconcile cache.
    mocks.setDocMock.mockResolvedValueOnce(undefined)
    mocks.compressImageMock.mockRejectedValueOnce(new Error('canvas-bust'))
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
    // Both the compress error and the rollback error captured for ops
    // correlation -- same pattern as the upload-fail variant.
    expect(mocks.captureErrorMock).toHaveBeenCalledTimes(2)
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
    // Phase 3.6: no client-side blob purge on rollback. Worker
    // storage-scan cron reaps orphaned bytes; client only undoes the
    // doc.
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
    expect(mocks.captureErrorMock).toHaveBeenCalledTimes(1)  // upload error only
  })

  it('finalize fails AFTER upload → deleteDoc rolls back, NO client-side blob purge (Worker scan reaps), throws', async () => {
    // Phase 3.6: Worker tx aborts atomically -- intent markUsed +
    // wish.image patch happen together or not at all. Client has
    // nothing local to purge; Worker storage-scan cron reaps any
    // orphan bytes. The client's responsibility on this path is just
    // to roll the wish doc back so the user can retry without a
    // duplicate.
    mocks.setDocMock.mockResolvedValueOnce(undefined)
    mocks.deleteDocMock.mockResolvedValueOnce(undefined)
    primeWishUpload('w-new')
    // Override the prime'd resolve with a reject so finalize fails.
    mocks.finalizeUploadIntentsMock.mockReset()
    mocks.finalizeUploadIntentsMock.mockRejectedValueOnce(new Error('finalize-fail'))

    await expect(createWish(
      't1',
      { title: 'X' } as unknown as Parameters<typeof createWish>[1],
      new File([], 'r.jpg'),
      'u1',
    )).rejects.toThrow(/finalize-fail/)

    // Request body still correctly built on the failure path —
    // requestUploadIntents + uploadToIntent ran before finalize failed.
    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'wish', entityId: 'w-new',
      uploads: [
        { kind: 'full',  contentType: 'image/webp', size: 1 },
        { kind: 'thumb', contentType: 'image/webp', size: 1 },
      ],
    })
    // (intent, file, label) pairing must still hold on this failure
    // path -- uploadToIntent runs to completion before finalize fails,
    // so bad bytes could leak to Storage if the pairing regresses.
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
    // finalize body shape -- applyToDoc with null expectedCurrentPath
    // even on the failure path.
    expect(mocks.finalizeUploadIntentsMock).toHaveBeenCalledWith(
      't1',
      ['i-w-new-F', 'i-w-new-T'],
      { mode: 'patch', expectedCurrentPath: null },
    )
    // Doc rollback ran; Worker storage-scan handles the bytes.
    expect(mocks.deleteDocMock).toHaveBeenCalledTimes(1)
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
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
    // Wish covers are image-only; if compressImage hands back a non-
    // image (PDF, decode failure), createWish silently skips the
    // upload step. setDoc still succeeds, no rollback fires. The
    // wish persists without an image -- the form UI prevents this
    // case in practice, but the service degrades cleanly.
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
    expect(mocks.finalizeUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.updateDocMock).not.toHaveBeenCalled()
    expect(mocks.deleteDocMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────
// updateWish — split-write ordering + Worker-authoritative image patch
// ────────────────────────────────────────────────────────────────────

describe('updateWish', () => {
  it('file replace + finalize OK → text updateDoc (no image), Worker patches image with expectedCurrentPath, purge OLD', async () => {
    primeWishUpload('w1')
    mocks.updateDocMock.mockResolvedValueOnce(undefined)
    mocks.safePurgeMock.mockResolvedValueOnce('purged')

    await updateWish(
      't1', 'w1',
      { title: 'Edit' } as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg'), existingImage: IMAGE },
    )

    // Text updateDoc fires FIRST in Phase 3.6 split-write order. The
    // patch must NOT include `image` on the replace path -- the Worker
    // is the only writer for that field. A regression that left
    // `patch.image = newImage` here would race with the Worker's tx
    // and trip the rules-tightening in Commit 3 (image field locked to
    // unchanged-or-removed client-side).
    expect(mocks.updateDocMock).toHaveBeenCalledTimes(1)
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch).not.toHaveProperty('image')
    // The intent request must be bound to the EXISTING wishId, not
    // to any drifted id — paths the Worker mints flow through this.
    // Lock the full uploads body so a regression on the update flow
    // that drops thumb / swaps kinds is caught here as well.
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
    // Phase 3.6 finalize: applyToDoc.expectedCurrentPath carries the
    // EXISTING image.path so the Worker can reject if Tab B already
    // replaced the image between Tab A's upload and finalize.
    expect(mocks.finalizeUploadIntentsMock).toHaveBeenCalledWith(
      't1',
      ['i-w1-F', 'i-w1-T'],
      { mode: 'patch', expectedCurrentPath: IMAGE.path },
    )
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)  // old purge on success
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { source: string; paths: string[] } }
    expect(purgeArgs.enqueue.source).toBe('updateWish/purge-old-image')
    expect(purgeArgs.enqueue.paths).toEqual(expect.arrayContaining([IMAGE.path, IMAGE.thumbPath]))
  })

  it('text updateDoc FAILS BEFORE upload → no requestUploadIntents, no purge, throws', async () => {
    // Split-write: text patch first. If it rejects, the upload step
    // never runs and no orphan bytes land in Storage. The OLD image
    // is untouched (the rejected updateDoc means no doc write
    // committed).
    //
    // compressImage runs upfront (to gate the deleteField branch on
    // non-image inputs) BEFORE the updateDoc call, so we still prime
    // it; the upload pipeline beyond compressImage never fires.
    mocks.compressImageMock.mockResolvedValueOnce({
      full:  new File(['x'], 'full.webp',  { type: 'image/webp' }),
      thumb: new File(['x'], 'thumb.webp', { type: 'image/webp' }),
    })
    mocks.updateDocMock.mockRejectedValueOnce(new Error('text-fail'))

    await expect(updateWish(
      't1', 'w1',
      { title: 'Edit' } as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg', { type: 'image/jpeg' }), existingImage: IMAGE },
    )).rejects.toThrow(/text-fail/)

    // compressImage runs upfront (to gate the deleteField branch on
    // non-image inputs), but the network path stops at updateDoc.
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.uploadToIntentMock).not.toHaveBeenCalled()
    expect(mocks.finalizeUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('finalize FAILS AFTER text patch → text edits persist, OLD image untouched, no client-side purge, throws', async () => {
    // Phase 3.6: Worker tx aborted means doc.image still references
    // the OLD blob. Client doesn't purge OLD (still referenced) and
    // doesn't purge the orphaned NEW upload (Worker storage-scan
    // reaps). User can retry; text fields re-write idempotently from
    // the same form state and only the upload retries.
    primeWishUpload('w1')
    mocks.updateDocMock.mockResolvedValueOnce(undefined)
    // Override prime'd finalize to reject.
    mocks.finalizeUploadIntentsMock.mockReset()
    mocks.finalizeUploadIntentsMock.mockRejectedValueOnce(new Error('finalize-stale'))

    await expect(updateWish(
      't1', 'w1',
      { title: 'Edit' } as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg'), existingImage: IMAGE },
    )).rejects.toThrow(/finalize-stale/)

    // Text updateDoc ran first and persisted.
    expect(mocks.updateDocMock).toHaveBeenCalledTimes(1)
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch).not.toHaveProperty('image')
    // Both intents requested + uploaded before finalize rejected.
    expect(mocks.requestUploadIntentsMock).toHaveBeenCalledWith({
      tripId: 't1', entityType: 'wish', entityId: 'w1',
      uploads: [
        { kind: 'full',  contentType: 'image/webp', size: 1 },
        { kind: 'thumb', contentType: 'image/webp', size: 1 },
      ],
    })
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
    expect(mocks.finalizeUploadIntentsMock).toHaveBeenCalledWith(
      't1',
      ['i-w1-F', 'i-w1-T'],
      { mode: 'patch', expectedCurrentPath: IMAGE.path },
    )
    // No purge -- OLD still referenced by doc; NEW orphan reaped by
    // Worker scan.
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
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
    expect(mocks.finalizeUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.deleteFieldMock).toHaveBeenCalled()
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch.image).toEqual({ _kind: 'deleteField' })
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
    const purgeArgs = mocks.safePurgeMock.mock.calls[0]![0] as { enqueue: { source: string } }
    expect(purgeArgs.enqueue.source).toBe('updateWish/purge-old-image')
  })

  it('non-image File (PDF) → patch.image = deleteField, no upload, purge OLD', async () => {
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

    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.uploadToIntentMock).not.toHaveBeenCalled()
    expect(mocks.finalizeUploadIntentsMock).not.toHaveBeenCalled()
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch.image).toEqual({ _kind: 'deleteField' })
    expect(mocks.safePurgeMock).toHaveBeenCalledTimes(1)
  })

  it('first-attach (no existingImage) + image File → finalize with expectedCurrentPath null, no purge', async () => {
    // Wish that never had an image (existingImage undefined) gets one
    // attached via updateWish. Worker first-attach guard: expect
    // wish.image absent → pass null.
    primeWishUpload('w1')
    mocks.updateDocMock.mockResolvedValueOnce(undefined)

    await updateWish(
      't1', 'w1',
      { title: 'Edit' } as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: new File([], 'r.jpg', { type: 'image/jpeg' }), existingImage: undefined },
    )

    expect(mocks.finalizeUploadIntentsMock).toHaveBeenCalledWith(
      't1',
      ['i-w1-F', 'i-w1-T'],
      { mode: 'patch', expectedCurrentPath: null },
    )
    // No OLD to purge.
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()
  })

  it('attachment=undefined (text-only edit) → text updateDoc only, no upload, no purge', async () => {
    mocks.updateDocMock.mockResolvedValueOnce(undefined)

    await updateWish(
      't1', 'w1',
      { title: 'Rename' } as unknown as Parameters<typeof updateWish>[2],
      { uid: 'u1', attachment: undefined, existingImage: IMAGE },
    )

    expect(mocks.compressImageMock).not.toHaveBeenCalled()
    expect(mocks.requestUploadIntentsMock).not.toHaveBeenCalled()
    expect(mocks.safePurgeMock).not.toHaveBeenCalled()  // image untouched
    const patch = mocks.updateDocMock.mock.calls[0]![1] as Record<string, unknown>
    expect(patch).not.toHaveProperty('image')
  })
})
