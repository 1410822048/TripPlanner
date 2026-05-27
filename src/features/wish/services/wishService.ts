// src/features/wish/services/wishService.ts
// Wish items: members propose places / food / activities / etc., everyone
// votes +1 to surface group favourites. Sorted server-side by createdAt
// then re-ordered client-side by vote count.
//
// Image lifecycle (Phase 3.7): the Worker is the authoritative writer for
// `wish.image` on BOTH create and update. When the caller supplies an
// image File:
//   - createWish → POST /wish-file-create. Worker authzs membership,
//     mints + consumes the upload intents, AND writes the wish doc
//     (image populated) in a single Firestore transaction. The client
//     never calls setDoc on this path. Eliminates the old doc-first
//     "blank card → image lands ~200ms later" listener flicker AND
//     removes the partial-failure half-state that the old
//     compress-fails-after-setDoc rollback dance needed.
//   - updateWish → POST /wish-file-update. Worker writes text patch +
//     image in the same tx. Detach (attachment=null) and non-image
//     fallback still go through client updateDoc with
//     `image: deleteField()` -- rules-tightening (Commit 4) permits
//     removing `image` client-side but blocks arbitrary writes to it.
//
// Without an image File the client setDoc / updateDoc paths are
// unchanged -- text-only wishes are still the fast no-Worker round-trip.
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
import { mintAndUploadEntityIntents } from '@/services/uploadIntentEntity'
import {
  requireWorkerWriteBase, preflightIdToken, workerFetch,
} from '@/services/workerBase'
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

async function deleteWishImage(image: WishImage): Promise<void> {
  // Set() dedupes when fullPath == thumbPath (some shapes had fall-through).
  const paths = new Set([image.path, image.thumbPath])
  await Promise.all([...paths].map(deleteStorageObject))
}

// ─── Write ────────────────────────────────────────────────────────

/** Create a wish.
 *
 *  WITHOUT image (and on non-image fallback): client setDoc — no Worker
 *  round-trip, text-only is the fast path. firestore.rules (Commit 4)
 *  permits client wish-create when the `image` field is absent.
 *
 *  WITH image: upload-first → POST /wish-file-create. The Worker mints +
 *  consumes intents AND writes the wish doc with the image populated in
 *  a single Firestore transaction. The realtime listener sees the wish
 *  for the first time WITH its image, so the UX is "card materializes
 *  with photo" instead of the old "blank card → image lands ~200ms
 *  later" flicker.
 *
 *  No partial-state recovery needed: the Worker tx is atomic. If the
 *  Worker rejects or times out, no doc was written, so the realtime
 *  listener never fires and the optimistic-rollback in the mutation hook
 *  cleans the temp row with no orphan to reconcile. Uploaded blobs (if
 *  any) get reaped by the Worker's intent-expiry + storage-scan cron.
 *
 *  Initial votes = [proposedBy] because their proposal counts as their
 *  own vote — matches typical wishlist UX (stamped Worker-side on the
 *  WITH-image path, client-side on the no-image path). */
