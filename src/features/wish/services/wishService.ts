// src/features/wish/services/wishService.ts
// Wish items: members propose places / food / activities / etc., everyone
// votes +1 to surface group favourites. Sorted server-side by createdAt
// then re-ordered client-side by vote count.
//
// Image lifecycle: optional single cover image with full+thumb variants
// (same compression pattern as bookings). Cover is one image only — wish
// items aren't a photo album, just a "is this the place" reference shot.
//
// Votes use arrayUnion / arrayRemove on the `votes: string[]` field for
// atomic toggle. Firestore rules gate "only my own uid" mutations on the
// non-proposer path.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { deleteStorageObject } from '@/services/storageDelete'
import { P } from '@/services/paths'
import { compressImage } from '@/utils/image'
import { stripEmpty } from '@/utils/stripEmpty'
import {
  requestUploadIntents,
  uploadToIntent,
  finalizeUploadIntents,
  type UploadIntentsRequest,
} from '@/services/uploadIntent'
import { captureError } from '@/services/sentry'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { createTripScopedListServices } from '@/services/tripScopedList'
import { validateUpdateOrThrow } from '@/services/validateUpdate'
import { auditUpdate } from '@/utils/audit'
import { getTripMemberIds } from '@/services/tripMemberIds'
import { bumpTripActivity } from '@/services/tripActivity'
import { safePurgeWithEnqueueFallback } from '@/services/orphanPurge'
import {
  WishDocSchema,
  UpdateWishSchema,
  type Wish,
  type WishImage,
  type CreateWishInput,
  type UpdateWishInput,
} from '@/types'

const LIST_LIMIT = 100

/**
 * Thrown by `createWish` when the doc-first flow can't fully unwind
 * after a failed image step. The wish doc landed in Firestore (and
 * possibly a blob too), the rollback `deleteDoc` failed (network
 * blip, rate limit, etc.), and the caller needs to know the wish
 * persists so it can `invalidateQueries` and reconcile the cache
 * with reality. Without this typed signal, callers can't distinguish
 * "fully failed -- safe to retry" from "partially failed -- retry
 * will duplicate" and a re-press of save would land a second wish.
 */
export class WishCreatePartialError extends Error {
  readonly wishId: string
  readonly cause:  unknown
  constructor(wishId: string, cause: unknown) {
    super('Wish doc was created but image step + rollback both failed')
    this.name = 'WishCreatePartialError'
    this.wishId = wishId
    this.cause = cause
  }
}

function wishFromDoc(d: QueryDocumentSnapshot): Wish {
  return firestoreDocFromSchema(WishDocSchema, d, 'wishFromDoc')
}

/** Stable comparator — votes.length desc, createdAt-desc tiebreak preserved
 *  because the upstream query already sorts by createdAt desc and JS
 *  Array.sort is stable. We can't `orderBy('votes', 'desc')` server-side
 *  because Firestore sorts arrays element-wise (lexicographic by uid),
 *  not by length. Denormalising voteCount would let us server-sort, but
 *  drifts under concurrent toggles. ≤100 wishes → client sort is fine. */
function byVotesDesc(a: Wish, b: Wish): number {
  return b.votes.length - a.votes.length
}

// ─── Read ─────────────────────────────────────────────────────────
const listServices = createTripScopedListServices<Wish>({
  path:    P.wishes,
  fromDoc: wishFromDoc,
  orderBy: [['createdAt', 'desc']],
  limit:   LIST_LIMIT,
  source:  'wishes',
  postProcess: items => [...items].sort(byVotesDesc),
})

export const getWishesByTrip = listServices.fetch
export const subscribeToWishes = listServices.subscribe

// ─── Storage helpers ──────────────────────────────────────────────

/**
 * Phase 3.5: Worker-issued upload intent flow. Wish cover image is
 * doc-first by design (createWish setDoc'd before this is called),
 * so the Worker's intent authz pass can verify proposedBy on the
 * existing wish doc.
 *
 * Returns null for non-image inputs -- wish covers are image-only.
 * Image flow: compressImage produces full + thumb, both upload via
 * intent + finalize, blob URLs come back from finalize.
 */
async function uploadWishImage(
  tripId: string,
  wishId: string,
  file: File,
): Promise<WishImage | null> {
  const { full, thumb } = await compressImage(file)
  if (!full.type.startsWith('image/')) return null  // only images

  const uploads: UploadIntentsRequest['uploads'] = [
    { kind: 'full', contentType: full.type, size: full.size },
  ]
  if (thumb) {
    uploads.push({ kind: 'thumb', contentType: thumb.type, size: thumb.size })
  }

  const intents = await requestUploadIntents({
    tripId, entityType: 'wish', entityId: wishId, uploads,
  })
  const fullIntent  = intents[0]!
  const thumbIntent = thumb ? intents[1] : undefined

  await Promise.all([
    uploadToIntent(fullIntent, full, 'wish-full'),
    thumb && thumbIntent
      ? uploadToIntent(thumbIntent, thumb, 'wish-thumb')
      : Promise.resolve(),
  ])

  const finalize = await finalizeUploadIntents(tripId, intents.map(i => i.intentId))
  const fullBlob  = finalize.blobs.find(b => b.kind === 'full')
  const thumbBlob = finalize.blobs.find(b => b.kind === 'thumb')
  if (!fullBlob || !fullBlob.url) {
    throw new Error('finalizeUploadIntents returned no primary blob or missing URL')
  }
  // WishImage has the legacy convention of thumbUrl/thumbPath falling
  // back to full when thumb absent -- preserves existing UI that
  // always indexes into both fields.
  return {
    url:       fullBlob.url,
    path:      fullBlob.path,
    thumbUrl:  thumbBlob?.url  ?? fullBlob.url,
    thumbPath: thumbBlob?.path ?? fullBlob.path,
  }
}

