// src/features/wish/services/wishService.ts
// Wish items: members propose places / food / activities / etc., everyone
// votes +1 to surface group favourites. Sorted server-side by vote count
// then createdAt to keep the popular items at the top without a client
// re-sort.
//
// Image lifecycle: optional single cover image with full+thumb variants
// (same compression pattern as bookings). Cover is one image only — wish
// items aren't a photo album, just a "is this the place" reference shot.
//
// Votes use arrayUnion / arrayRemove on the `votes: string[]` field for
// atomic toggle. Firestore rules gate "only my own uid" mutations on the
// non-proposer path, so a member can't tamper with others' votes.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase, getFirebaseStorage } from '@/services/firebase'
import { P } from '@/services/paths'
import { compressImage } from '@/utils/image'
import { retry, isTransientStorageError } from '@/utils/retry'
import { stripEmpty } from '@/utils/stripEmpty'
import { captureError } from '@/services/sentry'
import { firestoreDocFromSchema } from '@/services/firestoreDocFromSchema'
import { parseListSnapshot } from '@/services/parseListSnapshot'
import { subscribeToCollection } from '@/services/realtimeQuery'
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

// ─── Read ─────────────────────────────────────────────────────────

/**
 * All wishes for a trip — most-voted first, then newest. Server-sorts by
 * `createdAt` (auto-indexed; no composite needed) then re-orders by
 * `votes.length` client-side. We can't `orderBy('votes', 'desc')` because
 * Firestore sorts arrays element-wise (lexicographic by uid), not by
 * length. Maintaining a denormalised `voteCount` field would let us
 * server-sort, but it drifts under concurrent toggles (arrayUnion is
 * idempotent; increment isn't). For lists ≤ 100, client sort is faster
 * to ship and exactly correct.
 */
export async function getWishesByTrip(tripId: string, uid: string): Promise<Wish[]> {
  const { db, collection, query, where, orderBy, limit, getDocs } = await getFirebase()
  const snap = await getDocs(query(
    collection(db, ...P.wishes(tripId)),
    where('memberIds', 'array-contains', uid),
    orderBy('createdAt', 'desc'),
    limit(LIST_LIMIT),
  ))
  if (snap.size >= LIST_LIMIT) {
    captureError(new Error(`getWishesByTrip truncated at ${LIST_LIMIT}`), { tripId })
  }
  // Stable sort: votes.length desc; createdAt-desc tiebreak preserved
  // because the input is already in that order.
  return parseListSnapshot(snap, wishFromDoc).sort(byVotesDesc)
}

/** Stable comparator extracted so the realtime subscriber re-applies the
 *  same ordering as getWishesByTrip on every snapshot push. */
function byVotesDesc(a: Wish, b: Wish): number {
  return b.votes.length - a.votes.length
}

/**
 * Realtime variant of getWishesByTrip — listener delivers Wish[] in
 * the same votes-desc order as the one-shot fetcher.
 */
export const subscribeToWishes = (
  tripId: string,
  uid:    string,
  onData: (data: Wish[]) => void,
  onError: (e: Error) => void,
) => subscribeToCollection<Wish>({
  buildQuery: ({ db, collection, query, where, orderBy, limit }) => query(
    collection(db, ...P.wishes(tripId)),
    where('memberIds', 'array-contains', uid),
    orderBy('createdAt', 'desc'),
    limit(LIST_LIMIT),
  ),
  fromDoc:     wishFromDoc,
  postProcess: items => items.sort(byVotesDesc),
  source:      'subscribeToWishes',
  limit:       LIST_LIMIT,
}, onData, onError)

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
  const { storage, ref, deleteObject } = await getFirebaseStorage()
  const tasks: Promise<void>[] = []
  for (const p of new Set([image.path, image.thumbPath])) {
    tasks.push(
      deleteObject(ref(storage, p)).catch(e => {
        const code = (e as { code?: string }).code
        if (code === 'storage/object-not-found') return
        throw e
      })
    )
  }
  await Promise.all(tasks)
}

// ─── Write ────────────────────────────────────────────────────────

/** Create a wish. Single-shot via mint-id-first when a file is provided:
 *  doc-ref minted client-side → upload → setDoc with everything in one
 *  write. Saves the previous addDoc → updateDoc round-trip (~150-300ms
 *  p50 on attachment creates). Initial votes is the proposer's own +1
 *  because their proposal counts as their vote — matches typical
 *  wishlist UX (you wouldn't propose something you don't want). */
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
  // Wish uses `proposedBy` as the creator field (domain naming, predates
  // the createdBy convention) — auditCreate doesn't fit because of that
  // alias, so spell it out and let auditUpdate cover the updatedBy half.
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
 *  attachment matches the booking pattern: undefined = unchanged, null
 *  = remove, File = replace. Only proposer can call this (rule-gated). */
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
  // Defense-in-depth: see updateExpense for rationale.
  const parsed = UpdateWishSchema.safeParse(updates)
  if (!parsed.success) {
    captureError(parsed.error, { source: 'updateWish', tripId, wishId })
    throw new Error('Update payload failed validation')
  }
  const validated = parsed.data
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
 *  the lost-update problem a read-modify-write would have. The rule
 *  layer enforces that the diff only adds / removes the caller's own
 *  uid and changes nothing else. */
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

