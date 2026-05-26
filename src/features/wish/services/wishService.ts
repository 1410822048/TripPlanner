// src/features/wish/services/wishService.ts
// Wish items: members propose places / food / activities / etc., everyone
// votes +1 to surface group favourites. Sorted server-side by createdAt
// then re-ordered client-side by vote count.
//
// Image lifecycle: optional single cover image with full+thumb variants
// (same compression pattern as bookings). Cover is one image only — wish
// items aren't a photo album, just a "is this the place" reference shot.
//
// Phase 3.6: the Worker is the authoritative writer for `wish.image`.
// /upload-finalize patches the field atomically with the intent markUsed
// writes; the client never calls updateDoc({ image }) on the replace
// path. Detach (null) and non-image fallback still go through the text
// updateDoc as `deleteField()` -- firestore.rules (Commit 3) permits
// removing `image` client-side but locks down arbitrary writes to it.
//
// Votes use arrayUnion / arrayRemove on the `votes: string[]` field for
// atomic toggle. Firestore rules gate "only my own uid" mutations on the
// non-proposer path.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { deleteStorageObject } from '@/services/storageDelete'
import { P } from '@/services/paths'
import { compressImage, type CompressedImage } from '@/utils/image'
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
 * Phase 3.6: upload + finalize the wish cover image. The Worker patches
 * `wish.image` (url + path + thumbUrl + thumbPath -- all four required
 * by WishImage schema) atomically with the intent markUsed writes.
 *
 * Caller pre-filters non-image inputs; this helper assumes `compressed`
 * is image-typed. Thumb is OPTIONAL on the intent set: HEIC / HEIF
 * pass-throughs and canvas decode failures (see src/utils/image.ts
 * PASSTHROUGH_TYPES) ship `compressed.thumb === null`, so we send only
 * a `full` intent. Worker `buildAttachmentMapValue` then collapses the
 * WishImage thumb fields to the primary blob (`thumbUrl ?? fullUrl`,
 * `thumbPath ?? fullPath`), so the schema's four-fields requirement is
 * satisfied without an actual thumb upload.
 *
 * `expectedCurrentPath`:
 *   - `null`   → first-attach (doc-first create OR detach-then-replace
 *                edge case). Worker expects `image` absent on the doc.
 *   - string   → replace flow; Worker rejects with 409 if doc's actual
 *                current path differs (Tab A vs Tab B drift).
 *
 * Returns void. The wish doc's image field surfaces via the realtime
 * listener once the Worker's tx commits.
 */
async function uploadWishImage(
  tripId:              string,
  wishId:              string,
  compressed:          CompressedImage,
  expectedCurrentPath: string | null,
): Promise<void> {
  const { full, thumb } = compressed
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

  await finalizeUploadIntents(tripId, intents.map(i => i.intentId), {
    mode: 'patch',
    expectedCurrentPath,
  })
}

async function deleteWishImage(image: WishImage): Promise<void> {
  // Set() dedupes when fullPath == thumbPath (some shapes had fall-through).
  const paths = new Set([image.path, image.thumbPath])
  await Promise.all([...paths].map(deleteStorageObject))
}

// ─── Write ────────────────────────────────────────────────────────

/** Create a wish. Doc-first ordering: write the wish without image,
 *  THEN upload + finalize so the Worker patches `image` directly. The
 *  earlier upload-then-setDoc flow forced storage.rules to allow a
 *  `!exists(wishDoc)` first-upload exception (any member could write
 *  bytes against a yet-to-be-created wishId). Doc-first lets the
 *  Storage rule be proposer-only with no exceptions.
 *
 *  All-or-nothing semantics: if the image step fails after setDoc
 *  succeeded, we roll the wish doc back (deleteDoc) before throwing.
 *  Without this, the realtime listener would have already pushed the
 *  just-setDoc'd wish into the TanStack cache; the mutation's onError
 *  rollback only undoes its OWN optimistic patch, not the listener-
 *  driven cache insert. Net effect was: "save failed" toast + the new
 *  wish visible in the list + the user re-pressing save creating a
 *  DUPLICATE wish.
 *
 *  Orphan blob cleanup on uploadWishImage failure is handled by the
 *  Worker's intent-expiry cron + orphan-storage-scan -- no client-side
 *  purge ladder. The Worker is the only writer for `image`; a finalize
 *  abort leaves intents 'pending' (and any uploaded blobs orphaned)
 *  which the cron reaps on their 30-min / 24-hour grace windows.
 *
 *  Initial votes = [proposedBy] because their proposal counts as their
 *  own vote — matches typical wishlist UX. */