async function deleteWishImage(image: WishImage): Promise<void> {
  // Set() dedupes when fullPath == thumbPath (some shapes had fall-through).
  const paths = new Set([image.path, image.thumbPath])
  await Promise.all([...paths].map(deleteStorageObject))
}

// ─── Write ────────────────────────────────────────────────────────

/** Create a wish. Doc-first ordering: write the wish without image,
 *  THEN upload to Storage, THEN patch the image field back in. The
 *  earlier upload-then-setDoc flow forced storage.rules to allow a
 *  `!exists(wishDoc)` first-upload exception (any member could write
 *  bytes against a yet-to-be-created wishId). Doc-first lets the
 *  Storage rule be proposer-only with no exceptions.
 *
 *  All-or-nothing semantics: if the image step fails after setDoc
 *  succeeded, we roll the wish doc back (and clean any uploaded
 *  blob) before throwing. Without this, the realtime listener would
 *  have already pushed the just-setDoc'd wish into the TanStack
 *  cache; the mutation's onError rollback only undoes its OWN
 *  optimistic patch, not the listener-driven cache insert. Net
 *  effect was: "save failed" toast + the new wish visible in the
 *  list + the user re-pressing save creating a DUPLICATE wish.
 *  Cleanup keeps the mutation atomic from the caller's POV.
 *
 *  Initial votes = [proposedBy] because their proposal counts as their
 *  own vote — matches typical wishlist UX. */
export async function createWish(
  tripId: string,
  input: CreateWishInput,
  file: File | null,
  proposedBy: string,
): Promise<string> {
  const [{ db, collection, doc, setDoc, updateDoc, deleteDoc, serverTimestamp }, memberIds] = await Promise.all([
    getFirebase(),
    getTripMemberIds(tripId),
  ])
  // Wish uses `proposedBy` (domain naming predates createdBy convention) —
  // auditCreate doesn't fit because of that alias, so spell it out and
  // let auditUpdate cover the updatedBy half.
  const ref = doc(collection(db, ...P.wishes(tripId)))
  const basePayload: Record<string, unknown> = {
    ...stripEmpty(input),
    tripId,
    proposedBy,
    memberIds,
    votes:     [proposedBy],
    createdAt: serverTimestamp(),
    ...auditUpdate(proposedBy, serverTimestamp()),
  }
  await setDoc(ref, basePayload)

  if (file) {
    let uploadedImage: WishImage | null = null
    try {
      uploadedImage = await uploadWishImage(tripId, ref.id, file)
      if (uploadedImage) {
        await updateDoc(ref, {
          image: uploadedImage,
          ...auditUpdate(proposedBy, serverTimestamp()),
        })
      }
    } catch (e) {
      captureError(e, { source: 'createWish/uploadImage', tripId, wishId: ref.id })
      // All-or-nothing cleanup: roll the wish doc back so the
      // caller's mutation can rollback cleanly. Order matters --
      // Storage delete rule's proposer check needs the wish doc
      // to still exist, so drop the blob FIRST (if uploaded),
      // then the doc.
      if (uploadedImage) {
        // Capture into const so the closure inside safePurge sees a
        // narrowed (non-null) type — `let uploadedImage` widens back
        // to `WishImage | null` inside the async callback.
        const image = uploadedImage
        await safePurgeWithEnqueueFallback({
          purge: () => deleteWishImage(image),
          enqueue: {
            tripId, collection: 'wishes', entityId: ref.id,
            // Set() dedupes when full == thumb path (some shapes have
            // fall-through), matching deleteWishImage's own dedup.
            paths: [...new Set([image.path, image.thumbPath])],
            source: 'createWish/rollback-blob',
          },
          sentry: { source: 'createWish/rollback-blob', tripId, wishId: ref.id },
        })
      }
      let docRollbackOk = true
      try {
        await deleteDoc(ref)
      } catch (cleanupErr) {
        captureError(cleanupErr, { source: 'createWish/rollback-doc', tripId, wishId: ref.id })
        docRollbackOk = false
      }
      // Promote to typed error when the doc still persists -- the
      // caller's useTripListMutation only rolls back the optimistic
      // patch, but the realtime listener already pushed the
      // setDoc'd wish into cache. Without a cache invalidate, the
      // "save failed" toast appears WITH the wish still visible,
      // and the user's retry creates a duplicate. The mutation's
      // onError hook detects this type and invalidates the wish
      // query so cache reconciles to truth state.
      if (!docRollbackOk) {
        throw new WishCreatePartialError(ref.id, e)
      }
      throw e
    }
  }

  void bumpTripActivity(tripId, 'wish', proposedBy)
  return ref.id
}

