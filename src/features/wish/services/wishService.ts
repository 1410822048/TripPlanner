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
import { getFirebase, getFirebaseStorage } from '@/services/firebase'
import { deleteStorageObject } from '@/services/storageDelete'
import { P } from '@/services/paths'
import { compressImage } from '@/utils/image'
import { retry, isTransientStorageError } from '@/utils/retry'
import { stripEmpty } from '@/utils/stripEmpty'
import { captureError } from '@/services/sentry'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { createTripScopedListServices } from '@/services/tripScopedList'
import { validateUpdateOrThrow } from '@/services/validateUpdate'
import { auditUpdate } from '@/utils/audit'
import { getTripMemberIds } from '@/services/tripMemberIds'
import { bumpTripActivity } from '@/services/tripActivity'
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

function shortId(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function uploadWishImage(
  tripId: string,
  wishId: string,
  file: File,
): Promise<WishImage | null> {
  const { full, thumb } = await compressImage(file)
  if (!full.type.startsWith('image/')) return null  // only images
  const id = shortId()
  const folder = `trips/${tripId}/wishes/${wishId}`
  const path  = `${folder}/${id}.webp`
  const tpath = thumb ? `${folder}/${id}.thumb.webp` : path

  const { storage, ref, uploadBytes, getDownloadURL } = await getFirebaseStorage()
  const [fullSnap, thumbSnap] = await Promise.all([
    retry(
      () => uploadBytes(ref(storage, path), full, { contentType: full.type }),
      { shouldRetry: isTransientStorageError },
    ),
    thumb
      ? retry(
          () => uploadBytes(ref(storage, tpath), thumb, { contentType: thumb.type }),
          { shouldRetry: isTransientStorageError },
        )
      : Promise.resolve(null),
  ])
  const [url, thumbUrl] = await Promise.all([
    getDownloadURL(fullSnap.ref),
    thumbSnap ? getDownloadURL(thumbSnap.ref) : Promise.resolve(undefined),
  ])
  return {
    url,
    path,
    thumbUrl:  thumbUrl ?? url,
    thumbPath: thumb ? tpath : path,
  }
}

async function deleteWishImage(image: WishImage): Promise<void> {
  // Set() dedupes when fullPath == thumbPath (some shapes had fall-through).
  const paths = new Set([image.path, image.thumbPath])
  await Promise.all([...paths].map(deleteStorageObject))
}

// ─── Write ────────────────────────────────────────────────────────

/** Create a wish. Single-shot via mint-id-first when a file is provided.
 *  Initial votes = [proposedBy] because their proposal counts as their
 *  own vote — matches typical wishlist UX. */
export async function createWish(
  tripId: string,
  input: CreateWishInput,
  file: File | null,
  proposedBy: string,
): Promise<string> {
  const [{ db, collection, doc, setDoc, serverTimestamp }, memberIds] = await Promise.all([
    getFirebase(),
    getTripMemberIds(tripId),
  ])
  // Wish uses `proposedBy` (domain naming predates createdBy convention) —
  // auditCreate doesn't fit because of that alias, so spell it out and
  // let auditUpdate cover the updatedBy half.
  const ref = doc(collection(db, ...P.wishes(tripId)))
  let image: WishImage | null = null
  if (file) {
    try {
      image = await uploadWishImage(tripId, ref.id, file)
    } catch (e) {
      captureError(e, { source: 'createWish/uploadImage', tripId, wishId: ref.id })
      throw e
    }
  }
  const payload: Record<string, unknown> = {
    ...stripEmpty(input),
    tripId,
    proposedBy,
    memberIds,
    votes:     [proposedBy],
    createdAt: serverTimestamp(),
    ...auditUpdate(proposedBy, serverTimestamp()),
  }
  if (image) payload.image = image
  await setDoc(ref, payload)
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

  if (attachment === null) {
    if (existingImage) await deleteWishImage(existingImage)
    patch.image = deleteField()
  } else if (attachment instanceof File) {
    if (existingImage) await deleteWishImage(existingImage)
    const image = await uploadWishImage(tripId, wishId, attachment)
    if (image) patch.image = image
    else patch.image = deleteField()
  }

  await updateDoc(doc(db, ...P.wish(tripId, wishId)), patch)
  void bumpTripActivity(tripId, 'wish', uid)
}

export async function deleteWish(
  tripId: string,
  wishId: string,
  uid: string,
  image: WishImage | undefined,
): Promise<void> {
  if (image) {
    await deleteWishImage(image).catch(e => {
      captureError(e, { source: 'deleteWish/image', tripId, wishId, path: image.path })
    })
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