export async function createWish(
  tripId:     string,
  input:      CreateWishInput,
  file:       File | null,
  proposedBy: string,
): Promise<string> {
  const { db, collection, doc } = await getFirebase()
  // Mint the wishId client-side so the Worker can consume intents
  // bound to a known entityId AND the optimistic-cache temp-row
  // replacement has a stable target.
  const ref = doc(collection(db, ...P.wishes(tripId)))

  // Decide path BEFORE touching Firestore. Compress is the gate: image
  // input → Worker; non-image fallback → client setDoc (image-only is a
  // wish-cover contract, and the form UI prevents this case in practice
  // — but the service degrades cleanly to "wish persists, text-only").
  let compressed: CompressedImage | null = null
  if (file) {
    compressed = await compressImage(file)
    if (!compressed.full.type.startsWith('image/')) {
      compressed = null
    }
  }

  if (compressed) {
    // ── Upload-first + Worker-authoritative create ───────────────
    const workerBase = requireWorkerWriteBase()
    const idToken    = await preflightIdToken()
    const { intentIds } = await mintAndUploadEntityIntents({
      tripId, entityType: 'wish', entityId: ref.id, compressed, mode: 'create',
    })
    await workerFetch(workerBase, idToken, '/wish-file-create', {
      tripId,
      wishId: ref.id,
      // Worker re-validates body via WishValidationError; stripEmpty
      // matches the original setDoc payload semantics (no '' / null
      // fields polluting the doc).
      wish:   stripEmpty(input),
      intentIds,
    })
  } else {
    // ── Text-only client setDoc ──────────────────────────────────
    const memberIds = await getTripMemberIds(tripId)
    const { setDoc, serverTimestamp } = await getFirebase()
    // Wish uses `proposedBy` (domain naming predates createdBy
    // convention) — auditCreate doesn't fit because of that alias, so
    // spell it out and let auditUpdate cover the updatedBy half.
    await setDoc(ref, {
      ...stripEmpty(input),
      tripId,
      proposedBy,
      memberIds,
      votes:     [proposedBy],
      createdAt: serverTimestamp(),
      ...auditUpdate(proposedBy, serverTimestamp()),
    })
  }

  void bumpTripActivity(tripId, 'wish', proposedBy)
  return ref.id
}

/** Update wish text fields and optionally replace / clear the image.
 *  Tri-state attachment matches the booking pattern. Only proposer can
 *  call this.
 *
 *  WITH NEW IMAGE (File, image content): single Worker round-trip to
 *    /wish-file-update — text patch + image lands atomically. No
 *    separate client updateDoc; rules-tightening (Commit 4) blocks
 *    arbitrary `image` writes from the client SDK anyway.
 *
 *  DETACH (attachment === null) and NON-IMAGE File fallback: client
 *    updateDoc with `image: deleteField()`. Worker not involved. Rules
 *    permit removing the image field client-side.
 *
 *  TEXT-ONLY (attachment === undefined): client updateDoc with the text
 *    patch only. Image untouched. */
export async function updateWish(
  tripId:  string,
  wishId:  string,
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

  // Pre-compress to decide path. Non-image File falls back to detach
  // semantics (clear `image` field, no Worker call).
  let compressedForUpload: CompressedImage | null = null
  if (attachment instanceof File) {
    const compressed = await compressImage(attachment)
    if (compressed.full.type.startsWith('image/')) {
      compressedForUpload = compressed
    }
  }

  if (compressedForUpload) {
    // ── Worker-authoritative replace: text + image atomic ────────
    const workerBase = requireWorkerWriteBase()
    const idToken    = await preflightIdToken()
    const { intentIds } = await mintAndUploadEntityIntents({
      tripId, entityType: 'wish', entityId: wishId, compressed: compressedForUpload, mode: 'update',
    })
    await workerFetch(workerBase, idToken, '/wish-file-update', {
      tripId,
      wishId,
      // Worker stamps updatedBy + updatedAt itself; client only sends
      // validated text fields.
      patch: validated,
      intentIds,
      // Stale-replace guard: tell Worker what `image.path` the editor
      // loaded with (null = first-attach). If Tab B has already
      // replaced/detached, Worker returns 409 instead of silently
      // overwriting Tab B's commit + orphaning Tab B's blob.
      expectedCurrentPath: existingImage?.path ?? null,
    })
    if (existingImage) {
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
    return
  }

  // ── Client text/detach path (no new image) ─────────────────────
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
  let imageWillChange = false
  if (attachment === null) {
    patch.image = deleteField()
    imageWillChange = true
  } else if (attachment instanceof File) {
    // Non-image File (PDF / undecodable) fell through to here — treat
    // as detach (clear image field).
    patch.image = deleteField()
    imageWillChange = true
  }

  await updateDoc(doc(db, ...P.wish(tripId, wishId)), patch)

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