/** Update wish text fields and optionally replace the image. Tri-state
 *  attachment matches the booking pattern. Only proposer can call this. */
export async function updateWish(
  tripId: string,
  wishId: string,
  updates: UpdateWishInput,
  options: {
    uid:            string
    attachment:     File | null | undefined
    existingImage:  WishImage | undefined
  },
): Promise<void> {
  const { uid, attachment, existingImage } = options
  const validated = validateUpdateOrThrow(UpdateWishSchema, updates, {
    source: 'updateWish', tripId, wishId,
  })
  const { db, doc, updateDoc, deleteField, serverTimestamp } = await getFirebase()
  const patch: Record<string, unknown> = {
    ...stripEmpty(validated),
    ...auditUpdate(uid, serverTimestamp()),
  }
  for (const k of ['description', 'link', 'address'] as const) {
    if (k in validated && (validated[k] === undefined || validated[k] === '')) {
      patch[k] = deleteField()
    }
  }

  // Mirror the expense / booking pattern: upload NEW first (to a
  // unique shortId path so it doesn't collide with existing), patch
  // the doc, then purge OLD on success / NEW on failure. The previous
  // ordering (purge-old → upload-new → updateDoc) left the doc
  // referencing a deleted blob if updateDoc rejected — same race
  // class we fixed for the other two entities.
  let newImage: WishImage | null = null
  if (attachment === null) {
    patch.image = deleteField()
  } else if (attachment instanceof File) {
    newImage = await uploadWishImage(tripId, wishId, attachment)
    if (newImage) patch.image = newImage
    else patch.image = deleteField()
  }

  try {
    await updateDoc(doc(db, ...P.wish(tripId, wishId)), patch)
  } catch (e) {
    if (newImage) {
      const image = newImage
      await safePurgeWithEnqueueFallback({
        purge: () => deleteWishImage(image),
        enqueue: {
          tripId, collection: 'wishes', entityId: wishId,
          paths: [...new Set([image.path, image.thumbPath])],
          source: 'updateWish/rollback-new-image',
        },
        sentry: { source: 'updateWish/rollback-new-image', tripId, wishId },
      })
    }
    throw e
  }

  // Success: purge the OLD blob if there was one and we either cleared
  // or replaced the image.
  if (existingImage && (attachment === null || attachment instanceof File)) {
    await safePurgeWithEnqueueFallback({
      purge: () => deleteWishImage(existingImage),
      enqueue: {
        tripId, collection: 'wishes', entityId: wishId,
        paths: [...new Set([existingImage.path, existingImage.thumbPath])],
        source: 'updateWish/purge-old-image',
      },
      sentry: { source: 'updateWish/purge-old-image', tripId, wishId },
    })
  }

  void bumpTripActivity(tripId, 'wish', uid)
}

/**
 * Delete a wish + its cover image. Strict-cleanup gate mirrors
 * `deleteBooking`: when both purge and `_purges` enqueue fail, abort
 * before deleting the doc so the image.path → blob binding survives
 * for a human-driven retry. See bookingService.deleteBooking comment
 * block for the full reasoning.
 */
export async function deleteWish(
  tripId: string,
  wishId: string,
  uid: string,
  image: WishImage | undefined,
): Promise<void> {
  if (image) {
    const result = await safePurgeWithEnqueueFallback({
      purge: () => deleteWishImage(image),
      enqueue: {
        tripId, collection: 'wishes', entityId: wishId,
        paths: [...new Set([image.path, image.thumbPath])],
        source: 'deleteWish/image',
      },
      sentry: { source: 'deleteWish/image', tripId, wishId, path: image.path },
    })
    if (result === 'unrecoverable') {
      throw new Error(
        'カバー画像の削除に失敗し、再試行キューへの登録もできませんでした。' +
        'しばらくしてから再度お試しください。',
      )
    }
  }
  const { db, doc, deleteDoc } = await getFirebase()
  await deleteDoc(doc(db, ...P.wish(tripId, wishId)))
  void bumpTripActivity(tripId, 'wish', uid)
}

/** Toggle the caller's vote on a wish. arrayUnion / arrayRemove are
 *  atomic, so concurrent votes from multiple members compose without
 *  a lost-update problem. Rules enforce the diff only adds / removes
 *  the caller's own uid. */
export async function toggleWishVote(
  tripId: string,
  wishId: string,
  uid: string,
  isVoting: boolean,
): Promise<void> {
  const { db, doc, updateDoc, arrayUnion, arrayRemove, serverTimestamp } = await getFirebase()
  await updateDoc(doc(db, ...P.wish(tripId, wishId)), {
    votes: isVoting ? arrayUnion(uid) : arrayRemove(uid),
    ...auditUpdate(uid, serverTimestamp()),
  })
  void bumpTripActivity(tripId, 'wish', uid)
}