export async function createWish(
  tripId: string,
  input: CreateWishInput,
  file: File | null,
  proposedBy: string,
): Promise<string> {
  const [{ db, collection, doc, setDoc, deleteDoc, serverTimestamp }, memberIds] = await Promise.all([
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
    // Whole image step (compress + upload) is rollback-protected. If
    // compressImage rejects (canvas/encode/File-construction failure)
    // AFTER setDoc lands, we MUST still delete the orphan doc -- a
    // surviving doc lets the user's retry create a duplicate wish.
    // Non-image inputs (PDFs slipping through, decode failures via
    // PASSTHROUGH) drop silently INSIDE the try: wish covers are
    // image-only, and on the create path there's no existing image
    // field for us to clear, so the success path is "wish exists,
    // text-only" -- no upload, no rollback needed.
    try {
      const compressed = await compressImage(file)
      if (compressed.full.type.startsWith('image/')) {
        await uploadWishImage(tripId, ref.id, compressed, null)
      }
    } catch (e) {
      captureError(e, { source: 'createWish/imageStep', tripId, wishId: ref.id })
      // Roll the wish doc back. If failure was during finalize, Worker
      // tx aborted → no image field landed; if during compress / upload,
      // nothing reached Firestore. Either way no client-side blob purge
      // is needed (Worker storage-scan reaps any orphan bytes).
      let docRollbackOk = true
      try {
        await deleteDoc(ref)
      } catch (cleanupErr) {
        captureError(cleanupErr, { source: 'createWish/rollback-doc', tripId, wishId: ref.id })
        docRollbackOk = false
      }
      // Promote to typed error when the doc still persists -- caller
      // hook invalidates the wish query so cache reconciles to truth
      // state and the user's retry doesn't duplicate the wish.
      if (!docRollbackOk) {
        throw new WishCreatePartialError(ref.id, e)
      }
      throw e
    }
  }

  void bumpTripActivity(tripId, 'wish', proposedBy)
  return ref.id
}

/** Update wish text fields and optionally replace / clear the image.
 *  Tri-state attachment matches the booking pattern. Only proposer can
 *  call this.
 *
 *  Phase 3.6 split-write ordering:
 *    1. Text patch via updateDoc. Includes `image: deleteField()` for
 *       the null detach case AND for the non-image File fallback
 *       (PDF / undecodable). Replace does NOT include `image` here --
 *       the Worker is the only writer on replace.
 *    2. If attachment is an image File: uploadWishImage(..., existing.path).
 *       Worker patches `image` + updatedBy + updatedAt in its own tx.
 *       expectedCurrentPath catches a concurrent Tab B replace (409
 *       stale-finalize → throw, doc keeps Tab B's value).
 *    3. On combined success: purge the OLD blob if there was one.
 *
 *  Failure semantics:
 *    - Step 1 rejects → throw; doc unchanged, no upload tried.
 *    - Step 2 rejects → throw; text-only edits already saved, image
 *      unchanged. User can retry; the text fields will be re-written
 *      idempotently (same form state) and only the upload retries.
 *    - Step 1 + 2 both succeed → purge OLD via safePurge/_purges. */
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

  // Pre-compress when the caller is replacing so we can detect non-
  // image inputs BEFORE the updateDoc round-trip and roll the image
  // clear into the same text patch. (Non-image File falls back to a
  // clear; Worker won't be called.)
  let compressedForUpload: CompressedImage | null = null
  let imageWillChange = false
  if (attachment === null) {
    patch.image = deleteField()
    imageWillChange = true
  } else if (attachment instanceof File) {
    const compressed = await compressImage(attachment)
    if (compressed.full.type.startsWith('image/')) {
      compressedForUpload = compressed
      imageWillChange = true
      // patch.image NOT touched -- Worker writes it
    } else {
      patch.image = deleteField()  // PDF / undecodable fallback
      imageWillChange = true
    }
  }

  await updateDoc(doc(db, ...P.wish(tripId, wishId)), patch)

  if (compressedForUpload) {
    // Replace flow: Worker patches `image` (and bumps updatedBy /
    // updatedAt again). expectedCurrentPath catches Tab B drift.
    await uploadWishImage(tripId, wishId, compressedForUpload, existingImage?.path ?? null)
  }

  // Success path -- safe to drop the old blob now if we cleared or
  // replaced the image field.
  if (existingImage && imageWillChange) {
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
